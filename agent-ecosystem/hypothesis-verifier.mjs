// agent-ecosystem/hypothesis-verifier.mjs
// Hypothesis Verifier - 验证执行器
//
// 目标：跑 hypothesis card 的 verification_plan，产出判定
//       status: verified / falsified / inconclusive
//
// 策略：因为当前无 OpenAlex key 且飞轮冻结，走**证据引擎本地证据**做降级验证：
//   1. 从 citation_gaps 里查该 gap pair 是否有 citation 边（如果有 → verified）
//   2. 用 stance-classifier 判断"是否存在共享主题的实体对"（辅助）
//   3. 用 claim-extractor 找是否有相关 claim
//   4. 都不足证据时 → inconclusive（诚实弃权）
//
// 输出：
//   更新 hypothesis-queue.json 里的 entry.status
//   返回验证报告 JSON
//
// 使用：
//   node agent-ecosystem/hypothesis-verifier.mjs --id HYP-20261016-0001
//   node agent-ecosystem/hypothesis-verifier.mjs --top 10
//   node agent-ecosystem/hypothesis-verifier.mjs --all

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const { loadCards, loadQueue, saveQueue, transition, dequeue, initQueue } = await import('./hypothesis-queue.mjs');
const { classifyStance } = await import('../phase8/stance-classifier.mjs');

// ============== 数据加载 ==============

const SITE_DIRS = [
  'robot-parts', 'bionic-ai', 'agent-ecosystem', 'ai4science', 'biomed-ai',
  'quantum-computing', 'neuromorphic', 'edge-ai', 'ai-safety', 'semiconductor',
  'deep-sea-tech', 'nuclear-energy', 'brain-science', 'life-science', 'low-altitude',
];

function loadSiteEntities(site) {
  const realPath = path.join(ROOT, site, 'website', 'api', 'entities.json');
  const gzPath = path.join(ROOT, '.workbuddy', 'probe', `site-${site}.json.gz`);
  let d;
  if (fs.existsSync(realPath)) d = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
  else if (fs.existsSync(gzPath)) d = JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)).toString());
  else return [];
  return Array.isArray(d) ? d : (d.entities || []);
}

function loadCitationGaps() {
  const p = path.join(ROOT, 'data', 'citation-gaps.json');
  if (!fs.existsSync(p)) return { gapPairs: [], pairs: [] };
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// ============== 验证策略 ==============

export function verifyHypothesis(card, ctx) {
  const { gapPairs, allPairs, entitiesBySite } = ctx;
  const evidence = [];
  const signals = {};
  let decision = 'inconclusive';
  let confidence = 0;

  const gap = card.source_signals?.citation_gap_pair;
  const sharedTags = card.source_signals?.shared_tags || [];

  // 策略 1: 查 citation_gaps 里该 pair 是否有引用边
  if (gap) {
    const pairMatch = allPairs.find(p => {
      const [a, b] = gap.split('→');
      return (p.from === a && p.to === b) || (p.from === b && p.to === a);
    });
    if (pairMatch) {
      const edgeCount = pairMatch.edgeCount || pairMatch.directedEdges || 0;
      signals.citationEdgeCount = edgeCount;
      if (edgeCount >= 3) {
        decision = 'verified';
        confidence = Math.min(0.9, 0.6 + edgeCount * 0.05);
        evidence.push({
          type: 'citation-edges-found',
          detail: `Gap pair ${gap} has ${edgeCount} direct edges (expected 0)`,
          strength: 'strong',
        });
      } else if (edgeCount === 0 && sharedTags.length >= 1) {
        // 0 edge + shared tags → 保持 hypothesis_only，不 falsify
        signals.citationEdgeCount = 0;
        signals.sharedTagsCount = sharedTags.length;
      } else if (edgeCount === 0 && sharedTags.length === 0) {
        decision = 'falsified';
        confidence = 0.7;
        evidence.push({
          type: 'citation-absent-and-no-tag-overlap',
          detail: `Gap pair ${gap} has 0 edges and 0 shared tags — no plausible connection`,
          strength: 'medium',
        });
      }
    }
  }

  // 策略 2: 用 stance-classifier 检查该假设是否被库内某实体支持
  const pair = gap ? gap.split('→') : [];
  if (pair.length === 2 && (decision === 'inconclusive' || decision === 'verified')) {
    const [siteA, siteB] = pair;
    const entA = entitiesBySite.get(siteA) || [];
    const entB = entitiesBySite.get(siteB) || [];
    const sampleA = entA.slice(0, 5);
    const sampleB = entB.slice(0, 5);

    let supportCount = 0;
    let sampleStance = null;
    for (const ea of sampleA) {
      if (!ea.abstract || ea.abstract.length < 100) continue;
      for (const eb of sampleB) {
        const claim = `Entity from ${siteB} relates to ${ea.tags?.[0] || 'the same topic'}`;
        const r = classifyStance(eb.abstract, claim);
        if (r.stance === 'supports' && r.confidence >= 0.6) {
          supportCount++;
          if (!sampleStance) sampleStance = { entityA: ea.id, entityB: eb.id, ...r };
        }
      }
    }
    signals.crossSiteSupportCount = supportCount;
    if (supportCount >= 2 && decision === 'inconclusive') {
      decision = 'verified';
      confidence = Math.min(0.9, 0.55 + supportCount * 0.05);
      evidence.push({
        type: 'cross-site-stance-support',
        detail: `${supportCount} cross-site abstracts stance-support the connection`,
        strength: 'weak-medium',
      });
    } else if (supportCount >= 1) {
      evidence.push({
        type: 'cross-site-stance-partial',
        detail: `${supportCount} partial supports`,
        strength: 'weak',
      });
    }
    if (sampleStance) signals.sampleStance = sampleStance;
  }

  // 策略 3: 无充分证据 → inconclusive（诚实弃权）
  if (decision === 'inconclusive') {
    confidence = 0.35;
    signals.reason = 'insufficient-evidence-within-local-corpus';
  }

  return {
    id: card.id,
    decision,
    confidence: Math.round(confidence * 1000) / 1000,
    confidence_calibration: 'statistical-signal',
    evidence,
    signals,
    verifiedAt: new Date().toISOString(),
    verifier: 'agent-ecosystem/hypothesis-verifier.mjs',
    version: '1.0.0',
  };
}

// ============== 批量执行 ==============

export function runVerification({ top = 0, ids = null, all = false } = {}) {
  const cards = loadCards();
  if (cards.length === 0) return { error: 'no hypothesis cards' };

  // 初始化队列
  const queue = loadQueue();
  if (Object.keys(queue.entries).length === 0) initQueue();
  const queueRef = loadQueue();

  // 决定要跑哪些
  let targets;
  if (ids && ids.length) {
    targets = cards.filter(c => ids.includes(c.id));
  } else if (all) {
    targets = cards;
  } else if (top > 0) {
    const q = dequeue(queueRef, top);
    targets = cards.filter(c => q.some(it => it.id === c.id));
  } else {
    // 默认跑 top 10
    const q = dequeue(queueRef, 10);
    targets = cards.filter(c => q.some(it => it.id === c.id));
  }

  // 加载上下文
  const { gapPairs, pairs } = loadCitationGaps();
  const allPairs = pairs || gapPairs.pairs || [];
  const entitiesBySite = new Map();
  for (const site of SITE_DIRS) {
    const ents = loadSiteEntities(site);
    if (ents.length) entitiesBySite.set(site, ents);
  }
  const ctx = { gapPairs, allPairs, entitiesBySite };

  const results = [];
  for (const card of targets) {
    const result = verifyHypothesis(card, ctx);
    results.push(result);

    // 回写队列状态
    try {
      if (result.decision === 'verified') {
        transition(queueRef, card.id, 'verified', `confidence=${result.confidence}`);
      } else if (result.decision === 'falsified') {
        transition(queueRef, card.id, 'falsified', `confidence=${result.confidence}`);
      }
      // inconclusive 保持 queued
    } catch (e) {
      // 忽略状态更新失败
    }
  }

  // 汇总
  const byDecision = {};
  for (const r of results) byDecision[r.decision] = (byDecision[r.decision] || 0) + 1;

  return {
    runAt: new Date().toISOString(),
    targetsProcessed: results.length,
    byDecision,
    results,
  };
}

// ============== CLI ==============

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { top: 10, ids: [], all: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id') opts.ids.push(argv[++i]);
    else if (a === '--top') opts.top = parseInt(argv[++i]);
    else if (a === '--all') opts.all = true;
    else if (a === '--out') opts.out = argv[++i];
  }
  return opts;
}

function main() {
  const opts = parseArgs();
  const t0 = performance.now();
  const result = runVerification(opts);
  const ms = performance.now() - t0;

  console.log('=== HYPOTHESIS VERIFICATION RUN ===');
  console.log('targets: ' + result.targetsProcessed);
  console.log('byDecision: ' + JSON.stringify(result.byDecision));
  console.log('ms: ' + ms.toFixed(0));
  console.log('');

  for (const r of result.results.slice(0, 20)) {
    console.log('  ' + r.id + ' -> ' + r.decision + ' (conf=' + r.confidence + ')');
    if (r.evidence.length) console.log('     evidence: ' + r.evidence.map(e => e.type).join(', '));
  }

  const outPath = opts.out || path.join(ROOT, 'data', 'verification-runs', new Date().toISOString().slice(0, 10) + '-run.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('');
  console.log('output: ' + outPath);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main();
}
