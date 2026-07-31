/**
 * Creem Webhook 处理器 — 通用支付模板
 *
 * 功能：
 *   1. 验证 Creem HMAC-SHA256 签名（防止伪造请求）
 *   2. 解析支付完成事件
 *   3. 生成 License Key 并存入 KV（供用户兑换）
 *   4. 记录交易历史
 *
 * 路由：POST /api/credits/webhook
 *
 * 基于 RoboParts webhook.js（已验证可用）参数化而成，
 * 部署前请用 deploy.js 替换所有 __PLACEHOLDER__ 占位符。
 *
 * 安全要求：
 *   - CREEM_WEBHOOK_SECRET 必须配置为 Cloudflare Pages 环境变量（Secret）
 *   - 签名验证失败时返回 401，不执行任何业务逻辑
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

/**
 * HMAC-SHA256 签名验证
 * Creem 在请求头中通过 X-Creem-Signature 传递签名，
 * 签名方式：HMAC-SHA256(rawBody, webhook_secret)
 *
 * @param {string} rawBody - 原始请求体字符串
 * @param {string} signature - 请求头中的签名
 * @param {string} secret - Webhook 密钥（环境变量）
 * @returns {Promise<boolean>}
 */
async function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const computed = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // 常量时间比较，防止时序攻击
  if (computed.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * 生成 License Key：<product_id>-<random>
 */
function generateLicenseKey(productId) {
  const random = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(random)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${productId}-${hex}`;
}

// === 主处理：POST /api/credits/webhook ===
export async function onRequestPost({ request, env }) {
  // 1. 读取原始请求体（签名验证需要原始字节）
  const rawBody = await request.text();

  // 2. 验证签名
  const signature =
    request.headers.get('X-Creem-Signature') ||
    request.headers.get('x-creem-signature') ||
    '';

  const secret = env.CREEM_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[webhook] CREEM_WEBHOOK_SECRET 未配置');
    return jsonResponse({ error: 'server_misconfigured', message: 'Webhook 密钥未配置' }, 500);
  }

  const isValid = await verifySignature(rawBody, signature, secret);
  if (!isValid) {
    console.warn('[webhook] 签名验证失败');
    return jsonResponse({ error: 'invalid_signature', message: '签名验证失败' }, 401);
  }

  // 3. 解析事件
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: 'bad_request', message: '请求体不是有效 JSON' }, 400);
  }

  // Creem 事件类型：checkout.completed / payment.succeeded 等
  const eventType = event.type || event.event_type || 'unknown';

  // 仅处理支付完成事件
  if (eventType !== 'checkout.completed' && eventType !== 'payment.succeeded' && eventType !== 'order.completed') {
    // 非目标事件，快速返回成功（避免 Creem 重试）
    return jsonResponse({ success: true, message: '事件已接收（非支付完成事件，忽略）', event_type: eventType });
  }

  // 4. 提取订单/产品信息
  // Creem webhook 数据结构兼容多种字段命名
  const data = event.data || event.object || event;
  const productId =
    data.product_id ||
    data.productId ||
    data.product?.id ||
    data.metadata?.product_id ||
    null;

  const customerId =
    data.customer_id ||
    data.customerId ||
    data.customer?.id ||
    data.metadata?.customer_id ||
    'unknown';

  const orderId =
    data.id || data.order_id || data.orderId || data.checkout_id || `order_${Date.now()}`;

  const customerEmail = data.customer?.email || data.customer_email || data.metadata?.email || null;

  if (!productId) {
    console.error('[webhook] 缺少 product_id', { orderId });
    return jsonResponse({ error: 'missing_product', message: '缺少产品 ID' }, 400);
  }

  // 5. 匹配产品 -> 积分
  const productInfo = CONFIG.PRODUCT_MAP[productId];
  if (!productInfo) {
    console.error('[webhook] 未知产品 ID', { productId, orderId });
    return jsonResponse({ error: 'unknown_product', message: `未知产品 ID: ${productId}` }, 400);
  }

  // 6. 生成 License Key
  const licenseKey = generateLicenseKey(productId);
  const licenseHash = await sha256(licenseKey);
  const now = new Date().toISOString();

  // 7. 存入 KV —— 供用户在 balance.js 中兑换
  //    - pending:<licenseHash> -> productId（兑换时查找产品信息）
  //    - license_info:<licenseHash> -> 完整信息（审计用）
  if (env.API_KEYS) {
    await env.API_KEYS.put(`pending:${licenseHash}`, productId);

    const licenseInfo = {
      license_key: licenseKey,
      product_id: productId,
      product_name: productInfo.name,
      credits: productInfo.credits,
      tier: productInfo.tier,
      order_id: orderId,
      customer_id: customerId,
      customer_email_hash: customerEmail ? await sha256(customerEmail.toLowerCase()) : null,
      status: 'pending_redemption',
      created: now,
      site: CONFIG.SITE_NAME,
    };
    await env.API_KEYS.put(`license_info:${licenseHash}`, JSON.stringify(licenseInfo));
  }

  // 8. 记录交易历史（全局流水）
  if (env.USER_CREDIT_HISTORY) {
    const txKey = `tx:${orderId}:${Date.now()}`;
    const txRecord = {
      type: 'payment_received',
      event_type: eventType,
      product_id: productId,
      product_name: productInfo.name,
      credits: productInfo.credits,
      order_id: orderId,
      customer_id: customerId,
      license_key_generated: true,
      timestamp: now,
      site: CONFIG.SITE_NAME,
    };
    await env.USER_CREDIT_HISTORY.put(txKey, JSON.stringify(txRecord));
  }

  // 9. 返回成功（包含 License Key 供 Creem 发送给客户）
  //    注意：License Key 也会在 success.html 页面中展示
  console.log(`[webhook] 支付成功: ${productInfo.name} -> ${licenseKey.slice(0, 20)}...`);

  return jsonResponse({
    success: true,
    message: '支付已确认，License Key 已生成',
    event_type: eventType,
    product: productInfo.name,
    license_key: licenseKey,
    credits: productInfo.credits === -1 ? 'unlimited' : productInfo.credits,
    order_id: orderId,
    redeem_url: `${CONFIG.CREDITS_URL}`,
  });
}
