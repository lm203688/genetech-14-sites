#!/usr/bin/env node
/**
 * GeneTech 数据引擎 MCP Server — HTTP 模式（MCP 2025-11-25 streamable HTTP）
 * ----------------------------------------------------------------------------
 * 让外部 MCP 客户端通过 HTTP 直接连入 server（vs. `index.mjs` 的 stdio 模式）。
 * 实现基于 SDK 官方 `createMcpHandler`，协商协议版本为 **2025-11-25**（SDK v2.3.1 默认支持的最高修订版）。
 * 注意：2026-07-28 修订版要求的 per-request `_meta` envelope 未实现，因此**不宣称**支持 2026-07-28
 * （10-13 报告 N1：对外协议版本必须与实测一致，防可证伪虚假宣称）。
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
import { server as existingServer, warmupServer } from './index.mjs';

// createMcpHandler 要求工厂函数返回 server 实例。
// 这里复用 index.mjs 里已注册 14 个工具的 server，避免重复注册。
// 注意：createMcpHandler 每次请求会调用 factory，返回同一个 server 实例。
// MCP 协议是无状态的（JSON-RPC），server 不维护跨请求的会话状态，
// 因此复用同一实例是安全的。会话管理由 createMcpHandler 内部处理。
const factory = (ctx) => existingServer;

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

    // warmup 端点（非 MCP 协议）：后台预热实体分片，消除首个 tools/call 的冷加载
    if (req.method === 'POST' && req.url === '/warmup') {
      try {
        const r = await warmupServer();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...r }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
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
  console.error(`[GeneTech Data MCP HTTP] tools=${existingServer._registeredTools?.size || '?'} (reused from index.mjs)`);
  // 启动即后台预热（10-13 N2：首调冷加载 23s → 预热后 P95 <2s）。
  // 不阻塞 listen；失败不影响服务，首个请求仍会惰性加载。
  warmupServer()
    .then((r) => console.error(`[warmup] done in ${r.warmedInMs}ms, sites=${r.sites}, searchIndex=${r.searchIndexReady}, graphRag=${r.graphRagReady}`))
    .catch((e) => console.error(`[warmup] failed: ${e.message}`));
});

process.on('SIGINT', () => {
  console.error('[GeneTech Data MCP HTTP] shutting down');
  serverHttp.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  serverHttp.close(() => process.exit(0));
});
