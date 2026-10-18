#!/usr/bin/env node
/**
 * tools/build-gold-sample.mjs  (SCI 报告 §T2.2 — 人工标注 gold 子集)
 *
 * 从 eval/queries.jsonl 分层抽样 N=200 条（按构造类型分层），为每条附上
 * 检索器返回的 top-K 候选实体 id，便于人类标注者在「候选集」内标注相关/不相关，
 * 避免在全库 29 万实体中盲找。
 *
 * 输出 data/gold.jsonl：
 *   { idx, site, query, queryType, candidateIds:[topK], annotatorA:null, annotatorB:null }
 *   annotatorA/B 为「被标注者判定相关的候选 id 数组」，留空待人类填。
 *
 * 标注完成后运行 tools/gold-kappa.mjs 计算 Cohen's kappa。
 *
 * 用法：node tools/build-gold-sample.mjs --n=200 --k=20
 */

import fs from 'node:fs';
import path from 'node:path';
import { SearchIndex } from '../mcp-server/src/search.mjs';

const ROOT = process.cwd();
const EVAL_DIR = path.join(ROOT, 'eval');
const arg = process.argv.slice(2);
const N = parseInt(arg.find((a) => a.startsWith('--n='))?.slice(4) || '200', 10);
const K = parseInt(arg.find((a) => a.startsWith('--k='))?.slice(4) || '20', 10);

// 站点扫描（与 eval/run-eval.mjs 同逻辑）
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
  for (const e of list) if (!e._site) e._site = site;
  return list;
}

const allSites = listSites();
const indexBySite = new Map();
function getIdx(site) {
  if (!indexBySite.has(site)) indexBySite.set(site, new SearchIndex(loadEntities(site)));
  return indexBySite.get(site);
}

const lines = fs.readFileSync(path.join(EVAL_DIR, 'queries.jsonl'), 'utf8')
  .split('\n').filter(Boolean)
  .map((l, i) => { try { return { idx: i, ...JSON.parse(l) }; } catch { return null; } })
  .filter(Boolean);

// 按类型分层
const byType = {};
for (const q of lines) (byType[q.type || 'unknown'] ||= []).push(q);

// 分层抽样：每层按数量比例分配，至少取 1
const types = Object.keys(byType);
const sample = [];
for (const t of types) {
  const pool = byType[t];
  const take = Math.max(1, Math.round((pool.length / lines.length) * N));
  // 随机不重复抽样
  const idxs = pool.map((_, i) => i);
  for (let i = idxs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
  }
  for (const i of idxs.slice(0, take)) {
    const q = pool[i];
    const idx = getIdx(q.site);
    const hits = await idx.hybridSearch(q.query, { limit: K, site: null });
    const candidateIds = hits.map((h) => h.entity.id || `${h.entity._site}:${h.entity.name}`);
    sample.push({
      idx: q.idx,
      site: q.site,
      query: q.query,
      queryType: q.type || 'unknown',
      candidateIds,
      annotatorA: null, // 人类 A 标注：相关候选 id 数组
      annotatorB: null, // 人类 B 标注：相关候选 id 数组
    });
  }
}

const out = path.join(ROOT, 'data', 'gold.jsonl');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, sample.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');

const typeDist = {};
for (const s of sample) typeDist[s.queryType] = (typeDist[s.queryType] || 0) + 1;
console.log(`[gold] 抽样 ${sample.length} 条（目标 ${N}）写入 ${out}`);
console.log(`[gold] 类型分布: ${JSON.stringify(typeDist)}`);
console.log('[gold] 标注说明: 打开 data/gold.jsonl，为每条填 annotatorA / annotatorB（相关候选 id 数组）；');
console.log('       两人都填后运行 node tools/gold-kappa.mjs 计算 Cohen\'s kappa。');
