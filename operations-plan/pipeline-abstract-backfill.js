#!/usr/bin/env node
/**
 * 摘要回填流水线（abstract backfill）
 * pipeline-abstract-backfill.js
 *
 * 背景（2026-09-04 实测，见 .workbuddy/memory/automation-digest/2026-09-04.md §6b）：
 *   无摘要实体 152,348 条(50.8%)，其中 93.4%(142,295 条) 集中在 crossref / europepmc / preprints
 *   三源，且三者 DOI 可溯源度均 100%。属「抓取时未取 abstract 字段」而非脏数据。
 *   探针实测回填率（EPMC→OA 并集）：crossref 44% / europepmc 100% / preprints 100%
 *   → 三源可回填 ≈93,613 条，abstract 完整度 49%→80%。
 *
 * 设计：
 *   1. 全局 DOI 索引：同一 DOI 跨站重叠(5.67%)只查一次上游，命中后写回所有出现位置。
 *   2. 通道：EuropePMC 优先（abstractText 直接可得）→ OpenAlex 兜底（abstract_inverted_index 还原）。
 *      不用 Semantic Scholar：实测独贡献为 0，且未认证限流 100 req/5min 不划算。
 *   3. 分批：每轮 cap 个唯一 DOI（默认 2500），跨站配额均衡；未命中的 DOI 不记游标，
 *      下轮自然重试（429/超时视为本轮 miss，不产生错误状态）。
 *   4. 幂等：已有摘要(≥40 字符)的实体一律跳过；重跑安全。
 *   5. 并发：worker 池（--concurrency，默认 3）。EPMC/OA 礼貌限额远高于 3 并发
 *      （OA polite pool 10 rps、EPMC 无严格限），3 worker × 250ms 间隔 ≈ 8 req/s，安全。
 *   6. 只写 entities.json（序列化格式 JSON.stringify(arr,null,2) 与现存文件一致），
 *      覆盖率统计由 build-site.mjs 从实体数据重新计算，无需另改。
 *
 * 用法：
 *   node pipeline-abstract-backfill.js [--cap=2500] [--delay=250] [--concurrency=3] [--dry-run] [--site=<slug>] [--max-minutes=40]
 *
 * 运行环境：本地或 CI 均可。本地跑完后由 push.mjs commit 走 Contents API 推送，
 * 触发 pages-deploy 重建（瘦身后的构建 + 回填数据绑定上线）。
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TARGET_SOURCES = new Set(['crossref', 'europepmc', 'preprints']);
const STATE_PATH = path.join(PROJECT_ROOT, 'state', 'abstract-backfill-cursor.json');
const MIN_ABS_LEN = 40;

// ---- 参数
const args = process.argv.slice(2);
const getArg = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const CAP = parseInt(getArg('cap', '2500'), 10);
const DELAY = parseInt(getArg('delay', '250'), 10);
const CONCURRENCY = Math.max(1, parseInt(getArg('concurrency', '3'), 10));
const MAX_MINUTES = parseInt(getArg('max-minutes', '40'), 10);
const DRY = args.includes('--dry-run');
const ONLY_SITE = getArg('site', '');

const hasAbstract = (e) => {
  const a = e.abstract || e.summary || e.description || '';
  return typeof a === 'string' && a.trim().length >= MIN_ABS_LEN;
};
const normDoi = (d) =>
  d ? String(d).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '').toLowerCase() : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// miss 台账：miss 是高度确定性的（上游真没有该文献的摘要，如图书章节/会议摘要），
// 反复重查纯浪费。miss ≥ MISS_RETIRE 次的 DOI 退休不再查（留给未来源扩容）。
const MISS_RETIRE = 2;
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) { return { runs: [] }; }
}

// 摘要清洗：去 HTML/JATS 标签、压空白
const cleanAbstract = (t) =>
  String(t || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function invertToText(idx) {
  if (!idx || typeof idx !== 'object') return '';
  const arr = [];
  for (const [w, pos] of Object.entries(idx)) for (const p of pos) arr.push([p, w]);
  arr.sort((a, b) => a[0] - b[0]);
  return arr.map((x) => x[1]).join(' ');
}

async function fetchJson(url, timeoutMs = 15000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (r.status === 429) throw Object.assign(new Error('rate-limited'), { rateLimited: true });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fromEuropePMC(doi) {
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:%22${encodeURIComponent(doi)}%22&resultType=core&format=json`;
  const j = await fetchJson(url);
  const hit = j.resultList?.result?.[0];
  const t = cleanAbstract(hit?.abstractText || '');
  return t.length >= MIN_ABS_LEN ? t : null;
}

async function fromOpenAlex(doi) {
  const url = `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?mailto=ops@genetech.local`;
  const j = await fetchJson(url);
  const t = cleanAbstract(invertToText(j.abstract_inverted_index));
  return t.length >= MIN_ABS_LEN ? t : null;
}

async function fetchAbstract(doi) {
  try { const t = await fromEuropePMC(doi); if (t) return { text: t, via: 'europepmc' }; } catch (e) { if (e.rateLimited) await sleep(1000); }
  await sleep(DELAY);
  try { const t = await fromOpenAlex(doi); if (t) return { text: t, via: 'openalex' }; } catch (e) { if (e.rateLimited) await sleep(1000); }
  return null;
}

async function main() {
  const t0 = Date.now();
  const deadline = t0 + MAX_MINUTES * 60 * 1000;

  // 1) 发现站点并加载，建全局 DOI 索引
  const siteDirs = fs
    .readdirSync(PROJECT_ROOT)
    .filter((d) => {
      if (!/^[a-z0-9-]+$/.test(d)) return false;
      const p = path.join(PROJECT_ROOT, d);
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'website/api/entities.json'));
    })
    .filter((d) => (ONLY_SITE ? d === ONLY_SITE : true))
    .sort();

  const doiMap = new Map(); // doi -> [{ site, entities }]
  let missingEntities = 0;
  const siteData = new Map(); // site -> entities array (仅加载需写的)
  for (const site of siteDirs) {
    const p = path.join(site, 'website/api/entities.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(j) ? j : j.entities || [];
    siteData.set(site, { arr, file: p, modified: false });
    for (const e of arr) {
      const src = e.source || e.provider || e.source_name || 'unknown';
      if (!TARGET_SOURCES.has(src) || hasAbstract(e)) continue;
      const doi = normDoi(e.doi);
      if (!doi) continue;
      if (!doiMap.has(doi)) doiMap.set(doi, []);
      doiMap.get(doi).push({ site, e });
      missingEntities++;
    }
  }
  console.log(
    `[ABS-BACKFILL] 扫描 ${siteDirs.length} 站: 三源无摘要实体 ${missingEntities}, 唯一 DOI ${doiMap.size}, 本轮 cap=${CAP}${DRY ? ' (dry-run)' : ''}`,
  );

  if (DRY) {
    const bySource = {};
    for (const occs of doiMap.values()) for (const { e } of occs) { const s = e.source || 'unknown'; bySource[s] = (bySource[s] || 0) + 1; }
    console.log('[ABS-BACKFILL] dry-run 按源分布:', JSON.stringify(bySource));
    return;
  }

  // 2) worker 池并发反查（JS 单线程，计数器在 await 间隙读写是安全的）
  const state = loadState();
  state.missLedger = state.missLedger || {};
  const retired = [...doiMap.keys()].filter((d) => (state.missLedger[d] || 0) >= MISS_RETIRE).length;
  const dois = [...doiMap.keys()].filter((d) => (state.missLedger[d] || 0) < MISS_RETIRE).slice(0, CAP);
  let fetched = 0, filledEntities = 0, epmcHits = 0, oaHits = 0, misses = 0, attempted = 0, cursor = 0;
  const fillOne = (doi, res) => {
    for (const { site, e } of doiMap.get(doi)) {
      e.abstract = res.text;
      siteData.get(site).modified = true;
      filledEntities++;
    }
  };
  const worker = async () => {
    for (;;) {
      if (Date.now() > deadline) return;
      const i = cursor++;
      if (i >= dois.length) return;
      const doi = dois[i];
      attempted++;
      const res = await fetchAbstract(doi);
      if (res) {
        fetched++;
        delete state.missLedger[doi];
        if (res.via === 'europepmc') epmcHits++; else oaHits++;
        fillOne(doi, res);
      } else {
        misses++;
        state.missLedger[doi] = (state.missLedger[doi] || 0) + 1;
      }
      if (attempted % 100 === 0) {
        console.log(`[ABS-BACKFILL] 进度 ${attempted}/${dois.length}: 命中 ${fetched} (EPMC ${epmcHits}/OA ${oaHits}) miss ${misses}`);
      }
      await sleep(DELAY);
    }
  };
  console.log(`[ABS-BACKFILL] 并发 worker=${CONCURRENCY}, delay=${DELAY}ms, 台账退休 DOI=${retired}`);
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker().catch((e) => {
    console.error('[ABS-BACKFILL] worker 异常(不中断其他 worker):', e.message);
  })));

  // 3) 写回被修改的站点
  let sitesModified = 0;
  for (const [site, { arr, file, modified }] of siteData) {
    if (!modified) continue;
    fs.writeFileSync(file, JSON.stringify(arr, null, 2));
    sitesModified++;
  }

  // 4) 状态沉淀（state 已在选池前加载，含 missLedger）
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  const rec = {
    at: new Date().toISOString(),
    scannedMissing: missingEntities,
    uniqueDois: doiMap.size,
    retiredKnownMiss: retired,
    cap: CAP,
    attempted,
    fetched,
    filledEntities,
    sitesModified,
    misses,
    concurrency: CONCURRENCY,
    elapsedSec: Number(elapsed),
  };
  state.runs = [rec, ...(state.runs || [])].slice(0, 50);
  state.totalFilledEntities = (state.totalFilledEntities || 0) + filledEntities;
  state.lastRunAt = rec.at;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

  console.log(
    `[ABS-BACKFILL] 完成: 尝试 ${attempted} DOI → 命中 ${fetched} (EPMC ${epmcHits}/OA ${oaHits}/miss ${misses}), 回填实体 ${filledEntities} 条, 写 ${sitesModified} 站, 耗时 ${elapsed}s`,
  );
  console.log(`[ABS-BACKFILL] 剩余缺口（三源无摘要实体）约 ${missingEntities - filledEntities}`);
  if (fetched === 0 && attempted > 0) {
    console.error('[ABS-BACKFILL] ⚠️ 本轮 0 命中 —— 检查上游可达性（EPMC/OpenAlex）');
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error('[ABS-BACKFILL] fatal:', e.message);
  process.exit(1);
});
