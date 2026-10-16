// phase8/claim-extractor.mjs
// Claim Extractor - 从 evidence 抽原子 claim
//
// 目标：把 evidence-engine 抽出的 evidence 段（句子级）压成结构化 claim
//       subject / predicate / object + confidence
//
// 设计：
//   - 纯规则，零 LLM
//   - 主谓宾三槽位 + 时间/数值/量级修饰
//   - confidence 用启发式：句长 + 数字密度 + 术语密度
//
// 使用：
//   node phase8/claim-extractor.mjs --site robot-parts --limit 200
//   node phase8/claim-extractor.mjs --input evidence.json --out claims.json

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 谓语动词库（英文科研动词）
const PREDICATE_VERBS = [
  'improve', 'improves', 'improved', 'increase', 'increases', 'increased',
  'reduce', 'reduces', 'reduced', 'decrease', 'decreases', 'decreased',
  'enable', 'enables', 'enabled', 'demonstrate', 'demonstrates', 'demonstrated',
  'show', 'shows', 'shown', 'suggest', 'suggests', 'suggested',
  'reveal', 'reveals', 'revealed', 'achiev', 'achieves', 'achieved',
  'outperform', 'outperforms', 'outperforming', 'facilitat', 'facilitates',
  'validat', 'validates', 'validated', 'correlat', 'correlates', 'correlated',
  'associat', 'associates', 'associated', 'detect', 'detects', 'detected',
  'predict', 'predicts', 'predicted', 'classify', 'classifies', 'classified',
  'measure', 'measures', 'measured', 'optimize', 'optimizes', 'optimized',
  'boost', 'boosts', 'boosted', 'advance', 'advances', 'advanced',
  'deni', 'denies', 'denied', 'reject', 'rejects', 'rejected',
  'contradict', 'contradicts', 'contradicted', 'refut', 'refutes', 'refuted',
  'deteriorat', 'deteriorates', 'deteriorated', 'worsen', 'worsens',
  'limit', 'limits', 'limited', 'constrain', 'constrains', 'constrained',
];

const PREDICATE_SET = new Set(PREDICATE_VERBS);

// 主语/宾语候选词（术语）：大写字母开头词、复数、技术名
const TERMINAL_STOPWORDS = new Set([
  'the', 'this', 'these', 'that', 'those', 'our', 'their', 'its', 'his', 'her',
  'we', 'they', 'i', 'you', 'he', 'she', 'a', 'an', 'and', 'but', 'or',
  'of', 'in', 'on', 'to', 'for', 'with', 'from', 'at', 'by', 'as', 'into',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'not', 'than', 'then', 'also', 'however', 'therefore', 'thus', 'which',
  'who', 'whom', 'whose', 'what', 'when', 'where', 'why', 'how', 'very',
  'much', 'more', 'most', 'some', 'any', 'all', 'each', 'every', 'own',
  'same', 'other', 'another', 'new', 'first', 'last', 'only', 'much',
  'large', 'small', 'big', 'little', 'old', 'young', 'high', 'low',
]);

export function extractClaims(evidence, entity) {
  const claims = [];
  if (!evidence || !evidence.text) return claims;
  const sents = splitSentences(evidence.text);
  for (const sent of sents) {
    const c = extractClaimFromSentence(sent, entity, evidence.type);
    if (c) claims.push(c);
  }
  return claims;
}

function splitSentences(text) {
  return String(text).split(/(?<=[.!?])\s+/).filter(s => s.length > 20);
}

function extractClaimFromSentence(sent, entity, evidenceType) {
  const tokens = sent.toLowerCase().split(/[^a-z0-9%$-.]+/).filter(Boolean);
  if (tokens.length < 3) return null;

  // 找谓语
  const predIdx = tokens.findIndex((t, i) => {
    if (!PREDICATE_SET.has(t)) return false;
    // 谓语不能太靠前（主语应在谓语前）
    return i > 0 && i < tokens.length - 1;
  });
  if (predIdx < 0) return null;

  const predicate = tokens[predIdx];
  // 主语：谓语前最近的实义词
  const subj = findSubject(tokens.slice(0, predIdx));
  // 宾语：谓语后最近的实义词（可含 prepositional 短语）
  const obj = findObject(tokens.slice(predIdx + 1));

  if (!subj || !obj) return null;

  // 置信度：句子成分完整度 + 数字密度 + 术语密度
  const numDensity = (sent.match(/-?\d+\.?\d*/g) || []).length / Math.max(3, tokens.length);
  const termDensity = tokens.filter(t => t.length >= 6 && !TERMINAL_STOPWORDS.has(t)).length / Math.max(3, tokens.length);
  let confidence = 0.35 + Math.min(0.35, numDensity * 3) + Math.min(0.25, termDensity * 0.8);
  confidence = Math.min(0.92, Math.round(confidence * 100) / 100);

  return {
    id: `claim:${entity.id}:${sent.slice(0, 40).replace(/[^a-z0-9]/gi, '')}`,
    subject: subj,
    predicate: predicate,
    object: obj,
    sentence: sent,
    evidence_type: evidenceType || "unknown",
    entity_id: entity.id,
    entity_name: entity.name,
    confidence: confidence,
    confidence_calibration: 'statistical-signal',
    generated_at: new Date().toISOString(),
    source: 'phase8/claim-extractor.mjs',
  };
}

function findSubject(tokens) {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (TERMINAL_STOPWORDS.has(t) || t.length < 3) continue;
    // 排除动词（避免动词被误判为主语）
    if (PREDICATE_SET.has(t)) continue;
    return t;
  }
  return null;
}

function findObject(tokens) {
  const PREPS = new Set(['in', 'of', 'on', 'for', 'with', 'from', 'to', 'at', 'by', 'via', 'using']);
  let phrase = [];
  for (const t of tokens) {
    if (PREPS.has(t) || TERMINAL_STOPWORDS.has(t)) { phrase.push(t); continue; }
    if (PREDICATE_SET.has(t)) break;
    if (t.length < 3) continue;
    phrase.push(t);
  }
  if (phrase.length === 0) return null;
  return phrase.join(' ');
}

// ============== CLI ==============

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { site: null, limit: 50, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site') opts.site = argv[++i];
    else if (argv[i] === '--limit') opts.limit = parseInt(argv[++i]);
    else if (argv[i] === '--out') opts.out = argv[++i];
  }
  return opts;
}

async function run(opts) {
  if (!opts.site) {
    console.error('Usage: node phase8/claim-extractor.mjs --site robot-parts --limit 50');
    process.exit(1);
  }
  const realPath = path.join(ROOT, opts.site, 'website', 'api', 'entities.json');
  const gzPath = path.join(ROOT, '.workbuddy', 'probe', `site-${opts.site}.json.gz`);
  let d;
  if (fs.existsSync(realPath)) d = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
  else if (fs.existsSync(gzPath)) d = JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)).toString());
  else { console.error('data not found for ' + opts.site); process.exit(1); }
  const entities = (Array.isArray(d) ? d : (d.entities || [])).slice(0, opts.limit);

  // 复用 evidence-engine 的 extractEvidence
  const { extractEvidence } = await import('./evidence-engine.mjs');

  const allClaims = [];
  const predCount = {};
  let confSum = 0;

  for (const e of entities) {
    if (!e.abstract) continue;
    const evs = extractEvidence(e);
    const claims = extractClaims(evs.find(ev => ev.type === 'abstract-lead') || { text: e.abstract }, e);
    allClaims.push(...claims);
    for (const c of claims) {
      predCount[c.predicate] = (predCount[c.predicate] || 0) + 1;
      confSum += c.confidence;
    }
  }

  const topPreds = Object.entries(predCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const avgConf = allClaims.length ? (confSum / allClaims.length).toFixed(3) : 0;

  const out = {
    site: opts.site,
    entityCount: entities.length,
    claimCount: allClaims.length,
    avgConfidence: avgConf,
    topPredicates: topPreds,
    predicatesUnique: Object.keys(predCount).length,
    claims: allClaims.slice(0, 100), // 前 100 条示例
    allClaimsCount: allClaims.length,
  };
  const outPath = opts.out || path.join(ROOT, 'data', 'extracted-claims.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log('OK ' + opts.site + ': ' + allClaims.length + ' claims from ' + entities.length + ' entities');
  console.log('  avg_conf=' + avgConf + ', unique_preds=' + out.predicatesUnique);
  console.log('  top preds:', topPreds.slice(0, 5).map(([k, v]) => k + '=' + v).join(', '));
  console.log('  output: ' + outPath);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  run(parseArgs()).catch(e => { console.error('ERR', e); process.exit(1); });
}
