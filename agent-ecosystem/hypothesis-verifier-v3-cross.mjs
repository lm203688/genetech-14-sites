#!/usr/bin/env node
// agent-ecosystem/hypothesis-verifier-v3-cross.mjs — Phase 11 多源交叉验证
//
// 目的：打破 Phase 10 v2 验证器的**循环论证**——用多种**独立本地数据源**交叉验证
//       Phase 10 已 verified 的假设卡，只保留跨源一致的证据。
//
// 三种独立本地数据源（相互不引用对方）：
//   V1: citation-edges.json   — 原始引用边 25,682 条（pairMatrix 的源头，但作为独立事实层）
//   V2: cited-entities.json   — OpenAlex 抓取 48,760 条，有 concepts/topics（外部数据源）
//   V3: academic-entities.json — Crossref 抓取 1,634 条，有 tags/sites（有站点标识）
//
// 判据：3 源中 ≥2 源通过 → cross_verified；否则 → cross_inconclusive / cross_falsified
//
// 与 v2 的区别：
//   - v2 只用 pairMatrix（citation_edges 的汇总层）→ 循环论证
//   - v3 用 3 个独立数据源交叉，且**不依赖 pairMatrix**
//
// 使用：
//   node agent-ecosystem/hypothesis-verifier-v3-cross.mjs --n 30
//   node agent-ecosystem/hypothesis-verifier-v3-cross.mjs --n 30 --only-verified
//   node agent-ecosystem/hypothesis-verifier-v3-cross.mjs --ids HYP-20261016-0704 HYP-20261016-0209

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ============== 数据加载 ==============

function loadJson(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function loadCards() {
  return loadJson('data/hypothesis-cards.json')?.hypothesisCards || [];
}

// V1: citation-edges 原始边
function loadEdges() {
  return loadJson('data/citation-edges.json')?.edges || [];
}

// V2: cited-entities（OpenAlex 外部）
function loadCited() {
  const d = loadJson('data/cited-entities.json');
  if (!d) return [];
  return Array.isArray(d) ? d : (d.entities || d.records || []);
}

// V3: academic-entities（Crossref 外部）
function loadAcademic() {
  const d = loadJson('data/academic-entities.json');
  if (!d) return [];
  return Array.isArray(d) ? d : (d.entities || d.records || []);
}

// 站点 → 实体索引（学术实体）
function buildAcademicSiteIndex(academic) {
  const bySite = new Map();
  for (const e of academic) {
    const sites = e.sites || e.tags || [];
    for (const s of sites) {
      if (!bySite.has(s)) bySite.set(s, []);
      bySite.get(s).push(e);
    }
  }
  return bySite;
}

// 站点 → concepts 集合（cited-entities 通过 concepts/topics 反向映射到站点不精确，
// 我们用 title/abstract 的关键词匹配站点名）
function buildCitedConcepts(cited, sites, samplePerSite = 100) {
  // 为每个站点，从 cited-entities 中挑 samplePerSite 条相关实体，抽 concepts 高频词
  const result = {};
  for (const site of sites) {
    const siteTokens = new Set(site.split(/[-_ ]+/).filter(w => w.length >= 3));
    // 简单关键词匹配：title/abstract 中命中站点关键词的实体
    const matched = [];
    for (const e of cited) {
      if (matched.length >= samplePerSite) break;
      const text = ((e.title || '') + ' ' + (e.abstract || '')).toLowerCase();
      let hit = 0;
      for (const t of siteTokens) if (text.includes(t)) hit++;
      if (hit >= 1) matched.push(e);
    }
    // 抽 concepts 高频
    const conceptCount = {};
    for (const e of matched) {
      for (const c of (e.concepts || [])) {
        const n = c.name || c;
        if (n && n.length >= 3) conceptCount[n] = (conceptCount[n] || 0) + 1;
      }
    }
    // 取 top 30
    const top = Object.entries(conceptCount).sort((a, b) => b[1] - a[1]).slice(0, 30);
    result[site] = { concepts: top.map(t => t[0]), sampleCount: matched.length };
  }
  return result;
}

// ============== 3 源交叉验证 ==============

function verifyCross(card, { edgePairCounts, academicBySite, citedConcepts }) {
  const signals = card.source_signals || {};
  const t = card.hypothesis_type;
  let siteA = null, siteB = null;

  // 提取站点
  if (signals.citation_gap_pair) {
    const parts = signals.citation_gap_pair.split(/[→↔]/);
    siteA = parts[0]; siteB = parts[1];
  } else if (signals.citation_pair) {
    const parts = signals.citation_pair.split(/[→↔]/);
    siteA = parts[0]; siteB = parts[1];
  } else if (signals.observed_edge) {
    const parts = signals.observed_edge.split(/[→]/);
    siteA = parts[0]; siteB = parts[1];
  } else if (signals.imbalance_site && signals.target_site) {
    siteA = signals.imbalance_site; siteB = signals.target_site;
  }

  const evidence = { V1_edges: null, V2_concepts: null, V3_academic: null };
  let passes = 0;
  const failures = [];

  // V1: citation-edges 原始边（不是 pairMatrix）
  if (siteA && siteB) {
    const edges = edgePairCounts.get(`${siteA}|${siteB}`) || 0;
    evidence.V1_edges = edges;
    // 有边 → 支持；无边 → 不 falsify（保守）
    if (edges >= 1) passes++;
    else failures.push('V1: no edges in citation-edges raw');
  }

  // V2: cited-entities concepts 交集
  if (siteA && siteB && citedConcepts[siteA] && citedConcepts[siteB]) {
    const setA = new Set(citedConcepts[siteA].concepts);
    const setB = new Set(citedConcepts[siteB].concepts);
    const intersection = [...setA].filter(x => setB.has(x));
    evidence.V2_concepts = { shared: intersection.slice(0, 10), sampleA: citedConcepts[siteA].sampleCount, sampleB: citedConcepts[siteB].sampleCount };
    if (intersection.length >= 1) passes++;
    else failures.push(`V2: 0 shared concepts between ${siteA} and ${siteB}`);
  } else {
    failures.push('V2: site concepts not built');
  }

  // V3: academic-entities sites 匹配
  if (siteA && siteB) {
    const aIn = academicBySite.get(siteA) || [];
    const bIn = academicBySite.get(siteB) || [];
    evidence.V3_academic = { aCount: aIn.length, bCount: bIn.length };
    // 两站都有学术实体 → 支持；一方或双方无 → 不 falsify
    if (aIn.length >= 1 && bIn.length >= 1) passes++;
    else failures.push(`V3: academic-entities missing (${siteA}: ${aIn.length}, ${siteB}: ${bIn.length})`);
  }

  // 判定
  let decision = 'cross_inconclusive';
  if (passes >= 2) decision = 'cross_verified';
  else if (passes === 0) decision = 'cross_falsified';
  else decision = 'cross_weak'; // 1 通过

  const confidence = 0.35 + passes * 0.15; // 0.35 / 0.50 / 0.65 / 0.80

  return {
    id: card.id,
    hypothesis_type: t,
    siteA, siteB,
    passes,
    decision,
    confidence: Math.round(confidence * 1000) / 1000,
    confidence_calibration: 'statistical-signal-cross-validated',
    evidence,
    failures,
    verifiedAt: new Date().toISOString(),
    verifier: 'agent-ecosystem/hypothesis-verifier-v3-cross.mjs',
    version: '3.0.0',
  };
}

// ============== 主流程 ==============

function run({ n = 30, seed = 0, onlyVerified = true, ids = [] } = {}) {
  const cards = loadCards();
  const edges = loadEdges();
  const cited = loadCited();
  const academic = loadAcademic();

  // 构建索引
  const edgePairCounts = new Map();
  for (const [s, t, ss, ts] of edges) {
    if (!ss || !ts) continue;
    const k = `${ss}|${ts}`;
    edgePairCounts.set(k, (edgePairCounts.get(k) || 0) + 1);
  }
  const academicBySite = buildAcademicSiteIndex(academic);
  const sites = [...new Set([...academicBySite.keys()])];
  const citedConcepts = buildCitedConcepts(cited, sites);

  console.log(`▸ V1 edges: ${edges.length} raw, ${edgePairCounts.size} site-pairs`);
  console.log(`▸ V2 cited: ${cited.length} entities, ${Object.keys(citedConcepts).length} site-concepts`);
  console.log(`▸ V3 academic: ${academic.length} entities, ${academicBySite.size} sites indexed`);

  // 筛选 targets
  let pool;
  if (ids.length > 0) {
    pool = cards.filter(c => ids.includes(c.id));
  } else if (onlyVerified) {
    pool = cards.filter(c => c.status === 'verified');
  } else {
    pool = cards;
  }

  // 抽样（可复现）
  const targets = pool.length > n
    ? (() => {
        // 简单 shuffle
        const arr = [...pool];
        let h = 0;
        for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        for (let i = arr.length - 1; i > 0; i--) {
          h = (h * 1103515245 + 12345) >>> 0;
          const j = h % (i + 1);
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr.slice(0, n);
      })()
    : [...pool];

  console.log(`▸ 目标: ${targets.length} 张 (pool ${pool.length})`);

  const results = [];
  for (const card of targets) {
    results.push(verifyCross(card, { edgePairCounts, academicBySite, citedConcepts }));
  }

  // 汇总
  const byDecision = {};
  const byPassCount = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const byType = {};
  for (const r of results) {
    byDecision[r.decision] = (byDecision[r.decision] || 0) + 1;
    byPassCount[r.passes] = (byPassCount[r.passes] || 0) + 1;
    byType[r.hypothesis_type] = (byType[r.hypothesis_type] || 0) + 1;
  }

  return {
    runAt: new Date().toISOString(),
    nRequested: n,
    seed,
    onlyVerified,
    targetsProcessed: results.length,
    byDecision,
    byPassCount,
    byType,
    avgConfidence: results.length ? Math.round(results.reduce((s, r) => s + r.confidence, 0) / results.length * 1000) / 1000 : 0,
    dataSources: {
      V1_edges: edges.length,
      V2_cited: cited.length,
      V3_academic: academic.length,
    },
    results,
  };
}

// ============== CLI ==============

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { n: 30, seed: 0, onlyVerified: true, ids: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--n') opts.n = parseInt(argv[++i]);
    else if (a === '--seed') opts.seed = parseInt(argv[++i]);
    else if (a === '--all') opts.onlyVerified = false;
    else if (a === '--ids') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.ids.push(argv[++i]);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs();
  const t0 = performance.now();
  const result = run(opts);
  const ms = performance.now() - t0;

  console.log('\n=== HYPOTHESIS VERIFIER V3 (CROSS-SOURCE) ===');
  console.log('processed:', result.targetsProcessed);
  console.log('byDecision:', JSON.stringify(result.byDecision));
  console.log('byPassCount:', JSON.stringify(result.byPassCount));
  console.log('byType:', JSON.stringify(result.byType));
  console.log('avgConfidence:', result.avgConfidence);
  console.log('ms:', ms.toFixed(0));
  console.log('\nsamples:');
  for (const r of result.results.slice(0, 12)) {
    const v1 = r.evidence.V1_edges;
    const v2 = r.evidence.V2_concepts?.shared?.length;
    const v3 = r.evidence.V3_academic;
    console.log(`  ${r.id} [${r.hypothesis_type}] ${r.siteA}→${r.siteB} -> ${r.decision} (V1=${v1}, V2=${v2}, V3=(${v3?.aCount},${v3?.bCount}))`);
  }

  const outPath = path.join(ROOT, 'data', 'verification-runs', new Date().toISOString().slice(0, 10) + '-v3-cross-run.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('\noutput:', path.relative(ROOT, outPath));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { main(); } catch (e) { console.error('ERR', e.message); console.error(e.stack); process.exit(1); }
}
