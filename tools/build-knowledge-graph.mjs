#!/usr/bin/env node
/**
 * tools/build-knowledge-graph.mjs
 * 重建 GeneTech 实体级知识图谱（data/knowledge-graph.json + data/knowledge-graph-entities.json）。
 *
 * 设计目标：
 *  - 真正聚合全站 30 站 / 30 万实体（此前 pipeline-self-db-build.js 只产出 98 节点 / 0 边，是玩具图谱）。
 *  - 生成"有意义的关系"：跨站桥接 (cross_site) + 主题共现 (shared_tag，连到高屏标签枢纽)。
 *  - 有界可部署：节点上限 20k、边上限 90k、产物 ≤ 8MB（保护 Pages 99% 容量硬约束）。
 *
 * 用法：node tools/build-knowledge-graph.mjs [--dry-run] [--limit-nodes=20000] [--limit-edges=90000]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const REPORTS_DIR = path.join(ROOT, 'reports');

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const LIMIT_NODES = Number(([...argv].find(a => a.startsWith('--limit-nodes=')) || '').split('=')[1]) || 14000;
const LIMIT_EDGES = Number(([...argv].find(a => a.startsWith('--limit-edges=')) || '').split('=')[1]) || 90000;
const MAX_BYTES = 9 * 1024 * 1024;

const isStation = (name) => !name.startsWith('.') && !name.startsWith('_');

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function main() {
  const t0 = Date.now();
  console.log('[kg] 扫描站点实体…');
  const stations = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && isStation(e.name))
    .map(e => e.name);

  // id -> 所属站集合
  const entitySites = new Map();
  // id -> { name, source, url, confidence, tags:Set }
  const meta = new Map();
  const tagCount = new Map();

  let entityTotal = 0;
  for (const st of stations) {
    const p = path.join(ROOT, st, 'website/api/entities.json');
    const arr = readJsonSafe(p);
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      if (!x || !x.id) continue;
      entityTotal++;
      if (!entitySites.has(x.id)) entitySites.set(x.id, new Set());
      entitySites.get(x.id).add(st);
      let m = meta.get(x.id);
      if (!m) { m = { name: x.name || x.title || x.id, source: x.source || '', url: x.url || '', confidence: x.confidence || 0, tags: new Set() }; meta.set(x.id, m); }
      if (x.confidence != null) m.confidence = Math.max(m.confidence, x.confidence || 0);
      if (x.url) m.url = x.url;
      if (Array.isArray(x.tags)) for (const t of x.tags) { if (t) { m.tags.add(t); tagCount.set(t, (tagCount.get(t) || 0) + 1); } }
    }
  }
  console.log(`[kg] 站点 ${stations.length} | 实体记录 ${entityTotal} | 唯一实体 ${meta.size} | 标签种类 ${tagCount.size}`);

  // 跨站实体（桥接信号，最有价值）
  const crossSite = [];
  for (const [id, sites] of entitySites) if (sites.size > 1) crossSite.push(id);
  console.log(`[kg] 跨站实体（桥接）: ${crossSite.length}`);

  // 标签枢纽：出现频次 Top-N
  const TAG_HUBS = 300;
  const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, TAG_HUBS).map(e => e[0]);
  const topTagSet = new Set(topTags);
  console.log(`[kg] 标签枢纽 Top${TAG_HUBS} 已选`);

  // 选定实体节点：全部跨站实体 + 高频标签实体（按置信度补位，直到上限）
  const nodeIds = new Set(crossSite);
  if (nodeIds.size < LIMIT_NODES) {
    const rest = [...meta.keys()]
      .filter(id => !nodeIds.has(id) && (meta.get(id).tags.size >= 3))
      .sort((a, b) => meta.get(b).confidence - meta.get(a).confidence)
      .slice(0, LIMIT_NODES - nodeIds.size);
    rest.forEach(id => nodeIds.add(id));
  }
  console.log(`[kg] 实体节点数: ${nodeIds.size}`);

  const nodes = [];
  const idIndex = new Map(); // 新索引 id -> 数组下标
  let idx = 0;
  // 站枢纽节点
  for (const st of stations) { nodes.push({ id: `station:${st}`, name: st, type: 'station' }); idIndex.set(`station:${st}`, idx++); }
  // 标签枢纽节点
  for (const t of topTags) { nodes.push({ id: `tag:${t}`, name: t, type: 'tag', weight: tagCount.get(t) }); idIndex.set(`tag:${t}`, idx++); }
  // 实体节点
  for (const id of nodeIds) {
    const m = meta.get(id);
    nodes.push({
      id,
      name: m.name,
      type: 'entity',
      source: m.source,
      confidence: +m.confidence.toFixed(3),
      url: m.url,
      sites: [...entitySites.get(id)],
      // 标签关系已由 shared_tag 边表达，节点内仅保留用于枢纽定位的精简标签，控制产物体积（保护 Pages 容量）
      tags: [...m.tags].filter(t => topTagSet.has(t)).slice(0, 4),
    });
    idIndex.set(id, idx++);
  }
  console.log(`[kg] 总节点: ${nodes.length} (站 ${stations.length} + 标签 ${topTags.length} + 实体 ${nodeIds.size})`);

  // 边：跨站桥接（实体→站枢纽）+ 主题共现（实体→标签枢纽）
  const edges = [];
  const seen = new Set();
  const pushEdge = (s, t, relation, weight) => {
    if (edges.length >= LIMIT_EDGES) return false;
    const sk = `${s}|${t}`;
    if (seen.has(sk)) return true;
    seen.add(sk);
    edges.push({ source: s, target: t, relation, weight: weight || 1 });
    return true;
  };
  for (const id of nodeIds) {
    const sites = entitySites.get(id);
    for (const st of sites) pushEdge(id, `station:${st}`, 'cross_site');
    const m = meta.get(id);
    let w = 0;
    for (const t of m.tags) if (topTagSet.has(t)) { if (!pushEdge(id, `tag:${t}`, 'shared_tag')) break; w++; }
  }
  console.log(`[kg] 边数: ${edges.length} (cross_site + shared_tag)`);

  const graph = {
    builtAt: new Date().toISOString(),
    version: 2,
    schema: 'genetech-knowledge-graph/v2',
    stats: {
      stations: stations.length,
      uniqueEntities: meta.size,
      crossSiteEntities: crossSite.length,
      tagKinds: tagCount.size,
      nodes: nodes.length,
      edges: edges.length,
    },
    nodes,
    edges,
  };

  const json = JSON.stringify(graph);
  console.log(`[kg] 产物体积: ${(json.length / 1024 / 1024).toFixed(2)} MB`);
  if (json.length > MAX_BYTES) {
    console.error(`[kg][WARN] 产物 ${(json.length/1024/1024).toFixed(2)}MB 超过 ${MAX_BYTES/1024/1024}MB 上限，请下调 LIMIT 后重试（保护 Pages 容量）。`);
  }

  if (!DRY) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'knowledge-graph.json'), json);
    // 部署副本（与旧文件名保持一致，供下游消费）
    fs.writeFileSync(path.join(DATA_DIR, 'knowledge-graph-entities.json'), json);
    const report = { pipeline: 'build-knowledge-graph', timestamp: graph.builtAt, dryRun: false, ...graph.stats, bytes: json.length };
    fs.writeFileSync(path.join(REPORTS_DIR, `report-knowledge-graph-${Date.now()}.json`), JSON.stringify(report, null, 2));
    console.log(`[kg] 已写入 data/knowledge-graph.json + data/knowledge-graph-entities.json`);
  } else {
    console.log('[kg] dry-run，未写入');
  }
  console.log(`[kg] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
