#!/usr/bin/env node
/**
 * tools/aggregate-review.mjs
 *
 * 读取专家回传的评审 JSON，计算 inter-rater 一致性，产出人类验证报告。
 * 支撑 Phase 3 (T3.3)。
 *
 * 输入：review-pkg/reviews/*.json  —— 每位专家一个，结构见 _TEMPLATE.json
 *   { expert, domainCluster, items: [ { id, ratings:{novelty,interesting,feasible,evidence}, worthValidating, comment } ] }
 *
 * 输出：
 *   - 各维度均值 / 标准差
 *   - Cohen's kappa（逐对专家，按 worthValidating 二值化）
 *   - Krippendorff's alpha（整体，按 worthValidating）
 *   - 按 hypothesis_type 拆分的"值得验证率"
 *
 * 用法：
 *   node tools/aggregate-review.mjs review-pkg/reviews
 *   node tools/aggregate-review.mjs review-pkg/reviews --out=reports/human-validation-<date>.json
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'review-pkg/reviews';
const outArg = process.argv.find(a => a.startsWith('--out='))?.slice(6);

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
if (!files.length) { console.error(`[agg] 未找到评审文件于 ${dir}（请先放专家回传 JSON，排除 _TEMPLATE）`); process.exit(1); }

const reviews = files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
const dims = ['novelty', 'interesting', 'feasible', 'evidence'];

// id -> { expert -> {ratings, worthValidating} }
const mat = {};
for (const r of reviews) {
  for (const it of r.items || []) {
    (mat[it.id] ||= {})[r.expert || r.domainCluster || files[reviews.indexOf(r)]] = {
      ratings: it.ratings || {}, worth: it.worthValidating,
    };
  }
}

// 维度均值
const dimStats = {};
for (const d of dims) {
  const all = [];
  for (const id in mat) for (const e in mat[id]) {
    const v = mat[id][e].ratings?.[d];
    if (typeof v === 'number') all.push(v);
  }
  const mean = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;
  const variance = all.length ? all.reduce((a, b) => a + (b - mean) ** 2, 0) / all.length : 0;
  dimStats[d] = { n: all.length, mean: +mean.toFixed(3), std: +Math.sqrt(variance).toFixed(3) };
}

// Cohen's kappa（二值：worthValidating true/false）
function cohenKappa(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let a11 = 0, a10 = 0, a01 = 0, a00 = 0, n = 0;
  for (const k of keys) {
    const x = a[k]?.worth, y = b[k]?.worth;
    if (typeof x !== 'boolean' || typeof y !== 'boolean') continue;
    n++;
    if (x && y) a11++; else if (x && !y) a10++; else if (!x && y) a01++; else a00++;
  }
  if (!n) return null;
  const po = (a11 + a00) / n;
  const pe = ((a11 + a10) * (a11 + a01) + (a00 + a01) * (a00 + a10)) / (n * n);
  return pe === 1 ? 1 : +((po - pe) / (1 - pe)).toFixed(3);
}

const experts = [...new Set(reviews.map(r => r.expert || r.domainCluster))];
const kappaPairs = [];
for (let i = 0; i < experts.length; i++) for (let j = i + 1; j < experts.length; j++) {
  const ea = {}, eb = {};
  for (const id in mat) { if (mat[id][experts[i]]) ea[id] = mat[id][experts[i]]; if (mat[id][experts[j]]) eb[id] = mat[id][experts[j]]; }
  const k = cohenKappa(ea, eb);
  if (k !== null) kappaPairs.push({ pair: `${experts[i]}~${experts[j]}`, kappa: k });
}

// Krippendorff's alpha（nominal, worthValidating）
function krippendorffAlpha(mat) {
  const units = Object.keys(mat);
  const raters = new Set();
  for (const id in mat) for (const e in mat[id]) raters.add(e);
  const R = [...raters];
  // 类别集
  const cats = new Set();
  for (const id in mat) for (const e in mat[id]) { const w = mat[id][e].worth; if (typeof w === 'boolean') cats.add(w); }
  const C = [...cats];
  if (C.length < 2) return null;
  // 观测不一致 Do
  let Do = 0, nUnits = 0;
  for (const id in mat) {
    const vals = R.map(e => mat[id][e]?.worth).filter(v => typeof v === 'boolean');
    if (vals.length < 2) continue;
    nUnits++;
    for (let a = 0; a < vals.length; a++) for (let b = a + 1; b < vals.length; b++) {
      Do += (vals[a] === vals[b]) ? 0 : 1;
    }
  }
  // 期望不一致 De
  const flat = [];
  for (const id in mat) for (const e in mat[id]) { const w = mat[id][e].worth; if (typeof w === 'boolean') flat.push(w); }
  let De = 0;
  for (let i = 0; i < flat.length; i++) for (let j = 0; j < flat.length; j++) { if (i !== j) De += (flat[i] === flat[j]) ? 0 : 1; }
  De = flat.length > 1 ? De / (flat.length * (flat.length - 1)) * (flat.length) : 0;
  // 简化：alpha = 1 - Do/De（按单元对近似）
  const DoUnit = nUnits ? Do / (nUnits) : 0;
  return De > 0 ? +(1 - DoUnit / (De / (flat.length || 1))).toFixed(3) : null;
}
const alpha = krippendorffAlpha(mat);

// 按 type 拆分的"值得验证率"
const byType = {};
for (const id in mat) {
  const t = (id.startsWith('HYP-') ? null : null); // type 需从评审或原卡映射；此处用 worth 计数
}
// 需要原卡 type：尝试从 review-package.json 读
let typeMap = {};
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'review-pkg/review-package.json'), 'utf8'));
  for (const c of pkg.cards) typeMap[c.id] = c.type;
} catch {}
const worthByType = {};
for (const id in mat) {
  const t = typeMap[id] || 'unknown';
  const vals = Object.values(mat[id]).map(v => v.worth).filter(v => typeof v === 'boolean');
  (worthByType[t] ||= { n: 0, worth: 0 });
  worthByType[t].n += vals.length;
  worthByType[t].worth += vals.filter(Boolean).length;
}
for (const t in worthByType) worthByType[t].rate = worthByType[t].n ? +(worthByType[t].worth / worthByType[t].n).toFixed(3) : 0;

const overallWorth = (() => {
  let w = 0, n = 0; for (const id in mat) for (const e in mat[id]) { if (typeof mat[id][e].worth === 'boolean') { n++; if (mat[id][e].worth) w++; } }
  return { n, worth: w, rate: n ? +(w / n).toFixed(3) : 0 };
})();

const report = {
  generatedAt: new Date().toISOString(),
  reviewers: experts,
  cardsReviewed: Object.keys(mat).length,
  dimensionStats: dimStats,
  cohenKappaPairs: kappaPairs,
  krippendorffAlpha: alpha,
  overallWorthValidating: overallWorth,
  worthByType,
};
const out = outArg || 'reports/human-validation-' + new Date().toISOString().slice(0, 10) + '.json';
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`[agg] 评审者 ${experts.length} | 卡 ${Object.keys(mat).length}`);
console.log(`[agg] 维度均值: ${JSON.stringify(dimStats)}`);
console.log(`[agg] Cohen kappa 对: ${JSON.stringify(kappaPairs)}`);
console.log(`[agg] Krippendorff alpha: ${alpha}`);
console.log(`[agg] 整体值得验证率: ${JSON.stringify(overallWorth)}`);
console.log(`[agg] 报告 → ${out}`);
