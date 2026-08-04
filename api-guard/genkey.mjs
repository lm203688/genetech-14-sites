#!/usr/bin/env node
/**
 * 生成 GeneTech Pro API Key（与 api-auth-guard Worker 的 HMAC 校验配套）
 *
 * 用法：
 *   PRO_SECRET=你的密钥 node genkey.mjs <site> [有效天数，默认30]
 *
 * 输出的 Key 格式：gtk_<base64urlPayload>.<hexSig>
 * 用户将其作为 Authorization: Bearer 携带即可访问 /api/pro/* 付费端点。
 */
import crypto from 'node:crypto';

const secret = process.env.PRO_SECRET;
if (!secret) {
  console.error('请先设置环境变量 PRO_SECRET（与 Worker 的 PRO_SECRET 一致）');
  process.exit(1);
}

const site = process.argv[2] || 'genetech-tools';
const days = parseInt(process.argv[3] || '30', 10);
const exp = Date.now() + days * 86400000;

const payloadB64 = Buffer.from(JSON.stringify({ site, exp })).toString('base64url');
const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');

console.log(`gtk_${payloadB64}.${sig}`);
console.log(`\n有效期至: ${new Date(exp).toISOString()} (${days} 天)`);
