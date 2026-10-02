#!/usr/bin/env node
/**
 * GeneTech API Guard — Cloudflare REST API 部署脚本（不依赖 wrangler）
 * 用法（GitHub Actions / 本地）：
 *   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx PRO_SECRET=xxx \
 *     node deploy-api.mjs
 * - CLOUDFLARE_ACCOUNT_ID 缺省时，用 token 自动反查第一个账户。
 * - PRO_KV / INTEL_KV 命名空间：已存在则复用，不存在则创建。
 * - Worker 以经典 Service Worker 格式上传，内联注入 PRO_SECRET(secret_text)、
 *   PRO_KV(kv_namespace)、INTEL_KV(kv_namespace) 与 PRO_FREE_RATE(vars)，
 *   一次到位、幂等可重复运行。
 *
 * 2026-10-02 修复（P0，静默降级）
 *   Cloudflare 的 PUT /workers/scripts 是**整体替换**语义：不在本次 metadata 里
 *   出现的绑定会被移除。旧版脚本只注入 PRO_SECRET + PRO_KV，于是每跑一次
 *   deploy-api.mjs，线上 Worker 的 INTEL_KV 绑定就被悄悄摘掉：
 *     - /v1/intel/subscriptions → 503 no_storage（worker.js 硬返回）
 *     - /v1/intel/* 的 _storage 从 intel_kv 掉回 memory_only（重启即丢）
 *   而部署本身依然打印「部署成功」——典型的优雅降级变成生产静默故障。
 *   worker.js 里 INTEL_KV 是主存储（PRO_KV 只是 fallback），漏绑不是一个可选优化。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CF = process.env.CLOUDFLARE_API_TOKEN;
const PRO_SECRET = process.env.PRO_SECRET;
const SCRIPT = 'genetech-api-guard';
const CF_API = 'https://api.cloudflare.com/client/v4';

// LLM 桥接（可选）：让 /api/llm/* 通；不传则不开启 AI（Worker 返回 503 提示）。
const LLM_BRIDGE_BASE = process.env.LLM_BRIDGE_BASE || '';
const LLM_BRIDGE_KEY = process.env.LLM_BRIDGE_KEY || '';
const LLM_BRIDGE_MODEL = process.env.LLM_BRIDGE_MODEL || 'deepseek-chat';
const LLM_FREE_RATE = process.env.LLM_FREE_RATE || '20';

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

// 本账户下已有 KV 的名字。用来在多个 CF 账户里指认「装我们命名空间的那个账户」：
// 直接取 accounts[0] 在 3 账户环境里会指错（错账户下 KV 名不存在 → 凭空创建同名的空 KV，
// 于是 Worker 绑到一个空命名空间上，比不绑更难查）。
const NAMESPACES = ['PRO_KV', 'INTEL_KV'];

async function resolveAccount() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const r = await cf('GET', '/accounts?per_page=10');
  if (!r.json?.success || !r.json.result?.length) { console.error('✗ 无法反查 Account ID（响应：', r.text, '）'); process.exit(1); }
  // 优先选「已经同时含 PRO_KV 与 INTEL_KV」的账户，避免把命名空间建到空账户里
  let chosen = null;
  for (const acct of r.json.result) {
    const ns = await cf('GET', `/accounts/${acct.id}/storage/kv/namespaces?per_page=100`);
    const titles = new Set((ns.json?.result || []).map((n) => n.title));
    const hit = NAMESPACES.filter((t) => titles.has(t));
    if (hit.length > (chosen ? chosen.hit.length : -1)) chosen = { id: acct.id, hit };
    if (hit.length === NAMESPACES.length) break;
  }
  if (!chosen || !chosen.hit.length) {
    console.error('✗ 反查不到持有 PRO_KV / INTEL_KV 的账户，请显式设置 CLOUDFLARE_ACCOUNT_ID');
    console.error('   该 token 可见账户：', r.json.result.map((a) => a.id).join(', '));
    process.exit(1);
  }
  const id = chosen.id;
  console.log(`→ 反查到 Account ID: ${id}（已有命名空间 ${chosen.hit.join('/')}）`);
  return id;
}

async function ensureKV(acct, title) {
  const list = await cf('GET', `/accounts/${acct}/storage/kv/namespaces`);
  const found = list.json?.result?.find((n) => n.title === title);
  if (found) { console.log(`✓ 复用 ${title}:`, found.id); return found.id; }
  const create = await cf('POST', `/accounts/${acct}/storage/kv/namespaces`, { title });
  if (!create.json?.success) { console.error(`✗ 创建 ${title} 失败:`, create.text); process.exit(1); }
  console.log(`✓ 新建 ${title}:`, create.json.result.id);
  return create.json.result.id;
}

async function deploy(acct, proKvId, intelKvId) {
  const workerSrc = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8');
  const boundary = '----genetech' + Date.now();
  const meta = {
    body_part: 'worker.js',
    compatibility_date: '2024-09-23',
    // 两个 KV 必须同时出现：PUT 是整体替换语义，漏一个 = 静默摘绑（见文件头注释）
    bindings: [
      { type: 'secret_text', name: 'PRO_SECRET', text: PRO_SECRET },
      { type: 'kv_namespace', name: 'PRO_KV', namespace_id: proKvId },
      { type: 'kv_namespace', name: 'INTEL_KV', namespace_id: intelKvId },
    ],
    vars: {
      PRO_FREE_RATE: '60',
      LLM_BRIDGE_BASE,
      LLM_BRIDGE_KEY,
      LLM_BRIDGE_MODEL,
      LLM_FREE_RATE,
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
    console.log('✓ Worker', SCRIPT, '部署成功（脚本 + PRO_SECRET + PRO_KV + INTEL_KV + vars 已注入）');
    // 部署完立刻回读绑定，确认没有静默丢绑。Cloudflare PUT 只保证「我们发过去的」，
    // 不保证「线上现在有」，这一步是唯一能在部署后立刻证伪的检查。
    const after = await cf('GET', `/accounts/${acct}/workers/scripts/${SCRIPT}`);
    // CF 两种返回形状都要能吃下：旧/常规是 result.bindings，部分账户路径是 result.env.bindings。
    // 只读 result.bindings 会得到空数组 → 误判「所有绑定都丢了」→ 部署永远失败。
    // 2026-10-02 实测踩过第一次（PRO_SECRET 假阴性），第二次（PRO_KV 假阴性，线上绑定打印为空）。
    const res0 = after.json?.result || {};
    // 顺序不能反过来：空数组是 truthy，`res0.bindings || res0.env?.bindings` 遇到
    // result.bindings 为 [] 时会直接短路到空数组，env.bindings 永远读不到。
    // 2026-10-02 第三次部署失败就是这条短路造成的（报「线上绑定：(空)」）。
    const binds = (Array.isArray(res0.bindings) && res0.bindings.length
      ? res0.bindings
      : (res0.env?.bindings || []));
    const names = new Set(binds.map((b) => b.name));
    // 关键：Cloudflare 的 GET script **不回显 secret_text 绑定**（只返回 kv_namespaces / vars / 等可序列化项）。
    // 把 PRO_SECRET 当回读对象 = 必现假阴性 → exit 1 → 部署永远失败 → 线上代码停在旧版本。
    // （2026-10-02 实测：api-guard-deploy 就是因为这条假阴性连续红，线上 Worker 一直跑旧脚本。）
    // 所以这里只对 kv_namespace 做硬校验；secret_text 只打印线上实际绑定清单供人工核对，
    // 真正的验证靠部署请求本身返回 2xx（CF 对绑定格式错误会直接 400/200+errors）。
    // 诊断必须在循环之前打印：校验失败会立刻 exit，放在后面等于永远看不到。
    // 全部走 stderr：CI 里 stdout 是 pipe，process.exit() 会截断还没 flush 的
    // console.log（stderr 在 Node 里是同步写，留得住）。诊断行因此"凭空消失"过一轮。
    const say = (s) => process.stderr.write(s + '\n');
    say(`  [诊断] GET script 返回键：${Object.keys(res0).join(', ')}；解析到 ${binds.length} 条绑定`);
    if (!binds.length) say(`  [诊断] GET script 原始返回（截断 1200B）：${JSON.stringify(res0).slice(0, 1200)}`);
    for (const need of ['PRO_KV', 'INTEL_KV']) {
      if (!names.has(need)) {
        say(`✗ 回读校验失败：${need} 不在线上绑定里。线上绑定：${[...names].join(', ') || '(空)'}`);
        say(`  [诊断] 原始返回键：${Object.keys(res0).join(', ')}；result=${JSON.stringify(res0).slice(0, 1200)}`);
        process.exitCode = 1;
        return false;
      }
    }
    console.log(`✓ 绑定回读一致：${['PRO_KV', 'INTEL_KV'].filter((n) => names.has(n)).join(' / ')} 均在；`
      + `PRO_SECRET 为 secret_text，CF GET script 不回显，本次以 2xx 为准。线上绑定清单：${[...names].join(', ') || '(空)'}`);
    return true;
  }
  console.error('✗ 部署失败:', text.slice(0, 600));
  process.exit(1);
}

(async () => {
  const acct = await resolveAccount();
  const proKvId = await ensureKV(acct, 'PRO_KV');
  const intelKvId = await ensureKV(acct, 'INTEL_KV');
  const ok = await deploy(acct, proKvId, intelKvId);
  if (!ok) process.exit(1); // 只设 exitCode 不 exit：留时间把 stderr 冲出去
  console.log('=== api-guard 部署完成 ===');
})().catch((e) => { console.error('ERR', e); process.exit(1); });
