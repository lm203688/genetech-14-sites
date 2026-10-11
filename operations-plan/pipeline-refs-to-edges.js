#!/usr/bin/env node
/**
 * refs JSONL → 跨站引用边（离线算边，不发请求）
 * ============================================================
 * 为什么存在
 *   pipeline-openalex-citation.js 的 finish() 会扫 refs 目录所有 JSONL 算边，
 *   但 finish() 内联在 IIFE 里、只跑完抓取才执行。当抓取被 429/预算耗尽/网络
 *   中断打断时，refs 目录里已经累积了几万行引用列表，却永远不会算成边——
 *   这是「跑了几天跨站边永远是 0」的直接成因之一。
 *
 *   本脚本独立承担「只算边、不抓取」的职责：
 *     - 扫 refs 目录所有 .jsonl
 *     - 读语料确定站点归属
 *     - 输出 data/citation-edges.json（含 mergedFromOldEdges 兼容字段）
 *
 * 用法
 *   node operations-plan/pipeline-refs-to-edges.js              # 生产写入
 *   node operations-plan/pipeline-refs-to-edges.js --dry-run    # 只统计
 *   node operations-plan/pipeline-refs-to-edges.js --max=12     # 每实体出边上限
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_DIR = path.join(ROOT, 'state');
const REFS_DIR = path.join(STATE_DIR, 'openalex-refs');
const OUT = path.join(DATA_DIR, 'citation-edges.json');

const MAX_OUT_EDGES = (() => {
  const a = process.argv.find((x) => typeof x === 'string' && x.startsWith('--max='));
  return a ? Number(a.slice(6)) || 12 : 12;
})();
const DRY_RUN = process.argv.includes('--dry-run');

function normDoi(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  s = s.replace(/^doi:/i, '');
  return s || null;
}

// ---- 语料装载（站点归属）----
function loadSiteOf() {
  const siteOf = new Map();
  const sites = [];
  let total = 0;
  for (const d of fs.readdirSync(ROOT)) {
    let st;
    try { st = fs.statSync(path.join(ROOT, d)); } catch { continue; }
    if (!st.isDirectory()) continue;
    const f = path.join(ROOT, d, 'website/api/entities.json');
    if (!fs.existsSync(f)) continue;
    sites.push(d);
    let list;
    try {
      const wrap = JSON.parse(fs.readFileSync(f, 'utf8'));
      list = Array.isArray(wrap) ? wrap : (wrap.entities || []);
    } catch { continue; }
    for (const e of list) {
      total++;
      const doi = normDoi(e.doi);
      if (!doi) continue;
      const key = doi.toLowerCase();
      if (!siteOf.has(key)) siteOf.set(key, d);
    }
  }
  return { siteOf, sites, total };
}

// ---- 主流程（用 async IIFE 包住，允许 return）----
(async () => {
const t0 = Date.now();
const { siteOf, sites, total } = loadSiteOf();
console.log(`语料：${sites.length} 站 / ${total.toLocaleString()} 实体 / ${siteOf.size.toLocaleString()} DOI`);

if (!fs.existsSync(REFS_DIR)) {
  console.error(`[FATAL] refs 目录不存在：${REFS_DIR}`);
  process.exit(1);
}
const refsFiles = fs.readdirSync(REFS_DIR).filter((x) => x.endsWith('.jsonl')).sort().map((x) => path.join(REFS_DIR, x));
console.log(`refs 文件：${refsFiles.length} 个`);

const edges = [];
const crossSet = new Set();
const perEntity = new Map();
const badLines = [];
let lineNo = 0;
let oaHit = 0;
let doiHit = 0;
let outsideHit = 0;
let sameSiteHit = 0;

for (const rf of refsFiles) {
  const sz = fs.statSync(rf).size;
  console.log(`  扫 ${path.basename(rf)} (${(sz/1048576).toFixed(2)} MB)`);
  const rl = readline.createInterface({ input: fs.createReadStream(rf, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    lineNo++;
    let parsed;
    try { parsed = JSON.parse(line); } catch { if (badLines.length < 5) badLines.push({ file: path.basename(rf), line: lineNo, len: line.length }); continue; }
    if (!parsed) continue;
    const [doiKey, oaId, refs, refCount] = parsed;
    if (!doiKey) continue;
    const key = doiKey.toLowerCase();
    const srcSite = siteOf.get(key);
    if (!srcSite) continue;  // 源不在语料里，无法判断跨站

    let rec = perEntity.get(key);
    if (!rec) { rec = { citedBy: 0, refCount: 0, outEdges: 0, inEdges: 0, refSameSite: 0, refCrossSite: 0, refOutside: 0 }; perEntity.set(key, rec); }
    rec.refCount = refCount || (refs && refs.length) || 0;

    for (const refOa of (refs || [])) {
      // refs 里的目标可能是 OpenAlex id（https://openalex.org/W...）或裸 DOI
      let targetKey = null;
      const s = String(refOa);
      if (s.startsWith('https://openalex.org/W')) {
        // OpenAlex id — 需要 oa→doi 映射，但我们的 JSONL 里没有这个映射表
        // 只能放弃这条（refOutside++）
        rec.refOutside++; outsideHit++;
        continue;
      }
      // 裸 DOI
      targetKey = s.toLowerCase();
      if (!siteOf.has(targetKey)) { rec.refOutside++; outsideHit++; continue; }
      const tgtSite = siteOf.get(targetKey);
      if (tgtSite === srcSite) { rec.refSameSite++; sameSiteHit++; continue; }
      rec.refCrossSite++;
      doiHit++;
      if (rec.outEdges < MAX_OUT_EDGES) {
        const eid = `${key}=>${targetKey}`;
        if (!crossSet.has(eid)) {
          crossSet.add(eid);
          edges.push({ s: key, t: targetKey, ss: srcSite, ts: tgtSite });
        }
        rec.outEdges++;
      }
    }
  }
}

// 入度
for (const e of edges) {
  const tgt = perEntity.get(e.t);
  if (tgt) tgt.inEdges++;
}

// 涉及站点
const tsSites = new Set();
for (const e of edges) { tsSites.add(e.ss); tsSites.add(e.ts); }
const tsCnt = {};
for (const e of edges) tsCnt[e.ts] = (tsCnt[e.ts] || 0) + 1;

console.log('\n=== 结果 ===');
console.log(`扫过 JSONL 行：${lineNo.toLocaleString()}`);
console.log(`源实体命中：${perEntity.size.toLocaleString()}`);
console.log(`跨站引用边：${edges.length.toLocaleString()}`);
console.log(`涉及站点：${tsSites.size}/${sites.length}`);
console.log(`引用命中：DOI 直连 ${doiHit.toLocaleString()} / OpenAlex id ${oaHit.toLocaleString()} / 库外 ${outsideHit.toLocaleString()} / 同站 ${sameSiteHit.toLocaleString()}`);
console.log(`耗时：${((Date.now()-t0)/1000).toFixed(1)}s`);
if (edges.length > 0) {
  console.log('\n跨站边 Top（按目标站点）：');
  Object.entries(tsCnt).sort((a,b)=>b[1]-a[1]).slice(0,10).forEach(([k,v]) => console.log(`  → ${k.padEnd(24)} ${v.toLocaleString()}`));
}
if (badLines.length) {
  console.error(`\n[FATAL] JSONL 有 ${badLines.length} 条坏行：`);
  for (const b of badLines.slice(0,5)) console.error(`  ${b.file} line ${b.line} len=${b.len}`);
  if (!DRY_RUN) process.exit(4);
}

if (DRY_RUN) {
  console.log('\n[dry-run] 未写文件。');
  return;
}

// ---- 落盘 ----
// 合并逻辑：把已有的 citation-edges.json 的 edges 也合进来（去重），
// 新边和旧边共同构成 totalEdges。之前只保留 mergedFromOldEdges 计数不合并，
// 会让下游 pipeline-citation-gaps.js 读到 edges 数组时只用新边，导致引用边数
// 从 27,340 回落到 25,682 —— 是回归不是提升。
let oldEdges = [];
let mergedFromOldEdges = 0;
let oldStats = null;
if (fs.existsSync(OUT)) {
  try {
    const old = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    mergedFromOldEdges = (old.stats && old.stats.mergedFromOldEdges) || (old.edges || []).length;
    oldStats = old.stats;
    oldEdges = Array.isArray(old.edges) ? old.edges : [];
    console.log(`\n[merge] 已有 citation-edges.json，旧边 ${oldEdges.length.toLocaleString()} 条合入 edges 数组`);
  } catch (e) {
    console.error(`[warn] 无法读旧 citation-edges.json：${e.message}`);
  }
}

// 合并去重（按 [s, t, ss, ts] 元组哈希）
const mergedSet = new Set();
const mergedEdges = [];
for (const e of [...oldEdges, ...edges]) {
  if (!Array.isArray(e) || e.length < 4) continue;
  const k = `${e[0]}=>${e[1]}`;
  if (mergedSet.has(k)) continue;
  mergedSet.add(k);
  mergedEdges.push([e[0], e[1], e[2], e[3]]);
}
console.log(`[merge] 合并去重：旧 ${oldEdges.length.toLocaleString()} + 新 ${edges.length.toLocaleString()} → ${mergedEdges.length.toLocaleString()}（去重 ${oldEdges.length + edges.length - mergedEdges.length} 条）`);

const edgeDataset = {
  generatedAt: new Date().toISOString(),
  scope: { source: 'refs-jsonl-offline+legacy-merged', sites: sites.length, uniqueDois: siteOf.size, jsonlLines: lineNo, jsonlFiles: refsFiles.length },
  stats: {
    resolvedEdges: mergedEdges.length,
    newEdges: edges.length,
    mergedFromOldEdges: oldEdges.length,
    totalEdges: mergedEdges.length,
    sites: tsSites.size,
    entityCount: perEntity.size,
    jsonlLines: lineNo,
    doiHits: doiHit,
    oaHits: oaHit,
    outsideHits: outsideHit,
    sameSiteHits: sameSiteHit,
    maxOutEdges: MAX_OUT_EDGES,
    // 兼容字段（下游 pipeline-citation-gaps.js 读这些）
    sourceRecords: perEntity.size,
    edgeCount: mergedEdges.length,
  },
  edgeFormat: '[s, t, ss, ts]',
  edges: mergedEdges,
  legacyStats: oldStats || null,
};

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(edgeDataset));
console.log(`\n写入：${path.relative(ROOT, OUT)}（${edges.length.toLocaleString()} 新边 + ${mergedFromOldEdges.toLocaleString()} 旧边，${(fs.statSync(OUT).size/1048576).toFixed(2)} MB）`);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
