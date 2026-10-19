/**
 * 按邮箱查询未兑换 License Key — 通用支付模板
 *
 * 路由：POST /api/credits/licenses
 * 用途：success.html 的"输入邮箱查 license"兜底路径。
 *       webhook 生成的 license 是异步产物，Creem 跳回 success 时 URL 参数拿不到；
 *       本端点让买家自助查到 webhook 已写入 KV 的未兑换 license，替代运营手工转发。
 *
 * 安全：
 *   - 用 SHA-256(email) 作 KV 索引键，邮箱明文不落库
 *   - 无 API Key 也能查（仅列出未兑换项），速率由 CF 默认限流保护
 *   - 返回结果不含 customer_email_hash，避免侧信道泄露
 *
 * 依赖：webhook.js 写入 `user_licenses:<sha256(email)>` -> JSON array。
 */

const CONFIG = {
  SITE_NAME: '__SITE_NAME__',
  SITE_DOMAIN: '__SITE_DOMAIN__',
  RATE_LIMIT: '30 requests/hour',
};

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
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Cache-Control': 'no-store',
    },
  });
}

// OPTIONS 预检
export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, message: '请求体必须是 JSON' }, 400);
  }

  const email = (body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ success: false, message: '请提供有效 email 字段' }, 400);
  }

  if (!env.API_KEYS) {
    return jsonResponse({ success: false, message: '服务端 KV 未配置，无法查询' }, 500);
  }

  const emailHash = await sha256(email);
  const raw = await env.API_KEYS.get(`user_licenses:${emailHash}`);
  let all = [];
  try {
    all = JSON.parse(raw || '[]');
  } catch {
    all = [];
  }

  // 过滤已兑换：API_KEYS 里有 license:<hash> 即为已使用
  const kept = [];
  for (const it of all) {
    if (!it || !it.license_key) continue;
    const h = await sha256(it.license_key);
    const used = await env.API_KEYS.get(`license:${h}`);
    if (used) continue;
    kept.push({
      license_key: it.license_key,
      product_id: it.product_id || '',
      created: it.created || '',
    });
  }

  return jsonResponse({
    success: true,
    count: kept.length,
    licenses: kept,
    note: kept.length === 0
      ? '未找到未兑换 license。若付款超过 5 分钟，请刷新或联系支持。'
      : undefined,
  });
}
