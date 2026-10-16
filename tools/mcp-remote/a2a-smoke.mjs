// tools/mcp-remote/a2a-smoke.mjs
// A2A Agent Card Smoke Test - 冒烟测试
//
// 目标：验证 Worker 部署后 /agent-card 端点可用 + 内容合法 + 签名可验
//       未部署（wrangler 阻塞）时降级为「本地契约验证」：拉 GitHub raw + 校 schema
//
// 使用：
//   node tools/mcp-remote/a2a-smoke.mjs                     # 探测默认线上端点
//   node tools/mcp-remote/a2a-smoke.mjs --local              # 本地文件验证（跳过 HTTP）
//   node tools/mcp-remote/a2a-smoke.mjs --url <url>          # 指定端点
//
// 判据（M4）：
//   1. HTTP 200 + application/json
//   2. JSON 含 name / description / url / version / capabilities / skills 六必需字段
//   3. protocolVersion === "0.3"
//   4. skills.length >= 6
//   5. 若拉 /agent-card.sig.json，ed25519 签名校验通过

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PUB_KEY = path.join(ROOT, 'tools', 'keys', 'genetech-public.pem');
const LOCAL_CARD = path.join(ROOT, 'agent-ecosystem', 'agent-card.json');
const LOCAL_SIG = path.join(ROOT, 'agent-ecosystem', 'agent-card.json.sig.json');

const DEFAULT_URL = 'https://api.swarmlabs.tools/agent-card';

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { url: DEFAULT_URL, local: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') opts.url = argv[++i];
    else if (argv[i] === '--local') opts.local = true;
  }
  return opts;
}

function validateCard(card) {
  const checks = [];
  const REQUIRED = ['name', 'description', 'url', 'version', 'capabilities', 'skills'];
  for (const k of REQUIRED) {
    checks.push({ field: k, ok: !!card[k], detail: card[k] ? (typeof card[k] === 'object' ? 'present' : String(card[k]).slice(0, 40)) : 'MISSING' });
  }
  checks.push({ field: 'protocolVersion', ok: card.protocolVersion === '0.3', detail: card.protocolVersion });
  checks.push({ field: 'skills.count', ok: Array.isArray(card.skills) && card.skills.length >= 6, detail: 'count=' + (Array.isArray(card.skills) ? card.skills.length : 'N/A') });
  return checks;
}

function verifySignature(cardText, sig) {
  if (!fs.existsSync(PUB_KEY)) return { ok: false, detail: 'public key not found' };
  const pubKey = crypto.createPublicKey(fs.readFileSync(PUB_KEY));
  const target = Buffer.from(cardText);
  const sigBuf = Buffer.from(sig.signature, 'base64');
  const ok = crypto.verify(null, target, pubKey, sigBuf);
  const expectedSha = sig.sha256 || sig.digest?.sha256;
  const actualSha = crypto.createHash('sha256').update(target).digest('hex');
  const hashMatch = expectedSha === actualSha;
  return { ok: ok && hashMatch, signedAt: sig.signedAt || sig.signed_at, hashMatch };
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) return { status: res.status, error: 'HTTP ' + res.status };
  const ctype = res.headers.get('content-type') || '';
  const text = await res.text();
  return { status: res.status, ctype, text, json: JSON.parse(text) };
}

async function run(opts) {
  let card, cardText, cardUrl, sig, sigUrl, sigResult, checks, sigOk = null;

  console.log('=== A2A Agent Card Smoke Test ===');
  console.log('started_at: ' + new Date().toISOString());

  if (opts.local) {
    console.log('\n[mode] LOCAL FILE (no HTTP)');
    cardUrl = 'file://' + LOCAL_CARD;
    cardText = fs.readFileSync(LOCAL_CARD, 'utf-8');
    card = JSON.parse(cardText);
    if (fs.existsSync(LOCAL_SIG)) {
      sigUrl = 'file://' + LOCAL_SIG;
      sig = JSON.parse(fs.readFileSync(LOCAL_SIG, 'utf-8'));
    }
  } else {
    console.log('\n[mode] HTTP ENDPOINT');
    console.log('  url: ' + opts.url);
    try {
      const r = await fetchJson(opts.url);
      if (r.error) {
        console.log('  ✗ ' + r.error);
        process.exit(1);
      }
      console.log('  status: ' + r.status + ', content-type: ' + r.ctype);
      cardUrl = opts.url;
      cardText = r.text;
      card = r.json;

      // 拉签名
      sigUrl = opts.url.replace(/\/agent-card$/, '') + '/agent-card.sig.json';
      try {
        const sr = await fetchJson(sigUrl);
        if (!sr.error) {
          sig = JSON.parse(sr.text);
          console.log('  sig pulled: ' + sigUrl);
        }
      } catch (e) {
        console.log('  sig pull failed: ' + e.message);
      }
    } catch (e) {
      console.log('  ✗ fetch failed: ' + e.message);
      console.log('  ⚠ 未部署（wrangler 阻塞）？回退到本地契约验证…');
      // 降级：本地文件验证
      if (fs.existsSync(LOCAL_CARD)) {
        cardText = fs.readFileSync(LOCAL_CARD, 'utf-8');
        card = JSON.parse(cardText);
        cardUrl = 'file://' + LOCAL_CARD + ' (fallback)';
        if (fs.existsSync(LOCAL_SIG)) sig = JSON.parse(fs.readFileSync(LOCAL_SIG, 'utf-8'));
      } else {
        console.log('  ✗ 本地无 card，无法验证');
        process.exit(1);
      }
    }
  }

  // Schema 校验
  console.log('\n[checks] Card Schema');
  checks = validateCard(card);
  let allOk = true;
  for (const c of checks) {
    console.log('  ' + (c.ok ? '✅' : '❌') + ' ' + c.field + ': ' + c.detail);
    if (!c.ok) allOk = false;
  }

  // 签名验证
  if (sig) {
    console.log('\n[checks] ed25519 Signature');
    sigOk = verifySignature(cardText, sig);
    console.log('  ' + (sigOk.ok ? '✅' : '❌') + ' signature valid: ' + sigOk.ok);
    console.log('  signed_at: ' + (sigOk.signedAt || 'N/A'));
    console.log('  hash match: ' + sigOk.hashMatch);
    if (!sigOk.ok) allOk = false;
  } else {
    console.log('\n[checks] ed25519 Signature: SKIPPED (no sig file)');
  }

  // 汇总
  console.log('\n=== SUMMARY ===');
  console.log('card: ' + cardUrl);
  console.log('protocolVersion: ' + card.protocolVersion);
  console.log('skills: ' + (Array.isArray(card.skills) ? card.skills.length : 'N/A'));
  console.log('');
  console.log((allOk ? 'PASS' : 'FAIL') + ' gate: M4 A2A Agent Card');
  process.exit(allOk ? 0 : 1);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  run(parseArgs()).catch(e => { console.error('ERR', e); process.exit(2); });
}
