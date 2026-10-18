#!/usr/bin/env node
/**
 * tools/benchmark-known-discoveries.mjs
 *
 * 已知发现复现基准（无需人类专家）：取 data/known-discoveries.json 中
 * 历史上已证实的跨域发现，检验本项目的桥接检测方法在 T0 切分点是否会
 * 把 (A,B,topic) 判为"共享主题但低引用"候选，且随后（T0 后）真涌现。
 *
 * 这是 ML/IR 标准的"已知金标准复现"评估，完全自动化、可复现。
 * 输出：方法在该金标准上的 recall / 命中示例 / 漏检示例。
 *
 * 用法：
 *   node tools/benchmark-known-discoveries.mjs --t0=2023-01-01
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const T0 = process.argv.find(a => a.startsWith('--t0='))?.slice(5) || '2023-01-01';
const T0Y = parseInt(T0.slice(0, 4), 10);

const sites = fs.readdirSync(ROOT).filter(d =>
  fs.existsSync(path.join(ROOT, d, 'website/api/entities.json')));
const siteTags = new Map();
const idYear = new Map();
for (const s of sites) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, s, 'website/api/entities.json'), 'utf8'));
  const arr = Array.isArray(raw) ? raw : (raw.entities || []);
  const tags = new Set();
  for (const e of arr) {
    if (e.id) { const y = parseInt(String(e.publishedDate || '').slice(0, 4), 10); if (!isNaN(y)) { idYear.set(e.id, y); if (e.doi) idYear.set(e.doi, y); } }
    for (const t of (e.tags || [])) tags.add(t);
  }
  siteTags.set(s, tags);
}

const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/citation-edges.json'), 'utf8'));
const edges = c.edges || [];
const hist = new Map(); const post = new Map();
const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
for (const e of edges) {
  const y = idYear.get(e.citing);
  if (y === undefined) continue;
  const k = e.fromSite + '|' + e.toSite;
  if (y < T0Y) inc(hist, k); else inc(post, k);
}

const known = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/known-discoveries.json'), 'utf8')).discoveries;
let hit = 0; const rows = [];
for (const d of known) {
  const A = sites.find(s => s === d.A), B = sites.find(s => s === d.B);
  if (!A || !B) { rows.push({ ...d, status: 'DOMAIN_NOT_IN_30', predicted: null, realized: null }); continue; }
  const shared = [...siteTags.get(A)].filter(t => siteTags.get(B).has(t));
  const topicShared = shared.includes(d.topic) || shared.some(t => t.toLowerCase().includes(d.topic.toLowerCase().split(' ')[0]));
  const h = hist.get(A + '|' + B) || 0;
  const p = post.get(A + '|' + B) || 0;
  // 方法预测：共享主题 且 历史零引用
  const predicted = topicShared && h === 0;
  const realized = p > 0;
  if (predicted && realized) hit++;
  rows.push({ A: d.A, B: d.B, topic: d.topic, topicShared, histCitations: h, postCitations: p, predicted, realized, status: predicted && realized ? 'HIT' : (predicted ? 'PRED_NOT_REALIZED' : (realized ? 'REALIZED_NOT_PREDICTED' : 'NEITHER')) });
}

const evaluable = rows.filter(r => r.status !== 'DOMAIN_NOT_IN_30');
const recall = evaluable.length ? hit / evaluable.length : 0;
const report = {
  generatedAt: new Date().toISOString(), T0, T0Y,
  total: known.length, evaluable: evaluable.length,
  hits: hit, recall,
  details: rows,
};
fs.mkdirSync('reports', { recursive: true });
const out = `reports/known-discovery-benchmark-${T0}.json`;
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`[bench] 金标准 ${known.length} 条 | 可评 ${evaluable.length} | 命中 ${hit} | recall ${(recall * 100).toFixed(1)}%`);
console.log(`[bench] → ${out}`);
