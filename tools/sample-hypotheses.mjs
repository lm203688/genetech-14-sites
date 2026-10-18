#!/usr/bin/env node
/**
 * tools/sample-hypotheses.mjs
 *
 * 分层抽样 hypothesis-cards.json，产出"专家评审包"（CSV + JSON）。
 * 目标：支撑 Phase 3 (T3.1) 的人类验证 —— 解 SCI 评估里的 W1 死穴。
 *
 * 抽样策略（确定性，可复现）：
 *   - 按 hypothesis_type 分层
 *   - 每层按 confidence 降序取前 --perType 张（兼顾高低置信，避免只抽高置信导致的乐观偏差）
 *
 * 用法：
 *   node tools/sample-hypotheses.mjs --perType=10 --out=review-pkg
 *   node tools/sample-hypotheses.mjs --types=litellbridge,sparse_bridge_v2 --perType=15
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'data/hypothesis-cards.json');

function parseArgs() {
  const a = { perType: 10, out: 'review-pkg', types: null };
  for (const s of process.argv.slice(2)) {
    const i = s.indexOf('=');
    if (i < 0) continue;
    const k = s.slice(0, i), v = s.slice(i + 1);
    if (k === '--perType') a.perType = parseInt(v, 10) || 10;
    else if (k === '--out') a.out = v;
    else if (k === '--types') a.types = v.split(',').map(t => t.trim()).filter(Boolean);
  }
  return a;
}

const args = parseArgs();
const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const cards = data.hypothesisCards || data.cards || (Array.isArray(data) ? data : []);

const byType = {};
for (const c of cards) {
  const t = c.hypothesis_type || 'unknown';
  (byType[t] ||= []).push(c);
}

const targetTypes = args.types || Object.keys(byType);
const sampled = [];
for (const t of targetTypes) {
  const arr = byType[t];
  if (!arr) { console.warn(`[sample] 警告：类型 ${t} 不存在，跳过`); continue; }
  const sorted = [...arr].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  sampled.push(...sorted.slice(0, args.perType));
}

// 去重保安全
const seen = new Set();
const uniq = [];
for (const c of sampled) {
  if (c.id && !seen.has(c.id)) { seen.add(c.id); uniq.push(c); }
}

fs.mkdirSync(args.out, { recursive: true });

const esc = (s) => `"${String(s || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;
const header = ['id', 'type', 'confidence', 'statement', 'statement_zh', 'falsifiability', 'evidence_requirement'];
const rows = uniq.map(c => ({
  id: c.id,
  type: c.hypothesis_type,
  confidence: c.confidence,
  statement: c.statement,
  statement_zh: c.statement_zh,
  falsifiability: c.falsifiability?.falsification_condition,
  evidence_requirement: JSON.stringify(c.evidence_requirement || {}),
}));

fs.writeFileSync(
  path.join(args.out, 'review-sheet.csv'),
  header.join(',') + '\n' +
  rows.map(r => [r.id, r.type, r.confidence, `"${String(r.statement||'').replace(/"/g,'""')}"`, `"${String(r.statement_zh||'').replace(/"/g,'""')}"`, `"${String(r.falsifiability||'').replace(/"/g,'""')}"`, `"${String(r.evidence_requirement||'').replace(/"/g,'""')}"`].join(',')).join('\n') + '\n'
);

fs.writeFileSync(
  path.join(args.out, 'review-package.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    sampling: { perType: args.perType, strategy: 'stratified-by-type, desc-by-confidence', targetTypes },
    totalCards: cards.length,
    sampled: uniq.length,
    cardsByType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])),
    sampledByType: Object.fromEntries(targetTypes.map(t => [t, uniq.filter(c => c.hypothesis_type === t).length])),
    cards: uniq.map(c => ({
      id: c.id, type: c.hypothesis_type, confidence: c.confidence,
      statement: c.statement, statement_zh: c.statement_zh,
      falsifiability: c.falsifiability, evidence_requirement: c.evidence_requirement,
      verification_plan: c.verification_plan, provenance: c.provenance,
    })),
  }, null, 2)
);

// 同时生成专家回传模板目录与空白 JSON
const reviewsDir = path.join(args.out, 'reviews');
fs.mkdirSync(reviewsDir, { recursive: true });
const template = {
  expert: '<专家标识，如 E01>',
  domainCluster: '<领域簇，如 AI/量子/生物/能源>',
  items: uniq.map(c => ({
    id: c.id,
    ratings: { novelty: null, interesting: null, feasible: null, evidence: null }, // Likert 1-5
    worthValidating: null, // bool: 是否值得一个研究生去验证
    comment: '',
  })),
};
fs.writeFileSync(path.join(reviewsDir, '_TEMPLATE.json'), JSON.stringify(template, null, 2));

console.log(`[sample] 总卡 ${cards.length} | 类型 ${Object.keys(byType).length} | 抽样 ${uniq.length}`);
console.log(`[sample] 分层计数: ${JSON.stringify(Object.fromEntries(targetTypes.map(t => [t, uniq.filter(c => c.hypothesis_type === t).length])))}`);
console.log(`[sample] 产出: ${args.out}/review-package.json, review-sheet.csv, reviews/_TEMPLATE.json`);
