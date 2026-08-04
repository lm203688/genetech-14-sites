#!/usr/bin/env node
/**
 * GeneTech API Guard — Cloudflare REST API 部署脚本（不依赖 wrangler）
 * 用法（GitHub Actions / 本地）：
 *   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx PRO_SECRET=xxx \
 *     node deploy-api.mjs
 * - CLOUDFLARE_ACCOUNT_ID 缺省时，用 token 自动反查第一个账户。
 * - PRO_KV 命名空间：已存在则复用，不存在则创建。
 * - Worker 以经典 Service Worker 格式上传，内联注入 PRO_SECRET(secret_text)、
 *   PRO_KV(kv_namespace) 与 PRO_FREE_RATE(vars)，一次到位、幂等可重复运行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CF = process.env.CLOUDFLARE_API_TOKEN;
const PRO_SECRET = process.env.PRO_SECRET;
const SCRIPT = 'genetech-api-guard';
const CF_API = 'https://api.cloudflare.com/client/v4';

function need(v, name) { if (!v) { console.error(`✗ 缺少环境变量 ${name}`); process.exit(1); } }
need(CF, 'CLOUDFLARE_API_TOKEN');
need(PRO_SECRET, 'PRO_SECRET');

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
  const found = list.json?.result?.find((n) => n.title === 'PRO_KV');
  if (found) { console.log('✓ 复用 PRO_KV:', found.id); return found.id; }
  const create = await cf('POST', `/accounts/${acct}/storage/kv/namespaces`, { title: 'PRO_KV' });
  if (!create.json?.success) { console.error('✗ 创建 PRO_KV 失败:', create.text); process.exit(1); }
  console.log('✓ 新建 PRO_KV:', create.json.result.id);
  return create.json.result.id;
}

async function deploy(acct, kvId) {
  const workerSrc = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8');
  const boundary = '----genetech' + Date.now();
  const meta = {
    body_part: 'worker.js',
    compatibility_date: '2024-09-23',
    bindings: [
      { type: 'secret_text', name: 'PRO_SECRET', text: PRO_SECRET },
      { type: 'kv_namespace', name: 'PRO_KV', namespace_id: kvId },
    ],
    vars: { PRO_FREE_RATE: '60' },
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
    console.log('✓ Worker', SCRIPT, '部署成功（脚本 + PRO_SECRET + PRO_KV + vars 已注入）');
    return true;
  }
  console.error('✗ 部署失败:', text.slice(0, 600));
  process.exit(1);
}

(async () => {
  const acct = await resolveAccount();
  const kvId = await ensureKV(acct);
  await deploy(acct, kvId);
  console.log('=== api-guard 部署完成 ===');
})().catch((e) => { console.error('ERR', e); process.exit(1); });
