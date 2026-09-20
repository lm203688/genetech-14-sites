#!/usr/bin/env node
/**
 * SwarmLabs Data Gateway — Cloudflare REST API 部署脚本（不依赖 wrangler）
 * 用法：
 *   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx GATEWAY_SECRET=xxx \
 *     node deploy-api.mjs
 * - CLOUDFLARE_ACCOUNT_ID 缺省时，用 token 自动反查第一个账户。
 * - gw-rate KV 命名空间：已存在则复用，不存在则创建。
 * - Worker 以经典 Service Worker 格式上传，内联注入 GATEWAY_SECRET(secret_text)、
 *   GW_KV(kv_namespace) 与 GATEWAY_UPSTREAM / GW_QUOTA_PER_MIN(vars)，幂等可重复。
 *
 * 注意：本 worker 与 api-guard / unified-license 完全解耦，吊销路径独立
 * （wrangler kv key put gw-rate "revoked:<clientId>" "1"）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CF = process.env.CLOUDFLARE_API_TOKEN;
const GATEWAY_SECRET = process.env.GATEWAY_SECRET;
const SCRIPT = 'swarm-labs-gateway';
const CF_API = 'https://api.cloudflare.com/client/v4';

function need(v, name) { if (!v) { console.error(`✗ 缺少环境变量 ${name}`); process.exit(1); } }
need(CF, 'CLOUDFLARE_API_TOKEN');
need(GATEWAY_SECRET, 'GATEWAY_SECRET');

async function cf(method, p, body, isJson = true) {
  const headers = { Authorization: `Bearer ${CF}` };
  if (isJson && body) headers['Content-Type'] = 'application/json';
  const res = await fetch(CF_API + p, { method, headers, body: body ? (isJson ? JSON.stringify(body) : body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

async function resolveAccount() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const r = await cf('GET', '/accounts?per_page=5');
  if (!r.json?.success || !r.json.result?.length) { console.error('✗ 无法反查 Account ID（响应：', r.text, '）'); process.exit(1); }
  const id = r.json.result[0].id;
  console.log('→ 反查到 Account ID:', id);
  return id;
}

async function ensureKV(acct) {
  const list = await cf('GET', `/accounts/${acct}/storage/kv/namespaces`);
  const found = list.json?.result?.find((n) => n.title === 'gw-rate');
  if (found) { console.log('✓ 复用 gw-rate:', found.id); return found.id; }
  const create = await cf('POST', `/accounts/${acct}/storage/kv/namespaces`, { title: 'gw-rate' });
  if (!create.json?.success) { console.error('✗ 创建 gw-rate 失败:', create.text); process.exit(1); }
  console.log('✓ 新建 gw-rate:', create.json.result.id);
  return create.json.result.id;
}

async function deploy(acct, kvId) {
  const workerSrc = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8');
  const boundary = '----swarmlabs-gw' + Date.now();
  const meta = {
    body_part: 'worker.js',
    compatibility_date: '2024-09-23',
    bindings: [
      { type: 'secret_text', name: 'GATEWAY_SECRET', text: GATEWAY_SECRET },
      { type: 'kv_namespace', name: 'GW_KV', namespace_id: kvId },
    ],
    vars: {
      GATEWAY_UPSTREAM: 'https://lm203688.github.io/genetech-14-sites',
      GW_QUOTA_PER_MIN: '120',
    },
  };
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n` + JSON.stringify(meta) + '\r\n' +
    `--${boundary}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript\r\n\r\n` + workerSrc + '\r\n' +
    `--${boundary}--\r\n`;
  const res = await fetch(`${CF_API}/accounts/${acct}/workers/scripts/${SCRIPT}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${CF}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = null; }
  if (res.status >= 200 && res.status < 300 && (!j || j.success)) {
    console.log('✓ Worker', SCRIPT, '部署成功（脚本 + GATEWAY_SECRET + gw-rate + vars 已注入）');
    return true;
  }
  console.error('✗ 部署失败:', text.slice(0, 600));
  process.exit(1);
}

(async () => {
  const acct = await resolveAccount();
  const kvId = await ensureKV(acct);
  await deploy(acct, kvId);
  console.log('=== swarm-labs-gateway 部署完成 ===');
  console.log('Worker URL: https://swarm-labs-gateway.<account-subdomain>.workers.dev');
  console.log('下一步：绑定自定义域（如 gateway.swarmlabs.tools）或直接将 workers.dev 提供给 partner。');
})().catch((e) => { console.error('ERR', e); process.exit(1); });
