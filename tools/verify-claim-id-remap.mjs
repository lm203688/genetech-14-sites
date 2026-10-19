#!/usr/bin/env node
/*
 * tools/verify-claim-id-remap.mjs
 * ================================================================
 * G6 交付：claim / 假设层 ID remap 校验（报告 §3.1 G6）
 *
 * 背景
 *   hypothesis-cards.json / claims.json / extracted-claims.json 于 2026-10-16 生成；
 *   identity-map.json 于 2026-10-17 02:09 生成（F5 ID 规范化产物）。
 *   → claim / 假设层跑在 ID 规范化之前，若按裸 ID 引用实体，F5 之后
 *     "假设↔实体" 链路会断裂。
 *
 * 校验内容
 *   1. 抽取出 claim / 假设层里所有对"实体 ID"的引用
 *   2. 逐个到 identity-map.entries 命中 canonical 或 aliases
 *   3. 输出：命中 / 未命中 / 部分命中（alias 命中但 canonical 变了）清单
 *   4. 附建议 remap（把旧 ID 替换成 canonical）
 *
 * 用法
 *   node tools/verify-claim-id-remap.mjs                     # 只报统计
 *   node tools/verify-claim-id-remap.mjs --write             # 写入报告
 *   node tools/verify-claim-id-remap.mjs --report path       # 指定报告路径
 *
 * 退出码
 *   0 = 全命中
 *   1 = 存在未命中的实体 ID（需要 remap）
 *   2 = 数据缺失或格式错误
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const IDENT = path.join(ROOT, 'data/identity-map.json');
const CLAIMS = path.join(ROOT, 'data/claims.json');
const EXTRACTED = path.join(ROOT, 'data/extracted-claims.json');
const HYPOTHESIS = path.join(ROOT, 'data/hypothesis-cards.json');
const DEFAULT_REPORT = path.join(ROOT, 'reports/claim-id-remap-audit-2026-10-17.md');

const args = new Set(process.argv.slice(2));
const DO_WRITE = args.has('--write');
let REPORT_PATH = DEFAULT_REPORT;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--report' && process.argv[i + 1]) REPORT_PATH = path.resolve(process.argv[i + 1]);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

// ============ 1. 构建 identity-map 索引 ============
console.log('[remap] 加载 identity-map.json …');
const ident = readJson(IDENT);
if (!ident) { console.error(`[remap] 缺文件: ${IDENT}`); process.exit(2); }
const entries = ident.entries || {};

// alias -> canonical
const aliasToCanonical = new Map();
const canonicalSet = new Set();
for (const [canon, v] of Object.entries(entries)) {
  canonicalSet.add(canon);
  aliasToCanonical.set(canon, canon);
  if (Array.isArray(v.aliases)) for (const a of v.aliases) aliasToCanonical.set(a, canon);
}
console.log(`[remap] canonical=${canonicalSet.size} / alias total=${aliasToCanonical.size}`);

function remapOrFlag(id) {
  if (typeof id !== 'string' || !id) return { status: 'empty' };
  if (canonicalSet.has(id)) return { status: 'canonical', canonical: id };
  if (aliasToCanonical.has(id)) {
    const canon = aliasToCanonical.get(id);
    return canon === id ? { status: 'canonical', canonical: canon } : { status: 'alias→canonical', canonical: canon };
  }
  return { status: 'unmapped', raw: id };
}

// ============ 2. 抽 claim 引用 ============
console.log('[remap] 扫描 claims.json …');
const claims = readJson(CLAIMS);
const claimRefs = []; // { source, id, status, canonical? }
function collect(id, source) {
  if (!id) return;
  const r = remapOrFlag(id);
  claimRefs.push({ source, ...r });
}
if (claims) {
  if (Array.isArray(claims.claims)) {
    for (const c of claims.claims) {
      if (c.entityId) collect(c.entityId, 'claims.claims.entityId');
      if (c.sourceEntity) collect(c.sourceEntity, 'claims.claims.sourceEntity');
      if (c.targetEntity) collect(c.targetEntity, 'claims.claims.targetEntity');
      if (c.doi) collect(c.doi, 'claims.claims.doi');
      if (c.id) collect(c.id, 'claims.claims.id');
      // subjects / predicates 可能含 ID
      if (Array.isArray(c.subjects)) for (const s of c.subjects) collect(typeof s === 'string' ? s : s.id, 'claims.claims.subjects');
      if (Array.isArray(c.citations)) for (const ct of c.citations) collect(ct.doi || ct.entityId, 'claims.claims.citations');
    }
  }
  if (Array.isArray(claims.citations)) for (const c of claims.citations) collect(c.doi || c.entityId, 'claims.citations');
}

console.log('[remap] 扫描 extracted-claims.json …');
const extracted = readJson(EXTRACTED);
if (extracted) {
  if (Array.isArray(extracted.claims)) {
    for (const c of extracted.claims) {
      // 注意：subject / object 是 NLP 抽取的自然语言三元组（如 "models"/"learning"），
      // 不是实体 ID 引用，不纳入 remap 校验。
      if (c.entityId) collect(c.entityId, 'extracted-claims.claims.entityId');
      if (c.doi) collect(c.doi, 'extracted-claims.claims.doi');
      if (c.id) collect(c.id, 'extracted-claims.claims.id');
      if (c.sourceEntity) collect(c.sourceEntity, 'extracted-claims.claims.sourceEntity');
      if (c.targetEntity) collect(c.targetEntity, 'extracted-claims.claims.targetEntity');
      if (c.site) collect(c.site, 'extracted-claims.claims.site');
    }
  }
}

console.log('[remap] 扫描 hypothesis-cards.json …');
const hyp = readJson(HYPOTHESIS);
if (hyp) {
  const cards = hyp.cards || hyp.hypotheses || (Array.isArray(hyp) ? hyp : []);
  for (const h of cards) {
    if (h.id) collect(h.id, 'hypothesis.id');
    if (Array.isArray(h.supportingEntities)) for (const e of h.supportingEntities) collect(e, 'hypothesis.supportingEntities');
    if (Array.isArray(h.entities)) for (const e of h.entities) collect(e, 'hypothesis.entities');
    if (Array.isArray(h.evidence)) {
      for (const ev of h.evidence) collect(ev.entityId || ev.doi, 'hypothesis.evidence');
    }
    if (Array.isArray(h.citations)) for (const c of h.citations) collect(c.doi || c.entityId, 'hypothesis.citations');
  }
}

// ============ 3. 统计 ============
const counts = { canonical: 0, 'alias→canonical': 0, unmapped: 0, empty: 0 };
const unmapped = [];
const aliases = new Set(); // alias -> canonical 集合，用于 remap 建议
for (const r of claimRefs) {
  counts[r.status] = (counts[r.status] || 0) + 1;
  if (r.status === 'unmapped' && r.raw && !unmapped.find(u => u.raw === r.raw)) unmapped.push({ ...r });
  if (r.status === 'alias→canonical') aliases.add(`${r.raw} → ${r.canonical}`);
}
const total = claimRefs.length;
const hitRate = total ? ((counts.canonical + counts['alias→canonical']) / total * 100).toFixed(2) : '0.00';

// ============ 4. 输出 ============
const summary = {
  generatedAt: new Date().toISOString(),
  totalRefs: total,
  hitRate,
  counts,
  unmappedCount: unmapped.length,
  aliasRenames: [...aliases],
  unmappedSample: unmapped.slice(0, 50),
  allUnmapped: unmapped,
  identityMap: {
    generatedAt: ident.$generatedAt,
    canonical: canonicalSet.size,
    aliasTotal: aliasToCanonical.size,
  },
};

console.log('\n[remap] === 统计 ===');
console.log(`总引用: ${total}`);
console.log(`canonical: ${counts.canonical}`);
console.log(`alias→canonical: ${counts['alias→canonical']}`);
console.log(`unmapped: ${counts.unmapped}`);
console.log(`empty: ${counts.empty}`);
console.log(`命中率: ${hitRate}%`);
console.log(`未映射唯一 ID: ${unmapped.length}`);

if (DO_WRITE) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const lines = [];
  lines.push('# Claim ID Remap 审计报告（G6）');
  lines.push('');
  lines.push(`> 生成时间：${summary.generatedAt}`);
  lines.push(`> Identity-map 生成时间：${summary.identityMap.generatedAt}`);
  lines.push('');
  lines.push('## 摘要');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---:|');
  lines.push(`| 总引用 | ${total} |`);
  lines.push(`| canonical 命中 | ${counts.canonical} |`);
  lines.push(`| alias→canonical（可自动 remap） | ${counts['alias→canonical']} |`);
  lines.push(`| 未映射 | ${counts.unmapped} |`);
  lines.push(`| 空值 | ${counts.empty} |`);
  lines.push(`| 命中率 | **${hitRate}%** |`);
  lines.push('');
  lines.push('## 建议 remap（alias → canonical）');
  lines.push('');
  if (aliases.size === 0) {
    lines.push('_无 alias 需要 remap_');
  } else {
    lines.push('```');
    for (const a of [...aliases].slice(0, 100)) lines.push(a);
    if (aliases.size > 100) lines.push(`…（共 ${aliases.size} 条）`);
    lines.push('```');
  }
  lines.push('');
  lines.push(`## 未映射唯一 ID（共 ${unmapped.length}，仅显示前 50）`);
  lines.push('');
  if (unmapped.length === 0) {
    lines.push('_全部命中，无 remap 需要_');
  } else {
    lines.push('| source | raw ID |');
    lines.push('|---|---|');
    for (const u of unmapped.slice(0, 50)) lines.push(`| ${u.source} | ${u.raw} |`);
  }
  lines.push('');
  lines.push('## 建议动作');
  lines.push('');
  if (unmapped.length === 0 && counts['alias→canonical'] === 0) {
    lines.push('✅ Claim / 假设层 ID 已全部与 identity-map 对齐，无需 remap。');
  } else if (unmapped.length === 0) {
    lines.push('⚠️ 存在 alias 命中（需自动 remap 到 canonical），但无未映射。执行 remap 脚本可将 alias 全部收敛到 canonical。');
  } else {
    lines.push(`❌ ${unmapped.length} 条 ID 未在 identity-map 中命中。可能原因：`);
    lines.push('  1. 引用了裸 DOI 但未加 `doi:` 前缀');
    lines.push('  2. 引用了未入库的实体（identity-map 只覆盖 30 站在库实体）');
    lines.push('  3. 引用了已被 F5 合并掉的历史 ID（需检查是否有更完整的映射表）');
    lines.push('  建议：先跑 `pipeline-data-accumulation.js` 或 `pipeline-library-expand.js` 补齐缺口，再重跑本校验。');
  }
  fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8');
  console.log(`[remap] 报告已写入: ${REPORT_PATH}`);
}

process.exit(counts.unmapped > 0 ? 1 : 0);
