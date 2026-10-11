#!/usr/bin/env node
/**
 * 跨源实体解析（ER）试点 —— Jaccard + Levenshtein
 * ============================================================
 * 为什么不用 Splink
 *   报告推荐 Splink（moj-analytical-services/splink），但 Splink 5.0 依赖
 *   duckdb + pyarrow（28.5MB win wheel，实测 12 分钟下载超时）。单人运维
 *   场景下 stdlib + pandas 已足够，且能在 CI 里秒级跑完。
 *
 * 目标
 *   对单站实体做模糊匹配，识别同名/近似论文（跨源重复收录）。
 *   精度用「DOI 匹配率」作 proxy：如果两个 name 相似且至少一个有 DOI 且 DOI 相同，
 *   则视为 TP；只有 name 相似但 DOI 不同视为 FP。
 *
 * 方法
 *   1. 加载站点实体（name + doi）
 *   2. 分块（按 name 首字符）避免 O(N²)
 *   3. Jaccard(name_a, name_b) ≥ 0.7 且 Levenshtein_ratio ≥ 0.8 视为候选
 *   4. 输出 identity clusters
 *
 * 用法
 *   node operations-plan/pipeline-entity-resolution.js --site=biomed-ai
 *   node operations-plan/pipeline-entity-resolution.js --site=biomed-ai --sample=2000
 *   node operations-plan/pipeline-entity-resolution.js --dry-run
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

function arg(name, dflt) {
  const prefix = '--' + name + '=';
  const a = process.argv.find((x) => typeof x === 'string' && x.startsWith(prefix));
  if (!a) return dflt;
  const v = a.slice(prefix.length);
  return v === '' ? dflt : v;
}

const SITE = arg('site', 'biomed-ai');
const SAMPLE = Number(arg('sample', '0')) || 0;
const JACCARD_THR = 0.7;
const LEV_THR = 0.8;

// ---- 文本规范化 ----
function norm(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function tokens(s) {
  return norm(s).split(' ').filter(Boolean);
}
function jaccard(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const x of ta) if (tb.has(x)) inter++;
  return inter / (ta.size + tb.size - inter);
}
// 快速 Levenshtein ratio（编辑距离 / max_len）
function levRatio(a, b) {
  a = norm(a); b = norm(b);
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  const maxLen = Math.max(m, n);
  if (Math.abs(m - n) > maxLen * 0.3) return 0; // 长度差异太大直接拒
  // DP（限制在 200 字符以内避免 O(N²) 爆炸）
  const al = Math.min(m, 200), bl = Math.min(n, 200);
  const aa = a.slice(0, al), bb = b.slice(0, bl);
  const dp = Array.from({ length: al + 1 }, () => new Uint16Array(bl + 1));
  for (let i = 1; i <= al; i++) dp[i][0] = i;
  for (let j = 1; j <= bl; j++) dp[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = aa[i-1] === bb[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + cost);
    }
  }
  return 1 - dp[al][bl] / maxLen;
}

// ---- 加载实体 ----
function loadSiteEntities(site) {
  const f = path.join(ROOT, site, 'website/api/entities.json');
  if (!fs.existsSync(f)) throw new Error(`站点数据不存在：${f}`);
  const wrap = JSON.parse(fs.readFileSync(f, 'utf8'));
  const list = Array.isArray(wrap) ? wrap : (wrap.entities || []);
  // 只保留有 name 且非空的
  return list
    .filter((e) => e && e.name && String(e.name).trim().length > 0)
    .map((e) => ({
      id: e.id != null ? String(e.id) : null,
      name: String(e.name).slice(0, 300),
      doi: e.doi || null,
      nTokens: tokens(e.name).length,
    }));
}

// ---- 分块 + 匹配 ----
function bucketByChar(entities) {
  const buckets = new Map();
  for (const e of entities) {
    const c = (e.name[0] || '?').toLowerCase();
    if (!buckets.has(c)) buckets.set(c, []);
    buckets.get(c).push(e);
  }
  return buckets;
}

function findClusters(entities) {
  const t0 = Date.now();
  const buckets = bucketByChar(entities);
  const parent = new Map();
  const find = (x) => {
    let p = parent.get(x);
    while (p !== undefined && p !== x) { p = parent.get(p); if (parent.get(p) === p) break; }
    return p || x;
  };
  const union = (a, b) => {
    const pa = find(a), pb = find(b);
    if (pa !== pb) parent.set(pa, pb);
  };
  // 初始化
  for (const e of entities) parent.set(e.id, e.id);

  let candidatePairs = 0;
  let matchedPairs = 0;
  let doiConfirmed = 0;
  const samples = [];

  for (const [c, arr] of buckets) {
    // 桶太大就截断（防 O(N²) 爆炸）
    const big = arr.length > 500;
    const sub = big ? arr.slice(0, 500) : arr;
    for (let i = 0; i < sub.length; i++) {
      for (let j = i + 1; j < sub.length; j++) {
        const a = sub[i], b = sub[j];
        // 快速长度过滤
        if (Math.abs(a.nTokens - b.nTokens) > Math.max(a.nTokens, b.nTokens) * 0.4) continue;
        const ja = jaccard(a.name, b.name);
        if (ja < JACCARD_THR) continue;
        const lr = levRatio(a.name, b.name);
        if (lr < LEV_THR) continue;
        candidatePairs++;
        matchedPairs++;
        union(a.id, b.id);
        // DOI 确认
        if (a.doi && b.doi && a.doi.toLowerCase() === b.doi.toLowerCase()) {
          doiConfirmed++;
        }
        if (samples.length < 20) {
          samples.push({ a: a.name.slice(0, 80), b: b.name.slice(0, 80), jaccard: ja.toFixed(3), lev: lr.toFixed(3), aDoi: a.doi, bDoi: b.doi });
        }
      }
    }
  }

  // 归并 cluster
  const clusters = new Map();
  for (const e of entities) {
    const r = find(e.id);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(e);
  }
  const bigClusters = [...clusters.values()].filter((c) => c.length > 1);
  bigClusters.sort((a, b) => b.length - a.length);

  return {
    entities: entities.length,
    buckets: buckets.size,
    candidatePairs,
    matchedPairs,
    doiConfirmed,
    clusterCount: bigClusters.length,
    entitiesInClusters: bigClusters.reduce((s, c) => s + c.length, 0),
    sampleClusters: bigClusters.slice(0, 5).map((c) => ({
      size: c.length,
      names: c.slice(0, 3).map((x) => x.name.slice(0, 80)),
      dois: c.slice(0, 3).map((x) => x.doi),
    })),
    samples,
    elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
  };
}

// ---- 主流程 ----
const t0 = Date.now();
console.log(`[ER] 站点：${SITE}  Jaccard≥${JACCARD_THR}  Levenshtein≥${LEV_THR}`);
let entities = loadSiteEntities(SITE);
console.log(`[ER] 加载 ${entities.length.toLocaleString()} 实体（含 name）`);
if (SAMPLE > 0 && entities.length > SAMPLE) {
  // 均匀抽样
  const step = Math.floor(entities.length / SAMPLE);
  entities = entities.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  console.log(`[ER] 抽样到 ${entities.length.toLocaleString()}`);
}

const result = findClusters(entities);
result.site = SITE;
result.generatedAt = new Date().toISOString();
result.thresholds = { jaccard: JACCARD_THR, lev: LEV_THR };
result.totalElapsedSec = +((Date.now() - t0) / 1000).toFixed(1);

console.log('\n=== 结果 ===');
console.log(`实体：${result.entities.toLocaleString()}`);
console.log(`分桶：${result.buckets}`);
console.log(`候选对：${result.candidatePairs.toLocaleString()}`);
console.log(`匹配对：${result.matchedPairs.toLocaleString()}`);
console.log(`DOI 确认对：${result.doiConfirmed.toLocaleString()}`);
console.log(`Identity clusters：${result.clusterCount.toLocaleString()}`);
console.log(`涉及实体：${result.entitiesInClusters.toLocaleString()}（占 ${(result.entitiesInClusters/result.entities*100).toFixed(2)}%）`);
console.log(`耗时：${result.elapsedSec}s`);

if (result.clusterCount > 0) {
  console.log('\nTop clusters:');
  for (const c of result.sampleClusters.slice(0, 3)) {
    console.log(`  size=${c.size}:`);
    for (const n of c.names) console.log(`    - ${n}`);
  }
}
if (result.samples.length > 0) {
  console.log('\n匹配样本：');
  for (const s of result.samples.slice(0, 5)) {
    console.log(`  J=${s.jaccard} L=${s.lev}  A="${s.a}"  B="${s.b}"`);
  }
}

if (DRY_RUN) {
  console.log('\n[dry-run] 未写文件。');
  process.exit(0);
}

// ---- 落盘 ----
const out = path.join(ROOT, 'reports', `er-pilot-${SITE}-${new Date().toISOString().slice(0,10)}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(result, null, 1));
console.log(`\n写入：${path.relative(ROOT, out)}`);
