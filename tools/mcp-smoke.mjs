#!/usr/bin/env node
/**
 * GeneTech Data MCP 本地冒烟测试（mcp-smoke）
 * ============================================================================
 * 以子进程方式启动 mcp-server/src/index.mjs，走真实 stdio JSON-RPC 握手：
 *   initialize → notifications/initialized → tools/list →
 *   tools/call(list_sites) → tools/call(query_entities) → tools/call(semantic_search)
 * 全部通过 exit 0；任何一步异常 exit 1。供 CI 与本地发布前预检使用。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'mcp-server', 'src', 'index.mjs');

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });
let buf = '';
const pending = new Map();
let nextId = 1;
const stderrTail = [];

child.stderr.on('data', (d) => {
  stderrTail.push(String(d));
  if (stderrTail.length > 20) stderrTail.shift();
});
child.stdout.on('data', (d) => {
  buf += String(d);
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* 忽略非 JSON 行 */ }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting ${method}`)); }, 60000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  console.error(stderrTail.join(''));
  child.kill();
  process.exit(1);
}

(async () => {
  // 1. initialize 握手
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'genetech-smoke', version: '1.0.0' },
  }).catch((e) => fail(`initialize 失败: ${e.message}`));
  if (!init.result || init.result.serverInfo?.name !== 'genetech-data') fail(`initialize 响应异常: ${JSON.stringify(init).slice(0, 200)}`);
  console.log(`✓ initialize: server=${init.result.serverInfo.name} v${init.result.serverInfo.version}`);
  notify('notifications/initialized', {});

  // 2. tools/list 应含 6 个工具
  const list = await request('tools/list', {}).catch((e) => fail(`tools/list 失败: ${e.message}`));
  const names = (list.result.tools || []).map((t) => t.name);
  const expected = ['list_sites', 'query_entities', 'get_entity', 'semantic_search', 'export_citation', 'ask'];
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length) fail(`缺少工具: ${missing.join(', ')}（实际: ${names.join(', ')}）`);
  console.log(`✓ tools/list: ${names.length} 个工具齐全`);

  // 3. list_sites 真实读数
  const sites = await request('tools/call', { name: 'list_sites', arguments: {} }).catch((e) => fail(`list_sites 失败: ${e.message}`));
  if (sites.result?.isError) fail(`list_sites 返回 isError: ${sites.result.content?.[0]?.text?.slice(0, 150)}`);
  const sitesBody = JSON.parse(sites.result.content[0].text);
  if (!(sitesBody.count > 0)) fail('list_sites 返回 0 个站点（数据契约缺失？检查 <site>/website/api/index.json）');
  console.log(`✓ list_sites: ${sitesBody.count} 个站点（如 ${sitesBody.sites.slice(0, 3).map((s) => `${s.site}:${s.totalEntities}`).join(', ')}）`);

  // 4. query_entities 关键词过滤
  const firstSite = sitesBody.sites[0].site;
  const q = await request('tools/call', {
    name: 'query_entities',
    arguments: { site: firstSite, limit: 3 },
  }).catch((e) => fail(`query_entities 失败: ${e.message}`));
  const qBody = JSON.parse(q.result.content[0].text);
  if (!Array.isArray(qBody.entities)) fail('query_entities 未返回 entities 数组');
  console.log(`✓ query_entities[${firstSite}]: total=${qBody.total} returned=${qBody.returned}`);

  // 5. semantic_search 混合检索
  const s = await request('tools/call', {
    name: 'semantic_search',
    arguments: { query: 'quantum error correction', limit: 3 },
  }).catch((e) => fail(`semantic_search 失败: ${e.message}`));
  if (s.result?.isError) fail(`semantic_search isError: ${s.result.content?.[0]?.text?.slice(0, 150)}`);
  const sBody = JSON.parse(s.result.content[0].text);
  console.log(`✓ semantic_search: mode=${sBody.mode} results=${(sBody.results || []).length}`);

  console.log('[mcp-smoke] 全部通过：stdio 握手 / 6 工具 / 数据读取 / 过滤 / 混合检索均正常');
  child.kill();
  process.exit(0);
})().catch((e) => fail(`未预期异常: ${e.stack || e.message}`));
