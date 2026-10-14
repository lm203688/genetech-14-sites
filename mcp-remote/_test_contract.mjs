#!/usr/bin/env node
/**
 * mcp-remote 契约测试
 *
 * 目的（10-14 报告 §2 P0-3 提升方案①）：以 CI 方式跑 14 工具逐一 tools/call，
 * 断言 schema 与路由不再漂移。避免"改一版又 404 一半"的循环。
 *
 * 依赖：mcp-remote/worker.js（本地直接 import，无需 wrangler dev）
 * 桩：fetch 全量替换为本地路由表，命中真实数据；未命中给结构化错误。
 * 门禁：exit 1 = 契约破坏，可挂 GitHub Actions 阻断 PR。
 *
 * 用法：
 *   node mcp-remote/_test_contract.mjs             # 全跑
 *   node mcp-remote/_test_contract.mjs --verbose   # 打印每条断言
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const VERBOSE = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// 1. 加载 worker 与本地数据
// ---------------------------------------------------------------------------
import { pathToFileURL } from 'node:url';
const workerModule = await import(pathToFileURL(path.join(__dirname, 'worker.js')).href);
const worker = workerModule.default;

function loadSiteJson(site, name) {
  const p = path.join(ROOT, site, 'website/api', name);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

const allSites = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const sitesWithData = allSites.filter((s) => fs.existsSync(path.join(ROOT, s, 'website/api/entities.json')));

// ---------------------------------------------------------------------------
// 2. 构建本地 fetch 桩
// ---------------------------------------------------------------------------
function makeFetchStub(apiBase) {
  return async function fetch(url, opts = {}) {
    const u = typeof url === 'string' ? url : url.url;
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;

    // ---- /v1/domains ----
    if (u === `${apiBase}/v1/domains` && method === 'GET') {
      const sites = sitesWithData.map((slug) => {
        const idx = loadSiteJson(slug, 'index.json');
        return {
          slug,
          name: slug,
          totalEntities: idx?.totalEntities ?? 0,
          lastUpdated: idx?.lastUpdated ?? null,
        };
      });
      return jsonResp({ sites });
    }

    // ---- /v1/entities?--- ----
    const mEnt = u.match(new RegExp(`^${escapeRe(apiBase)}/v1/entities\\?(.+)$`));
    if (mEnt && method === 'GET') {
      const q = new URLSearchParams(mEnt[1]);
      const site = q.get('site');
      const kw = q.get('q') || '';
      const limit = Math.min(parseInt(q.get('limit') || '20', 10), 100);
      const ents = loadSiteJson(site || sitesWithData[0], 'entities.json') || [];
      const list = Array.isArray(ents) ? ents : (ents.entities || []);
      let filtered = list;
      if (kw) {
        const k = kw.toLowerCase();
        filtered = list.filter((e) =>
          (e.id || '').toLowerCase().includes(k) ||
          (e.doi || '').toLowerCase().includes(k) ||
          (e.name || '').toLowerCase().includes(k) ||
          (e.title || '').toLowerCase().includes(k),
        );
      }
      const body = filtered.slice(0, limit);
      return jsonResp({ results: body, total: filtered.length, hasMore: filtered.length > limit });
    }

    // ---- /v1/search/semantic（POST）----
    if (u === `${apiBase}/v1/search/semantic` && method === 'POST') {
      const q = body?.query || '';
      const site = Array.isArray(body?.sites) && body.sites.length === 1 ? body.sites[0] : null;
      const ents = loadSiteJson(site || sitesWithData[0], 'entities.json') || [];
      const list = Array.isArray(ents) ? ents : (ents.entities || []);
      const ql = q.toLowerCase();
      const scored = list
        .map((e) => ({
          entity: e,
          _site: site || sitesWithData[0],
          score: (e.name || '').toLowerCase().includes(ql) ? 1.0 : (e.tags || []).some((t) => String(t).toLowerCase().includes(ql)) ? 0.5 : 0.01,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, body?.topK || 10);
      return jsonResp({ query: q, results: scored, total: list.length });
    }

    // ---- /v1/citation/gaps ----
    if (u === `${apiBase}/v1/citation/gaps`) {
      const p = path.join(ROOT, 'data/citation-gaps.json');
      if (fs.existsSync(p)) return jsonResp(JSON.parse(fs.readFileSync(p, 'utf8')));
      return jsonResp({ zeroCitationPairs: 0, totalPairs: 0 });
    }

    // ---- /v1/citation/edges ----
    if (u === `${apiBase}/v1/citation/edges`) {
      const p = path.join(ROOT, 'data/citation-edges.json');
      if (fs.existsSync(p)) return jsonResp(JSON.parse(fs.readFileSync(p, 'utf8')));
      return jsonResp({ edges: [], stats: { totalEdges: 0 } });
    }

    // ---- /v1/intel/health ----
    if (u === `${apiBase}/v1/intel/health` && method === 'GET') {
      return jsonResp({ ok: true, totalRequests: 0, activeSubscriptions: 0 });
    }

    // ---- /v1/intel/demand（POST）----
    if (u === `${apiBase}/v1/intel/demand` && method === 'POST') {
      const rid = 'req_stub_' + Date.now().toString(36);
      return jsonResp({ request_id: rid, status: 'pending', created_at: new Date().toISOString() }, 202);
    }

    // ---- /v1/intel/requests ----
    const mReq = u.match(new RegExp(`^${escapeRe(apiBase)}/v1/intel/requests\\?(.+)$`));
    if (mReq && method === 'GET') {
      return jsonResp({ results: [], total: 0 });
    }

    // ---- /v1/license/validate（POST）----
    if (u.endsWith('/v1/license/validate')) {
      // 契约测试时默认允许，避免走完整鉴权路径
      return jsonResp({ valid: true, tier: 'pro', plan: 'pro' });
    }

    // ---- 未命中的路由 ----
    return new Response(JSON.stringify({ error: 'not_found_stub', path: u }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// 3. 契约测试主体
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    if (VERBOSE) console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function makeReq(method, url, body, headers = {}) {
  const h = new Headers(headers);
  if (body && !h.has('Content-Type')) h.set('Content-Type', 'application/json');
  return new Request(url, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const API_BASE = 'https://api.example.local';
const env = {
  API_BASE_URL: API_BASE,  // worker.js 读的是 API_BASE_URL，不是 API_BASE
  LICENSE_VALIDATE_URL: `${API_BASE}/v1/license/validate`,
  LICENSE_API_SECRET: 'test-secret',
  MAX_FREE_REQUESTS_PER_HOUR: 10000,
};

globalThis.fetch = makeFetchStub(API_BASE);

// ============ 3.1 /health ============
async function testHealth() {
  const r = await worker.fetch(makeReq('GET', `${API_BASE}/health`), env);
  ok('/health 200', r.status === 200);
  const j = await r.json();
  // health 走 jsonRpcResult 包裹，实际结果在 j.result.status
  ok('/health 含 result.status', j?.result?.status === 'ok', JSON.stringify(j).slice(0, 200));
}

// ============ 3.2 GET /mcp → 405 ============
async function testGetMcp405() {
  const r = await worker.fetch(makeReq('GET', `${API_BASE}/mcp`), env);
  ok('GET /mcp 405', r.status === 405, `got ${r.status}`);
  const j = await r.json();
  ok('GET /mcp error code = method_not_allowed', j.error === 'method_not_allowed');
  ok('GET /mcp Allow header = POST', r.headers.get('Allow') === 'POST');
}

// ============ 3.3 initialize ============
async function testInitialize() {
  const r = await worker.fetch(makeReq('POST', `${API_BASE}/mcp`, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', clientInfo: { name: 'test', version: '0' } },
  }), env);
  ok('initialize 200', r.status === 200);
  const j = await r.json();
  ok('initialize result 存在', !!j.result);
  ok('initialize protocolVersion 有值', !!j.result?.protocolVersion);
  ok('initialize capabilities.tools 存在', !!j.result?.capabilities?.tools);
}

// ============ 3.4 tools/list 数量 ============
async function testToolsList() {
  const r = await worker.fetch(makeReq('POST', `${API_BASE}/mcp`, {
    jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
  }), env);
  const j = await r.json();
  const tools = j.result?.tools || [];
  ok('tools/list 返回 14 工具', tools.length === 14, `got ${tools.length}`);
  const names = new Set(tools.map((t) => t.name));
  const expected = [
    'list_sites', 'query_entities', 'get_entity', 'semantic_search',
    'graph_search', 'export_citation', 'citation_gaps', 'ask',
    'submit_request', 'retrieve_requests', 'intake_health',
    'verify_entity', 'snapshot_at', 'domain_relatedness',
  ];
  for (const n of expected) ok(`工具存在: ${n}`, names.has(n));
  // schema 参数对齐本地 mcp-server
  const ss = tools.find((t) => t.name === 'semantic_search');
  const params = ss?.inputSchema?.properties || {};
  ok('semantic_search schema 用 topK', !!params.topK, `params=${Object.keys(params).join(',')}`);
}

// ============ 3.5 逐一 tools/call ============
async function callTool(name, args = {}) {
  const r = await worker.fetch(makeReq('POST', `${API_BASE}/mcp`, {
    jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call',
    params: { name, arguments: args },
  }), env);
  const j = await r.json();
  // 兼容 MCP 文本 / JSON 两种返回
  let parsed = null;
  const text = j?.result?.content?.[0]?.text;
  if (text) {
    try { parsed = JSON.parse(text); } catch { /* 保留原文 */ }
  }
  return { status: r.status, json: j, text, parsed };
}

async function testAllTools() {
  const firstSite = sitesWithData[0];
  const ents = loadSiteJson(firstSite, 'entities.json') || [];
  const list = Array.isArray(ents) ? ents : (ents.entities || []);
  const firstEntity = list[0];

  // list_sites
  let r = await callTool('list_sites');
  ok('list_sites 非空', !!r.json?.result, `status=${r.status}`);

  // query_entities
  r = await callTool('query_entities', { site: firstSite, limit: 5 });
  ok('query_entities 非空', !!r.json?.result);

  // get_entity
  if (firstEntity) {
    r = await callTool('get_entity', { id: firstEntity.id || 'any-id' });
    ok('get_entity 不返回 HTTP 404 状态', r.status === 200);
    const t = r.text || '';
    ok('get_entity 返回体包含 id 或提示', t.includes('id') || t.includes('404') || t.includes('未找到'));
  }

  // semantic_search
  r = await callTool('semantic_search', { query: 'quantum', site: firstSite, topK: 5 });
  ok('semantic_search 非空', !!r.json?.result || !!r.text);

  // graph_search
  r = await callTool('graph_search', { query: 'quantum', site: firstSite, hops: 2 });
  ok('graph_search 非空', !!r.json?.result || !!r.text);

  // export_citation
  if (firstEntity) {
    r = await callTool('export_citation', { id: firstEntity.id || 'any-id', format: 'bibtex' });
    ok('export_citation 非空', !!r.text);
  }

  // citation_gaps
  r = await callTool('citation_gaps', { mode: 'gaps', limit: 5 });
  ok('citation_gaps 非空', !!r.json?.result || !!r.text);

  // ask
  r = await callTool('ask', { question: 'AlphaFold 3 是什么？', site: firstSite });
  ok('ask 非空', !!r.text);
  ok('ask 返回 references 或 note', (r.text || '').includes('reference') || (r.text || '').includes('note'));

  // submit_request
  r = await callTool('submit_request', {
    project_name: 'test-proj', contact: 'tester',
    purpose: 'contract test', spec: { domains: [firstSite] },
  });
  ok('submit_request 非空', !!r.text || !!r.json?.result);

  // retrieve_requests
  r = await callTool('retrieve_requests', { status: 'pending', limit: 5 });
  ok('retrieve_requests 非空', !!r.json?.result || !!r.text);

  // intake_health
  r = await callTool('intake_health');
  ok('intake_health 非空', !!r.json?.result);

  // verify_entity
  if (firstEntity) {
    r = await callTool('verify_entity', { id: firstEntity.id || 'any-id' });
    ok('verify_entity 非空', !!r.text || !!r.json?.result);
  }

  // snapshot_at
  r = await callTool('snapshot_at', { site: firstSite, date: '2026-10-01' });
  ok('snapshot_at 返回错误提示而非 404', !!r.text);
  ok('snapshot_at 提到"未上线"或"暂未"', (r.text || '').includes('未') || (r.text || '').includes('暂未'));

  // domain_relatedness
  r = await callTool('domain_relatedness', { siteA: firstSite, siteB: sitesWithData[1] || firstSite });
  ok('domain_relatedness 非空', !!r.json?.result || !!r.text);
}

// ============ 3.6 fail-closed 鉴权 ============
async function testFailClosed() {
  // 未配 LICENSE_VALIDATE_URL / LICENSE_API_SECRET 时应 fail-closed
  // 注意：makeReq 的 4 参是 (method, url, body, headers)，Authorization 必须单独传
  const envBad = { ...env, LICENSE_VALIDATE_URL: '', LICENSE_API_SECRET: '' };
  const r = await worker.fetch(makeReq(
    'POST',
    `${API_BASE}/mcp`,
    {
      jsonrpc: '2.0', id: 100, method: 'tools/call',
      params: { name: 'list_sites', arguments: {} },
    },
    { 'Content-Type': 'application/json', Authorization: 'Bearer fake-pro-key' },
  ), envBad);
  ok('缺 LICENSE_VALIDATE_URL 时不返回 200（fail-closed）', r.status !== 200, `status=${r.status}`);
  if (r.status === 200) {
    const j = await r.json();
    ok('fail-closed 未泄漏 JSON-RPC result', !j.result, JSON.stringify(j).slice(0, 120));
  }
}

// ============ 3.7 路由存在性 ============
async function testRoutes() {
  const h = await worker.fetch(makeReq('GET', `${API_BASE}/health`), env);
  ok('GET /health 200', h.status === 200);
  const m = await worker.fetch(makeReq('GET', `${API_BASE}/manifest`), env);
  ok('GET /manifest 200', m.status === 200);
  const bad = await worker.fetch(makeReq('GET', `${API_BASE}/nonexistent`), env);
  ok('GET /nonexistent 404', bad.status === 404);
}

// ---------------------------------------------------------------------------
// 4. 运行
// ---------------------------------------------------------------------------
const t0 = Date.now();
await testHealth();
await testGetMcp405();
await testInitialize();
await testToolsList();
await testAllTools();
await testFailClosed();
await testRoutes();

const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

console.log(`\n===== mcp-remote 契约测试 =====`);
console.log(`通过 ${pass} / 失败 ${fail}（耗时 ${elapsed}s）`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
}
console.log(fail === 0
  ? '\n[gate] PASS — 契约完整，可发布'
  : '\n[gate] FAIL — 存在契约破坏，禁止发布');

process.exit(fail === 0 ? 0 : 1);
