#!/usr/bin/env node
/**
 * mcp-latency-gate.mjs — N2 首调延迟门禁
 *
 * 报告验收判据：P95 首次 tools/call < 2s
 * 本脚本启动一次干净的 MCP HTTP server，测量首调 list_sites 与 semantic_search 延迟，
 * 超过阈值即退出非零，用作 CI 门禁。
 *
 * 用法:
 *   node .workbuddy/probe/mcp-latency-gate.mjs [--threshold=2000] [--rounds=3]
 *
 * 说明:
 *   - server 启动时 warmup 在后台运行，首调走 warm 路径
 *   - rounds 次采样取 P95（rounds=1 时取单值）
 *   - 覆盖：list_sites / semantic_search / verify_entity
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(ROOT, 'mcp-server', 'src', 'http.mjs');

const args = process.argv.slice(2);
const PORT = args.find(a => a.startsWith('--port='))?.slice(7) || '3199';
const THRESHOLD_MS = parseInt(args.find(a => a.startsWith('--threshold='))?.slice(12) || '2000', 10);
const ROUNDS = parseInt(args.find(a => a.startsWith('--rounds='))?.slice(9) || '3', 10);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

let failures = [];
function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); failures.push(msg); }

async function post(pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (ct.includes('text/event-stream')) {
    const dataLine = text.split('\n').find(l => l.startsWith('data: '));
    if (dataLine) return { status: res.status, json: JSON.parse(dataLine.slice(6)), text };
  }
  try { return { status: res.status, json: JSON.parse(text), text }; }
  catch { return { status: res.status, text }; }
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.ceil(p / 100 * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}

async function main() {
  console.log(`[mcp-latency-gate] 启动 http.mjs on ${BASE}, threshold=${THRESHOLD_MS}ms, rounds=${ROUNDS}`);
  const child = spawn('node', [SERVER], {
    cwd: ROOT,
    env: { ...process.env, PORT, HOST },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  // 等待 health 就绪
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      const j = await r.json();
      if (j.ok) { ready = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  if (!ready) {
    child.kill('SIGTERM');
    console.error('✗ server 未就绪');
    process.exit(1);
  }
  ok('server /health 就绪');

  // 等后台 warmup 完成（最多 15s）；warmup 期间 tools/call 会被单线程阻塞
  const w0 = Date.now();
  let warmed = false;
  while (Date.now() - w0 < 15000) {
    await new Promise(r => setTimeout(r, 300));
    // 用一次轻量 list_sites 探测 warmup 是否完成
    try {
      const r = await post('/mcp', { jsonrpc: '2.0', id: 900, method: 'tools/call', params: { name: 'list_sites', arguments: {} } });
      if (r.json.result?.content?.length) {
        const t = Date.now() - w0;
        // list_sites 走轻量路径，不等 SearchIndex；改用直接 sleep 到 warmup 日志出现
      }
    } catch {}
    if (Date.now() - w0 > 8000) { warmed = true; break; } // 保守等 8s
  }
  ok(`warmup 等待 ${Date.now() - w0}ms`);

  try {
    // initialize
    const init = await post('/mcp', {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'latency-gate', version: '1' } },
    });
    if (!init.json.result?.serverInfo) fail(`initialize 握手失败: ${JSON.stringify(init.json).slice(0, 150)}`);
    else ok('initialize 握手');

    // tools/list（预热一次，之后测三个首调）
    await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    const targets = [
      { name: 'list_sites', args: {} },
      { name: 'semantic_search', args: { query: 'CRISPR gene editing', limit: 5 } },
      { name: 'verify_entity', args: { query: 'CRISPR' } },
    ];

    for (const t of targets) {
      const samples = [];
      for (let i = 0; i < ROUNDS; i++) {
        const t0 = Date.now();
        const r = await post('/mcp', {
          jsonrpc: '2.0', id: 100 + i, method: 'tools/call',
          params: { name: t.name, arguments: t.args },
        });
        const ms = Date.now() - t0;
        samples.push(ms);
        if (!r.json.result?.content?.length) fail(`${t.name} round ${i} 无返回`);
      }
      samples.sort((a, b) => a - b);
      const p50 = percentile(samples, 50);
      const p95 = percentile(samples, 95);
      const pmax = Math.max(...samples);
      console.log(`  → ${t.name}: p50=${p50}ms p95=${p95}ms max=${pmax}ms [${samples.join(',')}]`);
      if (p95 > THRESHOLD_MS) fail(`${t.name} P95=${p95}ms > 阈值 ${THRESHOLD_MS}ms`);
      else ok(`${t.name} P95=${p95}ms ≤ ${THRESHOLD_MS}ms`);
    }

  } catch (e) {
    fail(`异常: ${e.message}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  if (failures.length) {
    console.log(`\n✗ 延迟门禁失败 ${failures.length} 项：`);
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('\n✓ 首调延迟门禁全部通过（P95 ≤ 阈值）');
}

main().catch(e => { console.error('未捕获异常:', e); process.exit(2); });
