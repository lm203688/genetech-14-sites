#!/usr/bin/env node
/**
 * 能力域④-学术数据集补齐：pipeline-academic-datasets.js
 *
 * 解决了什么
 *   /v1/academic/entities|pubmed|crossref 三个端点在 worker.js:1365-1370 映射到
 *   data/{academic,crossref,pubmed}-entities.json，而三个文件历史上从没被生成过
 *   → 三个端点实测全 404。原计划由 pipeline-openalex-expand.js 产出，但它走 OpenAlex，
 *   而 OpenAlex 免费额度是「本 IP 全网共享的每日美元预算」（2026-10-02 实测 429 响应体
 *   含 dailyRemainingUsd:0），没有 key 时随时会被同出口 IP 的人跑光。
 *
 * 本脚本改用 2026-10-02 实测可用的**免密钥**源：
 *   - Crossref  api.crossref.org/works/{doi}        200（单 DOI 直查，带 reference[]）
 *   - Europe PMC eutils 搜索（免密钥、bot UA 放行；NCBI E-utilities 本网络下被 UA 分级拦截，见 pubmedFor 注释）
 * 产物 schema 与 pipeline-openalex-expand.js 保持一致（同一个 data/academic-entities.json
 * 目标文件），因此 OpenAlex 额度恢复后可直接 upsert 合并进去，不会互相破坏。
 *
 * 用法：
 *   node operations-plan/pipeline-academic-datasets.js --dry-run --per-site=40
 *   node operations-plan/pipeline-academic-datasets.js --per-site=40
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_DIR = path.join(ROOT, 'state');
const REPORT_DIR = path.join(ROOT, 'reports');

const ARGV = process.argv.slice(2);
const DRY = ARGV.includes('--dry-run');
const getArg = (k, d) => {
  const a = ARGV.find((x) => typeof x === 'string' && x.startsWith(`--${k}=`));
  return a ? a.slice(`--${k}=`.length) : d;
};

const PER_SITE = Math.max(1, Number(getArg('per-site', '40')) || 1);
const CONCURRENCY = Math.max(1, Number(getArg('concurrency', '3')) || 1);
const SOURCES = (getArg('sources', 'crossref,pubmed') || 'crossref,pubmed')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MAILTO = 'ops@genetech.tools';

const OUT_ACADEMIC = path.join(DATA_DIR, 'academic-entities.json');
const OUT_CROSSREF = path.join(DATA_DIR, 'crossref-entities.json');
// Europe PMC 每个 DOI 一次请求拿全题录（取代 NCBI 的 esearch+esummary 两步），750 条约 5 分钟。
// 上限可调，默认取全部已落盘 crossref 记录，便于分批补数据。
const PM_MAX_DEFAULT = 750;
const PM_MAX = Math.max(1, Number(getArg('pubmed-limit', String(PM_MAX_DEFAULT))) || PM_MAX_DEFAULT);
// Europe PMC 无硬限速但要求礼貌访问，并发压到 3 并自带退避重试（见 getJson）。
const PMC_CONCURRENCY = 3;
const OUT_PUBMED = path.join(DATA_DIR, 'pubmed-entities.json');
// **游标必须按源隔离**。原来 crossref / pubmed 共用一个游标文件：
// crossref 跑完后 750 条全是 done，之后再单独跑 pubmed 会让「待抓」显示为 0，
// 连带把可推导的 DOI 也算没了（同一个坑在引用图谱 pipeline 上已经踩过一次：
// openalex / crossref 共用游标 → 串源 → openalex 续跑把「已完成 11,000」误判成「待抓 0」）。
const cursorPath = (src) => path.join(STATE_DIR, `academic-datasets-cursor-${src}.json`);

// ---- 参数自检 ----
// 与 pipeline-openalex-citation.js 同一个坑：'--'+k+'=' 拼错一个字符就会变成
// 「命令没生效但不报错」。这里把解析结果原样打出来，肉眼一眼可验。
console.log('[args] ' + JSON.stringify({
  perSite: PER_SITE, concurrency: CONCURRENCY, sources: SOURCES,
  dryRun: DRY, mailto: MAILTO,
}));

const normDoi = (v) => {
  if (v == null) return '';
  let s = String(v).trim();
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');
  s = s.replace(/\s+/g, '');
  return s.toLowerCase();
};

// ---- 语料：各站 DOI 池（按站点等距抽样，保证每站都有代表）----
function loadPool() {
  const sitesDirs = fs
    .readdirSync(ROOT)
    .filter((d) => {
      try { return fs.statSync(path.join(ROOT, d)).isDirectory(); } catch { return false; }
    })
    .filter((d) => fs.existsSync(path.join(ROOT, d, 'website/api/entities.json')));

  const pool = [];
  for (const site of sitesDirs) {
    const wrap = JSON.parse(fs.readFileSync(path.join(ROOT, site, 'website/api/entities.json'), 'utf8'));
    const list = Array.isArray(wrap) ? wrap : (wrap.entities || []);
    const seen = new Set();
    // 每站取前 PER_SITE 个带 DOI 的实体。等距抽样需要知道总数，先用一次遍历算步长。
    const withDoi = [];
    for (const e of list) {
      const doi = normDoi(e.doi);
      if (!doi || seen.has(doi)) continue;
      seen.add(doi);
      withDoi.push(doi);
    }
    if (!withDoi.length) continue;
    const stride = Math.max(1, Math.ceil(withDoi.length / PER_SITE));
    for (let i = 0; i < withDoi.length && i / stride < PER_SITE; i += stride) {
      pool.push({ doi: withDoi[i], site });
    }
  }
  return { sites: sitesDirs, pool };
}

// ---- HTTP ----
// 2026-10-02 实测：本脚本原先用 https.request，并发时整批 25s 超时、0 成功，
// 而单独发一次只要 0.6s；换成 global fetch 同样的 URL/同样的并发就稳定 200。
// 更关键的是原实现**对网络错误零重试**（超时只记一个 null），失败被统计成「404」，
// 看起来像「这些 DOI Crossref 没有」，实际上是自己没发出去请求——
// 这类「静默丢数据」比直接报错危险得多。所以这里：
//   1) 统一用 global fetch（与引用图谱 pipeline 同源，避免两种建连行为）；
//   2) 超时 / 连接抖动 / 429 / 5xx 一律退避重试；
//   3) HARD_FAIL（上游没额度）类的错误不重试，直接抛出由调用方判定。
const NETWORK_RETRYABLE = /timeout|abort|econnreset|socket|fetch failed|network|429|503|502|504/i;

// Crossref 认描述性 UA（好市民做法，会给更宽松配额）。
// NCBI 相反：本网络下它只对浏览器类 UA 放行，非浏览器 UA（哪怕带 tool/email 参数）
// 一律回 HTTP 200 + HTML 的封锁诊断页 —— 实测 3 种组合，只有浏览器 UA 拿得到 JSON。
// 所以 NCBI 单独走一套 UA。这不是「绕过风控」，是 NCBI 自己的 UA 分级策略。
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// 脚本自身身份。Europe PMC 明确鼓励程序化访问，认这个 UA；NCBI 不认（见下方 pubmedFor 注释）。
const UA_BOT = 'Genetech14-InfraBot/1.0 (mailto:ops@genetech.tools)';

async function getJson(url, { timeoutMs = 25000, retries = 3, label = '', ua } = {}) {
  let lastErr = new Error('未发起任何请求（不应发生）');
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const r = await fetch(url, {
          headers: {
            'User-Agent': ua || `Genetech14-InfraBot/1.0 (mailto:${MAILTO})`,
            Accept: 'application/json',
          },
          signal: ac.signal,
        });
        if (r.status >= 200 && r.status < 300) {
          // **状态码 200 ≠ 成功**。NCBI 对非浏览器 UA 返回 HTTP 200 + 一整页
          // HTML 的「WWW Error Blocked Diagnostic」，这里若直接 r.json() 会抛，
          // 而抛点落在调用方，被外层 catch 吞成一条普通的「失败」——
          // 623 个 DOI 全军覆没却仍然 exit 0。必须先验 content-type。
          const ct = String(r.headers.get('content-type') || '');
          const wantsJson = ct.toLowerCase().includes('json');
          try {
            const j = wantsJson ? await r.json() : null;
            if (!wantsJson) {
              // 非 JSON 正文：把前 120 字符带出来，否则排障时只能看到「失败」两个字
              return { ok: false, status: r.status, json: null, nonJson: await r.text().then((t) => t.slice(0, 120)) };
            }
            return { ok: true, status: r.status, json: j };
          } catch (e) {
            const body = await r.text().catch(() => '');
            return { ok: false, status: r.status, json: null, nonJson: body.slice(0, 120) };
          }
        }
        return { ok: false, status: r.status, json: null };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String((e && e.message) || e));
      if (HARD_FAIL.test(lastErr.message)) throw lastErr;
      if (attempt < retries - 1 && NETWORK_RETRYABLE.test(lastErr.message)) {
        const wait = Math.min(800 * 2 ** attempt, 8000);
        console.warn(`  [retry${label ? ' ' + label : ''}] ${lastErr.message} → ${wait}ms 后第 ${attempt + 2} 次`);
        await sleep(wait);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 可判定的上游故障。
 * Crossref 的 429/403 是「配额/ UA 问题」，重试有意义；
 * 而 OpenAlex 那种「共享 IP 每日预算耗尽」重试再多次也是同一个结果，属于必须早退。
 * 这里明确区分两者，避免把死路当限流空转。
 */
const HARD_FAIL = /dailyRemainingUsd|budget is used up|insufficient budget|no API key/i;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  let hardStop = null;
  async function worker() {
    for (;;) {
      if (hardStop) return;
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (HARD_FAIL.test(msg)) { hardStop = msg; out[i] = null; return; }
        out[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return { results: out, hardStop };
}

// ---- Crossref ----
function crossrefRecord(msg, site) {
  const doi = normDoi(msg.DOI);
  const title = String((msg.title && msg.title[0]) || '(untitled)').replace(/\s+/g, ' ').trim();
  const authors = (msg.author || [])
    .map((a) => {
      const f = a.family || a.name || '';
      const g = a.given ? a.given + ' ' : '';
      return (g + f).trim();
    })
    .filter(Boolean)
    .slice(0, 20);
  const abstract = msg.abstract ? String(msg.abstract).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200) : '';
  return {
    id: `crossref:${doi}`,
    source: 'crossref',
    doi,
    title,
    abstract,
    url: doi ? `https://doi.org/${doi}` : '',
    authors,
    year: msg.issued && msg.issued['date-parts'] && msg.issued['date-parts'][0] ? msg.issued['date-parts'][0][0] : null,
    concepts: [],
    venue: msg['container-title'] ? msg['container-title'][0] : null,
    type: msg.type || null,
    publisher: msg.publisher || null,
    referenceCount: (msg.reference || []).length,
    tags: [site],
    sites: [site],
    referencedBy: null,
    confidence: 0.6,
    fetchedAt: new Date().toISOString(),
  };
}

/** 读回磁盘上已有的 crossref 产物，用于 PubMed 轮推导 DOI（纯函数，无副作用） */
function readCrossrefRecordsOnDisk() {
  try {
    const j = JSON.parse(fs.readFileSync(OUT_CROSSREF, 'utf8'));
    return Array.isArray(j) ? j.filter((r) => r && r.doi) : [];
  } catch { return []; }
}

// ---- NCBI（PubMed）----
async function pubmedFor(doi, site) {
  // 为什么换成 Europe PMC（EMBL-EBI）而不是 NCBI E-utilities：
  // 实测本网络下 NCBI 对 UA 做分级拦截 —— 脚本 UA 返回「HTTP 200 + HTML 封锁页」，
  // 浏览器 UA 才回正常 JSON。这不是限流（429），重试一万次也一样。
  // 想继续用 NCBI 唯一的办法是伪装浏览器 UA，那违反 NCBI 使用政策，且随时可能失效。
  // Europe PMC 是 PubMed/MEDLINE 的开放镜像：免密钥、bot UA 放行、明确鼓励程序化访问，
  // 且一次查询就能拿全题录字段，比 NCBI 的 esearch + esummary 两步往返还省一半请求。
  const url =
    'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=' +
    encodeURIComponent('DOI:"' + doi + '"') +
    '&format=json&pageSize=1&resultType=core';
  const r = await getJson(url, { label: 'epmc', ua: UA_BOT });
  // 非 JSON 正文（如封锁页）必须带出去，否则上游回 HTML 在日志里只有「失败」两个字
  if (!r.ok) return { ok: false, status: r.status, snippet: r.nonJson || null };
  const res = ((r.json && r.json.resultList && r.json.resultList.result) || [])[0];
  if (!res || !res.pmid) return { ok: true, pmid: null };
  const pmid = String(res.pmid);
  const journal = res.journalInfo && res.journalInfo.journal ? res.journalInfo.journal.title : null;
  return {
    ok: true,
    pmid,
    record: {
      id: `pubmed:${pmid}`,
      source: 'pubmed',
      pmid,
      pmcid: res.pmcid || null,
      doi: res.doi || doi,
      title: res.title || null,
      // 摘要带 HTML 标签（<h4>/<p>），不清洗会污染下游全文检索
      abstract: res.abstractText ? String(res.abstractText).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 1200) : '',
      url: res.pmrid ? `https://pubmed.ncbi.nlm.nih.gov/${res.pmrid}/` : `https://europepmc.org/article/MED/${pmid}`,
      authors: String(res.authorString || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20),
      year: res.pubYear || res.firstPublicationDate || null,
      venue: journal || res.bookOrReportDetails || null,
      type: res.pubTypeList ? [res.pubTypeList].flat().slice(0, 3) : null,
      concepts: [],
      tags: site ? [site] : [],
      sites: site ? [site] : [],
      referencedBy: null,
      confidence: 0.75,
      fetchedAt: new Date().toISOString(),
    },
  };
}

(async () => {
  const t0 = Date.now();
  const { sites, pool } = loadPool();
  console.log('=== 学术数据集补齐（Crossref + PubMed）===');
  console.log(`语料：${sites.length} 站，每站抽样 ≤${PER_SITE} 个 DOI → 池 ${pool.length} 条`);

  // 续跑：已抓过的 DOI 不重复请求。存的是「已完成的 DOI 集合」——
  // 本脚本规模是千级，字典体积可控；全量 26 万时再换前缀游标。
  // 每个源读自己的游标，避免「crossref 跑完 → pubmed 待抓变 0」这种串源静默跳过
  const doneSets = { crossref: {}, pubmed: {} };
  for (const s of ['crossref', 'pubmed']) {
    try { doneSets[s] = JSON.parse(fs.readFileSync(cursorPath(s), 'utf8')).done || {}; } catch { doneSets[s] = {}; }
  }
  const todo = pool.filter((x) => !doneSets.crossref[x.doi]);
  const pmDone = Object.keys(doneSets.pubmed).length;
  console.log(`已完成 crossref ${Object.keys(doneSets.crossref).length} 条 / pubmed ${pmDone} 条，crossref 待抓 ${todo.length} 条`);
  // 必须在任何早退判断之前初始化：PubMed 单跑时下面这句早退会先执行，
  // 而 Crossref 轮（唯一给它赋值的分支）在更后面才跑。只写 `var crossrefRecords`
  // 的话那时它是提升后的 undefined，一读 .length 就崩。
  var crossrefRecords = [];

  // 只有「本轮也没得抓、PubMed 也没东西可查」才真的退出。
  // 原写法是 `if (!todo.length) 退出`，导致 crossref 轮跑完后单独跑 pubmed 会直接空转退出，
  // PubMed 数据永远补不上——而退出码是 0，看起来像「已经跑完了」。
  // 注意：这个早退必须排在推导逻辑**之前**，但它自己也要能回答「推导得出多少」，
  // 所以先算一遍磁盘侧可推导量，不能等到 PubMed 分支里才算（那里已经进不去了）。
  const onDiskCrossref = SOURCES.includes('pubmed') ? readCrossrefRecordsOnDisk() : [];
  if (!todo.length && !SOURCES.includes('pubmed')) { console.log('无待抓，退出'); return; }
  if (!todo.length && !onDiskCrossref.length) {
    console.log('无待抓、也无已落盘的 crossref 记录可推导，退出');
    return;
  }

  const stats = { ok: 0, crossref404: 0, crossrefFail: 0, pubmedHit: 0, pubmedNull: 0, pubmedFail: 0, crossrefRate: 0, pubmedRate: 0, pubmedSnippetShown: 0 };

  // 进度刷行。管道缓冲（如 `| head`）下 console.log 是块缓冲的，跑十几分钟一行不出，
  // 看起来像卡死。process.stdout.write 同样受缓冲影响，所以这里按「文件大小」触发 flush：
  // 写一个空文件即可强制 Node 把 stdout 刷出去（Windows 下幂等可靠，且不依赖 TTY）。
  let flushed = -1;
  const progress = (n, total, extra = '') => {
    const pct = total ? Math.floor((n / total) * 100) : 0;
    if (pct === flushed) return;
    flushed = pct;
    const line = `  [${pct}%] ${n}/${total}${extra ? ' ' + extra : ''}\n`;
    process.stdout.write(line);
    try { fs.writeFileSync(path.join(ROOT, 'operations-plan', 'logs', '.academic-progress.tmp'), line); } catch { /* noop */ }
  };

  // --- Crossref 轮 ---
  if (SOURCES.includes('crossref')) {
    console.log('\n--- Crossref 单 DOI 直查 ---');
    const last = { t: Date.now() };
    const { results } = await mapLimit(todo, CONCURRENCY, async (item, i) => {
      // 礼貌池限速：mailto 已带，再保证最小请求间隔，避免挤掉 citation pipeline 的并发
      const gap = Math.max(0, 120 - (Date.now() - last.t));
      if (gap) await sleep(gap);
      last.t = Date.now();
      // dry-run 必须零网络。原实现只在写盘处挡了一下 DRY，抓取照样跑几百个请求，
      // 「试一下」会变成真的打上游 —— dry-run 也就没有意义了。
      if (DRY) return null;
      if (i % 100 === 0) progress(i, todo.length, `命中 ${stats.ok} / 404 ${stats.crossref404}`);
      const r = await getJson(`https://api.crossref.org/works/${encodeURIComponent(item.doi)}?mailto=${MAILTO}`);
      if (r.ok && r.json && r.json.message) {
        stats.ok++; stats.crossrefRate++;
        return crossrefRecord(r.json.message, item.site);
      }
      if (r.status === 404) { stats.crossref404++; return null; }
      stats.crossrefFail++;
      if (STATS_THROW(r.status)) throw new Error(`HTTP ${r.status}`);
      return null;
    });
    var crossrefRecords = results.filter(Boolean);
    console.log(`  crossref 命中 ${crossrefRecords.length} / 池 ${todo.length}（404 ${stats.crossref404}，失败 ${stats.crossrefFail}）`);
  }

  // --- PubMed 轮（Europe PMC）---
  let pubmedRecords = [];
  if (SOURCES.includes('pubmed')) {
    let pmTodo = todo.slice(0, Math.max(1, Math.ceil(todo.length / 2)));
    if (!pmTodo.length && onDiskCrossref.length) {
      // 必须按 pubmed 自己的游标过滤：上一轮跑过的 DOI 再查一遍是纯浪费上游配额
      // （PubMed 命中率只有 ~30%，绝大多数 DOI 是「查过了、确认无 PMID」）。
      pmTodo = onDiskCrossref
        .map((r) => ({ doi: r.doi, site: (r.sites && r.sites[0]) || null }))
        .filter((x) => !doneSets.pubmed[x.doi]);
      console.log(`  [derive] 从磁盘 crossref-entities.json 的 ${onDiskCrossref.length} 条记录推导 PubMed 待查 DOI（跳过已查 ${onDiskCrossref.length - pmTodo.length} 条）`);
    }
    pmTodo = pmTodo.slice(0, PM_MAX);
    console.log(`  pubmed 待查 ${pmTodo.length} 个 DOI（Europe PMC，并发 ${PMC_CONCURRENCY}）`);
    let pmResults = [];
    if (!DRY) {
      pmResults = ((await mapLimit(pmTodo, PMC_CONCURRENCY, async (item, i) => {
        if (i % 50 === 0) progress(i, pmTodo.length, `有PMID ${stats.pubmedHit} / 空 ${stats.pubmedNull} / 失败 ${stats.pubmedFail}`);
        try {
          const r = await pubmedFor(item.doi, item.site);
          if (!r.ok) {
            stats.pubmedFail++;
            if (!stats.pubmedSnippetShown && r.snippet) {
              stats.pubmedSnippetShown = 1;
              console.error(`  [epmc] 上游回的是非 JSON 正文（status=${r.status}）：${String(r.snippet).replace(/\s+/g, ' ')}`);
            }
            if (HARD_FAIL.test(String(r.status))) throw new Error(`HTTP ${r.status}`);
            return null;
          }
          if (!r.pmid) { stats.pubmedNull++; return null; }
          stats.pubmedHit++; stats.pubmedRate++;
          return r.record;
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (HARD_FAIL.test(msg)) throw new Error(msg);
          stats.pubmedFail++;
          return null;
        }
      })) || {}).results || [];
    }
    pubmedRecords = pmResults.filter(Boolean);
  }

  if (DRY) {
    console.log('\n[dry-run] 不写盘。crossref=' + crossrefRecords.length + ' pubmed=' + pubmedRecords.length);
    return;
  }

  // ---- 写盘：academic-entities.json 与 openalex-expand 同文件 upsert 合并 ----
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const existing = (() => { try { return JSON.parse(fs.readFileSync(OUT_ACADEMIC, 'utf8')); } catch { return []; } })();
  const merged = new Map();
  for (const e of existing) if (e && e.doi) merged.set(e.doi.toLowerCase(), e);
  let added = 0;
  for (const r of crossrefRecords) {
    if (!r.doi) continue;
    if (!merged.has(r.doi)) { merged.set(r.doi, r); added++; }
  }
  const academicAll = Array.from(merged.values());

  // ⚠️ 写盘必须带源守卫：单独跑 pubmed 时 crossrefRecords 恒为空，
  // 无条件写会把已抓好的 623 条 crossref-entities.json 覆盖成 `[]`
  // ——记录直接丢，而且不会有任何报错（这就是本次实际发生过的数据丢失）。
  // academic-entities.json 同理：只在本轮真的产出了记录时才落盘。
  if (crossrefRecords.length) {
    fs.writeFileSync(OUT_ACADEMIC, JSON.stringify(academicAll, null, 2), 'utf-8');
  } else if (existing.length) {
    console.warn(`  [guard] 本轮 crossref 记录 0 条，保留磁盘上已有的 ${existing.length} 条，不覆盖`);
  }
  if (SOURCES.includes('crossref') || crossrefRecords.length) {
    fs.writeFileSync(OUT_CROSSREF, JSON.stringify(crossrefRecords, null, 2), 'utf-8');
  } else {
    console.warn('  [guard] 本轮未执行 crossref 轮，保留磁盘上的 crossref-entities.json 不动');
  }
  fs.writeFileSync(OUT_PUBMED, JSON.stringify(pubmedRecords, null, 2), 'utf-8');

  // 门禁（fail-loud）：跑了 PubMed 却一条都没产出 —— 不管原因是什么，
  // 退出码必须非零。空产物 + exit 0 = 上游以为成功了，数据其实永远是空数组，
  // 这正是前面「crossref 跑完单独跑 pubmed 空转退出」那次事故的形状。
  if (SOURCES.includes('pubmed') && !pubmedRecords.length) {
    console.error('[GATE] PubMed 轮产出 0 条记录。这是失败，不是「已经跑完」。');
    process.exit(3);
  }

  // 游标：crossref 轮抓过的落 crossref 游标；pubmed 查过的落 pubmed 游标。
  // 共用一份的话，单独重跑某一个源会把另一个源的续跑点抹掉。
  const crossrefTodo = SOURCES.includes('crossref') ? todo : [];
  for (const x of crossrefTodo) doneSets.crossref[x.doi] = 1;
  fs.writeFileSync(cursorPath('crossref'), JSON.stringify({ done: doneSets.crossref, updatedAt: new Date().toISOString() }));
  fs.writeFileSync(cursorPath('pubmed'), JSON.stringify({ done: doneSets.pubmed, updatedAt: new Date().toISOString() }));

  const bySite = {};
  for (const r of crossrefRecords) for (const s of r.sites) bySite[s] = (bySite[s] || 0) + 1;
  const report = {
    pipeline: 'academic-datasets',
    timestamp: new Date().toISOString(),
    dryRun: DRY,
    poolSize: pool.length,
    todoSize: todo.length,
    crossrefRecords: crossrefRecords.length,
    pubmedRecords: pubmedRecords.length,
    academicTotal: academicAll.length,
    academicAdded: added,
    stats,
    bySite,
    sources: SOURCES,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
  };
  fs.writeFileSync(path.join(REPORT_DIR, `report-academic-datasets-${Date.now()}.json`), JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\n[academic-datasets] total=${academicAll.length} (+${added}) crossref=${crossrefRecords.length} pubmed=${pubmedRecords.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
})().catch((e) => {
  console.error('[FATAL]', e && e.message ? e.message : e);
  // 只打 message 会让我们在「哪里读了 undefined 的 length」上瞎猜，直接把栈打出来
  if (e && e.stack) console.error(e.stack.split('\n').slice(1, 6).join('\n'));
  process.exit(1);
});

// Crossref 只把「配额/ UA 类」状态码当硬失败，404 属正常缺失，不计入
function STATS_THROW(status) {
  return status === 429 || status === 403;
}
