// phase8/stance-classifier.mjs
// Stance Classifier - 立场分类器（规则版，零 LLM）
//
// 对 (evidence_text, claim) 判定四分类:
//   supports / contradicts / weakens / neutral
//
// 设计:
//   - 纯规则 + 词典 + 数值/时间/极性信号，不依赖 LLM
//   - 与 tools/stance-f1-harness.mjs 配套，作为其评估被测体
//   - confidence_calibration = 'statistical-signal'（区别于 LLM 伪概率）
//
// 使用:
//   node phase8/stance-classifier.mjs --evidence "text" --claim "proposition"
//   node phase8/stance-classifier.mjs --site robot-parts --limit 200

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const POS_STRONG = new Set([
  'demonstrate', 'demonstrates', 'demonstrated', 'prove', 'proves', 'proven',
  'confirm', 'confirms', 'confirmed', 'establish', 'establishes', 'established',
  'show', 'shows', 'shown', 'validat', 'validates', 'validated',
  'improve', 'improves', 'improved', 'increase', 'increases', 'increased',
  'enable', 'enables', 'enabled', 'facilitat', 'facilitates',
  'outperform', 'outperforms', 'superior', 'superiority',
  'success', 'successful', 'successfully', 'achiev', 'achieves', 'achieved',
  'advance', 'advances', 'advanced', 'boost', 'boosts', 'boosted',
]);

const POS_WEAK = new Set([
  'suggest', 'suggests', 'suggested', 'indicate', 'indicates', 'indicated',
  'reveal', 'reveals', 'revealed', 'point', 'points', 'pointed',
  'correlat', 'correlate', 'correlated', 'associat', 'associates',
  'effective', 'efficiency', 'beneficial', 'favorable', 'promising',
  'potential', 'encouraging', 'positive',
]);

const NEG_STRONG = new Set([
  'contradict', 'contradicts', 'contradicted', 'refut', 'refutes', 'refuted',
  'falsif', 'falsifies', 'falsified', 'disproven', 'disprove',
  'deni', 'denies', 'denied', 'reject', 'rejects', 'rejected',
  'fail', 'fails', 'failed', 'failure',
  'inferior', 'ineffective', 'inefficient', 'unreliable',
  'harmful', 'dangerous', 'problematic', 'flawed', 'incorrect',
  'erroneous', 'wrong', 'flaw', 'flaws',
]);

const NEG_WEAK = new Set([
  'limit', 'limits', 'limited', 'constrain', 'constrains',
  'reduc', 'reduces', 'reduced', 'decline', 'declines', 'declined',
  'deteriorat', 'deteriorates', 'worsen', 'worsens',
  'question', 'questions', 'questionable', 'doubt', 'doubts', 'doubtful',
  'uncertain', 'ambiguity', 'ambiguous', 'inconclusive', 'controversial',
  'partial', 'preliminary', 'tentative', 'weak',
]);

const NEUTRAL_MARKERS = new Set([
  'paper', 'study', 'article', 'review', 'research', 'work',
  'present', 'describe', 'describes', 'discuss', 'discusses',
  'introduc', 'introduces', 'overview', 'survey',
]);

const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'has', 'had',
  'are', 'was', 'were', 'been', 'being', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'for', 'into', 'upon',
  'which', 'who', 'whose', 'whom', 'what', 'when', 'where', 'why', 'how',
  'not', 'but', 'nor', 'yet', 'also', 'than', 'then', 'them', 'their',
  'there', 'here', 'other', 'some', 'any', 'all', 'each', 'every', 'own',
  'same', 'out', 'off', 'up', 'down',
]);

export function classifyStance(evidence, claim) {
  if (!evidence || !claim) {
    return { stance: 'neutral', confidence: 0, signals: { reason: 'missing-input' }, calibration: 'statistical-signal' };
  }

  const evLower = evidence.toLowerCase();
  const evTokens = tokenizeClaim(evidence);
  const clTokens = tokenizeClaim(claim);
  const coverage = claimCoverage(clTokens, evTokens);

  const posStrong = countTokens(evLower, POS_STRONG);
  const posWeak = countTokens(evLower, POS_WEAK);
  const negStrong = countTokens(evLower, NEG_STRONG);
  const negWeak = countTokens(evLower, NEG_WEAK);
  const neutral = countTokens(evLower, NEUTRAL_MARKERS);

  const evNums = extractNumbers(evLower);
  const clNums = extractNumbers(claim.toLowerCase());

  const signals = {
    posStrong, posWeak, negStrong, negWeak, neutral,
    claimCoverage: coverage.toFixed(3),
    hasNumClaim: clNums.length > 0, hasNumEvidence: evNums.length > 0,
    evNums: evNums.slice(0, 5), clNums: clNums.slice(0, 5),
  };

  const posWeight = posStrong * 2 + posWeak;
  const negWeight = negStrong * 2 + negWeak;

  // weakens 信号强度：evidence 有正面主张 + 但含限制词（limited/partial/weak/questioned/inconclusive 等）
  // 这些限制词即使和正面词共存，也表明证据不完全支持 claim
  const WEAKEN_SIGNALS = new Set(['limited', 'limit', 'limits', 'partial', 'weak', 'weakly',
    'questioned', 'questionable', 'inconclusive', 'preliminary', 'tentative', 'small',
    'narrow', 'restricted', 'uncertain', 'ambiguous']);
  const evTokensArr = evLower.split(/\s+/);
  const weakenHits = evTokensArr.filter(t => WEAKEN_SIGNALS.has(t)).length;

  let stance, confidence;

  if (coverage < 0.15 && posWeight === 0 && negWeight === 0 && weakenHits === 0) {
    stance = 'neutral'; confidence = 0.75;
  } else if (negStrong >= 2 || (negStrong >= 1 && posWeight === 0)) {
    // 强反驳
    stance = 'contradicts';
    confidence = Math.min(0.95, 0.65 + negStrong * 0.1 + negWeak * 0.05);
  } else if (posStrong >= 1 && posWeight >= 2 && weakenHits >= 1) {
    // 关键修复：正面词 + 限制词共存 → weakens（不是 supports）
    stance = 'weakens';
    confidence = Math.min(0.9, 0.55 + weakenHits * 0.1 + coverage * 0.1);
  } else if (negWeak >= 1 && posWeight >= 1) {
    // 弱负面词 + 正面词共存 → weakens
    stance = 'weakens';
    confidence = 0.6 + negWeak * 0.05 + coverage * 0.1;
  } else if (posStrong >= 2 || (posStrong >= 1 && posWeight >= 2)) {
    stance = 'supports';
    confidence = Math.min(0.95, 0.6 + posStrong * 0.12 + posWeak * 0.05 + coverage * 0.15);
  } else if (posWeight > negWeight && posWeight >= 2) {
    stance = 'supports';
    confidence = 0.55 + coverage * 0.2;
  } else if (negWeight > posWeight && negWeight >= 1) {
    stance = 'weakens';
    confidence = 0.55 + negWeak * 0.05 + coverage * 0.1;
  } else if (coverage >= 0.3) {
    stance = 'neutral'; confidence = 0.6;
  } else {
    stance = 'neutral'; confidence = 0.5;
  }

  return { stance, confidence, signals, calibration: 'statistical-signal' };
}

function tokenizeClaim(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

function countTokens(lowerText, dict) {
  if (!dict.size) return 0;
  const words = lowerText.split(/\s+/);
  let n = 0;
  for (const w of words) {
    if (dict.has(w)) { n++; continue; }
    for (const key of dict) {
      if (key.length < 5) continue;
      const stem = key.slice(0, -2);
      if (w.startsWith(stem) && stem.length >= 5) { n++; break; }
    }
  }
  return n;
}

function claimCoverage(claimTokens, evidenceTokens) {
  if (claimTokens.length === 0) return 0;
  const evSet = new Set(evidenceTokens);
  const hits = claimTokens.filter(t => evSet.has(t)).length;
  return hits / claimTokens.length;
}

function extractNumbers(text) {
  return (text.match(/-?\d+\.?\d*/g) || []).map(Number).filter(n => !isNaN(n));
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { evidence: null, claim: null, site: null, limit: 50, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--evidence') opts.evidence = argv[++i];
    else if (argv[i] === '--claim') opts.claim = argv[++i];
    else if (argv[i] === '--site') opts.site = argv[++i];
    else if (argv[i] === '--limit') opts.limit = parseInt(argv[++i]);
    else if (argv[i] === '--out') opts.out = argv[++i];
  }
  return opts;
}

async function run(opts) {
  if (opts.evidence && opts.claim) {
    const r = classifyStance(opts.evidence, opts.claim);
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (!opts.site) {
    console.error('Usage: node phase8/stance-classifier.mjs --evidence "..." --claim "..."');
    console.error('   or: node phase8/stance-classifier.mjs --site robot-parts --limit 50');
    process.exit(1);
  }
  const realPath = path.join(ROOT, opts.site, 'website', 'api', 'entities.json');
  const gzPath = path.join(ROOT, '.workbuddy', 'probe', `site-${opts.site}.json.gz`);
  let d;
  if (fs.existsSync(realPath)) d = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
  else if (fs.existsSync(gzPath)) d = JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)).toString());
  else { console.error('data not found for ' + opts.site); process.exit(1); }
  const entities = (Array.isArray(d) ? d : (d.entities || [])).slice(0, opts.limit);

  const dist = { supports: 0, contradicts: 0, weakens: 0, neutral: 0 };
  const samples = [];
  let confSum = 0;

  for (const e of entities) {
    if (!e.abstract || e.abstract.length < 100) continue;
    const kw = (e.tags && e.tags[0]) || (e.name || '').slice(0, 30);
    const claims = [
      kw + ' improves performance',
      kw + ' is effective',
      kw + ' reduces errors',
      'The paper presents ' + kw,
    ];
    for (const c of claims) {
      const r = classifyStance(e.abstract, c);
      dist[r.stance] = (dist[r.stance] || 0) + 1;
      confSum += r.confidence;
      if (samples.length < 5) samples.push({ entity: e.id, claim: c, ...r });
    }
  }

  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  const out = {
    site: opts.site, entityCount: entities.length, totalJudgments: total,
    stanceDistribution: dist,
    stanceRates: Object.fromEntries(Object.entries(dist).map(([k, v]) => [k, total ? (v / total).toFixed(3) : 0])),
    avgConfidence: total ? (confSum / total).toFixed(3) : 0,
    samples,
  };
  const outPath = opts.out || path.join(ROOT, opts.site, 'stance-results.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log('OK ' + opts.site + ': ' + total + ' judgments, avg_conf=' + out.avgConfidence);
  console.log('  distribution:', JSON.stringify(out.stanceRates));
  console.log('  output: ' + outPath);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  run(parseArgs()).catch(e => { console.error('ERR', e); process.exit(1); });
}
