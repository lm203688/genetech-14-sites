// tools/ci-verify-sig.mjs
// CI Signature Verification - 门禁验签脚本
//
// 目标：CI 每次运行都对白名单产物验签，任一失败 exit 1 阻断发布
//       输出审计日志 data/signing-audit.jsonl
//
// 使用：
//   node tools/ci-verify-sig.mjs                    # 验签所有白名单
//   node tools/ci-verify-sig.mjs --sign-missing      # 缺签则自动签
//   node tools/ci-verify-sig.mjs --list              # 只看白名单
//   node tools/ci-verify-sig.mjs --target <file>     # 只验签单个文件

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SIGN_TOOL = path.join(ROOT, 'tools', 'sign-manifest.mjs');
const AUDIT_LOG = path.join(ROOT, 'data', 'signing-audit.jsonl');
const PUB_KEY = path.join(ROOT, 'tools', 'keys', 'genetech-public.pem');

// 白名单：所有对外发布的关键产物
const WHITELIST = [
  'data/claims.json',
  'data/hypothesis-cards.json',
  'data/honesty-ledger.json',
  'data/stance-f1-eval.json',
  'data/extracted-claims.json',
  'data/conflicts-v2-robot-parts.json',
  'data/verification-runs/2026-10-16-all.json',
  'agent-ecosystem/agent-card.json',
  'agent-ecosystem/hypothesis-queue.json',
];

function loadPublicKey() {
  if (!fs.existsSync(PUB_KEY)) {
    console.error('FATAL: public key not found at ' + PUB_KEY);
    process.exit(2);
  }
  return crypto.createPublicKey(fs.readFileSync(PUB_KEY));
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function verifyOne(relPath, publicKey) {
  const absPath = path.join(ROOT, relPath);
  const sigPath = absPath + '.sig.json';

  if (!fs.existsSync(absPath)) return { file: relPath, status: 'MISSING_TARGET' };
  if (!fs.existsSync(sigPath)) return { file: relPath, status: 'MISSING_SIG' };

  const target = fs.readFileSync(absPath);
  const sig = JSON.parse(fs.readFileSync(sigPath, 'utf-8'));

  const actualSha = sha256(target);
  const expectedSha = sig.sha256 || sig.digest?.sha256;

  if (actualSha !== expectedSha) {
    return { file: relPath, status: 'HASH_MISMATCH', expectedSha, actualSha };
  }

  const signatureBuf = Buffer.from(sig.signature, 'base64');
  const valid = crypto.verify(null, target, publicKey, signatureBuf);
  return {
    file: relPath,
    status: valid ? 'OK' : 'SIGNATURE_INVALID',
    sha256: actualSha,
    signedAt: sig.signedAt || sig.signed_at,
    bytes: target.length,
  };
}

function appendAudit(entries) {
  fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    count: entries.length,
    ok: entries.filter(e => e.status === 'OK').length,
    failed: entries.filter(e => e.status !== 'OK').length,
  });
  fs.appendFileSync(AUDIT_LOG, line + '\n');
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { mode: 'verify', signMissing: false, target: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sign-missing') opts.signMissing = true;
    else if (a === '--target') opts.target = argv[++i];
    else if (a === '--list') opts.list = true;
  }
  return opts;
}

function main() {
  const opts = parseArgs();
  const publicKey = loadPublicKey();

  if (opts.list) {
    console.log('=== WHITELIST ===');
    for (const f of WHITELIST) console.log('  ' + f);
    return;
  }

  const targets = opts.target ? [opts.target] : WHITELIST;
  const results = [];
  for (const f of targets) {
    const r = verifyOne(f, publicKey);
    results.push(r);
  }

  console.log('=== CI SIGNATURE VERIFICATION ===');
  for (const r of results) {
    const icon = r.status === 'OK' ? '✅' : r.status === 'MISSING_TARGET' ? '⚠️' : '❌';
    const detail = r.sha256 ? r.sha256.slice(0, 12) + '...' : (r.status);
    console.log(icon + ' ' + r.file + ': ' + r.status + ' (' + detail + ')');
  }

  // 缺签则自动签（--sign-missing）
  if (opts.signMissing) {
    const missing = results.filter(r => r.status === 'MISSING_SIG');
    if (missing.length) {
      console.log('\n=== AUTO-SIGNING MISSING (' + missing.length + ') ===');
      
      for (const m of missing) {
        try {
          execFileSync('node', [SIGN_TOOL, '--sign', m.file], { stdio: 'inherit', cwd: ROOT });
          console.log('  signed: ' + m.file);
        } catch (e) {
          console.error('  FAILED to sign: ' + m.file);
        }
      }
      // 重新验签
      for (let i = 0; i < missing.length; i++) {
        results[i] = verifyOne(missing[i].file, publicKey);
      }
    }
  }

  // 审计日志
  appendAudit(results);

  // 汇总 + 门禁
  const ok = results.filter(r => r.status === 'OK').length;
  const failed = results.filter(r => r.status !== 'OK').length;
  const total = results.length;

  console.log('\n=== SUMMARY ===');
  console.log('OK: ' + ok + '/' + total + ' | Failed: ' + failed);
  console.log('audit log: ' + path.relative(ROOT, AUDIT_LOG));

  if (failed > 0) {
    console.log('FAIL gate: ' + failed + ' signature check(s) failed');
    process.exit(1);
  }
  console.log('PASS gate: all signatures valid');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { main(); } catch (e) { console.error('ERR', e); process.exit(2); }
}
