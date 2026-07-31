/**
 * 用户注册端点 — 通用支付模板
 *
 * 功能：
 *   1. 接收邮箱，使用 SHA-256 哈希存储（不存明文）
 *   2. 生成以 gtk_ 为前缀的 API Key
 *   3. 赠送 FREE_CREDITS 免费积分
 *   4. 写入 KV 命名空间（API_KEYS / USER_CREDITS / USER_CREDIT_HISTORY）
 *
 * 路由：POST /api/register
 *
 * 基于 RoboParts register.js（已验证可用）参数化而成，
 * 部署前请用 deploy.js 替换所有 __PLACEHOLDER__ 占位符。
 */

// === 站点配置（部署时自动替换） ===
const CONFIG = {
  SITE_NAME: '__SITE_NAME__',
  SITE_DOMAIN: '__SITE_DOMAIN__',
  CREDITS_URL: '__SITE_DOMAIN__/credits',
  FREE_CREDITS: 100,
  RATE_LIMIT: '30 requests/hour',
};

// === 工具函数 ===

/**
 * SHA-256 哈希（用于邮箱脱敏存储）
 */
async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 生成随机 API Key：gtk_ + 24 字节十六进制
 */
function generateApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return 'gtk_' + Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 统一 JSON 响应（含 CORS 头）
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * 简易邮箱格式校验
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// === CORS 预检 ===
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// === 主处理：POST /api/register ===
export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'bad_request', message: '请求体必须是 JSON' }, 400);
  }

  const email = (body.email || '').trim().toLowerCase();
  if (!email || !isValidEmail(email)) {
    return jsonResponse({ error: 'invalid_email', message: '请提供有效的邮箱地址' }, 400);
  }

  // 1. 邮箱哈希 —— 不存储明文
  const emailHash = await sha256(email);

  // 2. 检查是否已注册（防重复）
  if (env.API_KEYS) {
    const existing = await env.API_KEYS.get(`email:${emailHash}`);
    if (existing) {
      return jsonResponse(
        {
          error: 'already_registered',
          message: '该邮箱已注册，请使用已有 API Key 或前往积分页面查看余额',
          credits_url: CONFIG.CREDITS_URL,
        },
        409
      );
    }
  }

  // 3. 生成 API Key
  const apiKey = generateApiKey();
  const keyHash = await sha256(apiKey);
  const now = new Date().toISOString();

  // 4. 写入 API_KEYS 命名空间
  //    - key:hash -> 用户元数据（通过 API Key 反查）
  //    - email:hash -> apiKey（通过邮箱查重）
  const userMeta = {
    site: CONFIG.SITE_NAME,
    email_hash: emailHash,
    created: now,
    tier: 'free',
  };

  if (env.API_KEYS) {
    await env.API_KEYS.put(`key:${keyHash}`, JSON.stringify(userMeta));
    await env.API_KEYS.put(`email:${emailHash}`, apiKey);
  }

  // 5. 写入 USER_CREDITS 命名空间 —— 赠送免费积分
  const creditRecord = {
    balance: CONFIG.FREE_CREDITS,
    tier: 'free',
    updated: now,
    site: CONFIG.SITE_NAME,
  };
  if (env.USER_CREDITS) {
    await env.USER_CREDITS.put(keyHash, JSON.stringify(creditRecord));
  }

  // 6. 写入 USER_CREDIT_HISTORY 命名空间 —— 记录初始赠送
  const historyEntry = {
    type: 'free_grant',
    amount: CONFIG.FREE_CREDITS,
    balance_after: CONFIG.FREE_CREDITS,
    timestamp: now,
    note: `注册赠送 ${CONFIG.FREE_CREDITS} 免费积分`,
  };
  if (env.USER_CREDIT_HISTORY) {
    const historyKey = `${keyHash}:${Date.now()}`;
    await env.USER_CREDIT_HISTORY.put(historyKey, JSON.stringify(historyEntry));
  }

  // 7. 返回结果（API Key 仅此一次明文返回）
  return jsonResponse(
    {
      success: true,
      api_key: apiKey,
      free_credits: CONFIG.FREE_CREDITS,
      rate_limit: CONFIG.RATE_LIMIT,
      credits_url: CONFIG.CREDITS_URL,
      message: `注册成功！您已获得 ${CONFIG.FREE_CREDITS} 免费积分。请妥善保管您的 API Key，它只会显示一次。`,
      important:
        '请立即复制并保存您的 API Key。出于安全原因，我们无法再次显示它。',
    },
    201
  );
}
