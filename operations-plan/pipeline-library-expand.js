#!/usr/bin/env node
/**
 * pipeline-library-expand.js —— 用「已经补齐的被引文档」给 30 站扩库（飞轮第二环）
 *
 * 背景（2026-10-04，第 9 轮挖出来的真实卡点）
 *   飞轮的账面是：扩库 → 引用边变多 → 缺口矩阵更准 → 再指导扩库。
 *   前一轮我们已经把 59,623 条引用声明里的 48,760 个 unique 被引文档
 *   从 OpenAlex 抓回来落盘（data/cited-entities.json，78MB，不入库）。
 *   但**它们还没进库**，所以「被引文档在库率」还是 3.8%——
 *   抓回来的被引文档一个都变不成图节点，飞轮第一环是断的。
 *
 * 「满容」其实是假的
 *   30 站 × 10,000 = 300,000 实体看起来铁板一块，实测下来每站的**唯一 DOI 都少于 10,000**：
 *     ai-safety 10,000 实体 / 7,612 唯一 DOI、alien-minerals 7,547、quantum-computing 8,245……
 *   全站合计 23,231 个实体位是**重复 DOI 占位**（同一篇论文被多源合并成了多条）。
 *   这些位置换成「库里还没有、且确实是本站领域的论文」，实体总数仍然是 300,000，
 *   对外口径不变，但唯一实体从 260,689 往上走 —— 而边数恰恰由「被引文档在库率」决定。
 *
 * 所以本脚本做的事（全离线，零网络请求）
 *   1) 数出每站的真实空位（10000 − 唯一 DOI）；
 *   2) 用和 pipeline-cited-site-assign.js **完全同一套**打分（lib/site-domain-tags.mjs 单一真源）
 *      给 48,760 条候选推最像的那一站；
 *   3) 每站按 margin 降序（越自信越先填），跳过站内已有 DOI、以及已经用过一次候选；
 *   4) --write 才落盘：把重复 DOI 占位位的实体原地换成新实体，**实体数一条不少**；
 *      写盘前先做完整性校验（条数不变 / id 唯一 / DOI 唯一），校验不过就不写。
 *
 * 为什么 tags 直接写 topics
 *   新实体如果 tags 为空，在知识图里就是孤点（图谱的边本来就 100% 来自标签共现 + 引用）。
 *   OpenAlex 的 topics 是现成的主题词，写进 tags 才能让它一进库就连上边。
 *   代价：标签词表又会多出一截（项目里本来就是 50,065 distinct 标签 / 保留词表 245 的口径），
 *   这是有意的取舍——孤点节点比多一个标签词更没用。
 *
 * 用法
 *   node operations-plan/pipeline-library-expand.js                 # 只算不写（默认 dry-run）
 *   node operations-plan/pipeline-library-expand.js --write         # 真改 30 个站点实体文件
 *   node operations-plan/pipeline-library-expand.js --conf=high     # 只填高置信
 *   node operations-plan/pipeline-library-expand.js --dry-run=true  # 显式只算
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileMatcher, pickBestSite } from './lib/site-domain-tags.mjs';

const __file = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__file), '..');

const ARGV = process.argv.slice(2);
const WRITE = ARGV.includes('--write') && !ARGV.includes('--write=false');
const DRY_ONLY = ARGV.includes('--dry-run') && !ARGV.includes('--dry-run=false');
const getArg = (k, d) => {
  const a = ARGV.find((x) => typeof x === 'string' && x.startsWith(`--${k}=`));
  return a ? a.slice(`--${k}=`.length) : d;
};
const CONF = getArg('conf', 'medium');           // high | medium（high+medium）| all（不看置信度）
const MIN_SCORE = Number(getArg('min-score', '2')) || 2;
const MIN_MARGIN = Number(getArg('min-margin', '1')) || 1;
const SAMPLE_N = Number(getArg('sample', '0')) || 0; // 0 = 全量
const AUDIT_N = Number(getArg('audit', '25')) || 25;
const OUT = path.join(ROOT, 'data', 'library-expand.json');

const normDoi = (v) => {
  if (v == null) return '';
  let s = String(v).trim();
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '').replace(/\s+/g, '').toLowerCase();
  return s;
};
const CONF_ORDER = { high: ['high'], medium: ['high', 'medium'], all: ['high', 'medium', 'low'] };

function listSiteDirs() {
  return fs.readdirSync(ROOT).filter((d) => {
    try {
      return fs.statSync(path.join(ROOT, d)).isDirectory() && fs.existsSync(path.join(ROOT, d, 'website/api/entities.json'));
    } catch { return false; }
  });
}

function readEntities(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { arr: Array.isArray(j) ? j : (j.entities || []), wrap: j };
}

function main() {
  // ---------- 1. 读候选池（78MB 工作资产，不在仓库里） ----------
  const citedPath = path.join(ROOT, 'data', 'cited-entities.json');
  if (!fs.existsSync(citedPath)) {
    console.warn('[skip] 没有 data/cited-entities.json（78MB 工作资产，不入库）→ 不扩库，先跑 pipeline-cited-backfill.js');
    return;
  }
  const wrap = JSON.parse(fs.readFileSync(citedPath, 'utf8'));
  const all = Array.isArray(wrap) ? wrap : (wrap.entities || []);
  const cands = SAMPLE_N && SAMPLE_N < all.length ? Array.from({ length: SAMPLE_N }, (_, i) => all[Math.floor(i * (all.length / SAMPLE_N))]) : all;
  console.log(`候选被引文档 ${cands.length} 条` + (cands.length < all.length ? `（跨距抽样自 ${all.length}）` : ''));

  // ---------- 2. 读 30 站实体表 + 数空位 ----------
  const siteDirs = listSiteDirs();
  const sites = {};
  let totalEntities = 0, totalUniqueDoi = 0;
  for (const s of siteDirs) {
    const file = path.join(ROOT, s, 'website/api/entities.json');
    const { arr } = readEntities(file);
    const counts = new Map();
    for (const e of arr) { const d = normDoi(e && e.doi); if (d) counts.set(d, (counts.get(d) || 0) + 1); }
    const unique = counts.size;
    const dupIdx = [];
    const seen = new Set();
    arr.forEach((e, i) => {
      const d = normDoi(e && e.doi);
      if (!d) return;
      if (seen.has(d)) dupIdx.push(i); else seen.add(d);
    });
    totalEntities += arr.length;
    totalUniqueDoi += unique;
    sites[s] = { file, arr, unique, dupIdx, idSet: new Set(arr.map((e) => String(e.id))), doiSet: seen };
  }
  console.log(`\n--- 空位盘点：${siteDirs.length} 站 / 实体 ${totalEntities} / 唯一 DOI ${totalUniqueDoi} ---`);
  let totalFree = 0;
  const freeRows = Object.entries(sites).map(([s, v]) => ({ s, n: v.arr.length, u: v.unique, free: v.arr.length - v.unique }));
  for (const r of freeRows) totalFree += r.free;
  console.log(`重复 DOI 占位合计 ${totalFree} 个空位`);

  // 已入库 DOI 在哪些站（避免把一个已在别站的 DOI 再塞一遍：
  // 同一 DOI 存在于两站会凭空多出「跨站边」这种假信号，边数看着涨、信息没涨）
  const doiSites = new Map();
  for (const [s, v] of Object.entries(sites)) {
    for (const e of v.arr) { const d = normDoi(e && e.doi); if (d) { if (!doiSites.has(d)) doiSites.set(d, new Set()); doiSites.get(d).add(s); } }
  }

  // ---------- 3. 打分 ----------
  const matcher = compileMatcher();
  const allowed = new Set(CONF_ORDER[CONF] || CONF_ORDER.medium);
  // 注意：map 回调必须返回 [key, value] 两元组，返回裸数组会得到 {}（这条踩过）
  const perSite = Object.fromEntries(Object.keys(sites).map((s) => [s, []]));
  const confStat = { high: 0, medium: 0, low: 0, none: 0 };
  const t0 = Date.now();
  for (const it of cands) {
    const d = normDoi(it.doi);
    if (!d) { confStat.none++; continue; }
    const best = pickBestSite(it, matcher, MIN_SCORE, MIN_MARGIN);
    if (!best || !allowed.has(best.confidence)) { confStat.none++; continue; }
    confStat[best.confidence]++;
    const inLib = doiSites.get(d);
    const already = inLib && inLib.has(best.site);
    perSite[best.site].push({ doi: d, title: String(it.title || ''), venue: String(it.venue || ''), year: it.year, conf: best.confidence, score: best.score, margin: best.margin, evidence: best.evidence, inLibrary: inLib ? inLib.size : 0, topics: (it.topics || []).slice(0, 5) });
  }
  const scoredMs = Date.now() - t0;
  console.log(`\n--- 打分 ${scoredMs}ms：高置信 ${confStat.high} / 中置信 ${confStat.medium} / 未过阈值 ${confStat.none}（阈值 score≥${MIN_SCORE} margin≥${MIN_MARGIN}，取 ${CONF}）---`);

  // ---------- 4. 贪心填充 ----------
  const plan = {};
  for (const [s, list] of Object.entries(perSite)) {
    if (!list.length) { plan[s] = { free: sites[s].arr.length - sites[s].unique, fill: 0 }; continue; }
    const free = sites[s].arr.length - sites[s].unique;
    // 先填「全库都没有的」，再填「在别站的」（后者能补边但信息增量小）
    list.sort((a, b) => (a.inLibrary - b.inLibrary) || (b.margin - a.margin));
    const used = new Set();
    const take = [];
    for (const c of list) {
      if (take.length >= free) break;
      if (used.has(c.doi)) continue;               // 同站不重复塞
      if (sites[s].doiSet.has(c.doi)) continue;    // 这个 DOI 本来就在本站库里（那就是重复占位本身，别再塞一遍）
      used.add(c.doi); take.push(c);
    }
    plan[s] = { free, fill: take.length, take };
  }
  const totalFill = Object.values(plan).reduce((a, b) => a + b.fill, 0);
  console.log(`\n--- 填充计划：可填 ${totalFree} 空位，实际能填 ${totalFill} ---`);

  // ---------- 5. 人工复核样本 ----------
  const bySite = Object.entries(plan).filter(([, p]) => (p.take || []).length >= 3);
  const audit = [];
  for (let i = 0; i < AUDIT_N && bySite.length && audit.length < AUDIT_N; i++) {
    const [s, p] = bySite[Math.floor(Math.random() * bySite.length)];
    if (!p.take.length) continue;
    const t = p.take[Math.floor(Math.random() * p.take.length)];
    audit.push({ site: s, ...t });
  }
  console.log(`\n=== 人工复核样本（${audit.length} 条：标题 → 要填进哪个站，标 confidence/margin）===`);
  for (const a of audit) {
    console.log(` [${a.conf}/${a.margin}] ${a.site}\n   标题: ${String(a.title).slice(0, 78)}\n   证据: ${a.evidence.join(' | ')}`);
  }

  // ---------- 6. 落盘 ----------
  const result = {
    generatedAt: new Date().toISOString(),
    mode: WRITE ? 'WRITE' : 'DRY',
    method: 'data/cited-entities.json（已补齐的被引文档）→ lib/site-domain-tags.mjs 打分 → 替换每站重复 DOI 占位实体；实体总数不变，唯一 DOI 增加',
    thresholds: { conf: CONF, minScore: MIN_SCORE, minMargin: MIN_MARGIN },
    candidates: cands.length,
    confidence: { high: confStat.high, medium: confStat.medium, none: confStat.none },
    slotBefore: { entities: totalEntities, uniqueDoi: totalUniqueDoi, freeSlots: totalFree },
    slotAfter: null,
    perSite: {},
    auditSampleSize: audit.length,
  };
  if (!WRITE) {
    console.log(`\n[DRY] 计划填充 ${totalFill} 条，唯一 DOI ${totalUniqueDoi} → ${totalUniqueDoi + totalFill}；加 --write 才改实体文件`);
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
    // DRY 也把**完整填充清单**写进去（不止审计样本）——
    // 下游要用它算「这批候选里有多少真会出现在引用声明里能变成边」，
    // 只留 25 条审计样本等于让人凭感觉估收益。
    const fills = {};
    for (const [s, p] of Object.entries(plan)) if ((p.take || []).length) fills[s] = p.take.map((t) => ({ doi: t.doi, confidence: t.conf, margin: t.margin, title: t.title.slice(0, 80), ev: t.evidence }));
    fs.writeFileSync(OUT, JSON.stringify({
      ...result,
      fills,
      fillsTotal: totalFill,
      audit: audit.map((a) => ({ site: a.site, doi: a.doi, title: a.title.slice(0, 70), confidence: a.conf, margin: a.margin })),
    }, null, 2), 'utf-8');
    console.log(`[DRY] 已写产物（实体文件未动）：data/library-expand.json`);
    return;
  }
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  let newUnique = 0;
  const changed = [];
  for (const [s, v] of Object.entries(sites)) {
    const p = plan[s];
    const taken = new Map(p.take.map((t, i) => [t.doi, t]));
    // 空位顺序填充：dupIdx 里的位置逐个换成新实体
    let k = 0;
    const added = [];
    for (const idx of v.dupIdx) {
      if (k >= p.take.length) break;
      const c = p.take[k++];
      const title = String(c.title || '').trim();
      const ent = {
        id: 'doi:' + c.doi,
        name: title.replace(/\.$/, ''),
        source: 'openalex',
        // 被引文档是上一轮从 OpenAlex 抓回来的，abstract 本来就有（48,760 条里 33,540 条非空）。
        // 空着会让它变成「库里最没信息的一类实体」，抓了等于白抓。
        abstract: String(c.abstract || '').slice(0, 4000),
        url: 'https://doi.org/' + c.doi,
        authors: [],
        tags: c.topics.slice(0, 5),
        confidence: c.conf === 'high' ? 0.9 : 0.7,
        sites: [s],
        publishedDate: c.year ? String(c.year) : '',
        doi: c.doi,
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      // id 必须与站内已有 id 不撞（撞了会让下游按 id dedupe 时把两条合成一条）
      const alt = 'oa:' + c.doi.replace(/\W/g, '');
      if (!v.idSet.has(ent.id)) {
        // ok
      } else if (!v.idSet.has(alt)) {
        ent.id = alt;
      } else {
        console.error(`[ABORT] ${s}: doi ${c.doi} 的两种 id 都和站内已有 id 撞了 → 该站本次不写`);
        continue;
      }
      v.arr[idx] = ent;
      added.push({ doi: c.doi, id: ent.id, title: title.slice(0, 60) });
    }
    // ---- 完整性校验：不过就整体不写 ----
    const ids = v.arr.map((e) => String(e.id));
    const dois = v.arr.map((e) => normDoi(e && e.doi));
    const problems = [];
    if (v.arr.length !== 10000 && siteDirs.length > 1) problems.push(`条数变了 ${v.arr.length}`);
    if (new Set(ids).size !== ids.length) problems.push('id 有重复');
    if (new Set(dois).size !== dois.length) problems.push('DOI 有重复');
    if (problems.length) { console.error(`[ABORT] ${s}: ${problems.join('; ')} → 该站本次不写`); continue; }
    newUnique += new Set(dois).size;
    changed.push(s);
    fs.writeFileSync(v.file, JSON.stringify(v.arr), 'utf-8');
    result.perSite[s] = { free: p.free, filled: added.length, uniqueBefore: v.unique, uniqueAfter: new Set(dois).size };
    console.log(`  ${s}: 填 ${added.length} 条（唯一 DOI ${v.unique} → ${new Set(dois).size}）`);
  }
  result.slotAfter = { entities: totalEntities, uniqueDoi: newUnique };
  result.changedSites = changed.length;
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`\n[WRITE] 改动 ${changed.length} 站；唯一 DOI ${totalUniqueDoi} → ${newUnique}（+${newUnique - totalUniqueDoi}）；实体总数仍 ${totalEntities}`);
  console.log(`产物：data/library-expand.json`);
}
try { main(); } catch (e) { process.stderr.write('[FATAL] ' + (e && e.stack ? e.stack : String(e)) + '\n'); process.exit(1); }
