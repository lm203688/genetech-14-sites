/**
 * HTTP 模式的数据访问层——复用 index.mjs 里的 loadSites / SearchIndex / citation-gaps。
 * 与 index.mjs 保持同一份数据访问，避免两处逻辑漂移。
 *
 * 通过 dynamic import 索引 index.mjs 里已导出的 server 无关函数；
 * index.mjs 目前只 export { server }，因此这里独立实现最简数据访问。
 * 数据源与 index.mjs 完全一致（同 DATA_DIR / API_BASE / fetchJson）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.GENETECH_DATA_DIR || REPO_ROOT;
const API_BASE = process.env.GENETECH_API_BASE || '';
const API_KEY = process.env.GENETECH_API_KEY || '';

// 缓存
let _sites = null;
let _sitesTs = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchJson(url, localPath) {
  if (API_BASE && url.startsWith('http')) {
    const res = await fetch(url, { headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {} });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
  return JSON.parse(fs.readFileSync(localPath, 'utf-8'));
}

async function loadSites(force = false) {
  const now = Date.now();
  if (_sites && !force && now - _sitesTs < CACHE_TTL_MS) return _sites;

  const sites = {};
  const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const siteId = e.name;
    const apiDir = path.join(DATA_DIR, siteId, 'website', 'api');
    const indexLocal = path.join(apiDir, 'index.json');
    const entLocal = path.join(apiDir, 'entities.json');
    if (!fs.existsSync(indexLocal) || !fs.existsSync(entLocal)) continue;
    try {
      const indexUrl = API_BASE ? `${API_BASE}/${siteId}/website/api/index.json` : indexLocal;
      const entUrl = API_BASE ? `${API_BASE}/${siteId}/website/api/entities.json` : entLocal;
      const index = await fetchJson(indexUrl, indexLocal);
      const entities = await fetchJson(entUrl, entLocal);
      sites[siteId] = {
        index,
        entities: Array.isArray(entities) ? entities : (entities.entities || []),
      };
    } catch (err) {
      console.error(`[http-api] 跳过站点 ${siteId}: ${err.message}`);
    }
  }

  _sites = sites;
  _sitesTs = now;
  return sites;
}

export function listSites() {
  return Object.entries(_sites || {}).map(([id, s]) => ({
    site: id,
    totalEntities: s.index.totalEntities ?? s.entities.length,
    lastUpdated: s.index.lastUpdated || null,
    categories: s.index.categories || [],
  }));
}

export function queryEntities({ site, keyword, source, limit = 20 } = {}) {
  if (!_sites) return [];
  const out = [];
  for (const [siteId, s] of Object.entries(_sites)) {
    if (site && site !== siteId) continue;
    for (const ent of s.entities) {
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
    if (!_sites) await loadSites();
    const { SearchIndex } = await import('./search.mjs');
    const flat = [];
    for (const [siteId, s] of Object.entries(_sites || {})) {
      for (const ent of s.entities) flat.push({ ...ent, _site: siteId });
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
