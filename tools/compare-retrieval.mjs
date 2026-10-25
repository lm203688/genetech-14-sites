#!/usr/bin/env node
/**
 * tools/compare-retrieval.mjs
 *
 * 对比 BM25+field（baseline）vs BM25+field+vector（hybrid）两种检索模式
 * 在同一 3 站 pilot 上的指标差异。
 *
 * 输入：eval/results-<date>.json（baseline 与 hybrid 各一次）
 * 输出：终端表格 + reports/retrieval-comparison-<date>.md
 *
 * 用法：
 *   node tools/compare-retrieval.mjs --base=results-2026-10-22.json --hybrid=results-2026-10-22-v2.json
 *   node tools/compare-retrieval.mjs --base=results-2026-10-22.json --hybrid=results-hybrid.json --sites=sample-3
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const EVAL_DIR = path.join(ROOT, 'eval');
const REPORT_DIR = path.join(ROOT, 'reports');

function parseArgs() {
  const a = process.argv.slice(2);
  const args = { base: null, hybrid: null, sites: null, date: new Date().toISOString().slice(0, 10) };
  for (const s of a) {
    if (s.startsWith('--base=')) args.base = s.slice(7);
    else if (s.startsWith('--hybrid=')) args.hybrid = s.slice(9);
    else if (s.startsWith('--sites=')) args.sites = s.slice(8);
    else if (s.startsWith('--date=')) args.date = s.slice(7);
  }
  return args;
}

function loadResults(name) {
  if (!name) throw new Error('--base/--hybrid 必传');
  const p = path.isAbsolute(name) ? name : path.join(EVAL_DIR, name);
  if (!fs.existsSync(p)) throw new Error(`找不到结果文件: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function pct(n) { return `${(n * 100).toFixed(2)}%`; }
function delta(a, b) { return ((b - a) * 100).toFixed(2); }

function summarizeByType(results) {
  const by = {};
  for (const r of results) {
    const t = r.type || 'unknown';
    if (!by[t]) by[t] = { n: 0, r10: [], mrr: [], ndcg: [] };
    by[t].n++;
    by[t].r10.push(r['recall@10']);
    by[t].mrr.push(r.mrr);
    by[t].ndcg.push(r['ndcg@10']);
  }
  const out = {};
  for (const [t, v] of Object.entries(by)) {
    const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    out[t] = {
      n: v.n,
      r10: mean(v.r10),
      mrr: mean(v.mrr),
      ndcg: mean(v.ndcg),
    };
  }
  return out;
}

function printTable(rows, cols, headers) {
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c]).length)));
  const sep = `| ${w.map(x => '-'.repeat(x + 2)).join('|')} |`;
  console.log(sep);
  console.log(`| ${headers.map((h, i) => h.padEnd(w[i])).join(' | ')} |`);
  console.log(sep);
  for (const r of rows) {
    console.log(`| ${cols.map(c => String(r[c]).padEnd(w[cols.indexOf(c)])).join(' | ')} |`);
  }
  console.log(sep);
}

// --- Main ---
const args = parseArgs();
const base = loadResults(args.base);
const hybrid = loadResults(args.hybrid);

console.log(`\n================ 检索模式对比 ================`);
console.log(`Baseline (BM25+field): ${args.base}`);
console.log(`Hybrid   (BM25+field+vector): ${args.hybrid}`);
console.log(``);

// 全局对比
const rows = [
  { metric: 'Query 数', base: base.aggregate.queryCount, hybrid: hybrid.aggregate.queryCount, delta: '-' },
  { metric: 'Recall@10', base: pct(base.aggregate['avgRecall@10']), hybrid: pct(hybrid.aggregate['avgRecall@10']), delta: `+${delta(base.aggregate['avgRecall@10'], hybrid.aggregate['avgRecall@10'])}pp` },
  { metric: 'MRR',       base: pct(base.aggregate.avgMrr),        hybrid: pct(hybrid.aggregate.avgMrr),        delta: `+${delta(base.aggregate.avgMrr, hybrid.aggregate.avgMrr)}pp` },
  { metric: 'NDCG@10',   base: pct(base.aggregate['avgNdcg@10']), hybrid: pct(hybrid.aggregate['avgNdcg@10']), delta: `+${delta(base.aggregate['avgNdcg@10'], hybrid.aggregate['avgNdcg@10'])}pp` },
  { metric: '完美召回', base: base.aggregate.perfectCount, hybrid: hybrid.aggregate.perfectCount, delta: hybrid.aggregate.perfectCount - base.aggregate.perfectCount },
  { metric: '完全未召回', base: base.aggregate.missCount, hybrid: hybrid.aggregate.missCount, delta: hybrid.aggregate.missCount - base.aggregate.missCount },
  { metric: '延迟 P50',  base: `${base.aggregate.latencyMs?.p50 || 0}ms`, hybrid: `${hybrid.aggregate.latencyMs?.p50 || 0}ms`, delta: '-' },
  { metric: '延迟 P95',  base: `${base.aggregate.latencyMs?.p95 || 0}ms`, hybrid: `${hybrid.aggregate.latencyMs?.p95 || 0}ms`, delta: '-' },
];
printTable(rows, ['metric', 'base', 'hybrid', 'delta'], ['指标', 'Baseline', 'Hybrid', 'Δ']);

// 按 query type 分解
const baseByType = summarizeByType(base.results);
const hybridByType = summarizeByType(hybrid.results);
const allTypes = new Set([...Object.keys(baseByType), ...Object.keys(hybridByType)]);

console.log(`\n================ 按查询类型分解 ================`);
const rows2 = [];
for (const t of [...allTypes].sort()) {
  const b = baseByType[t] || { n: 0, r10: 0, mrr: 0, ndcg: 0 };
  const h = hybridByType[t] || { n: 0, r10: 0, mrr: 0, ndcg: 0 };
  rows2.push({
    type: t,
    n: h.n,
    baseR: pct(b.r10),
    hybridR: pct(h.r10),
    dR: `${delta(b.r10, h.r10)}pp`,
    baseMrr: pct(b.mrr),
    hybridMrr: pct(h.mrr),
    dMrr: `${delta(b.mrr, h.mrr)}pp`,
  });
}
printTable(rows2, ['type', 'n', 'baseR', 'hybridR', 'dR', 'baseMrr', 'hybridMrr', 'dMrr'],
  ['type', 'n', 'Base R@10', 'Hybrid R@10', 'ΔR', 'Base MRR', 'Hybrid MRR', 'ΔMRR']);

// 写报告
fs.mkdirSync(REPORT_DIR, { recursive: true });
const reportPath = path.join(REPORT_DIR, `retrieval-comparison-${args.date}.md`);
const lines = [
  `# 检索模式对比报告`,
  ``,
  `生成时间: ${new Date().toISOString()}`,
  ``,
  `- Baseline: BM25 + 字段加权 + RRF（${args.base}）`,
  `- Hybrid: BM25 + 字段加权 + 向量语义（BGE-M3）+ RRF（${args.hybrid}）`,
  ``,
  `## 总体指标`,
  ``,
  `| 指标 | Baseline | Hybrid | Δ |`,
  `|---|---|---|---|`,
  ...rows.map(r => `| ${r.metric} | ${r.base} | ${r.hybrid} | ${r.delta} |`),
  ``,
  `## 按查询类型分解`,
  ``,
  `| type | n | Base R@10 | Hybrid R@10 | ΔR | Base MRR | Hybrid MRR | ΔMRR |`,
  `|---|---|---|---|---|---|---|---|`,
  ...rows2.map(r => `| ${r.type} | ${r.n} | ${r.baseR} | ${r.hybridR} | ${r.dR} | ${r.baseMrr} | ${r.hybridMrr} | ${r.dMrr} |`),
  ``,
  `## 结论`,
  ``,
  `（自动生成，具体结论请结合 Δ 列判断）`,
];
fs.writeFileSync(reportPath, lines.join('\n'));
console.log(`\n报告写入: ${path.relative(ROOT, reportPath)}`);
