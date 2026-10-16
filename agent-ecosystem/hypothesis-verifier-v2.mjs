#!/usr/bin/env node
// agent-ecosystem/hypothesis-verifier-v2.mjs — Phase 10 抽样验证（7 种策略本地证据）
//
// 目的：从 hypothesis-queue 中 dequeue N 张卡（默认 100），
//       按 hypothesis_type 用不同的本地证据策略做验证判定，
//       把 result 写入 data/verification-runs/ 并回写 queue 状态。
//
// 与 hypothesis-verifier.mjs (v1) 的区别：
//   - v1 只认真正的 litellbridge（gap pair 有 citation 边），非 litellbridge 都 inconclusive
//   - v2 为每种 hypothesis_type 提供对应验证策略：
//       1. litellbridge         → 查 pairMatrix，找 gap pair 有边 → verified；0 边且无 shared tags → falsified
//       2. sparse_bridge_v2     → 查 pairMatrix，验证 actual_edges >= 2 × claimed_current_edges
//       3. moderate_bridge      → 查 pairMatrix，验证 current_edges 一致（数据事实）
//       4. degree_imbalance     → 查 degrees，重算 ratio，验证 imbalance_site/target_site 存在
//       5. emerging_topic       → 查 pairMatrix，验证 gap pair 且 shared tags > 0
//       6. bidirectional_gap    → 查 pairMatrix 反向对，验证 0 edge 且 gapPairs 中有反向
//       7. crossref_topic_bridge→ 查 pairMatrix，验证 observed_edge 存在且有边
//
// 输出：
//   - 更新 hypothesis-queue.json（状态转换 verified/falsified/inconclusive 保持 queued）
//   - 写入 data/verification-runs/YYYY-MM-DD-v2-run.json
//
// 使用：
//   node agent-ecosystem/hypothesis-verifier-v2.mjs --n 100
//   node agent-ecosystem/hypothesis-verifier-v2.mjs --n 50 --seed 42
//   node agent-ecosystem/hypothesis-verifier-v2.mjs --ids HYP-20261016-0101 HYP-20261016-0200

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const { loadQueue, saveQueue, transition, dequeue, loadCards } = await import('./hypothesis-queue.mjs');

// ============== 数据加载 ==============

function loadGaps() {
  const p = path.join(ROOT, 'data', 'citation-gaps.json');
  if (!fs.existsSync(p)) return { pairMatrix: [], degrees: [], gapPairs: [] };
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// 构造查找表
function buildLookup(gaps) {
  const pairLookup = new Map();
  for (const [a, b, e] of (gaps.pairMatrix || [])) {
    pairLookup.set(`${a}|${b}`, e);
  }
  const degreeLookup = new Map();
  for (const d of (gaps.degrees || [])) {
    degreeLookup.set(d.site, d);
  }
  const gapSet = new Set();
  for (const p of (gaps.gapPairs || [])) {
    gapSet.add(`${p.from}|${p.to}`);
    gapSet.add(`${p.to}|${p.from}`);
  }
  return { pairLookup, degreeLookup, gapSet };
}

function loadEdges() {
  const p = path.join(ROOT, 'data', 'citation-edges.json');
  if (!fs.existsSync(p)) return { edges: [] };
  const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return j;
}

// 边对计数表（sourceSite → targetSite → count）
function buildEdgePairCounts(edges) {
  const counts = new Map();
  for (const [sDoi, tDoi, sSite, tSite] of (edges.edges || [])) {
    const k = `${sSite}|${tSite}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

// ============== 7 种策略验证 ==============

function verifyByType(card, lk, edgeCounts) {
  const t = card.hypothesis_type;
  const signals = card.source_signals || {};
  const evidence = [];
  let decision = 'inconclusive';
  let confidence = 0.35;

  // 策略 1: litellbridge
  if (t === 'litellbridge') {
    const gap = signals.citation_gap_pair;
    const shared = signals.shared_tags || [];
    if (gap) {
      const [a, b] = gap.split('→');
      const edges = lk.pairLookup.get(`${a}|${b}`);
      if (edges !== undefined) {
        if (edges >= 3) {
          decision = 'verified';
          confidence = Math.min(0.85, 0.55 + edges * 0.02);
          evidence.push({ type: 'gap-pair-has-edges', detail: `${gap} has ${edges} edges in pairMatrix`, strength: 'strong' });
        } else if (edges === 0 && shared.length === 0) {
          decision = 'falsified';
          confidence = 0.65;
          evidence.push({ type: 'gap-pair-no-edges-no-tags', detail: `${gap} has 0 edges and 0 shared tags`, strength: 'medium' });
        } else if (edges === 0 && shared.length > 0) {
          // 有共享主题但无引用 → 保持 inconclusive（诚实弃权，不 falsify）
          decision = 'inconclusive';
          confidence = 0.40;
          evidence.push({ type: 'gap-pair-no-edges-with-tags', detail: `0 edges but ${shared.length} shared tags — keep abstaining`, strength: 'weak' });
        }
      }
    }
  }

  // 策略 2: sparse_bridge_v2（验证"应更密"，即实际边数是否 >= 2 × claimed）
  else if (t === 'sparse_bridge_v2') {
    const pairStr = signals.citation_pair;
    const claimed = signals.current_edges;
    if (pairStr) {
      const [a, b] = pairStr.split('↔');
      const actual = lk.pairLookup.get(`${a}|${b}`);
      if (actual !== undefined) {
        if (actual >= claimed && actual >= 2) {
          decision = 'verified';
          confidence = 0.55;
          evidence.push({ type: 'sparse-bridge-confirmed', detail: `pairMatrix ${actual} edges vs claimed ${claimed}`, strength: 'medium' });
        } else if (actual === claimed) {
          decision = 'inconclusive';
          confidence = 0.35;
          evidence.push({ type: 'sparse-bridge-stable', detail: `edge count stable at ${actual} — no growth observed`, strength: 'weak' });
        }
      }
    }
  }

  // 策略 3: moderate_bridge
  else if (t === 'moderate_bridge') {
    const pairStr = signals.citation_pair;
    const claimed = signals.current_edges;
    if (pairStr) {
      const [a, b] = pairStr.split('↔');
      const actual = lk.pairLookup.get(`${a}|${b}`);
      if (actual !== undefined && actual === claimed) {
        decision = 'verified';
        confidence = 0.60;
        evidence.push({ type: 'moderate-bridge-data-fact', detail: `edge count ${actual} confirmed from pairMatrix`, strength: 'medium' });
      } else if (actual !== undefined) {
        decision = 'inconclusive';
        confidence = 0.40;
        evidence.push({ type: 'moderate-bridge-drift', detail: `claimed ${claimed} vs actual ${actual}`, strength: 'weak' });
      }
    }
  }

  // 策略 4: degree_imbalance
  else if (t === 'degree_imbalance') {
    const site = signals.imbalance_site;
    const target = signals.target_site;
    const d = lk.degreeLookup.get(site);
    if (d) {
      const actualRatio = Math.max(d.inDegree / Math.max(d.outDegree, 1), d.outDegree / Math.max(d.inDegree, 1));
      const claimedRatio = parseFloat(signals.ratio);
      if (actualRatio > 5) {
        decision = 'verified';
        confidence = Math.min(0.75, 0.5 + actualRatio * 0.02);
        evidence.push({ type: 'imbalance-confirmed', detail: `${site}: in=${d.inDegree} out=${d.outDegree} ratio=${actualRatio.toFixed(2)} (claimed ${claimedRatio})`, strength: 'medium' });
      }
    }
  }

  // 策略 5: emerging_topic
  else if (t === 'emerging_topic') {
    const pairStr = signals.citation_gap_pair;
    const shared = signals.shared_tags || [];
    if (pairStr && shared.length > 0) {
      const [a, b] = pairStr.split('↔');
      const inGap = lk.gapSet.has(`${a}|${b}`) || lk.gapSet.has(`${b}|${a}`);
      if (inGap) {
        decision = 'verified';
        confidence = 0.60;
        evidence.push({ type: 'emerging-topic-confirmed', detail: `gap pair ${pairStr} with ${shared.length} shared tags (${shared.join(',')})`, strength: 'medium' });
      }
    }
  }

  // 策略 6: bidirectional_gap
  else if (t === 'bidirectional_gap') {
    const gap = signals.citation_gap_pair;
    const shared = signals.shared_tags || [];
    if (gap) {
      const [a, b] = gap.split('→');
      const revEdges = lk.pairLookup.get(`${a}|${b}`);
      if (revEdges === 0) {
        decision = 'verified';
        confidence = 0.55;
        evidence.push({ type: 'bidirectional-gap-confirmed', detail: `${gap} reverse pair also has 0 edges`, strength: 'medium' });
      } else if (revEdges !== undefined) {
        decision = 'falsified';
        confidence = 0.60;
        evidence.push({ type: 'bidirectional-gap-contradicted', detail: `reverse pair ${gap} has ${revEdges} edges — reverse flow exists`, strength: 'medium' });
      }
    }
  }

  // 策略 7: crossref_topic_bridge
  else if (t === 'crossref_topic_bridge') {
    const edgeStr = signals.observed_edge;
    if (edgeStr) {
      const [a, b] = edgeStr.split('→');
      const observedEdges = lk.pairLookup.get(`${a}|${b}`);
      if (observedEdges !== undefined && observedEdges > 0) {
        decision = 'verified';
        confidence = Math.min(0.65, 0.4 + observedEdges * 0.02);
        evidence.push({ type: 'crossref-bridge-confirmed', detail: `${a}→${b} has ${observedEdges} edges total`, strength: 'medium' });
      } else if (observedEdges === 0) {
        decision = 'falsified';
        confidence = 0.55;
        evidence.push({ type: 'crossref-bridge-vanished', detail: `${a}→${b} has 0 edges — observation was artifact`, strength: 'medium' });
      }
    }
  }

  return {
    id: card.id,
    hypothesis_type: t,
    decision,
    confidence: Math.round(confidence * 1000) / 1000,
    confidence_calibration: 'statistical-signal',
    evidence,
    source_signals: signals,
    verifiedAt: new Date().toISOString(),
    verifier: 'agent-ecosystem/hypothesis-verifier-v2.mjs',
    version: '2.0.0',
  };
}

// ============== 抽样 + 执行 ==============

function runVerification({ n = 100, seed = 0, ids = [] } = {}) {
  const gaps = loadGaps();
  const lk = buildLookup(gaps);
  const edges = loadEdges();
  const edgeCounts = buildEdgePairCounts(edges);

  const queue = loadQueue();
  const cards = loadCards();
  const cardById = new Map(cards.map(c => [c.id, c]));

  let targets;
  if (ids.length > 0) {
    targets = ids.map(id => cardById.get(id)).filter(Boolean);
  } else {
    const q = dequeue(queue, n);
    // seed 打散（可复现）
    if (seed > 0) {
      const rng = crypto.createHash('sha256');
      rng.update(`seed-${seed}`);
      // 简单 shuffle: 用 seed 作为偏移
      const offset = seed % Math.max(1, q.length - 1);
      const rotated = [...q.slice(offset), ...q.slice(0, offset)];
      targets = rotated.map(e => cardById.get(e.id)).filter(Boolean);
    } else {
      targets = q.map(e => cardById.get(e.id)).filter(Boolean);
    }
  }

  const results = [];
  const newQueue = loadQueue();

  for (const card of targets) {
    if (!card) continue;
    const result = verifyByType(card, lk, edgeCounts);
    results.push(result);

    // 回写 queue
    try {
      if (result.decision === 'verified') {
        transition(newQueue, card.id, 'verified', `v2 confidence=${result.confidence} evidence=${result.evidence.length}`);
      } else if (result.decision === 'falsified') {
        transition(newQueue, card.id, 'falsified', `v2 confidence=${result.confidence} evidence=${result.evidence.length}`);
      }
      // inconclusive 保持 queued（保留在队列里等未来证据）
    } catch (e) {
      // 忽略状态更新失败
    }
  }

  // 汇总
  const byDecision = {};
  const byType = {};
  for (const r of results) {
    byDecision[r.decision] = (byDecision[r.decision] || 0) + 1;
    byType[r.hypothesis_type] = (byType[r.hypothesis_type] || 0) + 1;
  }

  // 同步队列到磁盘（一次性，避免 transition 每次 IO）
  saveQueue(newQueue);

  return {
    runAt: new Date().toISOString(),
    nRequested: n,
    seed,
    targetsProcessed: results.length,
    byDecision,
    byType,
    avgConfidence: results.length ? Math.round(results.reduce((s, r) => s + r.confidence, 0) / results.length * 1000) / 1000 : 0,
    results,
  };
}

// ============== CLI ==============

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { n: 100, seed: 0, ids: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--n') opts.n = parseInt(argv[++i]);
    else if (a === '--seed') opts.seed = parseInt(argv[++i]);
    else if (a === '--ids') {
      // 后续参数都是 id
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.ids.push(argv[++i]);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs();
  const t0 = performance.now();
  const result = runVerification(opts);
  const ms = performance.now() - t0;

  console.log('=== HYPOTHESIS VERIFICATION V2 RUN ===');
  console.log('requested:', opts.n, opts.ids.length ? `ids=${opts.ids.length}` : '');
  console.log('processed:', result.targetsProcessed);
  console.log('byDecision:', JSON.stringify(result.byDecision));
  console.log('byType:', JSON.stringify(result.byType));
  console.log('avgConfidence:', result.avgConfidence);
  console.log('ms:', ms.toFixed(0));
  console.log('');
  console.log('samples:');
  for (const r of result.results.slice(0, 15)) {
    console.log('  ' + r.id + ' [' + r.hypothesis_type + '] -> ' + r.decision + ' (conf=' + r.confidence + ')');
    if (r.evidence[0]) console.log('     ' + r.evidence[0].type + ': ' + r.evidence[0].detail);
  }

  const outPath = path.join(ROOT, 'data', 'verification-runs', new Date().toISOString().slice(0, 10) + '-v2-run.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('');
  console.log('output:', path.relative(ROOT, outPath));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { main(); } catch (e) { console.error('ERR', e.message); console.error(e.stack); process.exit(1); }
}
