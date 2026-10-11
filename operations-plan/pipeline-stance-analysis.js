#!/usr/bin/env node
/**
 * pipeline-stance-analysis.js
 *
 * 立场/情绪规则分析：对 30 站实体摘要做词典+启发式打分，输出站点级立场分布。
 *
 * 目的：
 * - 报告 P1-立场：把「研究空白」从数学事实（零引用对）扩展到立场维度
 * - 建立「站-站-立场」三轴画像：某站是「乐观-中立-悲观」主导？站对之间立场差多少？
 * - 供 citation_gaps MCP 工具未来扩展「按立场过滤 gap pairs」
 *
 * 方法（无外部依赖，纯 stdlib）：
 *   1. 词典打分：预置 pos/neg/uncertain 词表（中英），加权计数
 *   2. 归一化：每条摘要得分 = (pos - neg) / (pos + neg + 1)，范围 [-1, +1]
 *   3. 分类：>0.15 乐观 / <-0.15 悲观 / 其他中立
 *   4. 站点聚合：按 30 站汇总分布 + Top 关键词
 *
 * 用法：
 *   node operations-plan/pipeline-stance-analysis.js
 *   node operations-plan/pipeline-stance-analysis.js --site=biomed-ai --limit=1000
 *
 * 产物：
 *   reports/stance-analysis-<YYYY-MM-DD>.json
 *   data/stance-entities.json（含分数）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 立场词表（中英混合，学术文本常见）
const POS = [
  // 英文
  'promising', 'breakthrough', 'effective', 'significant', 'improved', 'advance', 'achieved',
  'superior', 'enhanced', 'positive', 'successful', 'outstanding', 'notable', 'encouraging',
  'potential', 'innovative', 'efficient', 'robust', 'reliable', 'sustainable', 'scalable',
  'optimal', 'optimum', 'favorable', 'fruitful', 'beneficial', 'gains', 'increase', 'accelerate',
  'acceleration', 'revolutionary', 'disruptive', 'transformative', 'powerful', 'vibrant',
  // 中文
  '突破', '显著', '提升', '创新', '优势', '成效', '前景', '潜力', '优异', '革新', '颠覆', '变革', '加速', '高效', '可持续',
];
const NEG = [
  // 英文
  'limitation', 'challenge', 'constraint', 'hurdle', 'barrier', 'problem', 'fail', 'failure',
  'ineffective', 'inadequate', 'insufficient', 'difficult', 'negative', 'adverse', 'poor',
  'worse', 'decline', 'drawback', 'drawbacks', 'risk', 'risks', 'toxic', 'harmful', 'toxicity',
  'unreliable', 'fragile', 'brittle', 'vulnerability', 'vulnerable', 'crisis', 'declining',
  'stagnation', 'stagnant', 'detriment', 'harm', 'damage', 'side effect', 'adverse effect',
  'uncertain', 'inaccurate', 'misleading', 'controversial', 'disputed',
  // 中文
  '局限', '挑战', '困难', '失效', '不足', '缺陷', '风险', '危机', '衰退', '下降', '有害', '毒性',
  '不可靠', '脆弱', '争议', '误导', '不准', '停滞', '问题', '副作用', '不确定性', '隐患',
];
const UNCERTAIN = [
  'uncertain', 'ambiguous', 'limited evidence', 'inconsistent', 'mixed result', 'mixed results',
  'controversial', 'debated', 'open question', 'remains to be', 'further study', 'need further',
  'preliminary', 'hypothesis', 'conjecture', 'speculative', 'plausible', 'suggestive',
  'not clear', 'unclear', 'unknown', 'unknown', 'indefinite',
  // 中文
  '不确定', '未明', '待考', '存疑', '尚有', '难以', '初步', '假设', '推测', '存争议',
];

// 简单加权：NEG 权重稍高（负面词更强）
const W_POS = 1.0, W_NEG = 1.15, W_UNC = 0.4;

function countHits(text, words) {
  if (!text) return 0;
  const t = text.toLowerCase();
  let hits = 0;
  for (const w of words) {
    if (t.includes(w)) hits++;
  }
  return hits;
}

function score(text) {
  const pos = countHits(text, POS);
  const neg = countHits(text, NEG);
  const unc = countHits(text, UNCERTAIN);
  const denom = pos + neg + unc + 1;
  const s = (pos * W_POS - neg * W_NEG + unc * W_UNC) / denom;
  return {
    score: Math.round(s * 1000) / 1000,
    pos, neg, unc,
    stance: s > 0.15 ? 'optimistic' : s < -0.15 ? 'pessimistic' : 'neutral',
    tokens: pos + neg + unc,
  };
}

const ARG = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) ARG[m[1]] = m[2];
}
const TARGET_SITE = ARG.site || null;
const LIMIT = Number(ARG.limit || 0) || 0;
const SAMPLE = Number(ARG.sample || 500) || 500;

// 读站点实体
const sites = fs.readdirSync(ROOT).filter((d) => {
  try { return fs.statSync(path.join(ROOT, d)).isDirectory(); } catch { return false; }
});
const allSites = TARGET_SITE ? sites.filter((s) => s === TARGET_SITE) : sites;

console.log(`=== 立场分析 ${allSites.length} 站 ===`);

const perSite = [];
let totalEntities = 0;
const scoredAll = [];

for (const site of allSites) {
  const f = path.join(ROOT, site, 'website/api/entities.json');
  if (!fs.existsSync(f)) continue;
  const wrap = JSON.parse(fs.readFileSync(f, 'utf8'));
  const list = Array.isArray(wrap) ? wrap : (wrap.entities || []);
  // 采样：均匀间隔抽 SAMPLE 条
  const step = Math.max(1, Math.ceil(list.length / SAMPLE));
  let processed = 0;
  const dist = { optimistic: 0, neutral: 0, pessimistic: 0, no_abstract: 0 };
  let scoreSum = 0;
  let tokensWith = 0;
  const topPos = {}; const topNeg = {};
  for (let i = 0; i < list.length; i += step) {
    if (LIMIT && processed >= LIMIT) break;
    const e = list[i];
    const text = `${e.title || e.name || ''} ${e.abstract || ''}`.trim();
    if (!text) { dist.no_abstract++; continue; }
    const r = score(text);
    processed++;
    dist[r.stance]++;
    scoreSum += r.score;
    if (r.tokens > 0) tokensWith++;
    // 记 top 词（简单：命中过的词）
    if (r.pos > 0) { /* 简化：只统计次数 */ }
    scoredAll.push({ site, id: e.id, stance: r.stance, score: r.score, tokens: r.tokens });
  }
  const avg = processed ? scoreSum / processed : 0;
  perSite.push({
    site,
    processed,
    dist,
    avgScore: Math.round(avg * 1000) / 1000,
    withTokens: tokensWith,
    pctOptimistic: processed ? Math.round(dist.optimistic / processed * 1000) / 10 : 0,
    pctNeutral: processed ? Math.round(dist.neutral / processed * 1000) / 10 : 0,
    pctPessimistic: processed ? Math.round(dist.pessimistic / processed * 1000) / 10 : 0,
    verdict: avg > 0.05 ? 'leaning optimistic' : avg < -0.05 ? 'leaning pessimistic' : 'balanced',
  });
  totalEntities += processed;
}

perSite.sort((a, b) => b.avgScore - a.avgScore);

const report = {
  generatedAt: new Date().toISOString(),
  method: 'dictionary-scoring (POS/NEG/UNCERTAIN lexicons, weighted)',
  thresholds: { optimistic: '> +0.15', neutral: '[-0.15, +0.15]', pessimistic: '< -0.15' },
  totalEntities,
  siteCount: perSite.length,
  perSite,
  topOptimistic: perSite.slice(0, 5),
  topPessimistic: perSite.slice(-5).reverse(),
  note: '词典打分在抽象/关键词层面，不是模型情感分析；用于跨站相对比较，不做绝对判断。',
};

const date = new Date().toISOString().slice(0, 10);
fs.writeFileSync(
  path.join(ROOT, 'reports', `stance-analysis-${date}.json`),
  JSON.stringify(report, null, 2)
);
fs.writeFileSync(
  path.join(ROOT, 'data', 'stance-entities.json'),
  JSON.stringify({ generatedAt: report.generatedAt, count: scoredAll.length, entities: scoredAll.slice(0, 5000) })
);

console.log(`\n=== 结果 ===`);
console.log(`总样本: ${totalEntities} | 站点: ${perSite.length}`);
console.log(`\nTop 5 乐观:`);
for (const s of report.topOptimistic) {
  console.log(`  ${s.site.padEnd(22)} avg=${s.avgScore} opt=${s.pctOptimistic}% neu=${s.pctNeutral}% pes=${s.pctPessimistic}%  → ${s.verdict}`);
}
console.log(`\nTop 5 悲观:`);
for (const s of report.topPessimistic) {
  console.log(`  ${s.site.padEnd(22)} avg=${s.avgScore} opt=${s.pctOptimistic}% neu=${s.pctNeutral}% pes=${s.pctPessimistic}%  → ${s.verdict}`);
}
console.log(`\n产物: reports/stance-analysis-${date}.json + data/stance-entities.json`);
