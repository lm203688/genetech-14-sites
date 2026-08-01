/**
 * GeneTech 14站知识引擎 — 站点集成模块（Drop-in for webhook.js）
 *
 * 用途：14 个站点将本模块引入到各自的 Creem webhook.js（与 balance.js）中，
 *       即可同时支持「统一许可证 GLK_」与「站点本地许可证 gtk_ / <product>-<hex>」。
 *
 * 核心能力：
 *   1. notifyCentralOnPurchase(event, env)
 *      —— 当 Creem Webhook 在本站触发时，通知中央许可证服务器创建统一许可证。
 *   2. redeemLicenseKey(key, apiKey, env, ctx)
 *      —— 用户兑换许可证密钥。GLK_ 走中央校验+激活+本地发分；gtk_ / 旧格式走本地逻辑。
 *   3. isUnifiedKey(key) / isLegacyKey(key)
 *      —— 密钥类型判断。
 *
 * 兼容性：
 *   - GLK_ 前缀：统一许可证，调用中央 Worker
 *   - gtk_ 前缀：站点本地 API Key（注册赠送），不变
 *   - <product_id>-<hex>：旧版站点 License Key（webhook 生成），走本地兑换
 *
 * 集成示例（站点 webhook.js 末尾追加）：
 *
 *   import { notifyCentralOnPurchase } from '../../unified-license/site-integration.js';
 *
 *   export async function onRequestPost({ request, env }) {
 *     // ...原有 Creem 签名验证与本地逻辑...
 *     // 在支付成功、生成本地 License 后，通知中央：
 *     ctx.waitUntil(notifyCentralOnPurchase({ plan: 'pro', email, order_id }, env));
 *     return jsonResponse({ ... });
 *   }
 *
 * 依赖环境变量（站点侧）：
 *   - UNIFIED_LICENSE_WORKER_URL   中央 Worker URL
 *   - INTER_SERVICE_SECRET         与中央共享的 HMAC 密钥
 *   - SITE_NAME                    当前站点名
 * 依赖 KV（站点侧已有）：
 *   - API_KEYS / USER_CREDITS / USER_CREDIT_HISTORY
 */

import { verifyUnifiedLicense, invalidateCache, isUnifiedKey } from './verify.js';

// ============================================================================
// 配置
// ============================================================================

const CENTRAL_TIMEOUT_MS = 8000;

/** 旧版站点 License Key 的套餐映射（与各站点 webhook.js 的 PRODUCT_MAP 一致） */
const LEGACY_PLAN_TIERS = {
  starter: { credits: 100, tier: 'pro' },
  pro: { credits: 500, tier: 'pro' },
  lifetime: { credits: -1, tier: 'lifetime' },
};

// ============================================================================
// 工具函数
// ============================================================================

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

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

/** 是否为旧版本地 License Key（非 GLK_ 且非 gtk_，形如 <product>-<hex>） */
export function isLegacyKey(key) {
  if (!key || typeof key !== 'string') return false;
  if (key.startsWith('GLK_') || key.startsWith('gtk_')) return false;
  // 旧格式：<任意产品前缀>-<16+位 hex>
  return /^[a-zA-Z0-9_]+-[0-9a-f]{16,}$/.test(key);
}

/** 是否为站点本地 API Key（gtk_ 前缀） */
export function isLocalApiKey(key) {
  return typeof key === 'string' && key.startsWith('gtk_');
}

// ============================================================================
// 1. 通知中央：购买事件 → 创建统一许可证
// ============================================================================

/**
 * 当 Creem Webhook 在本站触发支付成功后，通知中央许可证服务器创建 GLK_ 统一许可证。
 * 仅当购买的是「统一产品」时调用（由调用方判断 productId 是否属于统一产品）。
 *
 * @param {object} payload { plan, email, order_id, customer_id, product_id }
 * @param {object} env
 * @returns {Promise<{success: boolean, license_key?: string, error?: string}>}
 */
export async function notifyCentralOnPurchase(payload, env) {
  const workerUrl = env.UNIFIED_LICENSE_WORKER_URL;
  const secret = env.INTER_SERVICE_SECRET;
  const siteName = env.SITE_NAME;

  if (!workerUrl || !secret) {
    console.warn('[integration] 中央许可证配置缺失，跳过通知');
    return { success: false, error: 'config_missing' };
  }

  const body = JSON.stringify({
    plan: payload.plan,
    email: payload.email || null,
    order_id: payload.order_id || null,
    customer_id: payload.customer_id || null,
    product_id: payload.product_id || null,
    source: `site:${siteName}`,
  });

  const signature = await hmacSign(body, secret);

  try {
    const resp = await fetch(workerUrl.replace(/\/+$/, '') + '/api/license/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Sig': signature,
        'X-Service-Name': siteName || 'unknown',
      },
      body,
      signal: AbortSignal.timeout ? AbortSignal.timeout(CENTRAL_TIMEOUT_MS) : undefined,
    });

    const data = await resp.json();
    if (resp.ok && data.success) {
      console.log(`[integration] 统一许可证已创建: ${data.license_key?.slice(0, 12)}...`);
      return { success: true, license_key: data.license_key, plan: data.plan };
    }
    console.warn('[integration] 中央创建许可证失败:', data.error || data.message);
    return { success: false, error: data.error || 'create_failed' };
  } catch (err) {
    console.error('[integration] 通知中央失败:', err.message);
    return { success: false, error: 'central_unreachable' };
  }
}

// ============================================================================
// 2. 中央激活（站点 → 中央 /api/license/activate）
// ============================================================================

/**
 * 调用中央 Worker 激活本站点。返回 first_activation 标记，
 * 据此决定是否向用户本地账户发放积分。
 *
 * @param {string} key       GLK_ 密钥
 * @param {object} env
 * @returns {Promise<{ok: boolean, first_activation?: boolean, credits?: number, plan?: string, error?: string}>}
 */
export async function activateOnCentral(key, env) {
  const workerUrl = env.UNIFIED_LICENSE_WORKER_URL;
  const secret = env.INTER_SERVICE_SECRET;
  const siteName = env.SITE_NAME;

  if (!workerUrl || !secret) {
    return { ok: false, error: 'config_missing' };
  }

  const body = JSON.stringify({ key, site_name: siteName });
  const signature = await hmacSign(body, secret);

  try {
    const resp = await fetch(workerUrl.replace(/\/+$/, '') + '/api/license/activate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Sig': signature,
        'X-Service-Name': siteName || 'unknown',
      },
      body,
      signal: AbortSignal.timeout ? AbortSignal.timeout(CENTRAL_TIMEOUT_MS) : undefined,
    });

    const data = await resp.json();
    if (resp.ok && data.success) {
      return {
        ok: true,
        first_activation: data.first_activation,
        credits: data.credits, // -1 = 无限
        plan: data.plan,
        activated_sites: data.activated_sites,
      };
    }
    return { ok: false, error: data.error || 'activate_failed' };
  } catch (err) {
    console.error('[integration] 中央激活失败:', err.message);
    return { ok: false, error: 'central_unreachable' };
  }
}

// ============================================================================
// 3. 通知中央：吊销（订阅取消 → 中央 /api/license/revoke）
// ============================================================================

/**
 * 当本站收到订阅取消/退款 Webhook 时，通知中央吊销对应统一许可证。
 *
 * @param {string} key       GLK_ 密钥（若已知）；未知时可传 email 由中央反查
 * @param {object} env
 * @param {object} [extra]   { email, reason }
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function notifyCentralRevoke(key, env, extra = {}) {
  const workerUrl = env.UNIFIED_LICENSE_WORKER_URL;
  const secret = env.INTER_SERVICE_SECRET;
  const siteName = env.SITE_NAME;

  if (!workerUrl || !secret) {
    return { success: false, error: 'config_missing' };
  }

  const body = JSON.stringify({ key, reason: extra.reason || `cancelled_by:${siteName}` });
  const signature = await hmacSign(body, secret);

  try {
    const resp = await fetch(workerUrl.replace(/\/+$/, '') + '/api/license/revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Sig': signature,
        'X-Service-Name': siteName || 'unknown',
      },
      body,
      signal: AbortSignal.timeout ? AbortSignal.timeout(CENTRAL_TIMEOUT_MS) : undefined,
    });

    const data = await resp.json();
    return { success: !!data.success, error: data.error };
  } catch (err) {
    console.error('[integration] 通知吊销失败:', err.message);
    return { success: false, error: 'central_unreachable' };
  }
}

// ============================================================================
// 4. 统一兑换入口：redeemLicenseKey
// ============================================================================

/**
 * 用户兑换许可证密钥的统一入口（balance.js POST 调用）。
 *
 * 自动分流：
 *   - GLK_ 前缀 → 走中央校验 + 激活 + 本地发分
 *   - gtk_ 前缀 → 本地 API Key，不支持兑换，返回提示
 *   - 旧版 <product>-<hex> → 走站点本地兑换逻辑（由调用方处理，本函数返回 legacy 信号）
 *
 * @param {string} licenseKey  用户输入的许可证密钥
 * @param {string} apiKey      用户的站点本地 API Key（gtk_），用于定位本地积分账户
 * @param {object} env
 * @param {object} [ctx]       Pages Function 上下文（用于 waitUntil）
 * @returns {Promise<{handled: boolean, type: 'unified'|'legacy'|'local_key'|'invalid', result?: object, message?: string}>}
 */
export async function redeemLicenseKey(licenseKey, apiKey, env, ctx) {
  const siteName = env.SITE_NAME;

  // ---- 分支 1：统一许可证 GLK_ ----
  if (isUnifiedKey(licenseKey)) {
    // 1a. 校验（命中本地缓存）
    const verify = await verifyUnifiedLicense(licenseKey, siteName, env);
    if (!verify.valid) {
      return {
        handled: true,
        type: 'unified',
        result: { success: false, error: verify.reason || 'invalid', message: '统一许可证无效或已过期' },
      };
    }

    // 1b. 激活本站点（中央原子操作，仅首次返回 first_activation）
    const activate = await activateOnCentral(licenseKey, env);
    if (!activate.ok) {
      return {
        handled: true,
        type: 'unified',
        result: { success: false, error: activate.error, message: '站点激活失败，请稍后重试' },
      };
    }

    // 1c. 仅在首次激活时发放本地积分（防止重复兑换）
    if (!activate.first_activation) {
      return {
        handled: true,
        type: 'unified',
        result: {
          success: true,
          message: '该统一许可证已在本站激活，积分此前已发放，请勿重复兑换',
          already_activated: true,
          plan: activate.plan,
        },
      };
    }

    // 1d. 向本地账户发放积分
    const grantResult = await grantLocalCredits(apiKey, activate.credits, activate.plan, env, ctx, {
      source: 'unified_license',
      license_key: licenseKey,
    });

    // 1e. 失效本地缓存（状态已变更）
    if (ctx) ctx.waitUntil(invalidateCache(licenseKey, siteName, env));
    else await invalidateCache(licenseKey, siteName, env);

    return {
      handled: true,
      type: 'unified',
      result: {
        success: grantResult.success,
        message: grantResult.success
          ? `兑换成功！已通过统一许可证（${activate.plan}）发放 ${activate.credits === -1 ? '无限' : activate.credits} 积分`
          : grantResult.message,
        credits_added: activate.credits === -1 ? 'unlimited' : activate.credits,
        new_balance: grantResult.new_balance,
        plan: activate.plan,
        activated_sites: activate.activated_sites,
      },
    };
  }

  // ---- 分支 2：本地 API Key gtk_（不可用于兑换）----
  if (isLocalApiKey(licenseKey)) {
    return {
      handled: true,
      type: 'local_key',
      result: { success: false, error: 'not_a_license', message: '该密钥为 API Key，不能用于兑换积分' },
    };
  }

  // ---- 分支 3：旧版本地 License（交给调用方原有逻辑处理）----
  if (isLegacyKey(licenseKey)) {
    return { handled: false, type: 'legacy', message: '旧版站点 License，请使用站点本地兑换逻辑' };
  }

  // ---- 分支 4：无法识别 ----
  return {
    handled: true,
    type: 'invalid',
    result: { success: false, error: 'invalid_license', message: '许可证密钥格式无法识别' },
  };
}

// ============================================================================
// 本地积分发放（与站点 balance.js 的积分写入逻辑保持一致）
// ============================================================================

/**
 * 向本地用户账户发放积分（写入 USER_CREDITS + USER_CREDIT_HISTORY）。
 *
 * @param {string} apiKey   站点本地 API Key（gtk_）
 * @param {number} credits  积分数（-1 = 无限/终身）
 * @param {string} plan     套餐名
 * @param {object} env
 * @param {object} [ctx]
 * @param {object} [meta]   { source, license_key }
 */
async function grantLocalCredits(apiKey, credits, plan, env, ctx, meta = {}) {
  if (!apiKey) {
    return { success: false, message: '缺少 API Key，无法定位积分账户' };
  }
  if (!env.USER_CREDITS || !env.API_KEYS) {
    return { success: false, message: '站点 KV 未配置' };
  }

  const keyHash = await sha256(apiKey);

  // 验证 API Key 存在
  const userMeta = await env.API_KEYS.get(`key:${keyHash}`);
  if (!userMeta) {
    return { success: false, message: 'API Key 无效或未注册' };
  }

  // 读取当前积分
  const now = new Date().toISOString();
  const raw = await env.USER_CREDITS.get(keyHash);
  const current = raw ? JSON.parse(raw) : { balance: 0, tier: 'free', updated: now, site: env.SITE_NAME };

  const isUnlimited = credits === -1 || current.balance === -1;
  const newBalance = isUnlimited ? -1 : (current.balance === -1 ? 0 : current.balance) + credits;

  const updated = {
    balance: newBalance,
    tier: plan === 'lifetime' ? 'lifetime' : 'pro',
    updated: now,
    site: env.SITE_NAME,
    unified_plan: plan,
  };
  await env.USER_CREDITS.put(keyHash, JSON.stringify(updated));

  // 记录历史
  if (env.USER_CREDIT_HISTORY) {
    const historyKey = `${keyHash}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
    const entry = {
      type: 'unified_license_redeem',
      plan,
      amount: credits,
      balance_after: newBalance,
      timestamp: now,
      source: meta.source || 'unified_license',
      license_key: meta.license_key ? (meta.license_key.slice(0, 12) + '...') : null,
    };
    if (ctx) ctx.waitUntil(env.USER_CREDIT_HISTORY.put(historyKey, JSON.stringify(entry)));
    else await env.USER_CREDIT_HISTORY.put(historyKey, JSON.stringify(entry));
  }

  return {
    success: true,
    new_balance: newBalance === -1 ? 'unlimited' : newBalance,
  };
}

// ============================================================================
// 5. Webhook 集成辅助：判断产品是否为统一产品
// ============================================================================

/**
 * 判断 Creem 产品 ID 是否属于「统一许可证产品」。
 * 统一产品的 ID 应配置在站点环境变量 UNIFIED_PRODUCT_IDS（逗号分隔）中。
 *
 * @param {string} productId
 * @param {object} env
 * @returns {boolean}
 */
export function isUnifiedProduct(productId, env) {
  if (!productId) return false;
  const ids = (env.UNIFIED_PRODUCT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.includes(productId);
}

/**
 * 根据产品 ID 推断套餐名（用于通知中央创建许可证）。
 * 优先使用站点 PRODUCT_MAP 的 tier/credits 反推；否则按命名启发式判断。
 *
 * @param {string} productId
 * @param {object} productMap  站点 CONFIG.PRODUCT_MAP
 * @returns {string|null} 'starter' | 'pro' | 'lifetime'
 */
export function inferPlanFromProduct(productId, productMap = {}) {
  const info = productMap[productId];
  if (info) {
    if (info.credits === -1 || info.tier === 'lifetime') return 'lifetime';
    if (info.credits >= 500) return 'pro';
    return 'starter';
  }
  // 启发式：产品 ID 命名包含 lifetime/pro/starter
  const pid = (productId || '').toLowerCase();
  if (pid.includes('lifetime') || pid.includes('lt')) return 'lifetime';
  if (pid.includes('pro')) return 'pro';
  if (pid.includes('starter')) return 'starter';
  return null;
}
