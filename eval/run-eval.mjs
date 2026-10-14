#!/usr/bin/env node
/**
 * eval/run-eval.mjs
 *
 * 报告 §8 T1-4「可复现评测 + 公开 leaderboard」的度量引擎。
 *
 * 输入：
 *   - eval/queries.jsonl         （queries.manifest.json 记录 seed 与来源）
 *   - 各站点 website/api/entities.json  （构造检索索引）
 *
 * 度量：
 *   Recall@K  = |relevant ∩ topK| / |relevant|
 *   MRR       = 1 / rank(first relevant hit)  （0 if never hit）
 *   NDCG@K    = DCG@K / IDCG@K                （0/1 gain：relevant 得 1，其余 0）
 *
 * 输出：
 *   eval/results-<date>.json     （逐 query 结果 + 聚合）
 *   eval/leaderboard-<date>.html （人类可读）
 *
 * 用法：
 *   node eval/run-eval.mjs                     # 跑全量 30 站（2026-10-14 起默认）
 *   node eval/run-eval.mjs --sites=sample-3    # 只跑前 3 站（快速，用于本地开发）
 *   node eval/run-eval.mjs --sites=all         # 显式全量
 *   node eval/run-eval.mjs --sites=quantum-computing,ai4science
 *   node eval/run-eval.mjs --k=10              # 默认 Recall@10/MRR/NDCG@10
 *
 * 说明：
 *   - 单进程内存索引：每站独立，避免"跨站串味"，也贴近真实场景（MCP 检索多带 site 过滤）
 *   - 若实体量过大触发 Node 默认堆限制，用 --max-old-space-size=4096
 *   - 2026-10-14 起默认 sites=all，补齐 §9 "只跑 3/30 站" 的覆盖缺口；
 *     另新增每条 query 的耗时，聚合层报告 P50/P95 延迟。
 */
import fs from 'node:fs';
import path from 'node:path';
import { SearchIndex } from '../mcp-server/src/search.mjs';

const ROOT = process.cwd();
const EVAL_DIR = path.join(ROOT, 'eval');
const NOW = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs() {
  const a = process.argv.slice(2);
  // 2026-10-14：默认从 sample-3 改为 all（30 站），修复 §9 「只跑 3/30 站」覆盖缺口
  const args = { sites: 'all', k: 10 };
  for (const s of a) {
    if (s === '--sites=all') args.sites = 'all';
    else if (s === '--sites=sample-3') args.sites = 'sample-3';
    else if (s.startsWith('--k=')) args.k = parseInt(s.slice(4), 10);
    else if (s.startsWith('--sites=')) args.sites = s.slice(8);
  }
  return args;
}

// ---------------------------------------------------------------------------
// 度量
// ---------------------------------------------------------------------------
function recallAtK(topIds, relevantSet, K) {
  const top = new Set(topIds.slice(0, K));
  let hits = 0;
  for (const id of relevantSet) if (top.has(id)) hits++;
  return hits / Math.max(1, relevantSet.size);
}

function mrr(topIds, relevantSet) {
  for (let i = 0; i < topIds.length; i++) {
    if (relevantSet.has(topIds[i])) return 1 / (i + 1);
  }
  return 0;
}

function ndcgAtK(topIds, relevantSet, K) {
  let dcg = 0;
  for (let i = 0; i < Math.min(K, topIds.length); i++) {
    if (relevantSet.has(topIds[i])) dcg += 1 / Math.log2(i + 2); // i+1 rank, +1 for log base
  }
  const idealCount = Math.min(K, relevantSet.size);
  let idcg = 0;
  for (let i = 0; i < idealCount; i++) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}

// ---------------------------------------------------------------------------
// 站点扫描
// ---------------------------------------------------------------------------
function listSites() {
  const out = [];
  for (const d of fs.readdirSync(ROOT)) {
    if (!fs.statSync(path.join(ROOT, d)).isDirectory()) continue;
    const p = path.join(ROOT, d, 'website/api/entities.json');
    if (fs.existsSync(p)) out.push(d);
  }
  return out.sort();
}

function loadEntities(site) {
  const p = path.join(ROOT, site, 'website/api/entities.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.entities || []);
  for (const e of list) {
    if (!e._site) e._site = site;
  }
  return list;
}

// ---------------------------------------------------------------------------
// 加载 queries
// ---------------------------------------------------------------------------
function loadQueries() {
  const p = path.join(EVAL_DIR, 'queries.jsonl');
  if (!fs.existsSync(p)) {
    console.error('[eval] 未找到 queries.jsonl，请先运行 node eval/generate-queries.mjs');
    process.exit(1);
  }
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  return lines.map((l, i) => {
    try { return { idx: i, ...JSON.parse(l) }; }
    catch { return null; }
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const args = parseArgs();
const allSites = listSites();
const targetSites = args.sites === 'all' ? allSites
  : args.sites === 'sample-3' ? allSites.slice(0, 3)
  : args.sites === 'all' || args.sites.split(',').length > 1
    ? args.sites.split(',').map((s) => s.trim()).filter(Boolean)
    : args.sites.split(',').map((s) => s.trim()).filter(Boolean);
const queries = loadQueries();
const manifest = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'queries.manifest.json'), 'utf8'));

console.log(`[eval] seed=${manifest.seed} | perSite=${manifest.perSite} | totalQueries=${manifest.totalQueries}`);
const scopeLabel = args.sites === 'all' ? '全量' : ('前 ' + targetSites.length + ' 站');
console.log(`[eval] 目标站点: ${targetSites.length}（${scopeLabel}） | K=${args.k}`);

// 按站缓存索引，避免重复构建
const indexBySite = new Map();
function getIdx(site) {
  if (!indexBySite.has(site)) {
    const ents = loadEntities(site);
    indexBySite.set(site, new SearchIndex(ents));
  }
  return indexBySite.get(site);
}

const results = [];
let nRecall, nMrr, nNdcg;
const t0 = Date.now();
// 2026-10-14 P1-4：新增 per-query 耗时采样，聚合时输出 P50/P95 延迟
const latencyMs = [];

for (const q of queries) {
  // 只跑本次目标站点的 query
  if (!targetSites.includes(q.site)) continue;

  const idx = getIdx(q.site);
  const relevantSet = new Set(q.relevantIds || []);
  // 检索时不传 site 过滤（评测的是检索器本身），只按站隔离建索引
  const _ts = Date.now();
  const hits = await idx.hybridSearch(q.query, { limit: Math.max(args.k, 20), site: null });
  const _dur = Date.now() - _ts;
  latencyMs.push(_dur);
  const topIds = hits.map(h => h.entity.id || `${h.entity._site}:${h.entity.name}`);

  results.push({
    idx: q.idx,
    site: q.site,
    type: q.type || null, // 10-13 N3：按构造类型分解，暴露哪类查询是检索器短板
    query: q.query.slice(0, 200),
    latencyMs: _dur,
    relevantCount: relevantSet.size,
    relevantIds: [...relevantSet],
    top10: topIds.slice(0, 10),
    hitInTop10: topIds.slice(0, 10).filter(id => relevantSet.has(id)).length,
    'recall@10': recallAtK(topIds, relevantSet, 10),
    'recall@k': recallAtK(topIds, relevantSet, args.k),
    mrr: mrr(topIds, relevantSet),
    'ndcg@10': ndcgAtK(topIds, relevantSet, 10),
  });
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

// 聚合
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function quantile(xs, q) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

const aggregate = {
  queryCount: results.length,
  'avgRecall@10': mean(results.map(r => r['recall@10'])),
  'avgRecall@k': mean(results.map(r => r['recall@' + args.k])),
  avgMrr: mean(results.map(r => r.mrr)),
  'avgNdcg@10': mean(results.map(r => r['ndcg@10'])),
  'recall@10_p50': quantile(results.map(r => r['recall@10']), 0.5),
  'recall@10_p25': quantile(results.map(r => r['recall@10']), 0.25),
  'recall@10_p10': quantile(results.map(r => r['recall@10']), 0.1),
  missCount: results.filter(r => r['recall@10'] === 0).length,
  perfectCount: results.filter(r => r['recall@10'] === 1).length,
  // 2026-10-14 P1-4：延迟指标（内存内检索，未含 I/O 与网络）
  latencyMs: {
    avg: mean(latencyMs),
    p50: quantile(latencyMs, 0.5),
    p95: quantile(latencyMs, 0.95),
    p99: quantile(latencyMs, 0.99),
    max: latencyMs.length ? Math.max(...latencyMs) : 0,
    samples: latencyMs.length,
  },
  // 10-13 N3：按构造类型分解。v1 循环构造下此项无意义（全部 100%）；
  // v2 非同源构造下，它直接指出检索器在哪类查询上塌方。
  byType: (function () {
    const by = {};
    for (const r of results) {
      const t = r.type || 'unknown';
      if (!by[t]) by[t] = [];
      by[t].push(r);
    }
    const out = {};
    for (const [t, arr] of Object.entries(by)) {
      out[t] = {
        queries: arr.length,
        'avgRecall@10': mean(arr.map(r => r['recall@10'])),
        avgMrr: mean(arr.map(r => r.mrr)),
        'avgNdcg@10': mean(arr.map(r => r['ndcg@10'])),
        missCount: arr.filter(r => r['recall@10'] === 0).length,
      };
    }
    return out;
  })(),
  perSite: (function () {
    const bySite = {};
    for (const r of results) {
      if (!bySite[r.site]) bySite[r.site] = [];
      bySite[r.site].push(r);
    }
    const out = {};
    for (const [site, arr] of Object.entries(bySite)) {
      out[site] = {
        queries: arr.length,
        'avgRecall@10': mean(arr.map(r => r['recall@10'])),
        avgMrr: mean(arr.map(r => r.mrr)),
        'avgNdcg@10': mean(arr.map(r => r['ndcg@10'])),
      };
    }
    return out;
  })(),
};

// 写入 results
const outDir = EVAL_DIR;
const resultsPath = path.join(outDir, `results-${NOW}.json`);
fs.writeFileSync(resultsPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  k: args.k,
  sites: targetSites,
  manifestSeed: manifest.seed,
  manifestPerSite: manifest.perSite,
  aggregate,
  results,
}, null, 2));
console.log(`[eval] 结果写入 ${path.relative(ROOT, resultsPath)}`);

// 汇总人类可读摘要
console.log('\n================ 评测摘要 ================');
console.log(`站点数: ${Object.keys(aggregate.perSite).length} | Query 数: ${aggregate.queryCount}`);
console.log(`avg Recall@10   = ${aggregate['avgRecall@10'].toFixed(4)}`);
console.log(`avg Recall@${args.k}    = ${aggregate[`avgRecall@${args.k}`].toFixed(4)}`);
console.log(`avg MRR         = ${aggregate.avgMrr.toFixed(4)}`);
console.log(`avg NDCG@10     = ${aggregate['avgNdcg@10'].toFixed(4)}`);
console.log(`完美召回(Recall@10=1): ${aggregate.perfectCount}`);
console.log(`完全未召回     : ${aggregate.missCount}`);
console.log(`耗时            : ${elapsed}s`);
console.log(`延迟 P50/P95   : ${aggregate.latencyMs.p50}ms / ${aggregate.latencyMs.p95}ms（内存内检索）`);

// 生成 leaderboard HTML
const lbPath = path.join(outDir, `leaderboard-${NOW}.html`);
const html = buildLeaderboardHtml(aggregate, targetSites, manifest, results);
fs.writeFileSync(lbPath, html);
console.log(`[eval] leaderboard 写入 ${path.relative(ROOT, lbPath)}`);

// ---------------------------------------------------------------------------
function buildLeaderboardHtml(agg, sites, man, results) {
  const perSiteRows = Object.entries(agg.perSite)
    .map(([s, m]) => `<tr><td>${s}</td><td>${m.queries}</td><td>${(m['avgRecall@10']*100).toFixed(1)}%</td><td>${(m.avgMrr*100).toFixed(1)}%</td><td>${(m['avgNdcg@10']*100).toFixed(1)}%</td></tr>`)
    .join('');
  const typeRows = Object.entries(agg.byType || {})
    .map(([t, m]) => `<tr><td><code>${t}</code></td><td>${m.queries}</td><td>${(m['avgRecall@10']*100).toFixed(1)}%</td><td>${(m.avgMrr*100).toFixed(1)}%</td><td>${(m['avgNdcg@10']*100).toFixed(1)}%</td><td class="${m.missCount ? 'miss' : ''}">${m.missCount}</td></tr>`)
    .join('');
  const totalRecall = (agg['avgRecall@10']*100).toFixed(1);
  const totalMrr = (agg.avgMrr*100).toFixed(1);
  const totalNdcg = (agg['avgNdcg@10']*100).toFixed(1);
  const genVersion = man.version || 1;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>GeneTech Eval Leaderboard ${NOW}</title>
<style>
body{font-family:-apple-system,"Segoe UI",sans-serif;max-width:1000px;margin:2em auto;padding:0 1em;color:#222;line-height:1.5}
h1{border-bottom:2px solid #333;padding-bottom:.3em}
h2{margin-top:1.5em;color:#0a6}
table{border-collapse:collapse;width:100%;margin:.5em 0}
th,td{border:1px solid #ccc;padding:6px 10px;text-align:left}
th{background:#f4f4f4}
.metric{text-align:right;font-variant-numeric:tabular-nums}
.card{border:1px solid #ddd;border-radius:6px;padding:1em;margin:1em 0;background:#fafafa}
.pill{display:inline-block;background:#e5f5e5;border:1px solid #b7e0b7;border-radius:12px;padding:2px 8px;margin-right:6px;font-size:.85em}
.miss{color:#b00;font-weight:600}
.perfect{color:#066;font-weight:600}
footer{margin-top:2em;color:#888;font-size:.85em}
</style>
</head>
<body>
<h1>GeneTech 检索评测 Leaderboard · ${NOW}</h1>
<p>评测基座：BM25（k1=1.5,b=0.75）+ 字段加权 + RRF(K=60)；查询来自 <code>eval/queries.jsonl</code>（seed=${man.seed}，perSite=${man.perSite}，共 ${man.totalQueries} 条，<b>benchmark 版本 v${genVersion}</b>）。</p>

<div class="card">
<h2>本次运行</h2>
<table>
<tr><th>范围</th><td>${sites.length} 站 · ${agg.queryCount} query</td></tr>
<tr><th>方法</th><td>hybridSearch（BM25+字段加权+RRF，向量未启用）</td></tr>
<tr><th>K</th><td>${args.k}</td></tr>
</table>
</div>

<div class="card">
<h2>总体指标</h2>
<table>
<tr><th>指标</th><th class="metric">值</th></tr>
<tr><td>avg Recall@10</td><td class="metric">${totalRecall}%</td></tr>
<tr><td>avg MRR</td><td class="metric">${totalMrr}%</td></tr>
<tr><td>avg NDCG@10</td><td class="metric">${totalNdcg}%</td></tr>
<tr><td>Recall@10 P50</td><td class="metric">${(agg['recall@10_p50']*100).toFixed(1)}%</td></tr>
<tr><td>Recall@10 P10</td><td class="metric">${(agg['recall@10_p10']*100).toFixed(1)}%</td></tr>
<tr><td>完美召回 Query 数</td><td class="metric">${agg.perfectCount} / ${agg.queryCount}</td></tr>
<tr><td>未召回 Query 数</td><td class="metric miss">${agg.missCount} / ${agg.queryCount}</td></tr>
${agg.latencyMs ? `
<tr><td>延迟 P50 / P95 / P99（内存）</td><td class="metric">${agg.latencyMs.p50}ms / ${agg.latencyMs.p95}ms / ${agg.latencyMs.p99}ms</td></tr>
<tr><td>延迟 Max / Avg</td><td class="metric">${agg.latencyMs.max}ms / ${agg.latencyMs.avg.toFixed(1)}ms</td></tr>` : ''}
</table>
</div>

<h2>按查询构造类型分解</h2>
<table>
<tr><th>类型</th><th class="metric">Query</th><th class="metric">Recall@10</th><th class="metric">MRR</th><th class="metric">NDCG@10</th><th class="metric">miss</th></tr>
${typeRows}
</table>
<p><small>类型说明：<code>tags-inverse</code>=仅用 tags 反查实体；<code>abstract-mid</code>=摘要中段短语；<code>cross-entity</code>=跨实体 tag 混合；<code>site-topic</code>=单 tag 主题浏览。Recall 低说明检索器在该类查询上依赖字面重合。</small></p>

<h2>分站点</h2>
<table>
<tr><th>站点</th><th class="metric">Query</th><th class="metric">Recall@10</th><th class="metric">MRR</th><th class="metric">NDCG@10</th></tr>
${perSiteRows}
</table>

<div class="card">
<h2>方法论与局限</h2>
<ul>
${genVersion >= 2
  ? '<li><b>benchmark v2（2026-10-13）</b>：查询与答案<b>不同源</b>——tags 反查 / 摘要中段 / 跨实体交叉 / 站点主题四类构造；v1 的"100% Recall"是 query 抄答案的恒等式，无信息量，已废弃。</li>'
  : '<li><b>benchmark v1（已废弃）</b>：query 由目标实体自身字段拼成，Recall@10=100% 是构造保证的恒等式，不反映检索质量。</li>'}
<li>multi-relevant 相关集（同 tag/共现实体），Recall/MRR 不再有构造性上限 1；NDCG 有真实区分度。</li>
<li>当前检索栈未启用向量（<code>GENETECH_EMBED_URL</code> 未设置），故分数只反映 BM25+RRF 表现。</li>
<li>评测只在内存里跑，未做并发/延迟测量。</li>
<li>用于<b>防止检索回归</b>与定位短板类型；跨系统绝对对比需人工标注子集（规划中）。</li>
</ul>
</div>

<footer>
生成于 ${new Date().toISOString()} · GeneTech 30 站知识引擎 · 评测代码 <code>eval/run-eval.mjs</code> · 生成器 <code>eval/generate-queries.mjs</code> · benchmark v${genVersion} · 指纹 ${man.fingerprint || 'n/a'}
</footer>
</body>
</html>`;
}
