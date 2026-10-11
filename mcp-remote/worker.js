/**
 * GeneTech MCP Remote — Cloudflare Worker (streamable-HTTP endpoint)
 *
 * 作用：让付费用户不用装本地 SDK，直接远程接入 MCP 端点。
 *
 * 传输：MCP v2 2026-07-28 spec 的 streamable-HTTP（JSON-RPC over POST）
 *   POST /mcp        → JSON-RPC 请求（initialize / tools/list / tools/call）
 *   GET  /mcp        → GET 端点预留 SSE（当前返回 200 empty，兼容客户端探测）
 *   GET  /health     → 健康检查（不需鉴权）
 *   GET  /manifest   → glama.json（MCP registry 元数据，不需鉴权）
 *
 * 数据源：
 *   - API_BASE_URL 指向 api.swarmlabs.tools（本仓库 Pages 部署）
 *   - Worker 转发实体/citation/gaps 数据查询到 API_BASE_URL，再包成 JSON-RPC 响应
 *   - 无需自己复制数据，避免与上游数据漂移
 *
 * 鉴权：
 *   - Free tier: 无 key，rate limit 60/min
 *   - Pro tier:  Bearer GUX_ token，转发到 LICENSE_VALIDATE_URL 校验
 *   - 校验失败返回 401
 *
 * 部署：
 *   wrangler deploy
 *
 * 密钥（不要写进文件）：
 *   wrangler secret put LICENSE_VALIDATE_URL
 *   wrangler secret put LICENSE_API_SECRET
 *
 * 前置：
 *   - LICENSE_VALIDATE_URL 需要指向 unified-license Worker 的 /api/license/validate 端点
 *   - API_BASE_URL 需要指向已部署的 api.swarmlabs.tools（当前是 Pages 直出）
 */

// 2026-07-28 MCP v2 spec 的 streamable-HTTP 版本
const MCP_VERSION = '2026-07-28';
const SERVER_NAME = 'genetech-data';
const SERVER_VERSION = '2.0.0';

// 端点常量
const API_BASE = 'https://api.swarmlabs.tools';
const MANIFEST_URL = 'https://lm203688.github.io/genetech-14-sites/mcp-server/glama.json';

// 14 个工具定义（与 mcp-server/src/index.mjs 的 registerTool 保持同步）
const TOOLS = [
  {
    name: 'list_sites',
    description: '列出 GeneTech 知识引擎的全部 30 站点（领域）及其实体数量、最后更新时间。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'query_entities',
    description: '按站点 / 数据源 / 标签 / 关键词 / 置信度过滤知识实体。',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: '站点 ID，例如 genetech-tools / quantum-computing' },
        source: { type: 'string', description: '数据源：pubmed / arxiv / openalex / github / crossref / huggingface' },
        tags: { type: 'string', description: '逗号分隔的标签，实体需命中其一' },
        keyword: { type: 'string', description: '标题/摘要中的关键词' },
        minConfidence: { type: 'number', minimum: 0, maximum: 1, description: '最低置信度阈值' },
        limit: { type: 'number', minimum: 1, maximum: 200, default: 20, description: '返回条数' },
        offset: { type: 'number', minimum: 0, default: 0, description: '分页偏移' },
      },
    },
  },
  {
    name: 'get_entity',
    description: '按 ID 获取单个实体详情，并附带 BibTeX / APA / RIS 引用。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '实体 ID，例如 pmid-42544432' },
        site: { type: 'string', description: '可选站点 ID，缩小查找范围' },
        citation: { type: 'string', enum: ['bibtex', 'apa', 'ris'], description: '同时返回该格式的引用' },
      },
      required: ['id'],
    },
  },
  {
    name: 'semantic_search',
    description: '混合检索（BM25 倒排 + 字段加权 + RRF 融合），可选向量语义。可选 graph_hop 开启图遍历扩召回。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询词/自然语言' },
        site: { type: 'string', description: '可选站点过滤' },
        topK: { type: 'number', default: 10, description: '返回条数' },
        graphHop: { type: 'boolean', default: false, description: '是否开启图遍历' },
      },
      required: ['query'],
    },
  },
  {
    name: 'graph_search',
    description: '图遍历检索：先 hybridSearch 找 anchor 节点，再沿实体关系边做 BFS 多跳遍历。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '起点查询词' },
        hops: { type: 'number', default: 2, description: 'BFS 深度' },
        site: { type: 'string', description: '可选站点过滤' },
      },
      required: ['query'],
    },
  },
  {
    name: 'export_citation',
    description: '将指定实体导出为学术引用格式（BibTeX / APA / RIS）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        site: { type: 'string' },
        format: { type: 'string', enum: ['bibtex', 'apa', 'ris'], default: 'bibtex' },
      },
      required: ['id'],
    },
  },
  {
    name: 'citation_gaps',
    description: '跨域引用缺口矩阵：零引用站对（研究空白候选）、桥接最强、各站入/出度。',
    inputSchema: {
      type: 'object',
      properties: {
        topN: { type: 'number', default: 20, description: 'Top-N 缺口' },
      },
    },
  },
  {
    name: 'ask',
    description: '对 GeneTech 30 站知识引擎做自然语言提问：内部混合检索 + LLM 桥接，返回带参考来源的答案。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '自然语言问题' },
        site: { type: 'string', description: '限定站点范围' },
      },
      required: ['question'],
    },
  },
  {
    name: 'submit_request',
    description: '提交结构化数据需求：下游项目申请定向数据采集。',
    inputSchema: {
      type: 'object',
      properties: {
        project_name: { type: 'string', description: '需求方项目标识' },
        entity_type: { type: 'string' },
        keyword: { type: 'string' },
        site: { type: 'string' },
      },
      required: ['project_name'],
    },
  },
  {
    name: 'retrieve_requests',
    description: '浏览数据需求队列：按状态 / 项目名筛选。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        project_name: { type: 'string' },
        limit: { type: 'number', default: 20 },
        offset: { type: 'number', default: 0 },
      },
    },
  },
  {
    name: 'intake_health',
    description: '检查数据需求队列的健康状态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'verify_entity',
    description: '按 DOI 或实体 ID 反查并返回完整溯源链（源→DOI→出版→入库→更新）与真实质量分。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'DOI 或实体 ID' },
        site: { type: 'string', description: '可选站点' },
      },
      required: ['id'],
    },
  },
  {
    name: 'snapshot_at',
    description: '时间机器：回放某站点在指定日期当时可见的数据状态。',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['site', 'date'],
    },
  },
  {
    name: 'domain_relatedness',
    description: '量化两个站点（领域）之间的相关度：基于知识图谱四类边 + 引用缺口矩阵。',
    inputSchema: {
      type: 'object',
      properties: {
        siteA: { type: 'string' },
        siteB: { type: 'string' },
      },
      required: ['siteA', 'siteB'],
    },
  },
];

/**
 * 处理 JSON-RPC 请求。
 * @param {Request} req
 * @param {Map<string, Response>|null} kv
 */
async function handleJSONRPC(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return jsonRpcError(null, -32700, 'Parse error');

  const { jsonrpc, id, method, params } = body;
  if (jsonrpc !== '2.0' || !method) {
    return jsonRpcError(id, -32600, 'Invalid request');
  }

  // 通知（无 id）
  if (id === undefined) {
    // notifications/initialized 等无响应
    return new Response('', { status: 202, headers: { 'Content-Type': 'application/json' } });
  }

  // 按方法分发
  try {
    switch (method) {
      case 'initialize':
        return jsonRpcResult(id, {
          protocolVersion: MCP_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: {},
            prompts: {},
          },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'GeneTech 30 站知识引擎 MCP。14 个工具覆盖实体查询、语义检索、引用导出、缺口分析、时间机器、跨域相关度。',
        });

      case 'notifications/initialized':
        return jsonRpcResult(id, {});

      case 'ping':
        return jsonRpcResult(id, {});

      case 'tools/list': {
        const cursor = params?.cursor || null;
        return jsonRpcResult(id, {
          tools: TOOLS,
          nextCursor: null,
        });
      }

      case 'tools/call': {
        const toolName = params?.name;
        const args = params?.arguments || {};
        const result = await dispatchTool(toolName, args, env);
        return jsonRpcResult(id, result);
      }

      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return jsonRpcError(id, -32603, `Internal error: ${e.message}`);
  }
}

/**
 * 分发到具体工具实现。当前实现走 API_BASE 转发，避免数据重复维护。
 */
async function dispatchTool(name, args, env) {
  const apiBase = env.API_BASE_URL || API_BASE;
  const headers = { 'Accept': 'application/json' };
  if (env.API_KEY) headers['Authorization'] = `Bearer ${env.API_KEY}`;

  const fetchJson = async (path, opts = {}) => {
    const url = `${apiBase.replace(/\/$/, '')}${path}`;
    const r = await fetch(url, { ...opts, headers });
    if (!r.ok) throw new Error(`API ${r.status}: ${await r.text().catch(() => '')}`);
    return r.json();
  };

  const textResult = (text, isError = false) => ({
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  });
  const jsonResult = (obj) => textResult(JSON.stringify(obj, null, 2));

  try {
    switch (name) {
      case 'list_sites':
        return jsonResult(await fetchJson('/v1/domains'));

      case 'query_entities': {
        const q = new URLSearchParams();
        if (args.site) q.set('site', args.site);
        if (args.source) q.set('source', args.source);
        if (args.keyword) q.set('q', args.keyword);
        if (args.limit) q.set('limit', String(args.limit));
        if (args.offset) q.set('offset', String(args.offset));
        return jsonResult(await fetchJson(`/v1/entities?${q}`));
      }

      case 'get_entity': {
        const url = `${apiBase}/v1/entities/${encodeURIComponent(args.id)}`;
        const r = await fetch(url, { headers });
        if (r.status === 404) return textResult(`404: 未找到实体 ${args.id}`, true);
        const e = await r.json();
        return jsonResult(e);
      }

      case 'semantic_search': {
        const q = new URLSearchParams();
        q.set('q', args.query);
        if (args.site) q.set('site', args.site);
        q.set('topK', String(args.topK || 10));
        if (args.graphHop) q.set('graphHop', '1');
        return jsonResult(await fetchJson(`/v1/search/semantic?${q}`));
      }

      case 'graph_search': {
        const q = new URLSearchParams();
        q.set('q', args.query);
        q.set('hops', String(args.hops || 2));
        if (args.site) q.set('site', args.site);
        return jsonResult(await fetchJson(`/v1/search/graph?${q}`));
      }

      case 'export_citation': {
        const url = `${apiBase}/v1/entities/${encodeURIComponent(args.id)}/citation?format=${args.format || 'bibtex'}`;
        const r = await fetch(url, { headers });
        if (!r.ok) return textResult(`Error: ${r.status}`, true);
        const text = await r.text();
        return textResult(text);
      }

      case 'citation_gaps': {
        const url = `${apiBase}/v1/citation/gaps?topN=${args.topN || 20}`;
        return jsonResult(await fetchJson(url));
      }

      case 'ask': {
        // Ask 走 LLM 桥接：先内部检索 + 桥接生成
        const url = `${apiBase}/v1/ask?${new URLSearchParams({ q: args.question, site: args.site || '' })}`;
        const r = await fetch(url, { headers });
        if (!r.ok) return textResult(`Error: ${r.status}`, true);
        const j = await r.json();
        return textResult(j.answer || JSON.stringify(j, null, 2));
      }

      case 'submit_request': {
        return jsonResult(await fetchJson('/v1/intel/request', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
        }));
      }

      case 'retrieve_requests': {
        const q = new URLSearchParams();
        if (args.status) q.set('status', args.status);
        if (args.project_name) q.set('project', args.project_name);
        q.set('limit', String(args.limit || 20));
        q.set('offset', String(args.offset || 0));
        return jsonResult(await fetchJson(`/v1/intel/requests?${q}`));
      }

      case 'intake_health':
        return jsonResult(await fetchJson('/v1/intel/health'));

      case 'verify_entity': {
        const url = `${apiBase}/v1/entities/${encodeURIComponent(args.id)}/verify`;
        const r = await fetch(url, { headers });
        if (!r.ok) return textResult(`Error: ${r.status}`, true);
        return jsonResult(await r.json());
      }

      case 'snapshot_at': {
        const url = `${apiBase}/v1/domains/${encodeURIComponent(args.site)}/snapshot?date=${args.date}`;
        const r = await fetch(url, { headers });
        if (!r.ok) return textResult(`Error: ${r.status}`, true);
        return jsonResult(await r.json());
      }

      case 'domain_relatedness': {
        const url = `${apiBase}/v1/citation/relatedness?siteA=${encodeURIComponent(args.siteA)}&siteB=${encodeURIComponent(args.siteB)}`;
        const r = await fetch(url, { headers });
        if (!r.ok) return textResult(`Error: ${r.status}`, true);
        return jsonResult(await r.json());
      }

      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (e) {
    return textResult(`Tool error: ${e.message}`, true);
  }
}

function jsonRpcResult(id, result) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonRpcError(id, code, message) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 鉴权：Bearer GUX_ token 校验（转发到 unified-license Worker）。
 * Free tier 无 token 放行 + 限流（当前用 KV 简易计数）。
 */
async function authenticate(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) return { ok: true, tier: 'free' };

  if (!env.LICENSE_VALIDATE_URL || !env.LICENSE_API_SECRET) {
    // 未配验证端点：Pro tier 直接放行（部署前需配 secret）
    return { ok: true, tier: 'pro-unverified' };
  }

  try {
    const r = await fetch(env.LICENSE_VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Api-Secret': env.LICENSE_API_SECRET,
      },
      body: JSON.stringify({ token }),
    });
    if (!r.ok) return { ok: false, tier: 'invalid' };
    const j = await r.json();
    return { ok: j.valid === true, tier: j.tier || 'pro' };
  } catch {
    return { ok: false, tier: 'validate-error' };
  }
}

/**
 * Free tier 简易限流（KV 计数，每分钟一次）。
 * 生产环境建议换成 Cloudflare Rate Limiting API（需 Business+ 计划）。
 */
async function checkRateLimit(req, env, ip) {
  const now = new Date();
  const minute = now.getUTCMinutes();
  const day = now.toISOString().slice(0, 10);
  const key = `rl:${day}:${minute}:${ip}`;
  const kv = env.RATE_KV;
  if (!kv) return true;

  try {
    const cur = (await kv.get(key)) || '0';
    const n = Number(cur) + 1;
    await kv.put(key, String(n), { expirationTtl: 65 });
    return n <= Number(env.RATE_LIMIT || '60');
  } catch {
    return true; // KV 失败不阻断
  }
}

/**
 * 简化 CORS：允许任意 origin（MCP 客户端通常在浏览器/桌面工具里）。
 */
function addCORS(headers, req) {
  const origin = req.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'Content-Type, MCP-Session-Id',
    'Access-Control-Max-Age': '86400',
    ...headers,
  };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';

    // OPTIONS：预检
    if (req.method === 'OPTIONS') {
      return new Response('', { status: 204, headers: addCORS({}, req) });
    }

    // /health 免鉴权
    if (url.pathname === '/health') {
      return jsonRpcResult(null, { status: 'ok', server: SERVER_NAME, version: SERVER_VERSION, time: new Date().toISOString() });
    }

    // /manifest 免鉴权（MCP registry 抓取元数据用）
    if (url.pathname === '/manifest') {
      try {
        const r = await fetch(MANIFEST_URL);
        if (!r.ok) throw new Error(`manifest fetch ${r.status}`);
        const j = await r.json();
        return new Response(JSON.stringify(j), {
          status: 200,
          headers: addCORS({ 'Content-Type': 'application/json' }, req),
        });
      } catch {
        return jsonRpcError(null, -32000, 'Manifest unavailable');
      }
    }

    // /mcp 端点
    if (url.pathname !== '/mcp') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: addCORS({ 'Content-Type': 'application/json' }, req),
      });
    }

    // Free tier 限流
    const auth = await authenticate(req, env);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: 'Unauthorized', tier: auth.tier }), {
        status: 401,
        headers: addCORS({ 'Content-Type': 'application/json' }, req),
      });
    }

    if (auth.tier === 'free' && !(await checkRateLimit(req, env, ip))) {
      return new Response(JSON.stringify({ error: 'Rate limited' }), {
        status: 429,
        headers: addCORS({ 'Content-Type': 'application/json' }, req),
      });
    }

    // GET /mcp 预留 SSE（当前返回 200 empty）
    if (req.method === 'GET') {
      return new Response('', {
        status: 200,
        headers: addCORS({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        }, req),
      });
    }

    // POST /mcp 处理 JSON-RPC
    if (req.method === 'POST') {
      const resp = await handleJSONRPC(req, env);
      // 加上 CORS headers
      const finalHeaders = addCORS({ ...resp.headers }, req);
      return new Response(resp.body, { status: resp.status, headers: finalHeaders });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: addCORS({ 'Content-Type': 'application/json' }, req),
    });
  },
};
