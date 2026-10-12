#!/usr/bin/env node
/**
 * GeneTech 数据引擎 MCP Server — HTTP 模式（MCP 2026-07-28 streamable HTTP）
 * ----------------------------------------------------------------------------
 * 让外部 MCP 客户端通过 HTTP 直接连入本 server（vs. `index.mjs` 的 stdio 模式）。
 * 实现基于 SDK 官方 `createMcpHandler`，符合 2026-07-28 规范（无状态核心 + JSON-RPC over HTTP）。
 *
 * 运行：
 *   node src/http.mjs
 *
 * 环境变量：
 *   PORT                 监听端口（默认 3000）
 *   HOST                 监听地址（默认 0.0.0.0）
 *   GENETECH_API_KEY     若设置，则所有非 OPTIONS 请求都要求 `Authorization: Bearer <key>`
 *   GENETECH_DATA_DIR    本地数据根目录（同 index.mjs）
 *   GENETECH_API_BASE    已部署 API base（同 index.mjs）
 *
 * 部署提示：
 *   - 单进程即可跑多个客户端连接；`createMcpHandler` 内部处理会话状态。
 *   - 上云前建议套一层反代 + TLS（Node 20+ http 模块本身不处理 TLS）。
 *   - 与 mcp-remote/worker.js（Cloudflare Worker 版）共用同一份 tools 定义（通过 `export { server }` 复用）。
 */

import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

// createMcpHandler 要求工厂（每次请求/每次 session 一个独立 server 实例），
// 不能传单例。因此这里内联定义工具（复用 index.mjs 里的 handler 逻辑不方便，
// 因为 index.mjs 是 CLI 单例；HTTP 服务需要无状态、可多 session 并发）。
//
// 这里刻意做一个精简但完整的工具集：list_sites / query_entities / semantic_search /
// citation_gaps 四个最常用的工具。其余 10 个工具通过 mcp-remote/worker.js 提供（完整集）。
// 这样本地 `node src/http.mjs` 就能立即启动 streamable HTTP 端点，且与 mcp-remote 兼容。

const factory = (ctx) => {
  const srv = new McpServer({ name: 'genetech-data-http', version: '2.0.0' });

  // 延迟加载 index.mjs 的数据访问函数（避免重复初始化搜索索引）
  let _api = null;
  const api = async () => {
    if (_api) return _api;
    _api = await import('./http-api.mjs');
    return _api;
  };

  srv.registerTool(
    'list_sites',
    { description: '列出全部站点及其实体数量、最后更新时间。', inputSchema: {} },
    async () => {
      const { listSites } = await api();
      return { content: [{ type: 'text', text: JSON.stringify(listSites(), null, 2) }] };
    }
  );

  srv.registerTool(
    'query_entities',
    {
      description: '按站点/数据源/标签/关键词过滤实体。',
      inputSchema: {
        site: z.string().optional().describe('站点 ID，如 "biomed-ai"'),
        keyword: z.string().optional().describe('全文关键词'),
        source: z.string().optional().describe('数据源，如 "crossref"'),
        limit: z.number().int().min(1).max(100).optional().describe('最多返回条数'),
      },
    },
    async ({ site, keyword, source, limit }) => {
      const { queryEntities } = await api();
      return { content: [{ type: 'text', text: JSON.stringify(queryEntities({ site, keyword, source, limit }) , null, 2) }] };
    }
  );

  srv.registerTool(
    'semantic_search',
    {
      description: '混合检索（BM25+RRF，可选向量）实体，返回带证据链的排序结果。',
      inputSchema: {
        query: z.string().describe('自然语言查询'),
        k: z.number().int().min(1).max(50).optional().describe('返回条数，默认 10'),
      },
    },
    async ({ query, k }) => {
      const { semanticSearch } = await api();
      return { content: [{ type: 'text', text: JSON.stringify(await semanticSearch({ query, k }), null, 2) }] };
    }
  );

  srv.registerTool(
    'citation_gaps',
    { description: '跨域引用缺口矩阵：零引用站对（研究空白候选）+ 站级 in/out 度。', inputSchema: {} },
    async () => {
      const { citationGaps } = await api();
      return { content: [{ type: 'text', text: JSON.stringify(citationGaps(), null, 2) }] };
    }
  );

  return srv;
};

const handler = createMcpHandler(factory);

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.GENETECH_API_KEY || '';

// Node http → fetch 桥接：createMcpHandler 是 Web Fetch API 形状，需将
// Node req/res 包成 Request/Response 对象
function nodeReqToWebReq(req) {
  // req.headers.host 已经带端口号（如 "localhost:3000"），不要重复拼 PORT
  const hostHeader = req.headers.host || `${HOST}:${PORT}`;
  return new Request(`http://${hostHeader}${req.url}`, {
    method: req.method,
    headers: Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])
    ),
    body: ['POST', 'PUT', 'PATCH'].includes(req.method) ? req : undefined,
    duplex: 'half',
  });
}

async function webResToNodeRes(res, nodeRes) {
  const headers = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  nodeRes.writeHead(res.status, headers);
  if (res.body) {
    nodeRes.end(await res.text());
  } else {
    nodeRes.end();
  }
}

const serverHttp = http.createServer(async (req, res) => {
  try {
    // CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }

    // 健康检查（非 MCP 协议）
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'genetech-data-mcp-http', version: '2.0.0' }));
    }

    // 鉴权
    if (API_KEY) {
      const hdr = req.headers.authorization || '';
      const token = String(hdr).replace(/^Bearer\s+/i, '');
      if (token !== API_KEY) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer',
        });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }
    }

    // 交给 createMcpHandler（返回 { fetch, close, notify, ... }，实际入口是 .fetch）
    const webReq = nodeReqToWebReq(req);
    const webRes = await handler.fetch(webReq);
    await webResToNodeRes(webRes, res);
  } catch (err) {
    console.error('[http] error:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: err.message }));
  }
});

serverHttp.listen(PORT, HOST, () => {
  console.error(`[GeneTech Data MCP HTTP] listening on http://${HOST}:${PORT}`);
  console.error(`[GeneTech Data MCP HTTP] auth=${API_KEY ? 'required' : 'disabled (set GENETECH_API_KEY to enable)'}`);
});

process.on('SIGINT', () => {
  console.error('[GeneTech Data MCP HTTP] shutting down');
  serverHttp.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  serverHttp.close(() => process.exit(0));
});
