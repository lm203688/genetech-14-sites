// GeneTech 统一许可证 Worker 一键部署脚本
// 前置：环境变量
//   CLOUDFLARE_API_TOKEN  必需（Cloudflare API Token，需 Workers Scripts + KV Storage 权限）
//   HUPIJIAO_APP_ID       必需（虎皮椒 AppID，来自用户）
//   HUPIJIAO_APP_SECRET   必需（虎皮椒 AppSecret，来自用户）
//   CF_ACCOUNT_ID         可选（不填则自动从 /accounts 取第一个）
//   ADMIN_SECRET          可选（不填则随机生成并打印，用于 /api/admin/issue HMAC）
//
// 脚本行为：取 account_id → 建/复用 KV 命名空间 → 写好 wrangler.toml（account_id+KV id+30站白名单）
//           → wrangler secret put 注入 3 个密钥 → wrangler deploy → 打印 Worker URL 与管理员密钥。
// 注意：密钥只经 wrangler secret put 送入 Cloudflare，绝不写入仓库或日志明文。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UL = path.join(ROOT, 'unified-license');
const TOML = path.join(UL, 'wrangler.toml');

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const HUP_ID = process.env.HUPIJIAO_APP_ID;
const HUP_SECRET = process.env.HUPIJIAO_APP_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(24).toString('hex');

const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
if (!TOKEN) fail('缺少 CLOUDFLARE_API_TOKEN（Cloudflare API Token）。');
if (!HUP_ID || !HUP_SECRET) fail('缺少 HUPIJIAO_APP_ID / HUPIJIAO_APP_SECRET。');

// 30 个真实站点 slug（与 pipeline SITE_QUERIES 一致）
const SITES = ['quantum-computing','alien-minerals','biocomputing','bionic-ai','deep-sea-tech','brain-science','life-science','new-energy','nuclear-energy','robot-parts','tcm-tools','genetech-tools','exo-science','agent-ecosystem','embodied-ai','synbio-manufacturing','semiconductor','ai4science','low-altitude','sat-6g','spatial-computing','privacy-computing','ai-safety','quantum-materials','carbon-neutral','digital-twin','biomed-ai','edge-ai','neuromorphic','agritech'];

function wranglerEnv() {
  return { ...process.env, CLOUDFLARE_API_TOKEN: TOKEN, NO_COLOR: '1' };
}

function run(args, stdin) {
  return new Promise((resolve, reject) => {
    const p = spawn('npx', ['wrangler', ...args], { cwd: UL, env: wranglerEnv(), shell: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    if (stdin != null) p.stdin.write(stdin);
    p.stdin.end();
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`wrangler ${args.join(' ')} 退出 ${code}\n--- stderr ---\n${err}\n--- stdout ---\n${out}`));
      resolve(out);
    });
  });
}

async function getAccountId() {
  if (process.env.CF_ACCOUNT_ID) return process.env.CF_ACCOUNT_ID;
  const r = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=1', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const j = await r.json();
  if (!j.success || !j.result?.length) fail('无法从 /accounts 获取 account_id，请显式设置 CF_ACCOUNT_ID。');
  console.log('✅ account_id =', j.result[0].id);
  return j.result[0].id;
}

async function ensureKV(accountId) {
  const list = await run(['kv', 'namespace', 'list']);
  let arr = [];
  try { arr = JSON.parse(list); } catch {}
  const hit = arr.find((n) => /UNIFIED_LICENSES/i.test(n.title || ''));
  if (hit) { console.log('✅ 复用已有 KV 命名空间:', hit.id, '(', hit.title, ')'); return hit.id; }
  const created = await run(['kv', 'namespace', 'create', 'UNIFIED_LICENSES']);
  let id = null;
  try { id = JSON.parse(created).result?.id; } catch {}
  if (!id) { const m = created.match(/id\s*=\s*"([a-f0-9]+)"/); id = m && m[1]; }
  if (!id) fail('创建 KV 命名空间失败，输出:\n' + created);
  console.log('✅ 已创建 KV 命名空间:', id);
  return id;
}

function patchToml(accountId, kvId) {
  let t = fs.readFileSync(TOML, 'utf8');
  if (!/^account_id\s*=/.test(t)) {
    t = t.replace(/^(name\s*=\s*"unified-license")/m, `$1\naccount_id = "${accountId}"`);
  } else {
    t = t.replace(/^account_id\s*=\s*".*"/m, `account_id = "${accountId}"`);
  }
  t = t.replace(/id\s*=\s*"__KV_UNIFIED_LICENSES_ID__"/, `id = "${kvId}"`);
  t = t.replace(/ALLOWED_SITES\s*=\s*"[^"]*"/, `ALLOWED_SITES = "${SITES.join(',')}"`);
  fs.writeFileSync(TOML, t);
  console.log('✅ wrangler.toml 已写为真实 account_id / KV id / 30 站白名单');
}

async function putSecret(name, value) {
  await run(['secret', 'put', name], value);
  console.log('✅ secret 已注入:', name);
}

async function main() {
  console.log('▶ 部署统一许可证 Worker（虎皮椒支付通道）');
  const accountId = await getAccountId();
  const kvId = await ensureKV(accountId);
  patchToml(accountId, kvId);
  await putSecret('ADMIN_SECRET', ADMIN_SECRET);
  await putSecret('HUPIJIAO_APP_ID', HUP_ID);
  await putSecret('HUPIJIAO_APP_SECRET', HUP_SECRET);
  console.log('▶ wrangler deploy ...');
  const out = await run(['deploy']);
  const m = out.match(/https:\/\/[^\s]+\.workers\.dev/);
  const url = m ? m[0] : '(请到 Cloudflare 控制台查看 Worker URL)';
  console.log('\n========== 部署完成 ==========');
  console.log('Worker URL :', url);
  console.log('ADMIN_SECRET（请妥善保存，用于管理员签发许可证）:', ADMIN_SECRET);
  console.log('下一步：将此 URL 配置到各站点的 verify.js 的 UNIFIED_API / site-adapter.js 的端点。');
}

main().catch((e) => { console.error('\n部署失败:\n' + e.message); process.exit(1); });
