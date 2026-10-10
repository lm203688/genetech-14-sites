#!/usr/bin/env node
/**
 * GeneTech 数据引擎 MCP Server
 * ----------------------------------------------------------------------------
 * 让外部 AI Agent（Claude / Cursor / LangChain / 自研 Agent）实时查询 GeneTech
 * 30 站知识引擎的实体数据：检索论文/工具/数据集、按标准标识符过滤、导出引用、分析跨域引用缺口。
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
 *   GENETECH_API_BASE   已部署站点的基础 URL，例如 https://lm203688.github.io/genetech-14-sites
 *                       设置后优先从该 URL 拉取各站 <site>/website/api/*.json
 *   GENETECH_API_KEY    若设置，则要求客户端在 Authorization: Bearer 中携带相同值
 *                       （实现付费墙：MCP = 高级 API 产品）
 *   GENETECH_REQUIRE_AUTH  设为 "true" 时强制校验 GENETECH_API_KEY
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import { SearchIndex } from './search.mjs';
import { KnowledgeGraph, GraphRAG } from './graphrag.mjs';
import { runAsk } from '../../tools/lib/ask.mjs';
import { submitRequest, retrieveRequests, healthCheck as requestHealth } from './mcp-request.mjs';

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
let _searchIndex = null;
let _searchTs = 0;
let _graph = null;
let _rag = null;

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

  // 构建混合检索索引（BM25 + 字段加权 + RRF；可选向量）
  const flat = [];
  for (const [siteId, s] of Object.entries(sites)) {
    for (const ent of s.entities) flat.push({ ...ent, _site: siteId });
  }
  const idx = new SearchIndex(flat);
  // 若配置了嵌入端点，后台惰性建向量（不阻塞加载）
  if (process.env.GENETECH_EMBED_URL) {
    idx
      .enableVector({
        embedUrl: process.env.GENETECH_EMBED_URL,
        embedModel: process.env.GENETECH_EMBED_MODEL || 'text-embedding-3-small',
        embedKey: process.env.GENETECH_EMBED_KEY || '',
        dataDir: DATA_DIR,
      })
      .catch((e) => console.error(`[search] 向量初始化失败: ${e.message}`));
  }
  _searchIndex = idx;
  _searchTs = now;

  // 惰性初始化 KnowledgeGraph + GraphRAG（不阻塞主流程）
  try {
    if (!_graph) _graph = KnowledgeGraph.fromPathOrDefault(path.join(DATA_DIR, 'data'));
    _rag = new GraphRAG(_graph, idx);
  } catch (e) {
    console.error(`[graphrag] 初始化失败（图检索不可用）: ${e.message}`);
    _graph = null;
    _rag = null;
  }

  // 暴露给 ask 工具使用（避免其内部重建索引）
  globalThis.__geneTechSearchIndex = idx;
  globalThis.__geneTechGraphRAG = _rag;
  return sites;
}

function ensureGraphRAG() {
  if (_rag) return _rag;
  // 兜底：loadSites 未跑过时，尝试用 knowledge-graph-entities.json 独立初始化
  try {
    if (!_graph) _graph = KnowledgeGraph.fromPathOrDefault(path.join(DATA_DIR, 'data'));
    if (!_graph || _graph.nodes.size === 0) {
      return { unavailable: '无实体数据或图数据未加载，请先调用 semantic_search' };
    }
    // 用 knowledge-graph-entities.json 的 nodes 单独构造一个 SearchIndex 作为 anchor 检索器
    if (!_searchIndex) {
      const kgPath = path.join(DATA_DIR, 'data', 'knowledge-graph-entities.json');
      if (fs.existsSync(kgPath)) {
        const j = JSON.parse(fs.readFileSync(kgPath, 'utf-8'));
        const entities = (j.nodes || []).map((n) => ({ ...n, _site: n.domain }));
        if (entities.length) _searchIndex = new SearchIndex(entities);
      }
    }
    _rag = _searchIndex ? new GraphRAG(_graph, _searchIndex) : null;
    if (!_rag) return { unavailable: '图数据为空或实体检索器未就绪' };
  } catch (e) {
    return { unavailable: e.message };
  }
  return _rag;
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
  version: '2.0.0',
});

server.registerTool(
  'list_sites',
  {
    description: '列出 GeneTech 知识引擎的全部站点（领域）及其实体数量、最后更新时间。',
    inputSchema: {},
  },
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

server.registerTool(
  'query_entities',
  {
    description: '按站点 / 数据源 / 标签 / 关键词 / 置信度过滤知识实体。',
    inputSchema: {
    site: z.string().optional().describe('站点 ID，例如 genetech-tools / quantum-computing'),
    source: z.string().optional().describe('数据源：pubmed / arxiv / openalex / github / crossref / huggingface'),
    tags: z.string().optional().describe('逗号分隔的标签，实体需命中其一'),
    keyword: z.string().optional().describe('标题/摘要中的关键词'),
    minConfidence: z.number().min(0).max(1).optional().describe('最低置信度阈值'),
    limit: z.number().min(1).max(200).default(20).describe('返回条数'),
    offset: z.number().min(0).default(0).describe('分页偏移'),
  },
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

server.registerTool(
  'get_entity',
  {
    description: '按 ID 获取单个实体详情，并附带 BibTeX / APA / RIS 引用。',
    inputSchema: {
    id: z.string().describe('实体 ID，例如 pmid-42544432'),
    site: z.string().optional().describe('可选站点 ID，缩小查找范围'),
    citation: z.enum(['bibtex', 'apa', 'ris']).optional().describe('同时返回该格式的引用'),
  },
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

server.registerTool(
  'semantic_search',
  {
    description: '对知识库做混合检索（BM25 倒排 + 字段加权 + RRF 融合，可选向量语义）。可选 graph_hop 开启图遍历扩召回。',
    inputSchema: {
    query: z.string().describe('检索词（中英文均可）'),
    site: z.string().optional().describe('限定站点'),
    limit: z.number().min(1).max(100).default(10).describe('返回条数'),
    graphHop: z.boolean().default(false).describe('启用后从 top-5 anchor 出发做 1 跳图遍历扩召回'),
    hops: z.number().min(1).max(3).default(1).describe('图遍历跳数（graphHop=true 时生效）'),
  },
  },
  async (args) => {
    await loadSites();
    const ranked = await _searchIndex.hybridSearch(args.query, { limit: args.limit, site: args.site });
    const rag = ensureGraphRAG();
    let graphExtensions = [];
    if (args.graphHop && rag && !rag.unavailable) {
      const res = await rag.search(args.query, { anchorLimit: 5, hops: args.hops, maxReached: 20, site: args.site });
      graphExtensions = (res.reached || []).map((r) => ({
        entity: r.entity,
        hop: r.hop,
        path: r.path,
      }));
    }
    // C3：给每条命中带 evidence（哪个字段命中 + 命中词）。
    // 为什么必须有：v2 报告 §6 C3「检索结果带证据」验收是 100% 命中带 evidence。
    // 之前 ranked 只有 score + entity，调用方无法解释"为什么它排在前面"——
    // 这在 RAG 场景里是"看不见的判断"，用户只能信任模型不验证。
    const qTerms = args.query.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5+#]+/).filter(t => t.length >= 2);
    const FIELD_WEIGHTS = [
      ['name', 1.0], ['title', 1.0], ['tags', 0.9], ['abstract', 0.7],
      ['description', 0.7], ['authors', 0.5], ['source', 0.3],
    ];
    const withEvidence = ranked.map(({ score, entity: e }) => {
      if (!e) return { score, entity: e };
      const hits = [];
      let totalWeight = 0;
      for (const [fname, weight] of FIELD_WEIGHTS) {
        const raw = e[fname];
        if (!raw) continue;
        const text = Array.isArray(raw) ? raw.join(' ') : String(raw);
        const lower = text.toLowerCase();
        const matchedTerms = qTerms.filter(t => lower.includes(t));
        if (!matchedTerms.length) continue;
        hits.push({ field: fname, matched: matchedTerms.slice(0, 5) });
        totalWeight += weight * matchedTerms.length;
      }
      // 若纯向量召回（无词面命中）也要给一个 evidence，标记是语义召回
      const evidence = hits.length
        ? { matchedFields: hits, totalWeight: Number(totalWeight.toFixed(2)) }
        : { matchedFields: [], totalWeight: 0, reason: 'vector-only (no lexical hit)' };
      return { score, entity: e, evidence };
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              query: args.query,
              mode: 'hybrid(bm25+field' + (_searchIndex.vectors ? '+vector' : '') + ')' + (args.graphHop ? '+graph' : ''),
              results: withEvidence,
              graphExtensions,
              graphStatus: args.graphHop ? (rag?.unavailable || 'ok') : null,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.registerTool(
  'graph_search',
  {
    description: '图遍历检索：先 hybridSearch 找 anchor 节点，再沿实体关系边做 BFS 多跳遍历，返回完整路径解释。适合跨域桥接 / 合著网络 / 上下游关系问题。',
    inputSchema: {
    query: z.string().describe('检索词，用于找 anchor（中英文均可）'),
    site: z.string().optional().describe('限定 anchor 站点'),
    anchorLimit: z.number().min(1).max(20).default(5).describe('anchor 数量'),
    hops: z.number().min(1).max(3).default(2).describe('图遍历跳数'),
    maxReached: z.number().min(1).max(200).default(50).describe('最多返回的 reached 节点数'),
    directed: z.boolean().default(false).describe('是否只用有向边（默认双向）'),
    includeHubs: z.boolean().default(true).describe('启用后自动把高 degree 节点也当 anchor（保证图中心节点被遍历到）'),
  },
  },
  async (args) => {
    await loadSites();
    const rag = ensureGraphRAG();
    if (!rag || rag.unavailable) {
      return { content: [{ type: 'text', text: `graph_search 不可用：${rag?.unavailable || '图数据未加载'}` }], isError: true };
    }
    const r = await rag.search(args.query, {
      anchorLimit: args.anchorLimit,
      hops: args.hops,
      maxReached: args.maxReached,
      directed: args.directed,
      site: args.site,
      includeHubs: args.includeHubs,
    });
    const payload = {
      query: args.query,
      anchorIds: r.anchorIds,
      anchors: r.anchors.map((a) => ({ id: a.id, name: a.name, category: a.category, domain: a.domain })),
      reached: r.reached.map((n) => ({
        id: n.entity?.id,
        name: n.entity?.name,
        category: n.entity?.category,
        domain: n.entity?.domain,
        hop: n.hop,
        path: n.path,
      })),
      meta: r.meta,
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
);

server.registerTool(
  'export_citation',
  {
    description: '将指定实体导出为学术引用格式（BibTeX / APA / RIS）。',
    inputSchema: {
    id: z.string().describe('实体 ID'),
    format: z.enum(['bibtex', 'apa', 'ris']).default('bibtex'),
    site: z.string().optional().describe('可选站点 ID'),
  },
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

// ============================================================================
// citation_gaps — 跨域引用缺口矩阵（2026-10-03 新增）
// ============================================================================
// 为什么要单独加工具：graph_search 回答的是「已存在的引用路径是什么」，
// 但科研场景里更值钱的问题是「**哪两个域之间一条引用都没有**」——
// 那是研究空白候选（也可能是本项目在该两域语料不足，必须结合 totalEntities 一起读）。
// 原始边列表（25,635 条 [doi,doi,site,site]）没法直接回答这个问题，
// 消费方得自己遍历聚合；本工具直接给结论。
//
// 数据源：data/citation-gaps.json（由 pipeline-citation-gaps.js 从
// data/citation-edges.json 纯派生，本 MCP 侧只读，不重算 —— 避免两处算出口径不一致）。
let _gapsCache = null;
let _gapsTs = 0;
const GAPS_TTL_MS = 10 * 60 * 1000;

async function loadCitationGaps(force = false) {
  const now = Date.now();
  if (_gapsCache && !force && now - _gapsTs < GAPS_TTL_MS) return _gapsCache;
  const local = path.join(DATA_DIR, 'data', 'citation-gaps.json');
  let doc = null;
  if (API_BASE) {
    // 走已部署的 Worker 端点（顺带验证 API 可用性），失败则回退本地文件
    for (const base of [API_BASE.replace(/\/$/, ''), 'https://api.swarmlabs.tools']) {
      try {
        const res = await fetch(`${base}/v1/citation/gaps`, {
          headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
        });
        if (res.ok) { doc = await res.json(); break; }
      } catch { /* 试下一个 base */ }
    }
  }
  if (!doc && fs.existsSync(local)) {
    try { doc = JSON.parse(fs.readFileSync(local, 'utf-8')); } catch (e) {
      console.error(`[citation-gaps] 本地文件解析失败: ${e.message}`);
    }
  }
  _gapsCache = doc;
  _gapsTs = now;
  return doc;
}

server.registerTool(
  'citation_gaps',
  {
    description: '跨域引用缺口矩阵：哪些站点之间零引用（研究空白候选）、哪些桥接最强（跨学科枢纽）、各站入/出度。适合「找未被桥接的跨域」「评估跨学科机会」类问题。',
    inputSchema: {
    mode: z.enum(['gaps', 'bridges', 'degrees', 'stats']).default('gaps')
      .describe('gaps=零引用站对（默认）｜bridges=最强桥接｜degrees=各站入出度｜stats=总览统计'),
    site: z.string().optional().describe('只看涉及该站的条目，例：quantum-computing'),
    limit: z.number().min(1).max(200).default(20).describe('返回条数（gaps/bridges 模式）'),
    includeInterpretation: z.boolean().default(true)
      .describe('是否带上 interpretation 字段（提醒 LLM gapPairs 可能是语料不足而非真空白）'),
  },
  },
  async (args) => {
    const doc = await loadCitationGaps();
    if (!doc || !Array.isArray(doc.gapPairs)) {
      return {
        content: [{ type: 'text', text: '503: 引用缺口数据不可用。需先跑 operations-plan/pipeline-openalex-citation.js --source=crossref 再跑 pipeline-citation-gaps.js。' }],
        isError: true,
      };
    }

    let payload;
    if (args.mode === 'stats') {
      payload = { stats: doc.stats, derivedFrom: doc.derivedFrom, builtAt: doc.builtAt };
    } else if (args.mode === 'degrees') {
      const rows = doc.degrees.filter((d) => !args.site || d.site === args.site);
      payload = { mode: 'degrees', degrees: rows, stats: doc.stats };
    } else if (args.mode === 'bridges') {
      const rows = doc.bridges
        .filter((b) => !args.site || b.from === args.site || b.to === args.site)
        .slice(0, args.limit);
      payload = { mode: 'bridges', bridges: rows, returned: rows.length, total: doc.bridges.length };
    } else {
      const rows = doc.gapPairs
        .filter((g) => !args.site || g.from === args.site || g.to === args.site)
        .slice(0, args.limit);
      payload = {
        mode: 'gaps',
        gaps: rows,
        returned: rows.length,
        totalGapPairs: doc.stats.gapPairs,
        // 明确带上被涉及站点的实体规模，让调用方能区分「真空白」与「我们没抓到」
        siteScale: Object.fromEntries(
          doc.degrees
            .filter((d) => rows.some((r) => r.from === d.site || r.to === d.site))
            .map((d) => [d.site, d.totalEntities])
        ),
      };
    }
    if (args.includeInterpretation && doc.interpretation) payload.interpretation = doc.interpretation;
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
);

// ============================================================================
// ask — 自然语言问题 → 混合检索 → LLM 桥接 → 带参考来源的答案
// ============================================================================
//
// 当外部 Agent 只想问"2026 量子计算的趋势是什么"这类开放问题时，
// 直接调 semantic_search 拿实体仍要自己做归纳。ask 帮你把"检索 + 写作"两步
// 合成一步：内部复用 SearchIndex.hybridSearch() 取前 N 条最相关实体
// （BM25 + 字段加权 + RRF，可选向量），把实体压缩成参考片段交给 LLM 桥接层，
// 让模型基于参考片段生成中文答案并标注来源。LLM 未配置时退化为"实体浓缩列表"。
server.registerTool(
  'ask',
  {
    description: '对 GeneTech 30 站知识引擎做自然语言提问：内部混合检索 + LLM 桥接，生成带参考来源的答案。LLM 未配置时退化为实体浓缩列表。',
    inputSchema: {
    question: z.string().describe('自然语言问题（中文/英文均可）'),
    site: z.string().optional().describe('限定站点，例如 quantum-computing'),
    limit: z.number().min(1).max(20).optional().describe('参考实体条数，默认 6'),
  },
  },
  async (args) => {
    await loadSites();
    const r = await runAsk({
      question: args.question,
      sites: args.site,
      limit: args.limit,
    });
    if (!r.ok) {
      return { content: [{ type: 'text', text: `ask 失败：${r.error || r.message || 'unknown'}` }], isError: true };
    }
    const body = JSON.stringify(
      {
        answer: r.answer,
        sources: r.sources || [],
        citations: r.citations || r.sources || [],
        model: r.model,
        ms: r.ms,
        fallback: r.fallback || null,
        usage: r.usage || null,
      },
      null,
      2
    );
    return { content: [{ type: 'text', text: body }] };
  }
);

// ============================================================================
// submit_request — 下游项目提交数据需求（intake 入口）
// ============================================================================
server.registerTool(
  'submit_request',
  {
    description: '为 GeneTech 30 站知识引擎提交结构化数据需求。下游独立项目（蜂群科研数据 / RoboParts / AIShield / 付费客户）通过此工具申请定向采集：指定领域、关键词、时间范围、数量目标与交付格式。返回 request_id（状态默认 pending_review）与 export_url（pull 模式下可直接拉取的交付地址，未履约时该 URL 返回 404）。幂等：7 天内相同项目 + 相同规格指纹不重复提交。',
    inputSchema: {
    project_name: z.string().describe('需求方项目标识，例如 swarmlabs / roboparts / aishield'),
    contact: z.string().describe('联系人邮箱或 GitHub 用户名'),
    purpose: z.string().describe('需求用途说明（一句话，用于审批审计）'),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium').describe('紧急度'),
    spec: z.object({
      domains: z.array(z.string()).optional().describe('目标领域，例如 ["robotics", "embodied-ai"]'),
      keywords: z.array(z.string()).optional().describe('检索关键词列表'),
      time_range: z.object({
        from: z.string().describe('起始日期，ISO 8601'),
        to: z.string().describe('截止日期，ISO 8601'),
      }).optional().describe('时间窗口'),
      min_confidence: z.number().min(0).max(1).default(0.5).describe('最低置信度阈值'),
      target_count: z.number().min(1).max(500).default(50).describe('期望返回实体数'),
      formats: z.array(z.enum(['json', 'bibtex', 'csv'])).default(['json']).describe('交付格式'),
      delivery_preference: z.enum(['pull', 'push', 'subscribe']).default('pull').describe('交付模式'),
    }).describe('需求规格，指定领域/关键词/时间/数量'),
  },
  },
  async (args) => {
    const result = submitRequest(args);
    if (!result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ============================================================================
// retrieve_requests — 浏览 / 筛选 / 统计数据需求队列
// ============================================================================
server.registerTool(
  'retrieve_requests',
  {
    description: '浏览 GeneTech 30 站数据需求队列：按状态 / 项目名筛选，返回统计摘要与分页结果。管理员与需求方均可调用。',
    inputSchema: {
    status_filter: z.enum(['pending_review', 'in_progress', 'fulfilled', 'rejected']).optional().describe('按状态过滤'),
    project_name: z.string().optional().describe('按项目名过滤'),
    limit: z.number().min(1).max(100).default(20).describe('返回条数'),
    offset: z.number().min(0).default(0).describe('分页偏移'),
  },
  },
  async (args) => {
    const result = retrieveRequests({
      status_filter: args.status_filter,
      project_name: args.project_name,
      limit: args.limit,
      offset: args.offset,
    });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ============================================================================
// intake_health — 数据需求系统自检
// ============================================================================
server.registerTool(
  'intake_health',
  {
    description: '检查数据需求队列的健康状态：文件路径、大小、条目数。',
    inputSchema: {},
  },
  async () => {
    const result = requestHealth();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ============================================================================
// D3 — 三个高价值工具：verify_entity / snapshot_at / domain_relatedness
// ----------------------------------------------------------------------------
// 为什么是这三个：它们把「对外宣称」变成「可被第三方一眼复核」的三个动作。
//   verify_entity    — 溯源链可复核（"每条可溯源"这条卖点的最小验证面）
//   snapshot_at      — 时间机器可回放（与 provenance 一致性可测）
//   domain_relatedness — 跨域相关度可量化（区分「真学术联系」与「零引用空白」）
// 三者都不引入新依赖，复用 loadSites / data/knowledge-graph.json /
// data/citation-edges.json / data/citation-gaps.json。
// ============================================================================

function normDoi(v) {
  return String(v || '')
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .toLowerCase();
}

/**
 * 实体标识 → 所在站点集合。_site 是权威归属，sites 字段是跨站共现。
 *
 * 必须同时收录三种 KG 端点形态，否则 domain_relatedness 会静默丢边：
 *   - `ent.id` 原样（KG 的 `other:*`，例如 oa:W2049934619 / arxiv-2607.29626v1）
 *   - `doi:<归一化 DOI>`（KG 的 `doi:*`，27,868 条 citation 边 + 22,604 条 cross_site 端点）
 *   - `station:<site>`（KG 的 56 个站点节点，29,927 条 cross_site 边全部经它连接）
 * 漏掉第三种会让 cross_site 计数恒为 0，而它正是跨站桥梁证据的主力。
 */
let _idToSites = null;
async function entityIdToSites() {
  if (_idToSites) return _idToSites;
  const sites = await loadSites();
  const m = new Map();
  const put = (key, siteId) => {
    if (!key || !siteId) return;
    let dest = m.get(key);
    if (!dest) { dest = new Set(); m.set(key, dest); }
    dest.add(siteId);
  };
  for (const [siteId, s] of Object.entries(sites)) {
    for (const ent of s.entities) {
      const id = ent.id || '';
      const doiKey = ent.doi ? `doi:${normDoi(ent.doi)}` : '';
      put(id, siteId);
      put(doiKey, siteId);
      // 跨站共现：该实体同时声明属于其它站点
      if (Array.isArray(ent.sites)) {
        for (const x of ent.sites) {
          put(id, x);
          put(doiKey, x);
        }
      }
    }
  }
  // KG 站点节点：cross_site 边用它做端点
  for (const siteId of Object.keys(sites)) put(`station:${siteId}`, siteId);
  _idToSites = m;
  return m;
}

let _kg = null;
function loadKg() {
  if (_kg) return _kg;
  const p = path.join(DATA_DIR, 'data', 'knowledge-graph.json');
  try {
    _kg = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    _kg = { nodes: [], edges: [] };
  }
  return _kg;
}

let _citEdges = null;
function loadCitationEdges() {
  if (_citEdges) return _citEdges;
  const p = path.join(DATA_DIR, 'data', 'citation-edges.json');
  try {
    _citEdges = JSON.parse(fs.readFileSync(p, 'utf-8')).edges || [];
  } catch {
    _citEdges = [];
  }
  return _citEdges;
}

let _gaps = null;
function loadGaps() {
  if (_gaps) return _gaps;
  const p = path.join(DATA_DIR, 'data', 'citation-gaps.json');
  try {
    _gaps = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    _gaps = null;
  }
  return _gaps;
}

/** 溯源链：源 → DOI → 出版 → 入库 → 更新。五段式，缺哪段就留空。 */
function provenanceChain(ent, siteId) {
  const chain = [
    { stage: 1, label: 'data_source', value: ent.source || 'unknown' },
    ent.doi && { stage: 2, label: 'doi', value: ent.doi },
    ent.publishedDate && { stage: 3, label: 'published', value: ent.publishedDate },
    ent.addedAt && { stage: 4, label: 'fetched_into_db', value: ent.addedAt, site: siteId },
    ent.updatedAt && { stage: 5, label: 'last_updated', value: ent.updatedAt },
  ].filter(Boolean);
  return {
    chain,
    chainLength: chain.length,
    source: ent.source || null,
    doi: ent.doi || null,
    publishedDate: ent.publishedDate || null,
    fetchedAt: ent.addedAt || null,
    updatedAt: ent.updatedAt || null,
    confidence: ent.confidence ?? null,
    qualityTier: ent.quality_tier || null,
    url: ent.url || null,
    ingestedFrom: ent.source ? `source:${ent.source}` : 'unknown',
  };
}

/**
 * 实测「同一 source 内 confidence 取值是否唯一」。
 *
 * 这是 verify_entity 对外的关键声明，不能硬编码。历史 bug：confidence 曾长期
 * 是 source 的常量编码（同一 source 全表共用一个值），那种状态下「confidence 是
 * 真实质量分」的说法完全站不住。只有实测同一 source 内有 >1 个不同取值，才能
 * 证明 confidence 承载了实体级信息而非来源级常量。
 */
let _confBySource = null;
async function confidenceStatsBySource() {
  if (_confBySource) return _confBySource;
  const sites = await loadSites();
  const m = new Map();
  for (const s of Object.values(sites)) {
    for (const e of s.entities) {
      if (typeof e.confidence !== 'number') continue;
      const src = e.source || 'unknown';
      let set = m.get(src);
      if (!set) { set = new Set(); m.set(src, set); }
      set.add(e.confidence);
    }
  }
  _confBySource = m;
  return m;
}

server.registerTool(
  'verify_entity',
  {
    description:
      '按 DOI 或实体 ID 反查并返回完整溯源链（源→DOI→出版→入库→更新）与真实质量分。跨全部站点查找，用于第三方复核"这条数据从哪来、是否重复入库"。',
    inputSchema: {
      identifier: z.string().describe('DOI（如 10.22331/q-2018-08-06）或实体 ID（如 oa:W2781738013）'),
      site: z.string().optional().describe('可选：只在该站点内反查'),
      citation: z.enum(['bibtex', 'apa', 'ris']).optional().describe('同时返回该格式的引用'),
      includeGaps: z.boolean().default(false).describe('附带该实体所属站对的引用缺口状态'),
    },
  },
  async (args) => {
    const sites = await loadSites();
    const id = String(args.identifier || '').trim();
    const asDoi = /^10\.\d{4,9}\//.test(id);
    const needle = asDoi ? normDoi(id) : id.toLowerCase();

    const hits = [];
    for (const [siteId, s] of Object.entries(sites)) {
      if (args.site && args.site !== siteId) continue;
      for (const ent of s.entities) {
        const byId = id && ent.id && ent.id.toLowerCase() === needle;
        const byDoi = asDoi && ent.doi && normDoi(ent.doi) === needle;
        if (byId || byDoi) hits.push({ site: siteId, entity: ent });
      }
    }

    const base = { identifier: id, interpretedAs: asDoi ? 'doi' : 'id', matchCount: hits.length };
    if (hits.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ ...base, status: 'not_found' }, null, 2) }] };
    }

    const confStats = await confidenceStatsBySource();
    const rows = hits.map(({ site, entity }) => {
      const prov = provenanceChain(entity, site);
      const src = entity.source || 'unknown';
      const distinct = confStats.get(src) || new Set();
      const row = {
        site,
        id: entity.id,
        name: entity.name || entity.title || null,
        provenance: prov,
        crossSitePresentIn: Array.isArray(entity.sites) ? entity.sites : [site],
        // 实测：同一 source 内 confidence 有不同取值 => confidence 是实体级质量分，
        // 不是来源级常量编码。distinctCount<=1 说明该来源仍是常量，不可当质量分用。
        confidenceSource: src,
        confidenceSourceDistinctCount: distinct.size,
        confidenceSourceDeterministic: distinct.size <= 1,
      };
      if (args.citation) row.citation = exportCitation(entity, site, args.citation);
      return row;
    });

    // 重复入库检测：同一 DOI 出现在多个站点
    const doiBySite = new Map();
    for (const r of rows) {
      const d = r.provenance.doi;
      if (!d) continue;
      const k = normDoi(d);
      if (!doiBySite.has(k)) doiBySite.set(k, []);
      doiBySite.get(k).push(r.site);
    }
    const duplicateIngestion = [];
    for (const [d, ss] of doiBySite) {
      if (ss.length > 1) duplicateIngestion.push({ doi: d, sites: ss, count: ss.length });
    }

    const sizes = rows.map((r) => r.confidenceSourceDistinctCount).filter((n) => n > 0);
    const out = {
      ...base,
      status: hits.length > 1 ? (duplicateIngestion.length ? 'found_duplicate_ingestion' : 'found_multi_match') : 'found',
      confidenceNote:
        'confidence 是实体级质量分（源权威度×摘要完整度×领域相关性×新鲜度×被引强度），' +
        '不是 source 的常量编码；qualityTier 是其分档。下面的 confidenceVerdict 是本次实测结论。',
      confidenceVerdict: sizes.length
        ? {
            measurable: true,
            sourcesChecked: sizes.length,
            minDistinctPerSource: Math.min(...sizes),
            isRealQualityScore: Math.min(...sizes) > 1,
            howToRead:
              'isRealQualityScore=true 表示命中来源内 confidence 存在 >1 个不同取值，' +
              '即质量分承载了实体级信息；false 表示该来源仍是常量，不可当质量分引用。',
          }
        : { measurable: false, note: '命中实体无可用 confidence 数值' },
      duplicateIngestion,
      results: rows,
    };

    if (args.includeGaps) {
      const g = loadGaps();
      const involved = new Set(rows.map((r) => r.site));
      if (g && Array.isArray(g.gapPairs)) {
        out.gapContext = g.gapPairs
          .filter((p) => involved.has(p.from) && involved.has(p.to))
          .slice(0, 10);
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  }
);

server.registerTool(
  'snapshot_at',
  {
    description:
      '时间机器：回放某站点在指定日期"当时可见"的数据状态。按入库时间 addedAt 重建，用于审计数据成长曲线、验证回放与 provenance 是否一致。',
    inputSchema: {
      site: z.string().describe('站点 ID'),
      date: z.string().describe('回放日期，格式 YYYY-MM-DD'),
      limit: z.number().min(1).max(50).default(10).describe('返回样例子数'),
      bySource: z.boolean().default(true).describe('按数据源拆分可见量'),
    },
  },
  async (args) => {
    const sites = await loadSites();
    const site = args.site;
    const s = sites[site];
    if (!s) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'site_not_found', site }, null, 2) }], isError: true };
    }
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(args.date));
    if (!m) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'bad_date', expected: 'YYYY-MM-DD' }, null, 2) }], isError: true };
    }
    const cutMs = Date.parse(`${args.date}T23:59:59.999Z`);
    if (Number.isNaN(cutMs)) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'bad_date', expected: 'YYYY-MM-DD' }, null, 2) }], isError: true };
    }

    const ents = s.entities;
    let visible = 0, dated = 0, undated = 0;
    const bySrc = {};
    const sample = [];
    let earliest = null, latest = null;
    for (const e of ents) {
      const t = e.addedAt ? Date.parse(e.addedAt) : null;
      if (t == null || Number.isNaN(t)) {
        undated++;
        continue;
      }
      dated++;
      if (!earliest || t < earliest) earliest = t;
      if (!latest || t > latest) latest = t;
      if (t <= cutMs) {
        visible++;
        const k = e.source || 'unknown';
        bySrc[k] = (bySrc[k] || 0) + 1;
        if (sample.length < args.limit) {
          sample.push({
            id: e.id,
            name: (e.name || e.title || '').slice(0, 90),
            source: e.source,
            doi: e.doi || null,
            addedAt: e.addedAt,
            confidence: e.confidence ?? null,
            qualityTier: e.quality_tier || null,
          });
        }
      }
    }

    const total = ents.length;
    const addedSince = total - visible - undated;
    const result = {
      site,
      at: args.date,
      totalNow: total,
      visibleAtDate: visible,
      visibleRatio: total ? Math.round((visible / total) * 10000) / 10000 : 0,
      addedAfterDate: addedSince,
      undatedEntities: undated,
      ingestionWindow: {
        earliest: earliest ? new Date(earliest).toISOString() : null,
        latest: latest ? new Date(latest).toISOString() : null,
      },
      bySourceAtDate: args.bySource ? bySrc : undefined,
      sampleVisible: sample,
      reconstruction:
        '本回放由 addedAt（入库时间戳，属 provenance 字段）重建，不是逐日存储的历史快照。' +
        '因此它能回答"该日期前入库了多少"，但不能回答"该日期当时某条实体的字段值是什么"。' +
        '若最早入库时间晚于 at，则返回空快照。',
      provenanceConsistency:
        visible === total ? '与当前状态一致' : visible === 0 ? '早于任何入库记录' : '部分可见',
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  'domain_relatedness',
  {
    description:
      '量化两个站点（领域）之间的相关度：基于知识图谱四类边（citation / shared_tag / cross_site / co_topic）+ 引用缺口矩阵。用于区分"真学术联系"与"零引用空白"。',
    inputSchema: {
      from: z.string().describe('起点站点 ID，例如 agent-ecosystem'),
      to: z.string().describe('终点站点 ID，例如 low-altitude'),
      limit: z.number().min(1).max(20).default(5).describe('返回的桥接证据条数'),
    },
  },
  async (args) => {
    const a = String(args.from || '').trim();
    const b = String(args.to || '').trim();
    if (!a || !b) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'bad_args' }, null, 2) }], isError: true };
    }
    const sites = await loadSites();
    const known = Object.keys(sites);
    if (!known.includes(a) || !known.includes(b)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'site_not_found', from: a, to: b, available: known }, null, 2) }],
        isError: true,
      };
    }

    const map = await entityIdToSites();
    const inPair = (k) => {
      const s = map.get(k);
      if (!s) return false;
      return (s.has(a) || s.has(b));
    };
    const domOf = (k) => {
      const s = map.get(k);
      if (!s) return null;
      if (s.has(a) && s.has(b)) return 'both';
      if (s.has(a)) return a;
      if (s.has(b)) return b;
      return null;
    };

    // 1) 图谱边：只统计两端都落在这一对领域内的边
    const kg = loadKg();
    const nodeNames = new Map((kg.nodes || []).map((n) => [n.id, n.name || n.id]));
    const counts = { citation: 0, shared_tag: 0, cross_site: 0, co_topic: 0 };
    const bridges = [];
    for (const e of kg.edges || []) {
      const da = domOf(e.source);
      const db = domOf(e.target);
      if (!da || !db) continue;
      if (!(da !== db)) continue; // 同一领域内不计
      if (counts[e.relation] !== undefined) counts[e.relation]++;
      if (e.relation === 'cross_site' && bridges.length < args.limit) {
        bridges.push({
          source: e.source,
          sourceName: nodeNames.get(e.source) || null,
          sourceSite: da,
          target: e.target,
          targetName: nodeNames.get(e.target) || null,
          targetSite: db,
        });
      }
    }

    // 2) 引用边（数组格式 [doiFrom, doiTo, siteFrom, siteTo]）直接按站对计数
    let citFromTo = 0, citToFrom = 0;
    for (const e of loadCitationEdges()) {
      if (!Array.isArray(e) || e.length < 4) continue;
      if (e[2] === a && e[3] === b) citFromTo++;
      else if (e[2] === b && e[3] === a) citToFrom++;
    }

    // 3) 缺口矩阵
    const g = loadGaps();
    const gapPair = g && Array.isArray(g.gapPairs)
      ? g.gapPairs.find((p) => (p.from === a && p.to === b) || (p.from === b && p.to === a))
      : undefined;

    // 4) 归一化评分（阈值写死在输出里，可审计）
    const caps = { citation: 50, shared_tag: 500, cross_site: 200, co_topic: 100 };
    const weights = { citation: 0.5, shared_tag: 0.2, cross_site: 0.2, co_topic: 0.1 };
    let score = 0;
    for (const k of Object.keys(caps)) score += weights[k] * Math.min((counts[k] || 0) / caps[k], 1);
    score = Math.round(score * 1000) / 1000;
    const tier = citFromTo + citToFrom === 0 && score < 0.05 ? 'zero-citation-gap' : score >= 0.4 ? 'strong' : score >= 0.15 ? 'weak' : 'negligible';

    const result = {
      from: a,
      to: b,
      totalLinks: Object.values(counts).reduce((x, y) => x + y, 0) + citFromTo + citToFrom,
      edgesByType: counts,
      directedCitation: { fromTo: citFromTo, toFrom: citToFrom, total: citFromTo + citToFrom },
      isZeroCitationGap: citFromTo + citToFrom === 0,
      gapRecord: gapPair || null,
      relatedness: score,
      tier,
      scoring: { weights, caps, note: '各边类型按 caps 饱和后加权求和；citation 权重最高，因为它直接体现真实学术引用。' },
      bridges: bridges,
      note:
        'edgesByType 只统计两端都落在该站对内的图谱边；directedCitation 来自 data/citation-edges.json 的站对级直连计数。' +
        'isZeroCitationGap=true 表示该站对是"研究空白候选"，正是扩域的目标。',
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// 启动
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[GeneTech Data MCP] server running on stdio');
