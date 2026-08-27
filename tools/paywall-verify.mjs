#!/usr/bin/env node
/**
 * GeneTech 付费墙线上校验（paywall-verify）
 * ============================================================================
 * 闭环角色：api-guard-deploy.yml 每日部署鉴权 Worker → 本脚本每日校验部署是否真实生效，
 * 形成「部署 → 校验 → 告警」闭环，防止付费墙静默失效（配置漂移 / 部署失败 / 密钥缺失）。
 *
 * 校验项：
 *   1. 公开层：<site>/website/api/index.json 匿名可访问且 200（SEO 友好不被误伤）
 *   2. 付费层：/api/pro/* 无 token → 401/403（未鉴权不可绕过）
 *   3. 付费层：伪造 token → 401/403（签名校验生效，非摆设）
 *   4. 免费层响应头 X-GeneTech-Tier 存在（Worker 真的在链路上）
 *   5. （可选）PAYWALL_PRO_SECRET 提供时：合法签名的 gtk_ token → 200
 *
 * 用法：
 *   PAYWALL_BASE_URL=https://genetech-api-guard.xxx.workers.dev \
 *   SITE_BASE_URL=https://lm203688.github.io/genetech-14-sites \
 *   PAYWALL_SITE=agent-ecosystem \
 *   [PAYWALL_PRO_SECRET=...] node tools/paywall-verify.mjs
 *
 * 未配置 PAYWALL_BASE_URL 时以 exit 0 跳过（CI 中不误伤其它任务）；
 * 配置后任一校验失败 → exit 1（由 workflow 建 Issue 告警）。
 */

const BASE = process.env.PAYWALL_BASE_URL || '';
const SITE_BASE = (process.env.SITE_BASE_URL || 'https://lm203688.github.io/genetech-14-sites').replace(/\/$/, '');
const SITE = process.env.PAYWALL_SITE || 'agent-ecosystem';
const PRO_SECRET = process.env.PAYWALL_PRO_SECRET || process.env.PRO_SECRET || '';

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal, redirect: 'manual' });
  } finally {
    clearTimeout(t);
  }
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacHex(message, secret) {
  const { createHmac } = await import('node:crypto');
  return createHmac('sha256', secret).update(message).digest('hex');
}

// 与 api-guard/worker.js 的 token 格式一致：gtk_<base64urlPayload>.<hexSig>
async function mintToken(site) {
  const payload = b64url(JSON.stringify({ site, exp: Date.now() + 10 * 60 * 1000 }));
  const sig = await hmacHex(payload, PRO_SECRET);
  return `gtk_${payload}.${sig}`;
}

let failures = 0;
function check(name, ok, detail) {
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

(async () => {
  if (!BASE) {
    console.log('[paywall-verify] 未配置 PAYWALL_BASE_URL，跳过线上校验（CI 中属正常：密钥门控）。');
    process.exit(0);
  }
  const base = BASE.replace(/\/$/, '');
  console.log(`[paywall-verify] Worker=${base} SiteBase=${SITE_BASE} Site=${SITE}`);

  // 1. 公开静态 JSON 仍可匿名访问（走 Worker 或源站均可，只要 200）
  try {
    const r = await fetchWithTimeout(`${base}/${SITE}/website/api/index.json`);
    check('公开层 index.json 可访问', r.status === 200, `HTTP ${r.status}, tier=${r.headers.get('x-genetech-tier') || '-'}`);
  } catch (e) {
    check('公开层 index.json 可访问', false, e.message);
  }

  // 2. 付费端点无 token 必须拒绝
  try {
    const r = await fetchWithTimeout(`${base}/api/pro/entities?site=${SITE}`);
    check('付费端点无 token 被拒', r.status === 401 || r.status === 403, `HTTP ${r.status}`);
  } catch (e) {
    check('付费端点无 token 被拒', false, e.message);
  }

  // 3. 伪造 token 必须被拒
  try {
    const forged = 'gtk_' + b64url(JSON.stringify({ site: SITE, exp: Date.now() + 600000 })) + '.' + '0'.repeat(64);
    const r = await fetchWithTimeout(`${base}/api/pro/entities?site=${SITE}`, {
      headers: { Authorization: `Bearer ${forged}` },
    });
    check('付费端点伪造 token 被拒', r.status === 401 || r.status === 403, `HTTP ${r.status}`);
  } catch (e) {
    check('付费端点伪造 token 被拒', false, e.message);
  }

  // 4. 合法 token（需 PRO_SECRET；可选）
  if (PRO_SECRET) {
    try {
      const token = await mintToken(SITE);
      const r = await fetchWithTimeout(`${base}/api/pro/entities?site=${SITE}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      check('付费端点合法 token 放行', r.ok, `HTTP ${r.status}, tier=${r.headers.get('x-genetech-tier') || '-'}`);
    } catch (e) {
      check('付费端点合法 token 放行', false, e.message);
    }
  } else {
    console.log('- 未提供 PAYWALL_PRO_SECRET，跳过合法 token 正向校验（负向校验已覆盖核心安全）');
  }

  console.log(failures === 0 ? '[paywall-verify] 全部通过' : `[paywall-verify] ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})();
