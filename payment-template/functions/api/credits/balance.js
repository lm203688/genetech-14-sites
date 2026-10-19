/**
 * 余额查询与许可证兑换端点 — 通用支付模板
 *
 * 功能：
 *   GET  /api/credits/balance  — 查询当前积分余额与使用情况
 *   POST /api/credits/balance  — 使用 License Key 兑换积分
 *
 * 基于 RoboParts balance.js（已验证可用）参数化而成，
 * 部署前请用 deploy.js 替换所有 __PLACEHOLDER__ 占位符。
 */

// === 站点配置（部署时自动替换） ===
const CONFIG = {
  SITE_NAME: '__SITE_NAME__',
  SITE_DOMAIN: '__SITE_DOMAIN__',
  CREDITS_URL: '__SITE_DOMAIN__/credits',
  FREE_CREDITS: 100,
  RATE_LIMIT: '30 requests/hour',
  // 产品 ID -> 积分映射（部署时替换为真实 Creem 产品 ID）
  PRODUCT_MAP: {
    '__PRODUCT_STARTER__': { credits: 100, name: 'Starter 入门包', tier: 'pro' },
    '__PRODUCT_PRO__': { credits: 500, name: 'Pro 专业包', tier: 'pro' },
    '__PRODUCT_LIFETIME__': { credits: -1, name: 'Lifetime 终身包', tier: 'lifetime' },
  },
};

// === 工具函数 ===

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Cache-Control': 'no-store',
    },
  });
}

function errorResponse(code, message, status = 400) {
  return jsonResponse({ error: code, message }, status);
}

/**
 * 从请求中提取 API Key
 * 优先级：X-API-Key 头 > Authorization: Bearer > query param
 */
function extractApiKey(request) {
  const headerKey =
    request.headers.get('X-API-Key') ||
    request.headers.get('Authorization')?.replace('Bearer ', '');
  const queryKey = new URL(request.url).searchParams.get('api_key');
  return headerKey || queryKey || null;
}

/**
 * 获取用户积分记录
 */
async function getCredits(keyHash, env) {
  if (!env.USER_CREDITS) return null;
  const raw = await env.USER_CREDITS.get(keyHash);
  return raw ? JSON.parse(raw) : null;
}

/**
 * 写入积分历史记录
 */
async function appendHistory(keyHash, entry, env) {
  if (!env.USER_CREDIT_HISTORY) return;
  const historyKey = `${keyHash}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
  await env.USER_CREDIT_HISTORY.put(historyKey, JSON.stringify(entry));
}

// === CORS 预检 ===
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// === GET：查询余额 ===
export async function onRequestGet({ request, env }) {
  const apiKey = extractApiKey(request);
  if (!apiKey) {
    return errorResponse('missing_api_key', '请提供 API Key（X-API-Key 头或 api_key 参数）', 401);
  }

  const keyHash = await sha256(apiKey);

  // 验证 API Key 是否存在
  if (env.API_KEYS) {
    const userMeta = await env.API_KEYS.get(`key:${keyHash}`);
    if (!userMeta) {
      return errorResponse('invalid_api_key', 'API Key 无效或未注册', 401);
    }
  }

  const credits = await getCredits(keyHash, env);
  if (!credits) {
    return errorResponse('no_credits', '未找到积分记录，请先注册', 404);
  }

  const isUnlimited = credits.balance === -1 || credits.tier === 'lifetime';

  return jsonResponse({
    success: true,
    site: CONFIG.SITE_NAME,
    balance: isUnlimited ? 'unlimited' : credits.balance,
    tier: credits.tier,
    rate_limit: CONFIG.RATE_LIMIT,
    updated: credits.updated,
    is_unlimited: isUnlimited,
  });
}

// === POST：兑换 License Key ===
export async function onRequestPost({ request, env }) {
  const apiKey = extractApiKey(request);
  if (!apiKey) {
    return errorResponse('missing_api_key', '请提供 API Key（X-API-Key 头）', 401);
  }

  const keyHash = await sha256(apiKey);

  // 验证 API Key
  if (env.API_KEYS) {
    const userMeta = await env.API_KEYS.get(`key:${keyHash}`);
    if (!userMeta) {
      return errorResponse('invalid_api_key', 'API Key 无效或未注册', 401);
    }
  }

  // 解析请求体
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('bad_request', '请求体必须是 JSON', 400);
  }

  const licenseKey = (body.license_key || '').trim();
  if (!licenseKey) {
    return errorResponse('missing_license', '请提供 license_key 字段', 400);
  }

  // 1. 检查 License Key 是否已被使用（防重复兑换）
  const licenseHash = await sha256(licenseKey);
  if (env.API_KEYS) {
    const used = await env.API_KEYS.get(`license:${licenseHash}`);
    if (used) {
      return errorResponse('license_used', '该 License Key 已被使用', 409);
    }
  }

  // 2. 根据产品映射确定积分数量
  //    License Key 格式约定：<product_id>-<random>
  //    取前缀匹配产品 ID
  let matchedProduct = null;
  let productId = null;
  for (const [pid, info] of Object.entries(CONFIG.PRODUCT_MAP)) {
    if (licenseKey.startsWith(pid) || licenseKey === pid) {
      matchedProduct = info;
      productId = pid;
      break;
    }
  }

  // 如果前缀未匹配，尝试完整 License 查找（webhook 兑换模式）
  if (!matchedProduct && env.USER_CREDIT_HISTORY) {
    // webhook 在支付完成时会写入 pending:license:<licenseHash> -> productId
    if (env.API_KEYS) {
      const pendingProduct = await env.API_KEYS.get(`pending:${licenseHash}`);
      if (pendingProduct) {
        productId = pendingProduct;
        matchedProduct = CONFIG.PRODUCT_MAP[productId] || null;
      }
    }
  }

  if (!matchedProduct) {
    return errorResponse(
      'invalid_license',
      'License Key 无效或产品未识别，请检查后重试',
      400
    );
  }

  // 3. 更新用户积分
  const currentCredits = (await getCredits(keyHash, env)) || {
    balance: 0,
    tier: 'free',
    updated: new Date().toISOString(),
  };

  const now = new Date().toISOString();
  const newBalance =
    matchedProduct.credits === -1
      ? -1 // unlimited
      : (currentCredits.balance === -1 ? 0 : currentCredits.balance) + matchedProduct.credits;

  const updatedCredits = {
    balance: newBalance,
    tier: matchedProduct.tier,
    updated: now,
    site: CONFIG.SITE_NAME,
  };

  if (env.USER_CREDITS) {
    await env.USER_CREDITS.put(keyHash, JSON.stringify(updatedCredits));
  }

  // 4. 标记 License 已使用
  if (env.API_KEYS) {
    await env.API_KEYS.put(`license:${licenseHash}`, JSON.stringify({ productId, used: now }));
  }

  // 5. 记录历史
  await appendHistory(
    keyHash,
    {
      type: 'license_redeem',
      product_id: productId,
      product_name: matchedProduct.name,
      amount: matchedProduct.credits,
      balance_after: newBalance,
      timestamp: now,
    },
    env
  );

  return jsonResponse({
    success: true,
    message: `兑换成功！已添加「${matchedProduct.name}」`,
    product: matchedProduct.name,
    credits_added: matchedProduct.credits === -1 ? 'unlimited' : matchedProduct.credits,
    new_balance: newBalance === -1 ? 'unlimited' : newBalance,
    tier: matchedProduct.tier,
  });
}
