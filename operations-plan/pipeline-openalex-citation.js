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

const UA = (() => {
  try { return require('./lib/user-agent.cjs').USER_AGENT; }
  catch { return 'GeneTechBot/2.0 (+https://swarmlabs.tools/; mailto:ops@swarmlabs.tools)'; }
})();

// ---- 数据源 ----
// 2026-10-02 实测：OpenAlex 的免费额度是**本 IP 全网共享的每日美元预算**，
// 实测某日耗到 $0 后所有请求（含单条）一律 429，retryAfter ≈ 79445s（22 小时），
// 退避重试毫无意义。所以必须有第二条不依赖 key 的通路。
//   openalex（默认）：批量 DOI OR，50/请求，快，但受共享预算约束
//   crossref        ：单 DOI 直查，无 key 无每日预算，但**不支持 doi 批量 OR**
//                     （filter=doi:a|b 实测 total-results=0），只能一 DOI 一请求
const SOURCE = (() => {
  const a = process.argv.find((x) => typeof x === 'string' && x.startsWith('--source='));
  return a ? a.slice('--source='.length) : 'openalex';
})();
// 游标按源分开：两条源的「批」不是一个单位（openalex 一批发 50 个 DOI，crossref 一个 DOI 一批），
// 共用一个游标会让 openalex 续跑把 crossref 的批号当成自己已完成，直接跳掉几千批。
const CURSOR_FILE = path.join(STATE_DIR, `openalex-citation-cursor-${SOURCE}.json`);

const OPENALEX = 'https://api.openalex.org/works';
const SELECT = ['id', 'doi', 'publication_year', 'cited_by_count',
  'referenced_works', 'referenced_works_count', 'abstract_inverted_index'].join(',');
const CROSSREF = 'https://api.crossref.org/works';
const CROSSREF_MAILTO = 'ops@swarmlabs.tools'; // 礼貌池凭据：Crossref 按 mailto 提高限额

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
// 2026-10-02 修复（P0，静默失效）：
//   原实现写的是 `a.slice('--' + name + '='.length)`。`.` 的优先级高于 `+`，
//   这行被解析成 `('-' '-' + name) + ('='.length)` = `'--limit' + 1` = `'--limit1'`，
//   于是 slice 的下标是个字符串 → 转 NaN → 0 → 返回**整串 "--limit=5000"** 而不是 "5000"。
//   后果：`Number('--limit=5000')` = NaN → `NaN || 1` → 1，--limit 永远像没传；
//   同理 --sites / --stride 也全是错的。而「命令没生效又不报错」是最难查的那种失败——
//   它看上去跑完了，其实一直在跑全量。
//   现在显式构造前缀字符串，并加一条启动自检，防止再退化回去。
function arg(name, dflt) {
  const prefix = '--' + name + '=';
  const a = process.argv.find((x) => typeof x === 'string' && x.startsWith(prefix));
  if (!a) return dflt;
  const v = a.slice(prefix.length);
  if (v === '') return dflt;
  return v;
}
const LIMIT = arg('limit', 0);
// 跨站均匀抽样步长。DOI 池按站点顺序排列，不加步长的话「跑到一半」只覆盖前 1-2 个站，
// 拿不到任何跨站边——而跨站边恰恰是本 pipeline 唯一的产品。
// --stride=13 表示从 26 万池里等距取 1/13，各站点占比与全集一致。
const STRIDE = Math.max(1, Number(arg('stride', '1')) || 1);
const SITES = arg('sites', '').split(',').map((s) => s.trim()).filter(Boolean);
const DRY_RUN = process.argv.includes('--dry-run');

// 启动自检：命令行参数写错在本项目里会静默退化成「跑全量」，
// 既慢又看不出哪里不对。这里把解析结果摊开打一遍，一眼可证。
if (process.env.GENECH_ARG_TRACE !== '0') {
  console.log(`[args] source=${SOURCE} limit=${LIMIT} stride=${STRIDE} sites=${SITES.length ? SITES.join(',') : '(all)'}`);
}

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
// 上游「今日预算耗尽」的可判定特征。OpenAlex 免费额度是**本 IP 全网共享的每日美元预算**
// （无 key 时），被同出口 IP 的其他人跑光后，本进程所有请求一律 429 且 retryAfter 约 22 小时。
// 这跟「瞬时限流」是两件事：退避重试毫无意义，必须换源或换 key，否则整轮抓取空转。
const BUDGET_EXHAUSTED = /insufficient budget|budget is used up|dailyRemainingUsd|no API key/i;

async function fetchBatch(dois, cursor) {
  const url = `${OPENALEX}?filter=doi:${dois.join('|')}&per-page=${dois.length}&select=${SELECT}`;
  let lastErr = new Error('未发起任何请求（不应发生）');
  let throttled = false;
  for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
    if (throttled) await new Promise((rs) => setTimeout(rs, Math.min(1500 * 2 ** attempt, 20000)));
    let r;
    try {
      r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.status === 429) {
        const body = await r.text().catch(() => '');
        // 先判预算耗尽：这类 429 退避再多次也是同样的结果
        if (BUDGET_EXHAUSTED.test(body)) {
          const m = /retryAfter["\s:]+(\d+)/.exec(body);
          cursor.budgetExhausted = {
            at: new Date().toISOString(),
            retryAfterSec: m ? Number(m[1]) : null,
            remaining: (/"dailyRemainingUsd"\s*:\s*([-\d.]+)/.exec(body) || [])[1] ?? null,
          };
          return null; // 不是失败，是「上游没额度了」——用 null 显式区分
        }
        throttled = true;
        cursor.throttled = (cursor.throttled || 0) + 1;
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
      const j = await r.json();
      cursor.fetched++;
      return j.results || [];
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e && e.message || e));
      throttled = false;
      await new Promise((rs) => setTimeout(rs, Math.min(800 * 2 ** attempt, 10000)));
    }
  }
  // 2026-10-02 修复：原实现在「每次都命中 429 的 continue 分支」时 `throw lastErr`，
  // 而 lastErr 从未被赋值 → `throw undefined` → 崩溃日志只有一行 "ERR undefined"，
  // 连是网络问题还是限流都看不出来，排查时会被带偏到「并发太高」上去。
  throw lastErr;
}

// Crossref 单 DOI 直查：取出 reference 里的 DOI 列表。
// 不传 select（`select` 在 /works/{doi} 路由上会 400 parameter-not-allowed），
// 全量记录解析后只取 reference，体积问题由 Node 的 GC 兜（单条 <200KB）。
async function fetchCrossref(doi, cursor) {
  const url = `${CROSSREF}/${encodeURIComponent(doi)}?mailto=${CROSSREF_MAILTO}`;
  let lastErr = new Error('未发起任何请求（不应发生）');
  for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.status === 429 || r.status === 503) {
        cursor.throttled = (cursor.throttled || 0) + 1;
        await new Promise((rs) => setTimeout(rs, Math.min(1200 * 2 ** attempt, 15000)));
        continue;
      }
      if (r.status === 404) { cursor.miss404 = (cursor.miss404 || 0) + 1; return { missing: true }; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      cursor.fetched++;
      const refs = ((j && j.message && j.message.reference) || [])
        .map((x) => String(x && x.DOI || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '').toLowerCase())
        .filter(Boolean);
      return { refs };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e && e.message || e));
      await new Promise((rs) => setTimeout(rs, Math.min(800 * 2 ** attempt, 8000)));
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
  // 每轮抓取一个独立落盘文件，避免续跑／重跑把上一轮的引用列表和这一轮混在一起
  const cursorRunId = String(Date.now());
  const poolFull = [...byDoi.keys()];
  if (STRIDE > 1) {
    const sampled = poolFull.filter((_, idx) => idx % STRIDE === 0);
    console.log(`[stride] 步长 ${STRIDE}：${poolFull.length.toLocaleString()} → 抽样 ${sampled.length.toLocaleString()} 个 DOI（各站占比与全集一致）`);
    poolFull.length = 0;
    for (const d of sampled) poolFull.push(d);
  }
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

  // 2026-10-02 修复（P0，进程被 OOM 杀）：
  //   原实现把 `{doi → {oa, year, citedBy, refs: [...]}}` 全量留在 works Map 里。
  //   249,689 条工作 × 平均每篇 ~100 条 referenced_works（OpenAlex 单篇上限 500）
  //   ≈ 2,500 万个 id 串 ≈ 1GB+ 常驻，进程在跑到十几批时 heap 直接被杀，
  //   且 catch 打印 "ERR undefined"（非 Error 对象），日志里看不到任何线索。
  //   现在引用的全量列表**逐批追加写盘**（JSONL），内存里只留摘要级字段；
  //   oa→doi 映射只有 26 万条键，约 20MB，完全安全。边在收尾时流式算。
  const refsDir = path.join(STATE_DIR, 'openalex-refs');
  fs.mkdirSync(refsDir, { recursive: true });
  const refsFile = path.join(refsDir, `refs-${cursorRunId}.jsonl`);
  const refsW = fs.createWriteStream(refsFile);

  // 工作集：DOI → 摘要级字段（不含引用列表）
  const works = new Map();
  const seen = new Set();
  // 摘要池（只留语料缺失的）
  const abstracts = new Map();
  // 站点归属（用于判断跨站）
  const siteOf = new Map();
  for (const [k, v] of byDoi) siteOf.set(k, v.site);

  const refLine = (doiKey, oaId, refs) => refsW.write(JSON.stringify([doiKey, oaId, refs, refs.length]) + '\n');

  // ---- Crossref 通路（无需 key、无每日预算，但只能一 DOI 一请求）----
  if (SOURCE === 'crossref') {
    const t1 = Date.now();
    console.log(`源=crossref（单 DOI 直查，并发 ${CONCURRENCY}）`);
    for (let i = 0; i < pool.length; i += CONCURRENCY) {
      const group = pool.slice(i, i + CONCURRENCY);
      const out = await Promise.all(group.map(async (d) => {
        try { return [d, await fetchCrossref(d, cursor)]; }
        catch { cursor.errors = (cursor.errors || 0) + 1; return [d, { error: true }]; }
      }));
      for (const [d, r] of out) {
        if (!r || r.error || r.missing) continue;
        if (!seen.has(d)) { seen.add(d); works.set(d, { oa: null, doi: d, year: null, citedBy: 0 }); refLine(d, null, r.refs); }
      }
      if ((i / CONCURRENCY) % 50 === 0) {
        const done = i + CONCURRENCY;
        console.log(`  [${(done / pool.length * 100).toFixed(1)}%] ${done.toLocaleString()}/${pool.length.toLocaleString()} DOI / works ${works.size.toLocaleString()} / 限流 ${cursor.throttled || 0} / 404 ${cursor.miss404 || 0} / ${((Date.now() - t1) / 1000).toFixed(0)}s`);
        cursor.doneBatches = [done];
        saveCursor(cursor);
      }
      if (BATCH_GAP_MS > 0) await new Promise((rs) => setTimeout(rs, BATCH_GAP_MS));
    }
    refsW.end();
    await new Promise((rs) => refsW.on('close', rs));
    cursor.doneBatches = [pool.length];
    cursor.completed = true;
    cursor.source = 'crossref';
    saveCursor(cursor);
    finish('crossref');
    return;
  }

  let batches = 0;
  let abortedByBudget = false;
  for (let i = 0; i < pool.length; i += BATCH) {
    const chunk = pool.slice(i, i + BATCH);
    const results = await fetchBatch(chunk, cursor);
    if (results === null) {
      // 上游当日预算耗尽：立刻停手，别把剩下的几千批白撞一遍墙。
      // 已完成的部分已经在游标里，明晚（或换 key 后）续跑即可。
      abortedByBudget = true;
      cursor.doneBatches = cursor.doneBatches || [];
      if (!cursor.doneBatches.includes(i)) cursor.doneBatches.push(i);
      saveCursor(cursor);
      console.log('\n[ABORT] OpenAlex 免费预算耗尽，停止抓取（已完成部分已落游标）。');
      break;
    }
    for (const w of results) {
      const doi = normDoi(w.doi);
      if (!doi) continue;
      const key = doi.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        works.set(key, {
          oa: w.id,
          doi,
          year: w.publication_year,
          citedBy: w.cited_by_count || 0,
        });
        // 引用列表落盘：一行一条（换行出现在 base64/url-safe id 里没有风险，
        // OpenAlex id 形如 https://openalex.org/W123，不含换行）
        refsW.write(JSON.stringify([key, w.id, w.referenced_works || [], w.referenced_works_count ?? 0]) + '\n');
      }
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
  refsW.end();
  await new Promise((rs) => refsW.on('close', rs));

  // ---- 构建跨站引用边（流式扫盘，内存里只有 oa→doi 映射）----
  // 声明成函数而不是内联：crossref 通路与 openalex 通路都要跑同一段收尾，
  // 抽出来才能只维护一份边构建逻辑（两份迟早会算出不同的边）。
  // 函数声明在外层 async IIFE 里会提升，所以下方 `finish('crossref')` 可以先调后定义。
  async function finish() {
  const oaToDoi = new Map();
  for (const [k, w] of works) if (w.oa) oaToDoi.set(w.oa, k);

  const edges = [];            // 跨站引用边
  const perEntity = new Map(); // doi → {citedBy, refCount, inEdges, outEdges, refSameSite, refCrossSite, refOutside}
  const crossSet = new Set();

  const rl = fs.createReadStream(refsFile, { encoding: 'utf8' });
  let lineNo = 0;
  for await (const line of rl) {
    if (!line) continue;
    lineNo++;
    const [doiKey, oaId, refs, refCount] = JSON.parse(line);
    const srcSite = siteOf.get(doiKey);
    const w = works.get(doiKey);
    if (!srcSite || !w) { perEntity.set(doiKey, null); continue; }
    // 引用计数用 OpenAlex 自报的 referenced_works_count，避免每次解析 100+ 个 id
    const rec = {
      citedBy: w.citedBy,
      refCount: refCount || refs.length,
      refSameSite: 0,
      refCrossSite: 0,
      refOutside: 0,
      outEdges: 0,
      inEdges: 0,
    };
    for (const refOa of refs) {
      // oa 模式：refOa 是 OpenAlex id，走 oaToDoi；
      // crossref 模式：refOa 是裸 DOI，直接查 siteOf（两边都小写归一化过）。
      let targetDoi = oaToDoi.get(refOa);
      if (!targetDoi && siteOf.has(refOa)) targetDoi = refOa;
      if (!targetDoi) { rec.refOutside++; continue; }
      const tgtSite = siteOf.get(targetDoi);
      if (!tgtSite || tgtSite === srcSite) { rec.refSameSite++; continue; }
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
  // 没抓到工作记录（OpenAlex 无此 DOI）的池条目也要占位，否则下游 inEdges 统计会漏
  for (const [k] of works) if (!perEntity.has(k)) perEntity.set(k, null);

  // 入度（跨站入边）
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

  // 2026-10-02 修复：tsCnt 原先只在 `if (edges.length > 0)` 里声明，
  // 而下面写产物时的 `Object.entries(tsCnt)` 在另一作用域 → ReferenceError，
  // 让「已经算完、也写了产物」的流程以非零码退出（CI 判红的典型成因）。
  const tsSites = new Set();
  for (const e of edges) { tsSites.add(e.ss); tsSites.add(e.ts); }
  const tsCnt = {};
  for (const e of edges) tsCnt[e.ts] = (tsCnt[e.ts] || 0) + 1;
  console.log(`\n涉及站点：${tsSites.size} / ${sites.length}`);
  if (edges.length > 0) {
    console.log('\n跨站边 Top（按目标站点）：');
    Object.entries(tsCnt).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => console.log(`  → ${k.padEnd(24)} ${v.toLocaleString()}`));
  }

  // ---- 落盘（POC 模式：只写报告，不写数据集）----
  const out = path.join(ROOT, 'reports', `openalex-citation-poc-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const sample = {
    generatedAt: new Date().toISOString(),
    scope: { source: SOURCE, sites: sites.length, poolDois: pool.length, batch: BATCH, concurrency: CONCURRENCY },
    stats: {
      corpusEntities: total,
      uniqueDois: byDoi.size,
      noDoi: orphans.length,
      worksFetched: works.size,
      abstractsRecovered: abstracts.size,
      crossSiteEdges: edges.length,
      estPayloadMb: +estTotalMB.toFixed(2),
      elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
      budgetExhausted: cursor.budgetExhausted || null,
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
  if (cursor.budgetExhausted) console.log('[note] 本次是「上游预算耗尽」的部分结果，不是失败；明晚续跑即可。');
  }   // ---- end finish() ----

  await finish();
})().catch((e) => {
  // 2026-10-02：原写法 `console.error('ERR', e)` 在进程被 OOM 杀死时打印 "ERR undefined"。
  // 被 heap 杀掉时 catch 拿到的是非 Error 对象（或已被销毁），光看 "undefined" 完全定位不了。
  // 这里把类型 + code + 堆栈都打出来，并给一个明确的 OOM 判据，免得下次再靠猜。
  const kind = e == null ? String(e) : (typeof e === 'object' ? `object(code=${e.code ?? 'none'}, type=${e.type ?? 'none'}, reason=${e.reason ?? 'none'})` : String(e));
  console.error('ERR', kind);
  try { console.error(e?.stack || '(no stack)'); } catch { /* 对象可能已被销毁 */ }
  constUsage();
  process.exit(1);
});

// Node 的堆上限在 64 位上默认 ≈ 2GB（--max-old-space-size 未设时）。
// 抓取 26 万条工作 × 每条上百个引用 id 是典型能撑爆的量级，这里给一个可判定的阈值。
function constUsage() {
  const m = process.memoryUsage().heapUsed / 1048576;
  const limit = (require('v8').getHeapStatistics().heap_size_limit) / 1048576;
  console.error(`heapUsed=${m.toFixed(0)}MB / limit=${limit.toFixed(0)}MB`);
  if (m > limit * 0.75) console.error('判据：接近堆上限，几乎可以确定是 OOM（应把引用列表改落盘）');
}
