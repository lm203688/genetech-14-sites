/**
 * GeneTech 14站知识引擎 — API Gateway Worker
 *
 * 功能：
 * 1. 为所有 /api/*.json 端点添加 API Key 认证
 * 2. 实施基于配额的速率限制（基于 KV）
 * 3. 提供免费层与 Pro 层的差异响应
 * 4. 记录调用日志用于审计和计费
 *
 * 部署方式：
 *   1. 将本文件部署为 Cloudflare Worker
 *   2. 绑定 KV namespace: KB_KV
 *   3. 设置 Secrets: API_GATEWAY_ADMIN_KEY
 *   4. 通过路由规则将 *.genetech.tools/api/* 指向此 Worker
 */

// === 配置 ===
const CONFIG = {
  FREE_TIER_DAILY_LIMIT: 100,
  PRO_TIER_DAILY_LIMIT: 10000,
  RATE_LIMIT_WINDOW_MS: 60 * 1000, // 1 分钟窗口
  RATE_LIMIT_FREE_PER_MIN: 10,     // 免费层每分钟 10 次
  RATE_LIMIT_PRO_PER_MIN: 60,      // Pro 层每分钟 60 次
  CORS_ORIGIN: '*',                // 生产环境建议限制为具体域名
};

// === 密钥哈希（不存储明文）===
async function hashKey(key) {
  const data = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// === 响应工具 ===
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': CONFIG.CORS_ORIGIN,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function errorResponse(code, message, status = 401) {
  return jsonResponse({ error: code, message }, status);
}

// === CORS 预检 ===
function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': CONFIG.CORS_ORIGIN,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// === 提取 API Key ===
function extractAPIKey(request) {
  // 优先级：Header > Query
  const headerKey = request.headers.get('X-API-Key') || request.headers.get('Authorization')?.replace('Bearer ', '');
  const queryKey = new URL(request.url).searchParams.get('api_key');
  return headerKey || queryKey || null;
}

// === 查询用户层级 ===
async function getUserTier(apiKey, env) {
  if (!apiKey) return { tier: 'anonymous', id: 'anon' };

  const keyHash = await hashKey(apiKey);
  const userData = await env.KB_KV.get(`user:${keyHash}`, 'json');

  if (!userData) return { tier: 'anonymous', id: 'anon' };
  return userData; // { tier: 'free'|'pro'|'enterprise', id: 'xxx', expires: ... }
}

// === 速率限制检查 ===
async function checkRateLimit(userId, tier, env) {
  const now = Date.now();
  const windowStart = Math.floor(now / CONFIG.RATE_LIMIT_WINDOW_MS) * CONFIG.RATE_LIMIT_WINDOW_MS;
  const windowKey = `ratelimit:${userId}:${windowStart}`;

  const limit = tier === 'pro' || tier === 'enterprise'
    ? CONFIG.RATE_LIMIT_PRO_PER_MIN
    : CONFIG.RATE_LIMIT_FREE_PER_MIN;

  const current = parseInt(await env.KB_KV.get(windowKey) || '0', 10);

  if (current >= limit) {
    return { allowed: false, remaining: 0, limit };
  }

  // 增加计数（设置 2 分钟过期）
  await env.KB_KV.put(windowKey, String(current + 1), { expirationTtl: 120 });

  return { allowed: true, remaining: limit - current - 1, limit };
}

// === 每日配额检查 ===
async function checkDailyQuota(userId, tier, env) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const quotaKey = `quota:${userId}:${today}`;

  const limit = tier === 'pro' || tier === 'enterprise'
    ? CONFIG.PRO_TIER_DAILY_LIMIT
    : CONFIG.FREE_TIER_DAILY_LIMIT;

  const used = parseInt(await env.KB_KV.get(quotaKey) || '0', 10);

  if (used >= limit) {
    return { allowed: false, used, limit };
  }

  // 增加配额（设置 48 小时过期，避免数据堆积）
  await env.KB_KV.put(quotaKey, String(used + 1), { expirationTtl: 172800 });

  return { allowed: true, used: used + 1, limit };
}

// === 免费层数据裁剪 ===
function truncateForFreeTier(data) {
  const result = { ...data };

  // 对于实体列表，免费层只返回前 10 个，其余用摘要替代
  for (const key of Object.keys(result)) {
    if (Array.isArray(result[key]) && result[key].length > 10) {
      const fullArray = result[key];
      result[key] = fullArray.slice(0, 10).map(item => {
        // 每个实体只保留摘要字段
        const truncated = { id: item.id, name: item.name || item.full_name || item.id };
        if (item.description) truncated.description = item.description;
        truncated._locked_fields = Object.keys(item).filter(k => !['id', 'name', 'full_name', 'description'].includes(k)).length;
        truncated._upgrade_message = '升级 Pro 解锁完整数据';
        return truncated;
      });
      result._truncated = true;
      result._total_available = fullArray.length;
      result._upgrade_url = 'https://genetech.tools/credits.html';
    }
  }

  return result;
}

// === 主处理函数 ===
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // OPTIONS 预检
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    // 健康检查端点（无需认证）
    if (path === '/api/health' || path === '/health') {
      return jsonResponse({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '2.0.0',
      });
    }

    // API Key 注册端点（仅管理员可访问）
    if (path === '/api/admin/keys' && request.method === 'POST') {
      return handleKeyRegistration(request, env);
    }

    // 仅对 /api/*.json 路径要求认证
    if (!path.startsWith('/api/') || !path.endsWith('.json')) {
      // 非 API 路径，直接返回（由 Pages 静态资源处理）
      return fetch(request);
    }

    try {
      // 1. 提取 API Key 并查询用户层级
      const apiKey = extractAPIKey(request);
      const user = await getUserTier(apiKey, env);

      // 2. 速率限制
      const rateLimit = await checkRateLimit(user.id, user.tier, env);
      if (!rateLimit.allowed) {
        return errorResponse('rate_limited', `请求过于频繁，每分钟限制 ${rateLimit.limit} 次`, 429);
      }

      // 3. 每日配额（匿名用户也计入）
      const quota = await checkDailyQuota(user.id, user.tier, env);
      if (!quota.allowed) {
        return errorResponse('quota_exceeded', `今日配额已用尽（${quota.limit} 次/天）`, 429);
      }

      // 4. 获取原始数据
      // 注意：Worker 通过 subrequest 获取 Pages 静态资源
      const originUrl = new URL(request.url);
      const originResponse = await fetch(originUrl.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      if (!originResponse.ok) {
        return errorResponse('origin_error', `后端返回 ${originResponse.status}`, originResponse.status);
      }

      let data = await originResponse.json();

      // 5. 根据层级裁剪数据
      if (user.tier === 'anonymous' || user.tier === 'free') {
        data = truncateForFreeTier(data);
      }

      // 6. 添加响应头信息
      const responseHeaders = {
        'X-Tier': user.tier,
        'X-Quota-Used': String(quota.used),
        'X-Quota-Limit': String(quota.limit),
        'X-RateLimit-Remaining': String(rateLimit.remaining),
      };

      // 7. 异步记录调用日志
      ctx.waitUntil(logApiCall(user, path, env));

      return jsonResponse(data, 200, responseHeaders);

    } catch (err) {
      console.error('API Gateway Error:', err);
      return errorResponse('internal_error', '内部服务器错误', 500);
    }
  },
};

// === API Key 注册（管理员操作）===
async function handleKeyRegistration(request, env) {
  const adminKey = request.headers.get('X-Admin-Key');
  if (adminKey !== env.API_GATEWAY_ADMIN_KEY) {
    return errorResponse('unauthorized', '需要管理员权限', 403);
  }

  try {
    const body = await request.json();
    const { tier = 'free', userId, expires } = body;

    if (!userId) {
      return errorResponse('bad_request', '缺少 userId', 400);
    }

    // 生成新 API Key
    const newKey = 'gtk_' + Array.from(crypto.getRandomValues(new Uint8Array(24)))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    const keyHash = await hashKey(newKey);
    const userData = {
      id: userId,
      tier,
      created: new Date().toISOString(),
      expires: expires || null,
    };

    await env.KB_KV.put(`user:${keyHash}`, JSON.stringify(userData));

    return jsonResponse({
      api_key: newKey, // 仅此一次返回明文
      tier,
      user_id: userId,
      expires: userData.expires,
    }, 201);
  } catch (err) {
    return errorResponse('bad_request', err.message, 400);
  }
}

// === 异步日志记录 ===
async function logApiCall(user, path, env) {
  const logId = `log:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const entry = {
    timestamp: new Date().toISOString(),
    user_id: user.id,
    tier: user.tier,
    path,
  };
  // 日志保留 30 天
  await env.KB_KV.put(logId, JSON.stringify(entry), { expirationTtl: 2592000 });
}
