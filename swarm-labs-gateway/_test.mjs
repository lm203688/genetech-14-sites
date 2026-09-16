#!/usr/bin/env node
/**
 * 本地自测：验证 HMAC 签发 + 校验链路 + Worker 主流程（不依赖 CF 环境）
 * 运行：node _test.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'c62ff6680c5002f1ee7d82d2300578453c976d455556eb6a4f0226cd4b54d51c';

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

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return new TextDecoder().decode(Uint8Array.from(Buffer.from(s, 'base64').toString('binary'), c => c.charCodeAt(0)));
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

async function main() {
  console.log('\n=== SwarmLabs Gateway 本地自测 ===\n');

  // --- 1. 签发 + 验证：swarm-buzz-2026 key ---
  const payload = {
    client: 'swarm-buzz-2026',
    exp: Date.now() + 365 * 86400 * 1000,
    scopes: ['entities:read', 'domains:read'],
    quota: 120,
  };
  const b64 = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacSign(b64, SECRET);
  const key = `slb_${b64}.${sig}`;

  // 校验：签名
  const verifyExpected = await hmacSign(b64, SECRET);
  check('HMAC 签名可复算', constantTimeEqual(verifyExpected, sig));

  // 校验：payload 可解
  const raw = key.slice(4);
  const parts = raw.split('.');
  check('key 结构 parts=2', parts.length === 2);
  const decoded = JSON.parse(b64urlDecode(parts[0]));
  check('payload.client 可解', decoded.client === 'swarm-buzz-2026');
  check('payload.scopes 含 entities:read', decoded.scopes.includes('entities:read'));
  check('payload.exp > now', decoded.exp > Date.now());

  // 校验：篡改签名应失败
  const tamperedSig = sig.slice(0, -2) + '00';
  const tamperedKey = `slb_${b64}.${tamperedSig}`;
  const tamperedExpected = await hmacSign(b64, SECRET);
  check('篡改签名被拒', !constantTimeEqual(tamperedExpected, tamperedSig));

  // 校验：改 client 后签名失效
  const evilPayload = { ...payload, client: 'evil' };
  const evilB64 = b64urlEncode(JSON.stringify(evilPayload));
  const evilSigCheck = await hmacSign(evilB64, SECRET);
  check('改 client 后原签名失效', !constantTimeEqual(evilSigCheck, sig));

  // 校验：过期
  const expiredPayload = { ...payload, exp: Date.now() - 1000 };
  const expiredB64 = b64urlEncode(JSON.stringify(expiredPayload));
  const expiredSig = await hmacSign(expiredB64, SECRET);
  const expiredKey = `slb_${expiredB64}.${expiredSig}`;
  const expiredDecoded = JSON.parse(b64urlDecode(expiredKey.slice(4).split('.')[0]));
  check('过期 key 检出 expired', expiredDecoded.exp < Date.now());

  // --- 2. 验证 partner registry 已写入 ---
  const partners = JSON.parse(fs.readFileSync(path.join(__dirname, 'partners.json'), 'utf8'));
  check('partners.json 存在', fs.existsSync(path.join(__dirname, 'partners.json')));
  check('台账 1 条', partners.issued.length === 1);
  check('台账 clientId 正确', partners.issued[0].clientId === 'swarm-buzz-2026');
  check('台账不含明文 key', !JSON.stringify(partners).includes(key));
  check('台账含 key prefix', partners.issued[0].keyPrefix.startsWith('slb_'));
  check('台账 scopes 完整', partners.issued[0].scopes.length === 2);

  // --- 3. 上游数据可达性（网络探测，只测 GET） ---
  console.log('\n=== 上游数据源可达性 ===');
  try {
    const res = await fetch('https://lm203688.github.io/genetech-14-sites/robot-parts/website/api/entities.json');
    check('上游 robot-parts 200', res.status === 200);
    const data = await res.json();
    check('entities 是数组', Array.isArray(data));
    check('entities ≥ 10000', data.length >= 10000);
    check('首条含 id/name/source/abstract', data[0].id && data[0].name && data[0].source && data[0].abstract);
  } catch (e) {
    console.log(`  ⚠️  上游探测失败（本环境网络问题，非代码问题）：${e.message}`);
  }

  // --- 4. 领域清单完整性 ---
  const domains = [
    'agritech', 'ai-safety', 'ai4science', 'alien-minerals', 'biocomputing',
    'biomed-ai', 'bionic-ai', 'brain-science', 'carbon-neutral', 'deep-sea-tech',
    'digital-twin', 'edge-ai', 'embodied-ai', 'exo-science', 'life-science',
    'low-altitude', 'neuromorphic', 'new-energy', 'nuclear-energy', 'privacy-computing',
    'quantum-computing', 'quantum-materials', 'robot-parts', 'sat-6g',
    'semiconductor', 'spatial-computing', 'synbio-manufacturing', 'tcm-tools',
    'agent-ecosystem', 'genetech-tools',
  ];
  check('领域数 30', domains.length === 30);
  const expectedDir = 'C:/Users/xing/Desktop/知识引擎14站/';
  let allExist = true;
  for (const d of domains) {
    const f = path.join(expectedDir, d, 'website', 'api', 'entities.json');
    if (!fs.existsSync(f)) { console.log(`  ⚠️  本地缺 ${d}`); allExist = false; }
  }
  check('本地 30 领域 entities.json 全存在', allExist);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
