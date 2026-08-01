/**
 * GeneTech 14站知识引擎 — 统一许可证中心 API (Cloudflare Worker)
 *
 * 一处购买，14 站通用。用户购买后获得一个 GUX_ 统一许可证密钥，
 * 可在全部 14 个站点凭密钥兑换并获得站点专属 API Key。
 *
 * KV 命名空间：UNIFIED_LICENSES
 *   license:<GUX_KEY>   -> 完整许可证对象（JSON）
 *   email:<sha256hex>    -> GUX_KEY（邮箱哈希反查，可选）
 *   meta:stats           -> 聚合统计（发行数 / 按套餐 / 按站点）
 *   rl:<ip>:<minute>     -> 速率限制计数（TTL 120s）
 *
 * 路由：
 *   OPTIONS *                          CORS 预检
 *   POST   /api/license/validate       校验密钥，返回站点列表与积分（只读）
 *   POST   /api/license/redeem          为指定站点兑换，返回站点专属 API Key
 *   GET    /api/license/status         查询许可证状态与全站使用情况
 *   POST   /api/admin/issue            发行统一许可证（管理员，HMAC 签名）
 *   POST   /api/creem/webhook           Creem Webhook（自动发行 / 吊销）
 *   GET    /health                     健康检查
 *
 * 安全：
 *   - 管理员接口使用 HMAC-SHA256 签名（X-Admin-Signature + X-Admin-Timestamp），防重放
 *   - 同时兼容 X-Admin-Secret 明文头（常量时间比较，便于调试）
 *   - Creem Webhook 校验 X-Creem-Signature（HMAC-SHA256）
 *   - 邮箱仅存 SHA-256 哈希，不存明文
 *   - CORS 反射 14 个站点域名白名单
 *   - 速率限制 10 次/分钟/IP（基于 KV，近似限流）
 *
 * 许可证密钥格式：GUX_ + 32 位十六进制字符（16 字节随机）
 */

// ============================================================================
// 配置
// ============================================================================

const CONFIG = {
  // 许可证密钥前缀与长度
  KEY_PREFIX: 'GUX_',
  KEY_HEX_LENGTH: 32, // 16 字节 = 32 hex
  // 站点专属 API Key 前缀（与现有站点 gtk_ 体系一致）
  SITE_KEY_PREFIX: 'gtk_',
  SITE_KEY_HEX_LENGTH: 48, // 24 字节
  // 速率限制
  RATE_LIMIT_PER_MINUTE: 10,
  RATE_LIMIT_TTL: 120, // 秒，略大于 60 以覆盖跨分钟边界
  // 管理员签名重放窗口（毫秒）
  ADMIN_REPLAY_WINDOW_MS: 5 * 60 * 1000, // 5 分钟
  // validate 结果建议缓存时长（秒），写入响应头供站点参考
  VALIDATE_CACHE_SECONDS: 3600, // 1 小时
};

/**
 * 套餐定义
 * - credits:    许可证总积分额度（-1 = 无限）
 * - duration_days: 有效期天数（null = 终身）
 */
const PLANS = {
  starter: { credits: 100, duration_days: 30, name: '入门版' },
  pro: { credits: 500, duration_days: 365, name: '专业版' },
  lifetime: { credits: -1, duration_days: null, name: '终身版' },
};

/**
 * 14 个站点的默认 CORS 白名单（生产环境请替换为真实域名，
 * 或通过环境变量 ALLOWED_ORIGINS 覆盖，逗号分隔）。
 * license.genetech.io 为中央 API 自身域名。
 */
const DEFAULT_SITE_ORIGINS = [
  'https://license.genetech.io',
  'https://site1.genetech.io',
  'https://site2.genetech.io',
  'https://site3.genetech.io',
  'https://site4.genetech.io',
  'https://site5.genetech.io',
  'https://site6.genetech.io',
  'https://site7.genetech.io',
  'https://site8.genetech.io',
  'https://site9.genetech.io',
  'https://site10.genetech.io',
  'https://site11.genetech.io',
  'https://site12.genetech.io',
  'https://site13.genetech.io',
  'https://site14.genetech.io',
  // 本地开发
  'http://localhost:8788',
  'http://localhost:3000',
];

/**
 * Creem 产品 ID -> 套餐映射（默认占位符）。
 * 通过环境变量 CREEM_PRODUCT_MAP（JSON 字符串）覆盖为真实产品 ID。
 */
const DEFAULT_CREEM_PRODUCT_MAP = {
  __CREEM_PRODUCT_STARTER__: 'starter',
  __CREEM_PRODUCT_PRO__: 'pro',
  __CREEM_PRODUCT_LIFETIME__: 'lifetime',
};

// ============================================================================
// 工具函数：哈希 / HMAC / 常量时间比较
// ============================================================================

/** SHA-256 哈希（邮箱脱敏、密钥指纹等） */
async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** HMAC-SHA256 签名（返回 hex） */
async function hmacSign(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 常量时间字符串比较，防止时序攻击 */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** HMAC-SHA256 验签（常量时间比较） */
async function hmacVerify(message, signature, secret) {
  if (!signature || !secret) return false;
  const computed = await hmacSign(message, secret);
  return constantTimeEqual(computed, signature);
}

// ============================================================================
// 工具函数：密钥生成与格式校验
// ============================================================================

/** 生成统一许可证密钥：GUX_ + 32 hex */
function generateLicenseKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return CONFIG.KEY_PREFIX + hex;
}

/** 生成站点专属 API Key：gtk_ + 48 hex（24 字节随机） */
function generateSiteApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return CONFIG.SITE_KEY_PREFIX + hex;
}

/** 校验统一许可证密钥格式：GUX_ + 32 hex */
function isValidKeyFormat(key) {
  return (
    typeof key === 'string' &&
    new RegExp(`^${CONFIG.KEY_PREFIX}[0-9a-f]{${CONFIG.KEY_HEX_LENGTH}}$`).test(key)
  );
}

// ============================================================================
// CORS 头生成（反射 Origin 白名单）
// ============================================================================

const ALLOWED_HEADERS =
  'Content-Type, X-License-Key, X-Site-Name, X-Site-Domain, X-Admin-Signature, X-Admin-Timestamp, X-Admin-Secret, X-Creem-Signature, Authorization';

/** 获取允许的来源列表（环境变量优先） */
function getAllowedOrigins(env) {
  if (env && env.ALLOWED_ORIGINS) {
    const list = env.ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length) return list;
  }
  return DEFAULT_SITE_ORIGINS;
}

/** 计算 CORS 响应头（反射匹配的 Origin） */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = getAllowedOrigins(env);
  // 命中白名单则反射具体 Origin；否则回退 *（本接口不使用 Cookie 凭证）
  const allow = allowed.includes(origin) ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// ============================================================================
// 响应封装
// ============================================================================

/** 统一 JSON 响应（含 CORS） */
function json(data, status, corsH, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsH,
      ...extraHeaders,
    },
  });
}

/** 错误响应 */
function err(code, message, status, corsH, extraHeaders = {}) {
  return json({ error: code, message }, status, corsH, extraHeaders);
}

/** CORS 预检响应 */
function corsResponse(request, env) {
  const corsH = corsHeaders(request, env);
  return new Response(null, {
    status: 204,
    headers: corsH,
  });
}

// ============================================================================
// 速率限制（基于 KV，10 次/分钟/IP）
// ============================================================================

/** 获取客户端 IP */
function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    'unknown'
  );
}

/**
 * 检查速率限制。基于 KV 的近似限流（最终一致性，突发场景可能略超）。
 * @returns {{ allowed: boolean, retryAfter?: number }}
 */
async function checkRateLimit(env, ip) {
  if (!env.UNIFIED_LICENSES || !ip || ip === 'unknown') {
    // KV 不可用时不阻塞请求（降级放行，由 Cloudflare 原生限流兜底）
    return { allowed: true };
  }
  const minuteBucket = Math.floor(Date.now() / 60000);
  const rlKey = `rl:${ip}:${minuteBucket}`;
  try {
    const raw = await env.UNIFIED_LICENSES.get(rlKey);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= CONFIG.RATE_LIMIT_PER_MINUTE) {
      return { allowed: false, retryAfter: 60 };
    }
    // 写入递增后的计数（TTL 覆盖跨分钟边界）
    await env.UNIFIED_LICENSES.put(rlKey, String(count + 1), {
      expirationTtl: CONFIG.RATE_LIMIT_TTL,
    });
    return { allowed: true };
  } catch (e) {
    console.warn('[ratelimit] KV 读写失败，降级放行:', e.message);
    return { allowed: true };
  }
}

// ============================================================================
// 站点白名单校验
// ============================================================================

/**
 * 校验站点名是否在允许列表内。
 * ALLOWED_SITES 环境变量为逗号分隔的站点名；未配置时放行全部（并告警）。
 */
function isAllowedSite(siteName, env) {
  if (!siteName || typeof siteName !== 'string') return false;
  const allowed = env && env.ALLOWED_SITES;
  if (!allowed) {
    console.warn('[license] ALLOWED_SITES 未配置，放行全部站点名（生产环境请配置）');
    return true;
  }
  const list = allowed
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(siteName.toLowerCase());
}

// ============================================================================
// 管理员鉴权（HMAC-SHA256 签名 + 时间戳防重放）
// ============================================================================

/**
 * 校验管理员调用。优先校验 HMAC 签名（推荐）：
 *   X-Admin-Timestamp: ISO 时间戳
 *   X-Admin-Signature: HMAC-SHA256(`${timestamp}\n${rawBody}`, ADMIN_SECRET)
 * 兼容 X-Admin-Secret 明文头（常量时间比较，便于调试）。
 *
 * @returns {{ ok: boolean, error?: Response }}
 */
async function verifyAdmin(request, rawBody, env, corsH) {
  const adminSecret = env.ADMIN_SECRET;
  if (!adminSecret) {
    return { ok: false, error: err('server_misconfigured', 'ADMIN_SECRET 未配置', 500, corsH) };
  }

  const signature = request.headers.get('X-Admin-Signature') || '';
  const timestamp = request.headers.get('X-Admin-Timestamp') || '';

  // 方式一：HMAC 签名（推荐，带防重放）
  if (signature && timestamp) {
    const ts = new Date(timestamp).getTime();
    if (isNaN(ts)) {
      return { ok: false, error: err('invalid_timestamp', '时间戳格式无效', 401, corsH) };
    }
    const age = Math.abs(Date.now() - ts);
    if (age > CONFIG.ADMIN_REPLAY_WINDOW_MS) {
      return { ok: false, error: err('signature_expired', '签名已过期，请重试', 401, corsH) };
    }
    // 常量时间比较签名（hmacVerify 内部使用 constantTimeEqual）
    if (await hmacVerify(`${timestamp}\n${rawBody}`, signature, adminSecret)) {
      return { ok: true };
    }
    return { ok: false, error: err('invalid_signature', '管理员签名验证失败', 401, corsH) };
  }

  // 方式二：明文密钥头（常量时间比较）
  const provided = request.headers.get('X-Admin-Secret') || '';
  if (constantTimeEqual(provided, adminSecret)) {
    return { ok: true };
  }
  return { ok: false, error: err('forbidden', '管理员鉴权失败', 403, corsH) };
}

// ============================================================================
// KV 读写封装
// ============================================================================

async function getLicense(env, key) {
  if (!env.UNIFIED_LICENSES) return null;
  const raw = await env.UNIFIED_LICENSES.get(`license:${key}`);
  return raw ? JSON.parse(raw) : null;
}

async function putLicense(env, key, data) {
  await env.UNIFIED_LICENSES.put(`license:${key}`, JSON.stringify(data));
}

// ============================================================================
// 统计维护
// ============================================================================

async function getStats(env) {
  if (!env.UNIFIED_LICENSES) {
    return { total: 0, active: 0, revoked: 0, by_plan: { starter: 0, pro: 0, lifetime: 0 }, by_site: {} };
  }
  const raw = await env.UNIFIED_LICENSES.get('meta:stats');
  return raw
    ? JSON.parse(raw)
    : { total: 0, active: 0, revoked: 0, by_plan: { starter: 0, pro: 0, lifetime: 0 }, by_site: {} };
}

async function saveStats(env, stats) {
  await env.UNIFIED_LICENSES.put('meta:stats', JSON.stringify(stats));
}

async function bumpStats(env, { plan, siteName, type }) {
  const stats = await getStats(env);
  if (type === 'issue') {
    stats.total = (stats.total || 0) + 1;
    stats.active = (stats.active || 0) + 1;
    stats.by_plan = stats.by_plan || { starter: 0, pro: 0, lifetime: 0 };
    stats.by_plan[plan] = (stats.by_plan[plan] || 0) + 1;
  } else if (type === 'redeem' && siteName) {
    stats.by_site = stats.by_site || {};
    stats.by_site[siteName] = (stats.by_site[siteName] || 0) + 1;
  } else if (type === 'revoke') {
    stats.active = Math.max(0, (stats.active || 0) - 1);
    stats.revoked = (stats.revoked || 0) + 1;
  }
  await saveStats(env, stats);
  return stats;
}

// ============================================================================
// 业务逻辑：发行 / 校验 / 兑换 / 吊销
// ============================================================================

/**
 * 计算剩余积分
 * @param {object} license
 * @returns {number} -1 表示无限
 */
function creditsRemaining(license) {
  if (license.credits_total === -1) return -1; // 终身版无限
  const used = license.credits_used || 0;
  return Math.max(0, license.credits_total - used);
}

/**
 * 发行统一许可证
 * @param {object} env
 * @param {object} params { plan, email, creem_checkout_id, expires, source }
 * @returns {Promise<{license: object, key: string}>}
 */
async function issueLicense(env, { plan, email, creem_checkout_id, expires, source }) {
  const planDef = PLANS[plan];
  if (!planDef) throw new Error(`unknown_plan: ${plan}`);

  const key = generateLicenseKey();
  const now = new Date().toISOString();
  // 过期时间：优先使用传入值，否则按套餐 duration_days 计算，终身版为 null
  let expiresAt = null;
  if (expires) {
    expiresAt = expires;
  } else if (planDef.duration_days) {
    expiresAt = new Date(Date.now() + planDef.duration_days * 86400000).toISOString();
  }

  const emailHash = email ? await sha256(email.trim().toLowerCase()) : null;

  const license = {
    key,
    email_hash: emailHash,
    plan,
    plan_name: planDef.name,
    credits_total: planDef.credits, // -1 = 无限
    credits_used: 0,
    sites: [], // [{ name, api_key, redeemed_at }]
    created: now,
    expires: expiresAt,
    creem_checkout_id: creem_checkout_id || null,
    status: 'active', // active | revoked
    source: source || 'manual',
  };

  await putLicense(env, key, license);

  // 邮箱哈希索引（可选，便于反查）
  if (emailHash && env.UNIFIED_LICENSES) {
    await env.UNIFIED_LICENSES.put(`email:${emailHash}`, key);
  }

  await bumpStats(env, { plan, type: 'issue' });

  return { license, key };
}

/**
 * 校验许可证（只读，不修改状态）
 * @returns {Promise<object>} 校验结果
 */
async function validateLicense(env, key, siteName) {
  if (!isValidKeyFormat(key)) {
    return { valid: false, error: 'invalid_key_format', message: '许可证密钥格式不正确' };
  }
  const license = await getLicense(env, key);
  if (!license) {
    return { valid: false, error: 'license_not_found', message: '许可证不存在' };
  }
  if (license.status === 'revoked') {
    return { valid: false, error: 'license_revoked', message: '许可证已被吊销' };
  }
  if (license.expires && new Date(license.expires).getTime() < Date.now()) {
    return { valid: false, error: 'license_expired', message: '许可证已过期' };
  }

  const siteNames = (license.sites || []).map((s) => s.name);
  const alreadyRedeemed = siteName ? siteNames.includes(siteName) : false;

  return {
    valid: true,
    key,
    plan: license.plan,
    plan_name: license.plan_name,
    credits_total: license.credits_total,
    credits_used: license.credits_used || 0,
    credits_remaining: creditsRemaining(license),
    sites: siteNames,
    already_redeemed: alreadyRedeemed,
    status: license.status,
    created: license.created,
    expires: license.expires,
    cache_ttl: CONFIG.VALIDATE_CACHE_SECONDS,
  };
}

/**
 * 为指定站点兑换许可证，返回站点专属 API Key。
 * - 站点首次兑换：生成随机 API Key 并写入 sites[]，返回新 Key
 * - 站点重复兑换：返回已存储的 API Key（幂等，不重复发放）
 *
 * @returns {Promise<object>}
 */
async function redeemLicense(env, key, siteName, siteDomain) {
  if (!isValidKeyFormat(key)) {
    return { valid: false, error: 'invalid_key_format', message: '许可证密钥格式不正确' };
  }
  if (!isAllowedSite(siteName, env)) {
    return { valid: false, error: 'unknown_site', message: `未知或不允许的站点: ${siteName}` };
  }
  const license = await getLicense(env, key);
  if (!license) {
    return { valid: false, error: 'license_not_found', message: '许可证不存在' };
  }
  if (license.status === 'revoked') {
    return { valid: false, error: 'license_revoked', message: '许可证已被吊销' };
  }
  if (license.expires && new Date(license.expires).getTime() < Date.now()) {
    return { valid: false, error: 'license_expired', message: '许可证已过期' };
  }

  license.sites = license.sites || [];
  const normalized = (s) => s.toLowerCase();
  let siteEntry = license.sites.find((s) => normalized(s.name) === normalized(siteName));

  if (!siteEntry) {
    // 首次兑换：生成站点专属 API Key 并记录
    siteEntry = {
      name: siteName,
      api_key: generateSiteApiKey(),
      redeemed_at: new Date().toISOString(),
      domain: siteDomain || null,
    };
    license.sites.push(siteEntry);
    await putLicense(env, key, license);
    await bumpStats(env, { siteName, type: 'redeem' });
  }
  // 重复兑换：幂等返回已存储的 api_key

  return {
    valid: true,
    key,
    api_key: siteEntry.api_key,
    plan: license.plan,
    plan_name: license.plan_name,
    credits: creditsRemaining(license), // 该许可证剩余可用积分（-1 = 无限）
    credits_total: license.credits_total,
    credits_used: license.credits_used || 0,
    sites: license.sites.map((s) => s.name),
    already_redeemed: true,
    redeemed_at: siteEntry.redeemed_at,
    expires: license.expires,
  };
}

/**
 * 吊销许可证
 */
async function revokeLicense(env, key, reason) {
  if (!isValidKeyFormat(key)) {
    return { ok: false, error: 'invalid_key_format' };
  }
  const license = await getLicense(env, key);
  if (!license) return { ok: false, error: 'license_not_found' };

  license.status = 'revoked';
  license.revoked_at = new Date().toISOString();
  license.revoke_reason = reason || 'revoked';
  await putLicense(env, key, license);

  await bumpStats(env, { plan: license.plan, type: 'revoke' });
  return { ok: true, key, status: 'revoked' };
}

// ============================================================================
// Creem Webhook 处理（自动发行 / 吊销）
// ============================================================================

function getCreemProductMap(env) {
  if (env.CREEM_PRODUCT_MAP) {
    try {
      return JSON.parse(env.CREEM_PRODUCT_MAP);
    } catch {
      console.warn('[creem] CREEM_PRODUCT_MAP 解析失败，回退默认映射');
    }
  }
  return DEFAULT_CREEM_PRODUCT_MAP;
}

async function handleCreemWebhook(request, rawBody, env, corsH) {
  const secret = env.CREEM_WEBHOOK_SECRET;
  if (!secret) {
    return err('server_misconfigured', 'CREEM_WEBHOOK_SECRET 未配置', 500, corsH);
  }
  const signature =
    request.headers.get('X-Creem-Signature') ||
    request.headers.get('x-creem-signature') ||
    '';
  if (!(await hmacVerify(rawBody, signature, secret))) {
    return err('invalid_signature', 'Creem 签名验证失败', 401, corsH);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return err('bad_request', '请求体不是有效 JSON', 400, corsH);
  }

  const eventType = event.type || event.event_type || 'unknown';
  const data = event.data || event.object || event;

  // 订阅取消 / 退款 -> 吊销
  const revokeEvents = [
    'subscription.canceled',
    'subscription.cancelled',
    'payment.refunded',
    'charge.refunded',
  ];
  if (revokeEvents.includes(eventType)) {
    const customerEmail = data.customer?.email || data.customer_email || data.metadata?.email || null;
    if (customerEmail && env.UNIFIED_LICENSES) {
      const emailHash = await sha256(customerEmail.trim().toLowerCase());
      const key = await env.UNIFIED_LICENSES.get(`email:${emailHash}`);
      if (key) {
        await revokeLicense(env, key, `creem:${eventType}`);
        return json(
          { success: true, action: 'revoked', key: key.slice(0, 12) + '...' },
          200,
          corsH
        );
      }
    }
    return json({ success: true, action: 'no_license_found', event_type: eventType }, 200, corsH);
  }

  // 支付完成 -> 发行统一许可证
  const issueEvents = ['checkout.completed', 'payment.succeeded', 'order.completed'];
  if (!issueEvents.includes(eventType)) {
    return json(
      { success: true, message: '事件已接收（非支付完成事件，忽略）', event_type: eventType },
      200,
      corsH
    );
  }

  const productId =
    data.product_id || data.productId || data.product?.id || data.metadata?.product_id || null;
  const customerEmail = data.customer?.email || data.customer_email || data.metadata?.email || null;
  const checkoutId = data.id || data.checkout_id || data.checkoutId || null;

  if (!productId) {
    return err('missing_product', '缺少产品 ID', 400, corsH);
  }

  const productMap = getCreemProductMap(env);
  const plan = productMap[productId];
  if (!plan) {
    return err('unknown_product', `未知产品 ID: ${productId}`, 400, corsH);
  }

  const { license, key } = await issueLicense(env, {
    plan,
    email: customerEmail,
    creem_checkout_id: checkoutId,
    source: 'creem_webhook',
  });

  console.log(`[creem] 统一许可证已创建: ${plan} -> ${key.slice(0, 12)}...`);

  return json(
    {
      success: true,
      message: '支付已确认，统一许可证已创建',
      event_type: eventType,
      plan,
      license_key: key,
      credits_total: license.credits_total === -1 ? 'unlimited' : license.credits_total,
      expires: license.expires,
    },
    200,
    corsH
  );
}

// ============================================================================
// 请求处理器
// ============================================================================

async function handleValidate(env, body, corsH) {
  const key = (body.key || body.license_key || '').trim();
  const siteName = (body.site_name || body.site || '').trim();
  if (!key) return err('missing_key', '请提供 key', 400, corsH);
  const result = await validateLicense(env, key, siteName || null);
  if (!result.valid) {
    // 统一返回 200，由 valid 字段判断，便于客户端处理
    return json(result, 200, corsH);
  }
  return json({ success: true, ...result }, 200, corsH);
}

async function handleRedeem(env, body, corsH) {
  const key = (body.key || body.license_key || '').trim();
  const siteName = (body.site_name || body.site || '').trim();
  const siteDomain = (body.site_domain || body.domain || '').trim();
  if (!key) return err('missing_key', '请提供 key', 400, corsH);
  if (!siteName) return err('missing_site', '请提供 site_name', 400, corsH);
  const result = await redeemLicense(env, key, siteName, siteDomain || null);
  if (!result.valid) {
    return json(result, 200, corsH);
  }
  return json({ success: true, ...result }, 200, corsH);
}

async function handleStatus(request, env, url, corsH) {
  const key = url.searchParams.get('key') || '';
  if (!key) return err('missing_key', '请提供 key 参数', 400, corsH);
  const result = await validateLicense(env, key, null);
  if (!result.valid) {
    return json(result, result.error === 'license_not_found' ? 404 : 200, corsH);
  }
  return json({ success: true, ...result }, 200, corsH);
}

async function handleIssue(request, rawBody, body, env, corsH) {
  const admin = await verifyAdmin(request, rawBody, env, corsH);
  if (!admin.ok) return admin.error;

  const plan = (body.plan || '').trim();
  if (!PLANS[plan]) {
    return err(
      'invalid_plan',
      `无效套餐: ${plan}（可选: starter / pro / lifetime）`,
      400,
      corsH
    );
  }
  const email = body.email ? String(body.email).trim() : null;

  const { license, key } = await issueLicense(env, {
    plan,
    email,
    creem_checkout_id: body.creem_checkout_id || null,
    expires: body.expires || null,
    source: body.source || 'admin_issue',
  });

  return json(
    {
      success: true,
      message: '统一许可证已发行',
      license_key: key,
      plan,
      plan_name: license.plan_name,
      credits_total: license.credits_total === -1 ? 'unlimited' : license.credits_total,
      expires: license.expires,
      created: license.created,
    },
    201,
    corsH
  );
}

// ============================================================================
// 路由分发
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS 预检
    if (method === 'OPTIONS') {
      return corsResponse(request, env);
    }

    const corsH = corsHeaders(request, env);

    try {
      // 健康检查（不限速）
      if ((path === '/' || path === '/health') && method === 'GET') {
        return json(
          {
            service: 'genetech-unified-license',
            status: 'ok',
            version: '2.0',
            time: new Date().toISOString(),
          },
          200,
          corsH
        );
      }

      // 速率限制（管理员与 Creem webhook 路径豁免，由各自鉴权保护）
      const isAdminPath = path.startsWith('/api/admin/');
      const isWebhookPath = path === '/api/creem/webhook';
      if (!isAdminPath && !isWebhookPath) {
        const ip = getClientIp(request);
        const rl = await checkRateLimit(env, ip);
        if (!rl.allowed) {
          return err(
            'rate_limited',
            '请求过于频繁，请稍后再试（限制 10 次/分钟/IP）',
            429,
            corsH,
            { 'Retry-After': String(rl.retryAfter) }
          );
        }
      }

      // ---- GET 路由 ----
      if (method === 'GET') {
        if (path === '/api/license/status') {
          return handleStatus(request, env, url, corsH);
        }
        return err('not_found', `未知路由: ${method} ${path}`, 404, corsH);
      }

      // ---- POST 路由 ----
      if (method === 'POST') {
        const rawBody = await request.text();

        // Creem Webhook（中央直接接收）
        if (path === '/api/creem/webhook') {
          return handleCreemWebhook(request, rawBody, env, corsH);
        }

        // 解析 JSON
        let body;
        try {
          body = JSON.parse(rawBody);
        } catch {
          return err('bad_request', '请求体必须是 JSON', 400, corsH);
        }

        if (path === '/api/license/validate') {
          return handleValidate(env, body, corsH);
        }
        if (path === '/api/license/redeem') {
          return handleRedeem(env, body, corsH);
        }
        if (path === '/api/admin/issue') {
          return handleIssue(request, rawBody, body, env, corsH);
        }

        return err('not_found', `未知路由: ${method} ${path}`, 404, corsH);
      }

      return err('method_not_allowed', `不支持的方法: ${method}`, 405, corsH);
    } catch (e) {
      console.error('[license] 未捕获错误:', e);
      return err('internal_error', e.message || '服务器内部错误', 500, corsH);
    }
  },
};
