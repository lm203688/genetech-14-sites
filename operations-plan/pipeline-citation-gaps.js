#!/usr/bin/env node
/**
 * operations-plan/pipeline-citation-gaps.js
 * 从 data/citation-edges.json 派生「跨域引用缺口矩阵」→ data/citation-gaps.json
 * ==========================================================================
 * 为什么必须存在（2026-10-03）
 *   `data/citation-edges.json`（25,635 条跨站引用边）已经有了，但它只是**原始边列表**，
 *   消费方要回答科研问题时得自己遍历 25k 条边做矩阵聚合 —— 而「哪些站之间一条引用都没有」
 *   恰恰是最有科研价值的信号（= 未被桥接的跨域 = 研究空白候选），却没有任何出口。
 *
 *   本脚本把边聚合成三张可消费的结构：
 *     1. pairMatrix   —— 有向站对矩阵（A→B 的引用数），870 个站对全覆盖
 *     2. gapPairs     —— 零引用站对清单（16.1% = 140 对），按「两站规模之和」降序
 *                         （规模大的两站之间没引用，比小站之间没引用更值得关注）
 *     3. bridges      —— 桥接强度排名（Top N），跨域枢纽识别
 *     另有 inDegree/outDegree 便于识别「只被引不引用」与「只引用不被引」的异常站
 *
 * 硬约束
 *   - **只读输入，不改 citation-edges.json**：那份是引用 pipeline 的唯一写入者产物，
 *     本脚本是纯函数式的下游派生（多写入者文件 + 护栏 = 上次踩过的自锁坑）。
 *   - **不写空矩阵**：edges 缺失或 0 边时 exit 3（fail-loud），
 *     静默产出一个全零矩阵 = 「所有站对都没引用」这种胡说八道会被下游当真。
 *   - 矩阵稀疏但**完整**：站点列表从 manifest/边数据两处取并集，
 *     避免某站没边就从矩阵里消失（消失会被读成「该站不存在」而不是「该站没引用」）。
 *
 * 用法
 *   node operations-plan/pipeline-citation-gaps.js            # 写 data/citation-gaps.json
 *   node operations-plan/pipeline-citation-gaps.js --dry-run  # 只打印统计
 *   node operations-plan/pipeline-citation-gaps.js --top=50   # bridges 取 50 条（默认 30）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const EDGES_FILE = path.join(DATA_DIR, 'citation-edges.json');
const OUT_FILE = path.join(DATA_DIR, 'citation-gaps.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
function argNum(prefix, fallback) {
  const hit = argv.find((a) => a.startsWith(prefix));
  if (!hit) return fallback;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) ? n : fallback;
}
const TOP_BRIDGES = argNum('--top=', 30);

function die(msg, code) {
  process.stderr.write(`[citation-gaps][FATAL] ${msg}\n`);
  process.exit(code === undefined ? 3 : code);
}

// ---- 读输入 ----
if (!fs.existsSync(EDGES_FILE)) {
  die(`缺输入 ${path.relative(ROOT, EDGES_FILE)}：先跑 pipeline-openalex-citation.js（--source=crossref）`);
}
let edgesDoc;
try {
  edgesDoc = JSON.parse(fs.readFileSync(EDGES_FILE, 'utf8'));
} catch (e) {
  die(`解析 ${path.relative(ROOT, EDGES_FILE)} 失败：${e.message}`);
}
const edges = edgesDoc && Array.isArray(edgesDoc.edges) ? edgesDoc.edges : null;
if (!edges) die(`${path.relative(ROOT, EDGES_FILE)} 里没有 edges 数组（键：${Object.keys(edgesDoc || {}).join(',')}）`);
if (edges.length === 0) die(`边数为 0。产出一个全零矩阵等于告诉下游「所有站对都没引用」——这是胡说八道，拒绝写入`);

// ---- 校验边格式（[citingDoi, citedDoi, srcSite, tgtSite]）----
let badRows = 0;
const m = new Map();          // "src|tgt" -> count
const outDeg = new Map();     // src -> count
const inDeg = new Map();      // tgt -> count
const siteSet = new Set();
for (const row of edges) {
  if (!Array.isArray(row) || row.length < 4) { badRows++; continue; }
  const src = row[2], tgt = row[3];
  if (typeof src !== 'string' || typeof tgt !== 'string' || !src || !tgt) { badRows++; continue; }
  if (src === tgt) { badRows++; continue; }   // 自引不是跨域边
  siteSet.add(src); siteSet.add(tgt);
  const k = src + '|' + tgt;
  m.set(k, (m.get(k) || 0) + 1);
  outDeg.set(src, (outDeg.get(src) || 0) + 1);
  inDeg.set(tgt, (inDeg.get(tgt) || 0) + 1);
}
if (badRows > 0) {
  process.stderr.write(`[citation-gaps][WARN] 跳过 ${badRows} 条格式不合法的边\n`);
}
if (siteSet.size < 2) die(`只解析出 ${siteSet.size} 个站点，无法构成矩阵`);

const sites = [...siteSet].sort();

// ---- 站点规模（用于给缺口排序：两站越大却没引用，越值得关注）----
// 规模从 _site 或各站 entities.json 读；读不到就退化为 1（排序退化但不影响正确性）
const siteSize = new Map();
for (const s of sites) {
  const p = path.join(ROOT, s, 'website', 'api', 'entities.json');
  let n = 1;
  try {
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const arr = Array.isArray(j) ? j : (j && j.entities);
      if (Array.isArray(arr)) n = arr.length;
    }
  } catch { /* 读不到就用 1 */ }
  siteSize.set(s, n);
}

// ---- 聚合三张表 ----
const pairMatrix = [];
const gapPairs = [];
for (const a of sites) {
  for (const b of sites) {
    if (a === b) continue;
    const c = m.get(a + '|' + b) || 0;
    pairMatrix.push([a, b, c]);
    if (c === 0) {
      const weight = (siteSize.get(a) || 1) + (siteSize.get(b) || 1);
      gapPairs.push({ from: a, to: b, combinedSize: weight });
    }
  }
}
// 缺口排序：合并规模降序 → 字母序（保证可复现，不依赖对象键序）
gapPairs.sort((x, y) => (y.combinedSize - x.combinedSize) || x.from.localeCompare(y.from) || x.to.localeCompare(y.to));

const bridges = pairMatrix.filter((p) => p[2] > 0)
  .sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  .slice(0, TOP_BRIDGES)
  .map((p) => ({ from: p[0], to: p[1], edges: p[2] }));

const degrees = sites.map((s) => ({
  site: s,
  inDegree: inDeg.get(s) || 0,
  outDegree: outDeg.get(s) || 0,
  totalEntities: siteSize.get(s) || 0,
}));
degrees.sort((a, b) => (b.inDegree + b.outDegree) - (a.inDegree + a.outDegree) || a.site.localeCompare(b.site));

const gapCount = gapPairs.length;
const pairTotal = pairMatrix.length;
const builtAt = new Date().toISOString();

const out = {
  version: 1,
  builtAt,
  derivedFrom: {
    file: 'data/citation-edges.json',
    generatedAt: edgesDoc.generatedAt || null,
    source: (edgesDoc.scope && edgesDoc.scope.source) || null,
    edgeCount: edges.length,
  },
  stats: {
    sites: sites.length,
    directedPairs: pairTotal,
    pairsWithEdges: pairTotal - gapCount,
    gapPairs: gapCount,
    gapRatio: Number((gapCount / pairTotal).toFixed(4)),
    badRowsSkipped: badRows,
  },
  // 语义说明：给消费方（含 LLM）看，避免把 gapPairs 误解成「数据缺失」
  interpretation: {
    gapPairs: '零跨域引用的有向站对。可能是真实的研究空白（两域尚未打通），也可能是本项目语料在该两域的覆盖不足——需结合 totalEntities 一起读。',
    bridges: '跨域引用最强的站对，可作为跨学科桥接的种子。',
    degrees: 'inDegree 高 = 被别的域大量引用（该域是知识输出方）；outDegree 高 = 大量引用别域（吸收方）。两者严重失衡值得复核。',
  },
  sites,
  degrees,
  pairMatrix,
  gapPairs,
  bridges,
};

console.log(`[citation-gaps] ${sites.length} 站 / ${pairTotal} 有向站对`);
console.log(`[citation-gaps] 有边站对 ${pairTotal - gapCount}，零引用站对 ${gapCount}（${(gapCount / pairTotal * 100).toFixed(1)}%）`);
console.log(`[citation-gaps] Top5 桥接：${bridges.slice(0, 5).map((b) => `${b.from}→${b.to}(${b.edges})`).join(', ')}`);
console.log(`[citation-gaps] 最大缺口（按两站规模之和）：${gapPairs.slice(0, 5).map((g) => `${g.from}↔${g.to}(${g.combinedSize})`).join(', ')}`);
if (badRows) console.warn(`[citation-gaps][WARN] 跳过 ${badRows} 条坏行`);

if (DRY) {
  console.log('[citation-gaps] --dry-run：未写盘');
  process.exit(0);
}

const body = JSON.stringify(out);
fs.writeFileSync(OUT_FILE, body);
console.log(`[citation-gaps] 已写 ${path.relative(ROOT, OUT_FILE)}（${(Buffer.byteLength(body) / 1024).toFixed(1)} KB）`);
