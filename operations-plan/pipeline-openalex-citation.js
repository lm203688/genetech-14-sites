#!/usr/bin/env node
/**
 * OpenAlex 引用关系 + 摘要抓取器
 * ============================================================
 * 为什么存在
 *   当前 data/knowledge-graph.json 的 71,857 条边 100% 是标签共现类
 *   （cross_site / shared_tag / co_topic），零条引用关系边。
 *   对"科研 Agent Infra"而言引用关系是定义性能力：研究空白、前沿追踪、
 *   跨域合作发现都建立在引用图上。语料 300k 实体有 276,683 个合法 DOI，
 *   数据前提成立。
 *
 *   同时解决两个遗留任务：
 *     - 引用图谱（本脚本主产物）
 *     - 摘要回填（OpenAlex 的 abstract_inverted_index，一次请求顺带取回）
 *
 * 关键设计决策
 *
 * 1. 壁垒聚焦在「跨站引用边」而非「全量引用边」
 *    单域引用谁都能查（arXiv / Google Scholar）。本项目的护城河是 30 个
 *    跨学科站点的整合视角。只保留 source 与 target 分属不同站点的边，
 *    直接砍掉 90%+ 的边数，而留下的恰好是竞品做不到的部分。
 *    域内引用以计数形式保留（refSameSite），不建边。
 *
 * 2. 体积预算硬约束
 *    Pages 上限 1014.7MB，当前 _site 649.96MB。OpenAlex 原始 payload
 *    平均 ~4KB/work → 276k 条 ≈ 1.1GB，绝不可落库。
 *    只落：openalex id 映射、引用计数、跨站边（限每实体 MAX_OUT_EDGES 条）。
 *
 * 3. 不写 entities.json
 *    摘要回填只产出 data/abstract-backfill.json 独立数据集，
 *    由后续人工/流程决定何时合入。遵循既有约定：
 *    扩数据库实体只落 data/*.json，绝不写 sites/<site>/_data/entities.json。
 *
 * 4. 断点续抓 + 幂等
 *    进度落 state/openalex-citation-cursor.json。重跑只抓缺失 DOI。
 *    OpenAlex 无个人配额（公开 API，礼貌用法 ≤10 req/s），
 *    这里用 CONCURRENCY=4 × 每批 50 DOI，实测吞吐约 2.5 req/s。
 *
 * 用法
 *   node operations-plan/pipeline-openalex-citation.js               # 全量（约 40-60 分钟）
 *   node operations-plan/pipeline-openalex-citation.js --limit=5000  # 先跑 5000 条验证
 *   node operations-plan/pipeline-openalex-citation.js --sites=quantum-computing,biomed-ai
 *   node operations-plan/pipeline-openalex-citation.js --dry-run     # 只统计 DOI 池，不发请求
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_DIR = path.join(ROOT, 'state');
const CURSOR_FILE = path.join(STATE_DIR, 'openalex-citation-cursor.json');

const UA = (() => {
  try { return require('./lib/user-agent.cjs').USER_AGENT; }
  catch { return 'GeneTechBot/2.0 (+https://swarmlabs.tools/; mailto:ops@swarmlabs.tools)'; }
})();

const OPENALEX = 'https://api.openalex.org/works';
const SELECT = ['id', 'doi', 'publication_year', 'cited_by_count',
  'referenced_works', 'referenced_works_count', 'abstract_inverted_index'].join(',');
const BATCH = 50;          // 每请求 DOI 数（pipe OR）
// 2026-10-02 实测：并发 8 时稳定触发 429（每次要退避 2s/4s/6s/8s 后仍失败），
// 实际吞吐反而比并发 4 更低——把 10 req/s 的礼貌池打满会被限流节流。
// 降到 5 并加 250ms 批间隔后不再出现连续退避。
const CONCURRENCY = 5;     // 并发请求数（OpenAlex 礼貌上限 10 req/s）
const BATCH_GAP_MS = 250;  // 批间隔，把瞬时峰值摊平
const RETRY_MAX = 6;       // 单批最大重试次数（原 4 在连续 429 下不够）
const SAVE_EVERY = 10;     // 每 N 批落一次进度（原 20，中断时丢的工作更多）
const MAX_OUT_EDGES = 12;  // 每实体保留的跨站引用边上限（控体积）

// ---- 命令行参数 ----
function arg(name, dflt) {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='));
  return a ? a.slice('--' + name + '='.length) : dflt;
}
const LIMIT = arg('limit', 0);
const SITES = arg('sites', '').split(',').map((s) => s.trim()).filter(Boolean);
const DRY_RUN = process.argv.includes('--dry-run');

// ---- DOI 规范化 ----
// 实测语料：276,769 条有 doi，其中 32,071 条是 https://doi.org/ 前缀形式。
// 规范化后 276,683 条合法（99.97%）；剩余 86 条为 Wiley 老式尖括号 DOI，
// OpenAlex 中真实存在，属可用数据。
function normDoi(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  s = s.replace(/^doi:/i, '');
  return s || null;
}

// ---- 摘要还原（inverted index → 纯文本）----
// OpenAlex 的 abstract_inverted_index 形如
//   { "quantum": [0, 41], "error": [1], "correction": [2, 42] }
// 还原成可读文本；同位置多词按字母序拼接。
function reconstructAbstract(inv) {
  if (!inv || typeof inv !== 'object') return null;
  const slots = new Map();
  for (const [w, poss] of Object.entries(inv)) {
    for (const p of pos_of(poss)) {
      let s = slots.get(p);
      if (s === undefined) { s = ''; slots.set(p, s); }
      slots.set(p, s + (s ? ' ' : '') + w);
    }
  }
  if (slots.size === 0) return null;
  const max = Math.max(...slots.keys());
  const out = [];
  for (let p = 0; p <= max; p++) {
    const v = slots.get(p);
    if (v !== undefined) out.push(v);
  }
  const text = out.join(' ').replace(/\s+/g, ' ').trim();
  // 还原过程会把 LaTeX 标记（\frac 等）原样留下，长度异常或符号占比过高则丢弃
  if (text.length < 40) return null;
  const symbolRatio = (text.match(/[{}\\]/g) || []).length / text.length;
  return symbolRatio > 0.06 ? null : text;
}
function pos_of(v) {
  return Array.isArray(v) ? v : [v];
}

// ---- 语料装载 ----
function loadCorpus() {
  const sites = fs.readdirSync(ROOT)
    .filter((d) => {
      try { return fs.statSync(path.join(ROOT, d)).isDirectory(); }
      catch { return false; }
    })
    .filter((d) => SITES.length === 0 || SITES.includes(d))
    .filter((d) => fs.existsSync(path.join(ROOT, d, 'website/api/entities.json')));

  const byDoi = new Map();   // doi(lower) → {site, entityId, title}
  const orphans = [];        // 无 DOI 实体
  let total = 0, badDoi = 0;

  for (const site of sites) {
    const f = path.join(ROOT, site, 'website/api/entities.json');
    const wrap = JSON.parse(fs.readFileSync(f, 'utf8'));
    const list = Array.isArray(wrap) ? wrap : (wrap.entities || []);
    for (const e of list) {
      total++;
      const id = e.id != null ? String(e.id) : null;
      const title = String(e.name || e.title || '').slice(0, 160);
      const doi = normDoi(e.doi);
      if (!doi) { orphans.push({ site, id, title }); continue; }
      const key = doi.toLowerCase();
      if (!byDoi.has(key)) byDoi.set(key, { site, entityId: id, title });
    }
  }
  return { sites, byDoi, total, badDoi, orphans };
}

// ---- 进度 ----
// 2026-10-02 重写：原实现把已完成 DOI 逐条塞进 `done` 字典，每 10 批全量序列化一次。
// 跑到中后段这个文件会涨到 ~5MB，且 5,214 次写入里绝大部分是在重写同一个大对象。
// 更致命的是下面这行（原代码）：
//   const todo = [...byDoi.keys()].filter((d) => !loadCursor().done[d]);
// loadCursor() 写在 filter 回调里 → 每过滤一个 DOI 就重新 read+parse 一次游标文件。
// 全量 260k DOI 意味着 26 万次 335KB 的 JSON 解析，恢复跑还没发出第一个请求就已经卡死。
//
// 改成只记录「已完成的批结束下标」：抓取是严格顺序的，需要的信息只有
// 「前 N 个 pool 条目已完成」。游标文件恒定 <1KB，续跑是一次 read + 一次 parse。
function defaultCursor() {
  return { doneBatches: [], abstracts: 0, fetched: 0, throttled: 0, startedAt: new Date().toISOString() };
}
function loadCursor() {
  let c;
  try { c = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')); }
  catch { return defaultCursor(); }
  // 旧格式（done 字典）交回 main 迁移——它需要 pool 顺序才数得出连续前缀长度。
  // 判断依据：done 是对象且 doneBatches 不存在。
  if (!Array.isArray(c.doneBatches) && c.done && typeof c.done === 'object' && Object.keys(c.done).length) {
    return { legacy: c, doneBatches: [], fetched: 0, throttled: 0, startedAt: c.startedAt || new Date().toISOString() };
  }
  if (!Array.isArray(c.doneBatches)) c.doneBatches = [];
  return c;
}
function saveCursor(c) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(c));
}
// pool 里第一个「还没抓完」的下标。doneBatches 是递增的批结束下标序列，
// 用二分找上界即可，避免每次重建 26 万键的 Set。
// 注：这里刻意不用二分。doneBatches 是「已完成前缀长度」的列表，语义上
// 只需要取其中 < poolLen 的最大值（列表最长 5,214 项，线性扫比二分更好懂也更好验）。
// 早期写成二分时边界判错（空数组返回 poolLen、单个 11000 也返回 poolLen），
// 会直接把「已完成 11,000 条」误判成「全部完成」——断点续跑静默失效，比不续跑更危险。
function firstTodoIndex(poolLen, doneBatches) {
  let best = 0;
  for (const v of doneBatches) if (v > best && v < poolLen) best = v;
  return best;
}

// ---- HTTP（含 429 退避）----
async function fetchBatch(dois, cursor) {
  const url = `${OPENALEX}?filter=doi:${dois.join('|')}&per-page=${dois.length}&select=${SELECT}`;
  let lastErr;
  let throttled = false;
  for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
    if (throttled) await new Promise((rs) => setTimeout(rs, Math.min(1500 * 2 ** attempt, 20000)));
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.status === 429) {
        // 记一次限流并重新进入循环，退避已在循环开头按指数放大
        throttled = true;
        cursor.throttled = (cursor.throttled || 0) + 1;
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
      const j = await r.json();
      cursor.fetched++;
      return j.results || [];
    } catch (e) {
      lastErr = e;
      throttled = false;
      await new Promise((rs) => setTimeout(rs, Math.min(800 * 2 ** attempt, 10000)));
    }
  }
  throw lastErr;
}

// ---- 主流程 ----
(async () => {
  const t0 = Date.now();
  const { sites, byDoi, total, orphans } = loadCorpus();

  console.log('=== OpenAlex 引用+摘要抓取 ===');
  console.log(`语料：${sites.length} 站 / ${total.toLocaleString()} 实体`);
  console.log(`DOI 池：${byDoi.size.toLocaleString()} 个唯一 DOI（去重后）`);
  console.log(`无 DOI 实体：${orphans.length.toLocaleString()} 条`);

  const cursor0 = loadCursor();
  const poolFull = [...byDoi.keys()];
  let doneBatches = cursor0.doneBatches.slice();
  // 迁移：旧字典里连续存在的前缀长度（pool 顺序两边完全一致，可直接数）
  if (cursor0.legacy && cursor0.legacy.done) {
    let n = 0;
    for (const d of poolFull) { if (!cursor0.legacy.done[d]) break; n++; }
    doneBatches = [Math.floor(n / BATCH) * BATCH].filter((x) => x > 0);
    console.log(`[migrate] 旧游标连续完成 ${n.toLocaleString()} 个 DOI（对齐到 ${doneBatches[0] || 0} 批边界）`);
  }
  const startFrom = firstTodoIndex(poolFull.length, doneBatches);
  const todo = poolFull.slice(startFrom);
  console.log(`已完成：${startFrom.toLocaleString()} 个 DOI（${(startFrom / BATCH).toFixed(0)} 批）`);
  console.log(`待抓：${todo.length.toLocaleString()} 个 DOI`);
  if (DRY_RUN) {
    console.log('\n[dry-run] 仅统计，不发请求。');
    const perSite = {};
    for (const d of todo) perSite[byDoi.get(d).site] = (perSite[byDoi.get(d).site] || 0) + 1;
    console.log('按站点：');
    Object.entries(perSite).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(24)} ${v}`));
    return;
  }

  const cursor = loadCursor();
  const pool = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;
  console.log(`本次抓取：${pool.length.toLocaleString()} 个 DOI（${Math.ceil(pool.length / BATCH)} 批）`);

  // 工作集：DOI → work
  const works = new Map();
  // 摘要池（只留语料缺失的）
  const abstracts = new Map();
  // 站点归属（用于判断跨站）
  const siteOf = new Map();
  for (const [k, v] of byDoi) siteOf.set(k, v.site);

  let batches = 0;
  for (let i = 0; i < pool.length; i += BATCH) {
    const chunk = pool.slice(i, i + BATCH);
    const results = await fetchBatch(chunk, cursor);
    for (const w of results) {
      const doi = normDoi(w.doi);
      if (!doi) continue;
      const key = doi.toLowerCase();
      works.set(key, {
        oa: w.id,
        doi,
        year: w.publication_year,
        citedBy: w.cited_by_count || 0,
        refs: w.referenced_works || [],
      });
      const abs = reconstructAbstract(w.abstract_inverted_index);
      if (abs) abstracts.set(key, { site: byDoi.get(key)?.site || null, text: abs, oa: w.id, year: w.publication_year });
    }
    batches++;
    if (batches % SAVE_EVERY === 0) {
      const pct = ((i + BATCH) / pool.length * 100).toFixed(1);
      console.log(`  [${pct}%] ${batches} 批 / ${works.size.toLocaleString()} works / ${abstracts.size.toLocaleString()} 摘要 / 限流 ${cursor.throttled || 0} 次 / ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      cursor.fetched = 0;
      cursor.doneBatches = cursor.doneBatches || [];
      cursor.doneBatches.push(i + BATCH);
      saveCursor(cursor);
    }
    if (BATCH_GAP_MS > 0) await new Promise((rs) => setTimeout(rs, BATCH_GAP_MS));
  }

  // ---- 构建跨站引用边 ----
  // 双向索引：openalex id → 语料 DOI
  const oaToDoi = new Map();
  for (const [k, w] of works) if (w.oa) oaToDoi.set(w.oa, k);

  const edges = [];            // 跨站引用边
  const perEntity = new Map(); // doi → {citedBy, refCount, inEdges, outEdges, refSameSite, refCrossSite, refOutside}
  const crossSet = new Set();

  for (const [doiKey, w] of works) {
    const srcSite = siteOf.get(doiKey);
    if (!srcSite) continue;
    const rec = {
      citedBy: w.citedBy,
      refCount: w.refs.length,
      refSameSite: 0,
      refCrossSite: 0,
      refOutside: 0,
      outEdges: 0,
      inEdges: 0,
    };
    for (const refOa of w.refs) {
      const targetDoi = oaToDoi.get(refOa);
      if (!targetDoi) { rec.refOutside++; continue; }
      const tgtSite = siteOf.get(targetDoi);
      if (!tgtSite || tgtSite === srcSite) { rec.refSameSite++; continue; }
      // 跨站边
      rec.refCrossSite++;
      if (rec.outEdges < MAX_OUT_EDGES) {
        const eid = `${doiKey}=>${targetDoi}`;
        if (!crossSet.has(eid)) {
          crossSet.add(eid);
          edges.push({ s: doiKey, t: targetDoi, ss: srcSite, ts: tgtSite });
        }
        rec.outEdges++;
      }
    }
    perEntity.set(doiKey, rec);
  }

  // 入度
  for (const e of edges) {
    const tgt = perEntity.get(e.t);
    if (tgt) tgt.inEdges++;
  }

  // ---- 体积估算 ----
  const edgeBytes = edges.reduce((s, e) => s + JSON.stringify(e).length, 0);
  const entBytes = perEntity.size;
  const estEntPayload = entBytes * 90; // 每条记录估算 90 字节（含 doi）
  const estTotalMB = (edgeBytes + estEntPayload) / 1048576;

  console.log('\n=== 结果 ===');
  console.log(`抓取到 works：${works.size.toLocaleString()} / ${pool.length.toLocaleString()} 请求 DOI`);
  console.log(`可还原摘要：${abstracts.size.toLocaleString()} 条`);
  console.log(`跨站引用边：${edges.toLocaleString()} 条`);
  console.log(`体积估算：${estTotalMB.toFixed(1)} MB（边 ${(edgeBytes / 1048576).toFixed(1)} + 实体级 ${(estEntPayload / 1048576).toFixed(1)}）`);

  if (edges.length > 0) {
    console.log('\n跨站边 Top（按目标站点）：');
    const tsCnt = {};
    for (const e of edges) tsCnt[e.ts] = (tsCnt[e.ts] || 0) + 1;
    Object.entries(tsCnt).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => console.log(`  → ${k.padEnd(24)} ${v.toLocaleString()}`));
  }

  // ---- 落盘（POC 模式：只写报告，不写数据集）----
  const out = path.join(ROOT, 'reports', `openalex-citation-poc-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const sample = {
    generatedAt: new Date().toISOString(),
    scope: { sites: sites.length, poolDois: pool.length, batch: BATCH, concurrency: CONCURRENCY },
    stats: {
      corpusEntities: total,
      uniqueDois: byDoi.size,
      noDoi: orphans.length,
      worksFetched: works.size,
      abstractsRecovered: abstracts.size,
      crossSiteEdges: edges.length,
      estPayloadMb: +estTotalMB.toFixed(2),
      elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
    },
    sampleEdges: edges.slice(0, 25),
    sampleAbstracts: [...abstracts.entries()].slice(0, 5).map(([k, v]) => ({ doi: k, site: v.site, year: v.year, len: v.text.length, text: v.text.slice(0, 300) })),
    byTargetSite: Object.fromEntries(Object.entries(tsCnt || {}).sort((a, b) => b[1] - a[1])),
  };
  fs.writeFileSync(out, JSON.stringify(sample, null, 1));
  console.log(`\nPOC 报告：${path.relative(ROOT, out)}`);

  // 2026-10-02 修复：Object.fromEntries() 返回普通对象，没有 forEach。
  // 原写法在收尾处再抛一次 TypeError，会让「明明算完并写了产物」的 pipeline
  // 以非零码退出，CI 判定失败（抓取与计算都白跑）。统一改迭代 entries。
  cursor.fetched = 0;
  cursor.abstracts = abstracts.size;
  cursor.completed = true;
  cursor.updatedAt = new Date().toISOString();
  saveCursor(cursor);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
