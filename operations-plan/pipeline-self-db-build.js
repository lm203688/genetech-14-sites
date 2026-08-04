#!/usr/bin/env node
/**
 * 能力域⑤-自建库扩展：pipeline-self-db-build.js
 * 将 14 站已部署实体聚合为统一知识图谱（自建库），附带标准标识符与置信度，
 * 输出 data/knowledge-graph.json（供 MCP / 前端跨站检索 / 专业库对接消费）。
 * 用法：node pipeline-self-db-build.js [--dry-run]
 */
const fs = require('fs').promises;
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');

async function readJsonSafe(p) { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } }

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const graph = { builtAt: new Date().toISOString(), nodes: [], edges: [], stats: {} };
  const byId = new Map();

  const entries = await fs.readdir(PROJECT_ROOT, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const livePath = path.join(PROJECT_ROOT, e.name, 'website', 'api', 'entities.json');
    const data = await readJsonSafe(livePath);
    if (!Array.isArray(data)) continue;
    for (const x of data) {
      const node = byId.get(x.id) || { id: x.id, name: x.name, sources: new Set(), sites: new Set(), tags: new Set(), confidence: x.confidence || 0, url: x.url || '' };
      node.sources.add(x.source);
      node.sites.add(e.name);
      (x.tags || []).forEach((t) => node.tags.add(t));
      node.confidence = Math.max(node.confidence, x.confidence || 0);
      if (x.url) node.url = x.url;
      byId.set(x.id, node);
    }
  }

  graph.nodes = Array.from(byId.values()).map((n) => ({
    id: n.id, name: n.name, sources: [...n.sources], sites: [...n.sites],
    tags: [...n.tags], confidence: +n.confidence.toFixed(3), url: n.url,
  }));

  // 简易共现边：同标签实体关联
  const tagIndex = {};
  for (const n of graph.nodes) for (const t of n.tags) (tagIndex[t] = tagIndex[t] || []).push(n.id);
  const seen = new Set();
  for (const t of Object.keys(tagIndex)) {
    const ids = tagIndex[t];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = [ids[i], ids[j]].sort().join('|');
      if (seen.has(k)) continue; seen.add(k);
      graph.edges.push({ source: ids[i], target: ids[j], relation: 'shared_tag', tag: t });
      if (graph.edges.length > 5000) break; // 限幅
    }
    if (graph.edges.length > 5000) break;
  }

  graph.stats = { nodes: graph.nodes.length, edges: graph.edges.length, sites: new Set(graph.nodes.flatMap((n) => n.sites)).size };
  const report = { pipeline: 'self-db-build', timestamp: graph.builtAt, dryRun, ...graph.stats };

  if (!dryRun) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(path.join(DATA_DIR, 'knowledge-graph.json'), JSON.stringify(graph, null, 2), 'utf-8');
    await fs.writeFile(path.join(REPORTS_DIR, `report-self-db-build-${Date.now()}.json`), JSON.stringify(report, null, 2), 'utf-8');
  }
  console.log(`[self-db-build] 节点=${graph.stats.nodes} 边=${graph.stats.edges} 站点=${graph.stats.sites}` + (dryRun ? ' (dry-run)' : ''));
}
main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
