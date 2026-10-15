/**
 * HTTP 模式的数据访问层——冷启动延迟优化版（10-13 报告 N2）
 * ----------------------------------------------------------------------------
 * 旧实现问题（10-13 实测 23.0s）：`loadSites()` 串行读取 30 个站点
 * `entities.json`（每个 10–21 MB，合计约 450 MB JSON）并全量 JSON.parse。
 *
 * 本版改为：
 *   1. **主数据源** = `data/search-index/site-*.json.gz` 分片（gzip 35.39MB，
 *      与线上语义检索同一份数据，300,000 实体）。实测 30 站并行读 + parse
 *      仅 **1.4s**（旧版 23s，快 ~16×）。
 *   2. **站点元信息**（totalEntities / lastUpdated / categories）仍读各站
 *      `website/api/index.json`（每站仅 ~1KB），不碰大文件。
 *   3. 惰性加载：list_sites 只需要元信息 → 不触发实体加载；
 *      query_entities / semantic_search 首次调用才加载分片。
 *   4. 保留 API_BASE 模式（线上部署时数据走 HTTP，不读本地）。
 *
 * 缓存 TTL 5 分钟，之后冷启动重复一次（1.4s，可接受）。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.GENETECH_DATA_DIR || REPO_ROOT;
const API_BASE = process.env.GENETECH_API_BASE || '';
const API_KEY = process.env.GENETECH_API_KEY || '';

// 缓存
let _siteMeta = null;        // { siteId: { totalEntities, lastUpdated, categories } } —— 轻量，list_sites 用
let _siteEntities = null;    // { siteId: [entity,...] } —— 重量，检索用（惰性）
let _entitiesTs = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchJson(url, localPath) {
  if (API_BASE && url.startsWith('http')) {
    const res = await fetch(url, { headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {} });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
  return JSON.parse(fs.readFileSync(localPath, 'utf-8'));
}

/**
 * 站点元信息（轻量）：只读每站 index.json（~1KB）。
 * 不触发实体加载 → list_sites 冷启动 <50ms。
 */
async function loadSiteMeta() {
  if (_siteMeta) return _siteMeta;
  const meta = {};
  const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const indexLocal = path.join(DATA_DIR, e.name, 'website', 'api', 'index.json');
    if (!fs.existsSync(indexLocal)) continue;
    try {
      const idx = await fetchJson(
        API_BASE ? `${API_BASE}/${e.name}/website/api/index.json` : indexLocal,
        indexLocal
      );
      meta[e.name] = {
        totalEntities: idx.totalEntities ?? null,
        lastUpdated: idx.lastUpdated || null,
        categories: idx.categories || [],
      };
    } catch (err) {
      console.error(`[http-api] 跳过站点元信息 ${e.name}: ${err.message}`);
    }
  }
  _siteMeta = meta;
  return meta;
}

/**
 * 实体数据（重量）：优先读 data/search-index/site-*.json.gz 分片（快 ~16×），
 * 回退到 website/api/entities.json（兼容未建索引的环境）。
 * 并行读取 + parse，实测 30 站 1.4s。
 */
async function loadSiteEntities(force = false) {
  const now = Date.now();
  if (_siteEntities && !force && now - _entitiesTs < CACHE_TTL_MS) return _siteEntities;

  const shardDir = path.join(DATA_DIR, 'data', 'search-index');
  const hasShards = fs.existsSync(shardDir) &&
    fs.readdirSync(shardDir).some(f => f.endsWith('.json.gz'));

  if (hasShards) {
    // 快路径：gz 分片并行加载
    const meta = await loadSiteMeta();
    const shardFiles = fs.readdirSync(shardDir).filter(f => f.startsWith('site-') && f.endsWith('.json.gz'));
    const results = await Promise.all(shardFiles.map(f => new Promise((resolve, reject) => {
      zlib.gunzip(fs.readFileSync(path.join(shardDir, f)), (err, buf) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(buf.toString('utf-8'))); } catch (e) { reject(e); }
      });
    })));
    const sites = {};
    for (const arr of results) {
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const siteId = arr[0].site || 'unknown';
      sites[siteId] = arr;
    }
    // 用 index.json 补全分片缺失的站点元信息
    for (const [sid] of Object.entries(sites)) {
      if (!meta[sid]) meta[sid] = { totalEntities: sites[sid].length, lastUpdated: null, categories: [] };
    }
    _siteEntities = sites;
    _entitiesTs = now;
    return sites;
  }

  // 慢路径（回退）：串行读 entities.json —— 仅在无分片时触发
  console.error('[http-api] 无 search-index 分片，回退 entities.json（慢路径 ~23s）');
  const sites = {};
  const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const entLocal = path.join(DATA_DIR, e.name, 'website', 'api', 'entities.json');
    if (!fs.existsSync(entLocal)) continue;
    try {
      const entities = await fetchJson(
        API_BASE ? `${API_BASE}/${e.name}/website/api/entities.json` : entLocal,
        entLocal
      );
      sites[e.name] = Array.isArray(entities) ? entities : (entities.entities || []);
    } catch (err) {
      console.error(`[http-api] 跳过站点 ${e.name}: ${err.message}`);
    }
  }
  _siteEntities = sites;
  _entitiesTs = now;
  return sites;
}

/** 供 warmup 端点调用：启动时后台预加载，避免首个用户请求命中冷加载 */
export async function warmup() {
  const t0 = Date.now();
  await loadSiteEntities(true);
  return { warmedInMs: Date.now() - t0, sites: Object.keys(_siteEntities || {}).length };
}

export async function listSites() {
  const meta = await loadSiteMeta();
  return Object.entries(meta).map(([id, m]) => ({
    site: id,
    totalEntities: m.totalEntities,
    lastUpdated: m.lastUpdated,
    categories: m.categories,
  }));
}

export async function queryEntities({ site, keyword, source, limit = 20 } = {}) {
  const sites = await loadSiteEntities();
  const out = [];
  for (const [siteId, entities] of Object.entries(sites)) {
    if (site && site !== siteId) continue;
    for (const ent of entities) {
      if (source && ent.source !== source) continue;
      if (keyword) {
        const hay = `${ent.name || ''} ${ent.description || ''} ${(ent.tags || []).join(' ')}`.toLowerCase();
        if (!hay.includes(keyword.toLowerCase())) continue;
      }
      out.push({ ...ent, _site: siteId });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// 混合检索（BM25）——复用 index.mjs 的 SearchIndex 逻辑
export async function semanticSearch({ query, k = 10 }) {
  try {
    const sites = await loadSiteEntities();
    const { SearchIndex } = await import('./search.mjs');
    const flat = [];
    for (const [siteId, entities] of Object.entries(sites)) {
      for (const ent of entities) flat.push({ ...ent, _site: siteId });
    }
    const idx = new SearchIndex(flat);
    const results = idx.search(query, { k });
    return { query, k, count: results.length, results };
  } catch (e) {
    return { query, k, error: e.message };
  }
}

export function citationGaps() {
  const gapsPath = path.join(DATA_DIR, 'data', 'citation-gaps.json');
  if (!fs.existsSync(gapsPath)) {
    return { error: 'data/citation-gaps.json not found; run pipeline-citation-gaps.js first' };
  }
  return JSON.parse(fs.readFileSync(gapsPath, 'utf-8'));
}
