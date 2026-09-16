#!/usr/bin/env node
/**
 * SwarmLabs Gateway — Key 管理工具
 * ============================================================================
 * 三种子命令：
 *
 *   1) secret
 *      生成 GATEWAY_SECRET（用于签发/验证所有 slb_ key）
 *        $ node genkey.mjs secret
 *
 *   2) issue  --client <id> [--project <name>] [--scopes a,b] [--exp-days N] [--quota N]
 *      为某个 partner 项目签发独立 API Key
 *        $ node genkey.mjs issue --client swarm-buzz-2026 \
 *            --project "蜂群科研数据" --scopes entities:read,domains:read \
 *            --exp-days 365 --quota 120
 *
 *   3) list   打印 partners.json 已签发台账
 *        $ node genkey.mjs list
 *
 * 环境变量：
 *   GATEWAY_SECRET     签发时用（issue 必填；也可用 --secret <hex>）
 *
 * Key 格式：slb_<base64url(JSON{client,exp,scopes,quota})>.<hexSig>
 *   - client   partner 标识，吊销时 KV 写 revoked:<client>
 *   - exp      过期 Unix ms
 *   - scopes   允许的 scope 列表
 *   - quota    每 key 每分钟配额（可选，落到 wrangler [vars] 全局配置，此字段仅为元数据）
 */

import fs from 'fs';
import path from 'path';

const HEX_RE = /^[0-9a-fA-F]+$/;

// ---------- HMAC ----------
async function hmacSign(msg, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function b64urlEncode(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return Buffer.from(bin, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomHex(bytes) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ---------- 台账 ----------
const PARTNERS_PATH = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1/')), 'partners.json');
const PARTNERS_PATH_WIN = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Z]:)/, '$1/'), 'partners.json');

function getPartnersPath() {
  // 兼容 Git Bash / POSIX 与 Windows Node 的差异；pathname 可能含 URL-encoded 中文，需 decodeURI
  const urlStr = new URL(import.meta.url).pathname;
  let dir = decodeURI(urlStr).replace(/^\/([A-Z]:)/, '$1/');
  dir = path.dirname(dir);
  return path.join(dir, 'partners.json');
}

function readPartners() {
  const p = getPartnersPath();
  if (!fs.existsSync(p)) return { gateway: 'swarm-labs-gateway', version: '1.0.0', issued: [] };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return { gateway: 'swarm-labs-gateway', version: '1.0.0', issued: [] }; }
}

function writePartners(obj) {
  fs.writeFileSync(getPartnersPath(), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ---------- 子命令 ----------

async function cmdSecret() {
  const secret = randomHex(32);
  console.log(`GATEWAY_SECRET=${secret}`);
  console.log('');
  console.log('使用方法：');
  console.log('  wrangler secret put GATEWAY_SECRET');
  console.log('（或用 --secret <hex> 传给 issue 子命令）');
  return 0;
}

async function cmdIssue(args) {
  const secret = args.secret || process.env.GATEWAY_SECRET;
  if (!secret) {
    console.error('ERROR: GATEWAY_SECRET 未设置。请用 --secret <hex> 或 export GATEWAY_SECRET=<hex>（可先跑 `node genkey.mjs secret`）。');
    return 2;
  }
  if (!HEX_RE.test(secret) || secret.length < 32) {
    console.error('ERROR: secret 必须是 ≥32 hex 字符（≥16 字节随机数）。');
    return 2;
  }
  if (!args.client) {
    console.error('ERROR: --client <id> 必填（partner 唯一标识，吊销靠它）');
    return 2;
  }
  const scopes = (args.scopes || 'entities:read,domains:read').split(',').map(s => s.trim()).filter(Boolean);
  const expDays = parseInt(args['exp-days'] || '365', 10);
  const quota = parseInt(args.quota || '120', 10);
  const expMs = Date.now() + expDays * 86400 * 1000;

  const payload = {
    client: args.client,
    exp: expMs,
    scopes,
    quota,
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacSign(payloadB64, secret);
  const key = `slb_${payloadB64}.${sig}`;

  // 写台账（不写 key 本体，只写元数据；key 打印到 stdout 让操作者复制到 partner）
  const partners = readPartners();
  const entry = {
    clientId: args.client,
    projectName: args.project || args.client,
    scopes,
    quota,
    issuedAt: new Date().toISOString().slice(0, 10),
    expiresAt: new Date(expMs).toISOString().slice(0, 10),
    status: 'active',
    keyPrefix: key.slice(0, 24) + '…',
  };
  partners.issued = partners.issued.filter(p => p.clientId !== args.client);
  partners.issued.push(entry);
  writePartners(partners);

  console.log('✅ 已签发 partner API Key：');
  console.log('');
  console.log(`  clientId     ${args.client}`);
  console.log(`  projectName  ${entry.projectName}`);
  console.log(`  scopes       ${scopes.join(', ')}`);
  console.log(`  quota        ${quota} req/min`);
  console.log(`  expiresAt    ${entry.expiresAt}`);
  console.log('');
  console.log('  KEY（请立刻复制给 partner，此后仅存于本终端与 partner 侧）：');
  console.log('  ------------------------------------------------------');
  console.log(`  ${key}`);
  console.log('  ------------------------------------------------------');
  console.log('');
  console.log(`已同步写入台账 partners.json（只存元数据，不含 key 本体）`);
  return 0;
}

async function cmdList() {
  const partners = readPartners();
  if (!partners.issued.length) {
    console.log('（台账为空，未签发任何 key）');
    return 0;
  }
  console.log(`partner keys (共 ${partners.issued.length})：`);
  console.log('-'.repeat(96));
  for (const p of partners.issued) {
    console.log(`  [${p.status.toUpperCase().padEnd(7)}] ${p.clientId.padEnd(24)} ${p.expiresAt}  scopes=${p.scopes.join(',')}`);
    console.log(`              project=${p.projectName}  prefix=${p.keyPrefix}`);
  }
  return 0;
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case 'secret': return cmdSecret();
    case 'issue': return cmdIssue(args);
    case 'list': return cmdList();
    default:
      console.log('用法：');
      console.log('  node genkey.mjs secret');
      console.log('  node genkey.mjs issue --client <id> [--project <name>] [--scopes a,b] [--exp-days N] [--quota N] [--secret <hex>]');
      console.log('  node genkey.mjs list');
      return cmd ? 2 : 0;
  }
}

main().then(code => process.exit(code)).catch(e => { console.error(e); process.exit(1); });
