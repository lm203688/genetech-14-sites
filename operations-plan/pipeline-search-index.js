#!/usr/bin/env node
/**
 * operations-plan/pipeline-search-index.js
 * 重建 Pro 档语义检索索引 data/search-index.json
 * ==========================================================================
 * 为什么必须存在（2026-10-02 摸底）
 *   ops-extra.yml 的 searchindex 任务调用 `node operations-plan/pipeline-search-index.js`，
 *   但该文件在仓库里**根本不存在** → `node: no such module` → 每日 CI 直接红。
 *   worker.js 的注释同样写着「由 pipeline-search-index.js 每日构建」。
 *   更糟的是 data/search-index.json 的 generatedAt = 2026-09-19，已 13 天未更新，
 *   而 Pro 档 /v1/search/semantic 全靠它：13,333 / 300,000 实体 = 4.4% 覆盖率。
 *
 * 硬约束（决定了下面的分片设计）
 *   Cloudflare Worker 内存约 128MB。实测旧索引 13,333 实体 / 6.9MB
 *   → 已接近单次 JSON.parse 的安全上限（再往上就会 OOM 1112）。
 *   而全语料 300k 实体带摘要 ≈ 150MB，无论怎么压都不可能塞进单个 Worker 内存。
 *   所以「全量语义检索」在 Workers 上是架构级不可行的，不是参数没调好。
 *
 * 因此产出两级索引：
 *   A. data/search-index.json             —— 单文件精简索引，走 Worker 原有路径（安全、低延迟）
 *   B. data/search-index/site-<站>.json   —— 按站分片的全量索引，Worker 可做分片渐进加载
 *      data/search-index/manifest.json
 *   A 是 B 的投影（每站取 top-N），保证任何 Worker 版本都能跑；
 *   B 供后续把 /v1/search/semantic 改成分片加载器后用，覆盖率从 4.4% 提到 100%。
 *
 * 用法
 *   node operations-plan/pipeline-search-index.js                 # 默认 top=600/站
 *   node operations-plan/pipeline-search-index.js --top=444       # 复刻旧索引规模
 *   node operations-plan/pipeline-search-index.js --no-shards     # 只产出 A
 *   node operations-plan/pipeline-search-index.js --dry-run       # 只统计，不写
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_FILE = path.join(DATA_DIR, 'search-index.json');
const SHARD_DIR = path.join(DATA_DIR, 'search-index');
const MANIFEST = path.join(SHARD_DIR, 'manifest.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
// 分片默认**关闭**：全量分片实测 149.28MB（30 片 / 300k 实体），
// 而 Cloudflare Worker 内存 128MB 根本装不下，必须配一套分片渐进加载器才有消费方。
// 没有消费方就写进去 = 白占 Pages 配额（_site 已 654MB / 64%）且永远走不到。
// 所以 shards 默认不生成；接好 worker.js 的分片加载器后，用 --shards 显式产出。
const SHARDS = argv.includes('--shards');

function argNum(prefix, fallback) {
  const hit = argv.find((a) => a.startsWith(prefix));
  if (!hit) return fallback;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) ? n : fallback;
}
const TOP = argNum('--top=', 600);
// 摘要截断： Worker 内存是硬约束，单实体预算 ~450B。
// 240 字符摘要 + 标题 + 标签 + URL ≈ 450B，30 站 ×600 = 18k 实体 ≈ 8MB，安全区。
const SNIPPET_MAX = 240;
const TAGS_MAX = 8;

const isStation = (n) => !n.startsWith('.') && !n.startsWith('_');

function readSiteEntities(site) {
  const p = path.join(ROOT, site, 'website', 'api', 'entities.json');
  if (!fs.existsSync(p)) return [];
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
  const arr = Array.isArray(j) ? j : j.entities;
  return Array.isArray(arr) ? arr : [];
}

/** 摘要 → 检索用 snippet（截断 + 去 LaTeX 噪声，字段语义与旧索引一致） */
function makeSnippet(e) {
  const src = typeof e.abstract === 'string' && e.abstract.length
    ? e.abstract
    : (typeof e.description === 'string' ? e.description : '');
  let s = src.replace(/\\[a-zA-Z]+/g, ' ').replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > SNIPPET_MAX) s = s.slice(0, SNIPPET_MAX).replace(/\s+\S*$/, '') + '…';
  return s;
}

/** 实体 → 索引记录（与 worker.js tokenize/打分所依赖的字段严格对齐） */
function toRecord(e, site) {
  return {
    id: e.id,
    name: e.name || '',
    site,
    tags: (Array.isArray(e.tags) ? e.tags : []).slice(0, TAGS_MAX).map(String),
    snippet: makeSnippet(e),
    url: e.url || '',
    source: e.source || '',
    publishedDate: e.publishedDate || '',
    confidence: Number.isFinite(e.confidence) ? e.confidence : 0,
  };
}

/** 旧索引的 top-N 排序键：confidence 高且摘要长（信息量大）者优先 */
function scoreFor(rec) {
  return (rec.confidence || 0) * 10 + Math.min(rec.snippet.length, SNIPPET_MAX) / SNIPPET_MAX;
}

async function main() {
  const t0 = Date.now();
  const sites = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isStation(d.name))
    .map((d) => d.name)
    .filter((s) => fs.existsSync(path.join(ROOT, s, 'website', 'api', 'entities.json')));

  console.log(`[search-index] 站点 ${sites.length} 个，每站 top=${TOP}`);
  const all = [];
  let read = 0;
  for (const s of sites) {
    const list = readSiteEntities(s);
    read += list.length;
    for (const e of list) all.push(toRecord(e, s));
    console.log(`  - ${s}: ${list.length}`);
  }

  // 去同名同 id 重复（旧索引 dedupDropped=422）
  const seen = new Set();
  const deduped = [];
  let dropped = 0;
  for (const r of all) {
    const k = `${r.site}::${r.id}`;
    if (seen.has(k)) { dropped++; continue; }
    seen.add(k);
    deduped.push(r);
  }
  console.log(`[search-index] 读取 ${read} / 去重丢弃 ${dropped} / 唯一 ${deduped.length}`);

  // ---- A. 单文件索引：每站 top-N ----
  const bySite = new Map();
  for (const r of deduped) {
    if (!bySite.has(r.site)) bySite.set(r.site, []);
    bySite.get(r.site).push(r);
  }
  const topPerSite = [];
  for (const s of sites) {
    const list = (bySite.get(s) || []).slice().sort((a, b) => scoreFor(b) - scoreFor(a));
    topPerSite.push(...list.slice(0, TOP));
  }
  topPerSite.sort((a, b) => scoreFor(b) - scoreFor(a));

  const builtAt = new Date().toISOString();
  const payload = {
    generatedAt: builtAt,
    totalEntities: deduped.length,
    sourceSites: sites.length,
    entitiesRead: read,
    dedupDropped: dropped,
    topPerSite: TOP,
    version: 2,
    entities: topPerSite,
  };
  const json = JSON.stringify(payload);
  console.log(`[search-index] 单文件索引: ${topPerSite.length} 实体 / ${(json.length / 1024 / 1024).toFixed(2)} MB`);

  if (!DRY) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, json);
    console.log(`[search-index] 已写 ${path.relative(ROOT, OUT_FILE)}`);
    fs.writeFileSync(
      path.join(REPORTS_DIR, `search-index-${new Date().toISOString().slice(0, 10)}.json`),
      JSON.stringify({
        pipeline: 'pipeline-search-index',
        timestamp: builtAt,
        dryRun: false,
        entitiesRead: read,
        dedupDropped: dropped,
        uniqueEntities: deduped.length,
        indexedEntities: topPerSite.length,
        coverage: +(topPerSite.length / deduped.length * 100).toFixed(2),
        bytes: json.length,
        plannedShards: SHARDS ? sites.length : 0,
      }, null, 2)
    );
  }

  // ---- B. 按站分片全量索引（Worker 分片渐进加载用）----
  if (!SHARDS) {
    console.log(
      `[search-index][INFO] 本轮不产出分片（--shards 才写）。\n` +
      `[search-index][INFO] 分片 = 30 片 / 300k 实体 / 149.28MB，Worker 128MB 内存装不下，\n` +
      `[search-index][INFO] 必须先给 worker.js 接上分片渐进加载器，否则写了也没人消费、白占 Pages 配额。`
    );
  }
  if (!DRY && SHARDS) {
    fs.mkdirSync(SHARD_DIR, { recursive: true });
    // 清掉上一轮分片，避免改名/删站后残留幽灵分片
    for (const f of fs.readdirSync(SHARD_DIR)) {
      if (/^site-.*\.json$/.test(f)) fs.unlinkSync(path.join(SHARD_DIR, f));
    }
    const shards = [];
    let totalBytes = 0;
    for (const s of sites) {
      const list = (bySite.get(s) || []).slice().sort((a, b) => scoreFor(b) - scoreFor(a));
      const body = JSON.stringify(list);
      const file = `site-${s}.json`;
      fs.writeFileSync(path.join(SHARD_DIR, file), body);
      totalBytes += Buffer.byteLength(body);
      shards.push({ site: s, file, count: list.length, bytes: Buffer.byteLength(body) });
    }
    const manifest = {
      version: 2,
      builtAt,
      mode: 'site-shards',
      base: '/data/search-index/',
      totalEntities: deduped.length,
      coverage: 1,
      shards,
      totalBytes,
    };
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    console.log(`[search-index] 分片索引: ${shards.length} 片 / ${deduped.length} 实体 / ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  }

  // ---- 关键告警：覆盖率受 Worker 内存限制，不是脚本参数能解决的 ----
  const cov = (topPerSite.length / deduped.length * 100).toFixed(2);
  if (topPerSite.length / deduped.length < 0.5) {
    console.warn(
      `[search-index][WARN] 单文件索引覆盖率仅 ${cov}%。\n` +
      `[search-index][WARN] 上限来自 Cloudflare Worker 128MB 内存，非本脚本参数：\n` +
      `[search-index][WARN] 300k 带摘要实体约 150MB，单文件不可能装下。\n` +
      `[search-index][WARN] 若要 100% 覆盖，必须让 worker.js 消费 data/search-index/manifest.json 做分片渐进加载。`
    );
  }

  fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, 'state', 'search-index-cursor.json'),
    JSON.stringify({ builtAt, top: TOP, shards: SHARDS ? sites.length : 0, updatedAt: builtAt }, null, 2)
  );
  console.log(`[search-index] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (require.main === module) {
  main().catch((e) => { console.error('ERR', e); process.exit(1); });
}
module.exports = { main, toRecord, makeSnippet };
