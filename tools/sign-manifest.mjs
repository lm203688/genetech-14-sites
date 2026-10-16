#!/usr/bin/env node
// tools/sign-manifest.mjs — ed25519 签名/验证数据集清单
// 使用 Node 内置 node:crypto 的 Ed25519 密钥对，零外部依赖
//
// 用法：
//   node tools/sign-manifest.mjs --gen-keys                    # 生成密钥对
//   node tools/sign-manifest.mjs --sign <file>                 # 用私钥签
//   node tools/sign-manifest.mjs --verify <file> [--sig <sig>] # 验签
//
// 设计原则：签名对**内容哈希**做；sigfile 是可公开分发的 JSON，含 sha256 + 签名 + 时间戳。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function genKeyPair(keyDir) {
  fs.mkdirSync(keyDir, { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privPath = path.join(keyDir, 'genetech-private.pem');
  const pubPath = path.join(keyDir, 'genetech-public.pem');
  fs.writeFileSync(privPath, privPem, { mode: 0o600 });
  fs.writeFileSync(pubPath, pubPem, { mode: 0o644 });
  console.log(`✓ 私钥: ${privPath}`);
  console.log(`✓ 公钥: ${pubPath}`);
  return { privPath, pubPath };
}

function signFile(filePath, keyDir) {
  const privPath = path.join(keyDir, 'genetech-private.pem');
  if (!fs.existsSync(privPath)) throw new Error(`私钥不存在: ${privPath}`);
  const privateKey = crypto.createPrivateKey(fs.readFileSync(privPath));
  const content = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const signature = crypto.sign(null, content, privateKey);
  const manifest = {
    version: '1.0.0',
    target: path.relative(ROOT, filePath),
    sha256: hash,
    byteLength: content.length,
    signedAt: new Date().toISOString(),
    keyAlgorithm: 'ed25519',
    signature: signature.toString('base64'),
  };
  const sigPath = filePath + '.sig.json';
  fs.writeFileSync(sigPath, JSON.stringify(manifest, null, 2));
  console.log(`✓ 已签名: ${filePath}`);
  console.log(`  sha256: ${hash}`);
  console.log(`  bytes:  ${content.length}`);
  console.log(`  sig:    ${sigPath}`);
  return manifest;
}

function verifyFile(filePath, sigPath) {
  const candidates = [
    path.resolve(ROOT, 'data', 'genetech-public.pem'),
    path.resolve(ROOT, 'tools', 'keys', 'genetech-public.pem'),
    path.resolve(path.dirname(sigPath), 'genetech-public.pem'),
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error('公钥未找到，尝试位置: ' + candidates.join(', '));
  const publicKey = crypto.createPublicKey(fs.readFileSync(found));
  const content = fs.readFileSync(filePath);
  const manifest = JSON.parse(fs.readFileSync(sigPath, 'utf-8'));
  const recomputedHash = crypto.createHash('sha256').update(content).digest('hex');
  const signature = Buffer.from(manifest.signature, 'base64');
  const validSig = crypto.verify(null, content, publicKey, signature);
  const validHash = recomputedHash === manifest.sha256;
  const result = {
    target: manifest.target,
    sha256InManifest: manifest.sha256,
    sha256Computed: recomputedHash,
    hashMatches: validHash,
    signatureValid: validSig,
    overallValid: validHash && validSig,
    signedAt: manifest.signedAt,
    keyAlgorithm: manifest.keyAlgorithm,
    verifiedAt: new Date().toISOString(),
    publicKeyPath: path.relative(ROOT, found),
  };
  console.log(`✓ 验证结果: ${result.overallValid ? 'PASS' : 'FAIL'}`);
  console.log(`  hash match:    ${validHash}`);
  console.log(`  signature:     ${validSig}`);
  console.log(`  target:        ${result.target}`);
  console.log(`  signed at:     ${result.signedAt}`);
  console.log(`  publicKey:     ${result.publicKeyPath}`);
  return result;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {
    cmd: null,
    file: null,
    sig: null,
    keyDir: path.join(ROOT, 'tools', 'keys'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key-dir') {
      opts.keyDir = path.resolve(argv[++i]);
    } else if (a === '--sign') {
      opts.cmd = 'sign';
      opts.file = path.resolve(argv[++i]);
    } else if (a === '--verify') {
      opts.cmd = 'verify';
      opts.file = path.resolve(argv[++i]);
    } else if (a === '--sig') {
      opts.sig = path.resolve(argv[++i]);
    } else if (a === '--gen-keys') {
      opts.cmd = 'genkeys';
    }
  }
  return opts;
}

const opts = parseArgs();
try {
  if (opts.cmd === 'genkeys') {
    genKeyPair(opts.keyDir);
  } else if (opts.cmd === 'sign') {
    if (!opts.file || !fs.existsSync(opts.file)) throw new Error(`文件不存在: ${opts.file}`);
    signFile(opts.file, opts.keyDir);
  } else if (opts.cmd === 'verify') {
    if (!opts.file || !fs.existsSync(opts.file)) throw new Error(`文件不存在: ${opts.file}`);
    const sigPath = opts.sig || (opts.file + '.sig.json');
    if (!fs.existsSync(sigPath)) throw new Error(`签名文件不存在: ${sigPath}`);
    const r = verifyFile(opts.file, sigPath);
    process.exit(r.overallValid ? 0 : 1);
  } else {
    console.error('用法: node tools/sign-manifest.mjs --gen-keys | --sign <file> | --verify <file> [--sig <sig>] [--key-dir <dir>]');
    process.exit(1);
  }
} catch (e) {
  console.error('✗', e.message);
  process.exit(2);
}
