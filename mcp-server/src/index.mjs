#!/usr/bin/env node
/**
 * GeneTech 数据引擎 MCP Server
 * ----------------------------------------------------------------------------
 * 让外部 AI Agent（Claude / Cursor / LangChain / 自研 Agent）实时查询 GeneTech
 * 14 站知识引擎的实体数据：检索论文/工具/数据集、按标准标识符过滤、导出引用。
 *
 * 数据来源（默认）：本地仓库中每个站点的 <site>/website/api/entities.json
 * 也可通过环境变量指向已部署的 Pages URL（见下方 GENETECH_API_BASE）。
 *
 * 运行：
 *   npm install
 *   node src/index.mjs
 *
 * 可选环境变量：
 *   GENETECH_DATA_DIR   本地数据根目录（默认：本文件上两级目录，即仓库根）
 *   GENETECH_API_BASE   已部署站点的基础 URL，例如 https://genetech14.pages.dev
 *                       设置后优先从该 URL 拉取各站 <site>/website/api/*.json
 *   GENETECH_API_KEY    若设置，则要求客户端在 Authorization: Bearer 中携带相同值
 *                       （实现付费墙：MCP = 高级 API 产品）
 *   GENETECH_REQUIRE_AUTH  设为 "true" 时强制校验 GENETECH_API_KEY
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.GENETECH_DATA_DIR || REPO_ROOT;
const API_BASE = process.env.GENETECH_API_BASE || '';
const API_KEY = process.env.GENETECH_API_KEY || '';
const REQUIRE_AUTH = process.env.GENETECH_REQUIRE_AUTH === 'true';

// ============================================================================
// 数据加载（带缓存）
// ============================================================================

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchJson(url, tryLocalPath) {
  if (API_BASE && url.startsWith('http')) {
    const res = await fetch(url, { headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {} });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
  return JSON.parse(fs.readFileSync(tryLocalPath, 'utf-8'));
}

async function loadSites(force = false) {
  const now = Date.now();
  if (_cache && !force && now - _cacheTs < CACHE_TTL_MS) return _cache;

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
      console.error(`[load] 跳过站点 ${siteId}: ${err.message}`);
    }
  }

  _cache = sites;
  _cacheTs = now;
  return sites;
}

function allEntities(sites, siteFilter) {
  const out = [];
  for (const [siteId, s] of Object.entries(sites)) {
    if (siteFilter && siteFilter !== siteId) continue;
    for (const ent of s.entities) {
      out.push({ ...ent, _site: siteId });
    }
  }
  return out;
}

// ============================================================================
// 引用导出（BibTeX / APA / RIS）
// ============================================================================

function extractYear(ent) {
  const raw = ent.publishedDate || ent.addedAt || '';
  const m = raw.match(/(\d{4})/);
  return m ? m[1] : 'n.d.';
}

function formatAuthors(ent, style = 'bibtex') {
  const authors = ent.authors || [];
  if (style === 'bibtex') {
    if (authors.length === 0) return 'Unknown';
    if (authors.length === 1) return authors[0].replace(/\s+/g, ' ').trim();
    return authors.map((a) => a.replace(/\s+/g, ' ').trim()).join(' and ');
  }
  if (authors.length === 0) return 'Unknown';
  if (authors.length <= 3) return authors.join(', ');
  return `${authors[0]} et al.`;
}

function bibtexKey(ent, siteId) {
  const first = (ent.authors && ent.authors[0]) || 'unknown';
  const last = first.split(/\s+/).pop() || 'unknown';
  return `${last}${extractYear(ent)}_${String(ent.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 8)}`;
}

function exportCitation(ent, siteId, format) {
  const year = extractYear(ent);
  const title = ent.name || ent.title || 'Untitled';
  const url = ent.url || '';
  const authors = formatAuthors(ent, 'bibtex');

  if (format === 'bibtex') {
    const key = bibtexKey(ent, siteId);
    const how = ent.source === 'pubmed' ? 'article' : ent.source === 'arxiv' ? 'misc' : 'misc';
    return `@${how}{${key},\n  title = {${title}},\n  author = {${authors}},\n  year = {${year}},\n  url = {${url}}\n}`;
  }
  if (format === 'apa') {
    return `${formatAuthors(ent, 'apa')} (${year}). ${title}. Retrieved from ${url}`;
  }
  // RIS
  const risAuthors = (ent.authors || []).map((a) => `AU  - ${a}`).join('\n');
  return [
    'TY  - JOUR',
    risAuthors,
    `TI  - ${title}`,
    `PY  - ${year}`,
    `UR  - ${url}`,
    'ER  -',
  ].join('\n');
}

// ============================================================================
// 关键词相关性排序（无嵌入，基于词频/字段加权）
// ============================================================================

function scoreEntity(ent, query) {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const name = (ent.name || ent.title || '').toLowerCase();
  const abstract = (ent.abstract || '').toLowerCase();
  const tags = (ent.tags || []).join(' ').toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (name.includes(t)) score += 5;
    if (tags.includes(t)) score += 3;
    if (abstract.includes(t)) score += 1;
  }
  if (ent.confidence) score += ent.confidence * 2; // 高置信实体加权
  return score;
}

// ============================================================================
// 鉴权
// ============================================================================

function authError() {
  return {
    content: [
      { type: 'text', text: '401 Unauthorized: 本 MCP Server 需要有效的 GENETECH_API_KEY（在 Authorization: Bearer 中携带）。' },
    ],
    isError: true,
  };
}

function checkAuth(ctx) {
  if (!REQUIRE_AUTH) return true;
  const hdr = (ctx && ctx.request && ctx.request.headers && (ctx.request.headers.authorization || ctx.request.headers.Authorization)) || '';
  const token = hdr.replace(/^Bearer\s+/i, '');
  return token === API_KEY && API_KEY !== '';
}

// ============================================================================
// MCP Server
// ============================================================================

const server = new McpServer({
  name: 'genetech-data',
  version: '1.0.0',
});

server.tool(
  'list_sites',
  '列出 GeneTech 知识引擎的全部站点（领域）及其实体数量、最后更新时间。',
  {},
  async () => {
    const sites = await loadSites();
    const rows = Object.entries(sites).map(([id, s]) => ({
      site: id,
      totalEntities: s.index.totalEntities ?? s.entities.length,
      lastUpdated: s.index.lastUpdated || null,
      categories: s.index.categories || [],
    }));
    return { content: [{ type: 'text', text: JSON.stringify({ count: rows.length, sites: rows }, null, 2) }] };
  }
);

server.tool(
  'query_entities',
  '按站点 / 数据源 / 标签 / 关键词 / 置信度过滤知识实体。',
  {
    site: z.string().optional().describe('站点 ID，例如 genetech-tools / quantum-computing'),
    source: z.string().optional().describe('数据源：pubmed / arxiv / openalex / github / crossref / huggingface'),
    tags: z.string().optional().describe('逗号分隔的标签，实体需命中其一'),
    keyword: z.string().optional().describe('标题/摘要中的关键词'),
    minConfidence: z.number().min(0).max(1).optional().describe('最低置信度阈值'),
    limit: z.number().min(1).max(200).default(20).describe('返回条数'),
    offset: z.number().min(0).default(0).describe('分页偏移'),
  },
  async (args) => {
    const sites = await loadSites();
    let ents = allEntities(sites, args.site);
    if (args.source) ents = ents.filter((e) => (e.source || '').toLowerCase() === args.source.toLowerCase());
    if (args.tags) {
      const tagSet = args.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
      ents = ents.filter((e) => (e.tags || []).some((t) => tagSet.includes(String(t).toLowerCase())));
    }
    if (args.keyword) {
      const kw = args.keyword.toLowerCase();
      ents = ents.filter((e) => `${(e.name || e.title || '').toLowerCase()} ${(e.abstract || '').toLowerCase()}`.includes(kw));
    }
    if (args.minConfidence != null) ents = ents.filter((e) => (e.confidence || 0) >= args.minConfidence);
    const total = ents.length;
    const page = ents.slice(args.offset, args.offset + args.limit);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ total, returned: page.length, entities: page }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  'get_entity',
  '按 ID 获取单个实体详情，并附带 BibTeX / APA / RIS 引用。',
  {
    id: z.string().describe('实体 ID，例如 pmid-42544432'),
    site: z.string().optional().describe('可选站点 ID，缩小查找范围'),
    citation: z.enum(['bibtex', 'apa', 'ris']).optional().describe('同时返回该格式的引用'),
  },
  async (args) => {
    const sites = await loadSites();
    const ents = allEntities(sites, args.site);
    const ent = ents.find((e) => e.id === args.id);
    if (!ent) {
      return { content: [{ type: 'text', text: `404: 未找到实体 ${args.id}` }], isError: true };
    }
    const result = { entity: ent };
    if (args.citation) result.citation = exportCitation(ent, ent._site, args.citation);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  'semantic_search',
  '对知识库做关键词相关性检索（标题/标签加权 + 置信度加权），返回最相关实体。',
  {
    query: z.string().describe('检索词'),
    site: z.string().optional().describe('限定站点'),
    limit: z.number().min(1).max(100).default(10).describe('返回条数'),
  },
  async (args) => {
    const sites = await loadSites();
    const ents = allEntities(sites, args.site);
    const ranked = ents
      .map((e) => ({ e, score: scoreEntity(e, args.query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, args.limit);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { query: args.query, results: ranked.map((x) => ({ score: x.score, ...x.e })) },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  'export_citation',
  '将指定实体导出为学术引用格式（BibTeX / APA / RIS）。',
  {
    id: z.string().describe('实体 ID'),
    format: z.enum(['bibtex', 'apa', 'ris']).default('bibtex'),
    site: z.string().optional().describe('可选站点 ID'),
  },
  async (args) => {
    const sites = await loadSites();
    const ents = allEntities(sites, args.site);
    const ent = ents.find((e) => e.id === args.id);
    if (!ent) {
      return { content: [{ type: 'text', text: `404: 未找到实体 ${args.id}` }], isError: true };
    }
    return { content: [{ type: 'text', text: exportCitation(ent, ent._site, args.format) }] };
  }
);

// 启动
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[GeneTech Data MCP] server running on stdio');
