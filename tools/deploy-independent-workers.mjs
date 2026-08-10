// 独立部署两个 Worker 到 Cloudflare（账户 8162aa3b / 61960005）
// 不再依赖 swarmlabs.tools zone，自动获得 workers.dev 路由：
//   genetech-license.<sub>.workers.dev
//   genetech-api-guard.<sub>.workers.dev
//
// 用法（需 CF_API_TOKEN 环境变量）：
//   CF_API_TOKEN=cfut_xxx node tools/deploy-independent-workers.mjs
//
// 设计：复用现有 KV (UNIFIED_LICENSES) 避免已签发许可证丢失；
//       虎皮椒凭证直接注入 secret；全新 ADMIN_SECRET（KV 当前为空，换密钥安全）。
//       注意：该 token/账户下 ESM(main_module) 上传持续失败，故两个 Worker 均按
//       经典 Service Worker 格式部署（api-guard 原即经典；unified-license 部署期转为经典，源码保持 ESM）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CF = process.env.CF_API_TOKEN;
if (!CF) { console.error('缺少 CF_API_TOKEN'); process.exit(1); }
const ACCT = '8162aa3b2241c132e43a81f526d7f758';
const KV_ID = 'a24af3fc198b443a8a615d27516d6156';
const SUB = '61960005'; // 账户级 workers.dev 子域

const ALLOWED_SITES = [
  'quantum-computing','alien-minerals','biocomputing','bionic-ai','deep-sea-tech',
  'brain-science','life-science','new-energy','nuclear-energy','robot-parts',
  'tcm-tools','genetech-tools','exo-science','agent-ecosystem','embodied-ai',
  'synbio-manufacturing','semiconductor','ai4science','low-altitude','sat-6g',
  'spatial-computing','privacy-computing','ai-safety','quantum-materials','carbon-neutral',
  'digital-twin','biomed-ai','edge-ai','neuromorphic','agritech',
].join(',');

const ADMIN_SECRET = crypto.randomBytes(24).toString('hex');

// 把 unified-license (ESM) 转成经典 Service Worker，便于本 token/账户部署
function buildLicenseClassic() {
  let h = fs.readFileSync(path.join(ROOT, 'unified-license/hupijiao.js'), 'utf8');
  h = h.replace(/export\s*\{[\s\S]*?\};\s*$/, ''); // 去掉 hupijiao 的 export {}
  let w = fs.readFileSync(path.join(ROOT, 'unified-license/worker.js'), 'utf8');
  w = w.replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/hupijiao\.js['"];?\s*/g, '');
  w = w.replace(/export\s+default\s*\{\s*/, '');
  w = w.replace(/async\s+fetch\s*\(\s*request\s*,\s*env\s*,\s*ctx\s*\)\s*\{/, 'async function __handle(request) {');
  w = w.replace(/},\s*\};\s*$/, '\n}');

  // 用 typeof 守卫把 Cloudflare 注入的全局绑定汇聚成 worker 期望的 env 对象
  const envShim = `
const env = {
  UNIFIED_LICENSES: (typeof UNIFIED_LICENSES !== 'undefined' ? UNIFIED_LICENSES : undefined),
  ADMIN_SECRET: (typeof ADMIN_SECRET !== 'undefined' ? ADMIN_SECRET : undefined),
  HUPIJIAO_APP_ID: (typeof HUPIJIAO_APP_ID !== 'undefined' ? HUPIJIAO_APP_ID : undefined),
  HUPIJIAO_APP_SECRET: (typeof HUPIJIAO_APP_SECRET !== 'undefined' ? HUPIJIAO_APP_SECRET : undefined),
  ALLOWED_SITES: (typeof ALLOWED_SITES !== 'undefined' ? ALLOWED_SITES : undefined),
  HUPIJIAO_PRICE_MAP: (typeof HUPIJIAO_PRICE_MAP !== 'undefined' ? HUPIJIAO_PRICE_MAP : undefined),
  HUPIJIAO_CHANNELS: (typeof HUPIJIAO_CHANNELS !== 'undefined' ? HUPIJIAO_CHANNELS : undefined),
  ALLOWED_ORIGINS: (typeof ALLOWED_ORIGINS !== 'undefined' ? ALLOWED_ORIGINS : undefined),
  HUPIJIAO_NOTIFY_URL: (typeof HUPIJIAO_NOTIFY_URL !== 'undefined' ? HUPIJIAO_NOTIFY_URL : undefined),
  HUPIJIAO_RETURN_URL: (typeof HUPIJIAO_RETURN_URL !== 'undefined' ? HUPIJIAO_RETURN_URL : undefined),
};
`;
  return envShim + '\n' + h + '\n' + w +
    '\naddEventListener("fetch", (event) => { event.respondWith(__handle(event.request)); });\n';
}

// 手动构造 multipart/form-data（精确控制 Content-Type，避免 undici 让 CF 忽略 metadata）
function buildMultipart(fields) {
  const boundary = '----xbnd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const chunks = [];
  for (const f of fields) {
    let head = `--${boundary}\r\n`;
    head += `Content-Disposition: form-data; name="${f.name}"`;
    if (f.filename) head += `; filename="${f.filename}"`;
    head += `\r\n`;
    if (f.contentType) head += `Content-Type: ${f.contentType}\r\n`;
    head += `\r\n`;
    chunks.push(Buffer.from(head, 'utf8'));
    chunks.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function deployClassic(name, code, bindings) {
  const meta = { body_part: 'worker.js', compatibility_date: '2024-09-23', bindings };
  const mp = buildMultipart([
    { name: 'metadata', contentType: 'application/json', data: JSON.stringify(meta) },
    { name: 'worker.js', filename: 'worker.js', contentType: 'application/javascript', data: code },
  ]);
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/workers/scripts/${name}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${CF}`, 'Content-Type': mp.contentType },
    body: mp.body,
  });
  const txt = await res.text();
  let json; try { json = JSON.parse(txt); } catch { json = { raw: txt.slice(0, 300) }; }
  if (!res.ok || json.success === false) {
    console.error(`[FAIL] ${name} HTTP ${res.status}`, JSON.stringify(json).slice(0, 600));
    process.exitCode = 1;
    return null;
  }
  console.log(`[OK] 部署 ${name} -> https://${name}.${SUB}.workers.dev`);
  return `https://${name}.${SUB}.workers.dev`;
}

const licenseCode = buildLicenseClassic();
const licenseBindings = [
  { type: 'kv_namespace', name: 'UNIFIED_LICENSES', namespace_id: KV_ID },
  { type: 'plain_text', name: 'ALLOWED_SITES', text: ALLOWED_SITES },
  { type: 'plain_text', name: 'HUPIJIAO_PRICE_MAP', text: JSON.stringify({ starter: '9.90', pro: '39.90', lifetime: '199.00' }) },
  { type: 'secret_text', name: 'ADMIN_SECRET', text: ADMIN_SECRET },
  { type: 'secret_text', name: 'HUPIJIAO_APP_ID', text: '201906181178' },
  { type: 'secret_text', name: 'HUPIJIAO_APP_SECRET', text: 'd856af3cab45ce0b0ae5d491a2ac94b0' },
];

const apiCode = fs.readFileSync(path.join(ROOT, 'api-guard/worker.js'), 'utf8');
const apiBindings = [
  { type: 'plain_text', name: 'LLM_BRIDGE_BASE', text: 'http://150.158.119.19:8420/v1' },
  { type: 'plain_text', name: 'LLM_BRIDGE_MODEL', text: 'deepseek-chat' },
  { type: 'plain_text', name: 'LLM_FREE_RATE', text: '20' },
  { type: 'plain_text', name: 'LLM_BRIDGE_KEY', text: '' },
  { type: 'plain_text', name: 'LICENSE_VALIDATE_URL', text: `https://genetech-license.${SUB}.workers.dev/api/license/validate` },
];

const a = await deployClassic('genetech-license', licenseCode, licenseBindings);
const b = await deployClassic('genetech-api-guard', apiCode, apiBindings);

console.log('\n=== 部署结果 ===');
console.log('genetech-license :', a || '(失败)');
console.log('genetech-api-guard:', b || '(失败)');
console.log('\n[重要] 新 ADMIN_SECRET（请本地记一份，用于未来管理员签发许可证）:');
console.log(ADMIN_SECRET);
