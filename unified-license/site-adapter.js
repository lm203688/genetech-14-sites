/**
 * GeneTech 14站知识引擎 — 站点许可证适配器 (Cloudflare Pages Function)
 *
 * 部署位置：各站点的 `functions/api/license/` 目录（建议命名为 `index.js`）。
 *   例如：站点项目/functions/api/license/index.js
 *
 * 职责：
 *   1. 接收站点前端的许可证校验请求，代理至中央许可证 API
 *   2. 在站点本地 KV 中缓存「有效许可证」结果 1 小时，降低中央调用量
 *   3. 缓存过期或未命中时回源中央 API；缓存命中时直接返回
 *
 * 请求（前端 -> 本适配器）：
 *   POST /api/license
 *   Content-Type: application/json
 *   { "license_key": "GUX_...", "site_name": "site1", "site_domain": "site1.genetech.io" }
 *
 * 响应：
 *   成功 -> { "valid": true, "api_key": "gtk_...", "credits": 500, "plan": "pro", "cached": true/false }
 *   失败 -> { "valid": false, "error": "...", "message": "..." }
 *
 * 依赖环境变量（站点侧，在站点 wrangler.toml / Pages 设置中配置）：
 *   - UNIFIED_LICENSE_API   中央 API 地址（默认 https://license.genetech.io）
 *   - SITE_NAME              当前站点名（若请求体未传 site_name，则使用此值）
 *
 * 依赖 KV 命名空间（站点侧，复用已有或新建）：
 *   - LICENSE_CACHE          许可证缓存（优先）；未绑定时回退 API_KEYS
 *     缓存键：ulc:<sha256(license_key)>:<site_name>
 *     有效结果 TTL：3600 秒（1 小时）
 *     无效结果 TTL：300 秒（5 分钟，防止被刷接口）
 */

// ============================================================================
// 配置
// ============================================================================

const DEFAULT_CENTRAL_API = 'https://license.swarmlabs.tools';
const CACHE_TTL_VALID = 3600; // 有效结果缓存 1 小时
const CACHE_TTL_INVALID = 300; // 无效结果缓存 5 分钟
const REQUEST_TIMEOUT_MS = 10000;

// ============================================================================
// 工具函数
// ============================================================================

/** SHA-256 哈希 */
async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 获取中央 API 地址（环境变量优先） */
function getCentralApi(env) {
  return (env && env.UNIFIED_LICENSE_API) || DEFAULT_CENTRAL_API;
}

/** 获取缓存 KV（优先 LICENSE_CACHE，回退 API_KEYS） */
function getCacheKV(env) {
  return (env && (env.LICENSE_CACHE || env.UNIFIED_LICENSES || env.API_KEYS)) || null;
}

/** CORS 响应头（允许同站前端跨域调用） */
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(data, status, corsH) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsH,
    },
  });
}

/** 带超时的 fetch */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// 中央 API 调用：validate + redeem
// ============================================================================

/**
 * 调用中央 API 校验并兑换，返回合并结果。
 * @returns {Promise<object>} { valid, api_key?, credits?, plan?, error? }
 */
async function callCentral(licenseKey, siteName, siteDomain, env) {
  const base = getCentralApi(env).replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };

  // 1. validate（只读校验）
  let validateData;
  try {
    const vResp = await fetchWithTimeout(
      `${base}/api/license/validate`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ key: licenseKey, site_name: siteName, site_domain: siteDomain }),
      },
      REQUEST_TIMEOUT_MS
    );
    validateData = await vResp.json();
  } catch (e) {
    return { valid: false, error: 'central_unreachable', message: `中央 API 不可达: ${e.message}` };
  }

  if (!validateData || validateData.valid === false) {
    return {
      valid: false,
      error: (validateData && validateData.error) || 'invalid',
      message: (validateData && validateData.message) || '许可证无效',
    };
  }

  // 2. redeem（兑换获得站点专属 API Key）
  let redeemData;
  try {
    const rResp = await fetchWithTimeout(
      `${base}/api/license/redeem`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ key: licenseKey, site_name: siteName, site_domain: siteDomain }),
      },
      REQUEST_TIMEOUT_MS
    );
    redeemData = await rResp.json();
  } catch (e) {
    // validate 通过但 redeem 失败：返回有效但无 api_key
    return {
      valid: true,
      plan: validateData.plan,
      credits: validateData.credits_remaining,
      error: 'redeem_unreachable',
      message: `兑换请求失败: ${e.message}`,
    };
  }

  if (!redeemData || redeemData.valid === false) {
    return {
      valid: false,
      error: (redeemData && redeemData.error) || 'redeem_failed',
      message: (redeemData && redeemData.message) || '兑换失败',
    };
  }

  // 3. 合并结果
  return {
    valid: true,
    api_key: redeemData.api_key,
    credits: redeemData.credits, // -1 = 无限
    plan: redeemData.plan || validateData.plan,
    sites: redeemData.sites || validateData.sites,
    already_redeemed: redeemData.already_redeemed,
    expires: redeemData.expires || validateData.expires,
  };
}

// ============================================================================
// Pages Function 入口
// ============================================================================

/** CORS 预检 */
export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/license
 * 请求体：{ license_key, site_name?, site_domain? }
 */
export async function onRequestPost({ request, env, ctx }) {
  const corsH = corsHeaders(request);

  // 解析请求体
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ valid: false, error: 'bad_request', message: '请求体必须是 JSON' }, 400, corsH);
  }

  const licenseKey = (body.license_key || body.key || '').trim();
  // site_name 优先取请求体，回退环境变量 SITE_NAME
  const siteName = (body.site_name || body.site || (env && env.SITE_NAME) || '').trim();
  const siteDomain = (body.site_domain || body.domain || '').trim();

  if (!licenseKey) {
    return jsonResponse({ valid: false, error: 'missing_key', message: '请提供 license_key' }, 400, corsH);
  }
  if (!siteName) {
    return jsonResponse(
      { valid: false, error: 'missing_site', message: '请提供 site_name 或配置 SITE_NAME' },
      400,
      corsH
    );
  }

  // 计算缓存键
  const keyHash = await sha256(licenseKey);
  const cacheKey = `ulc:${keyHash}:${siteName.toLowerCase()}`;
  const cacheKV = getCacheKV(env);

  // 1. 检查本地缓存
  if (cacheKV) {
    try {
      const cached = await cacheKV.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        // 缓存命中（无论有效/无效），附加 cached 标记后返回
        return jsonResponse({ ...parsed, cached: true }, 200, corsH);
      }
    } catch {
      // 缓存读取失败，继续回源
    }
  }

  // 2. 缓存未命中 -> 调用中央 API
  const result = await callCentral(licenseKey, siteName, siteDomain, env);

  // 3. 写入本地缓存
  if (cacheKV) {
    const ttl = result.valid ? CACHE_TTL_VALID : CACHE_TTL_INVALID;
    const payload = JSON.stringify(result);
    try {
      // 使用 ctx.waitUntil 异步写入，不阻塞响应
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(cacheKV.put(cacheKey, payload, { expirationTtl: ttl }));
      } else {
        await cacheKV.put(cacheKey, payload, { expirationTtl: ttl });
      }
    } catch {
      // 缓存写入失败不影响主流程
    }
  }

  return jsonResponse({ ...result, cached: false }, 200, corsH);
}

/** GET /api/license?key=xxx —— 只读状态查询（代理中央 status，附带缓存） */
export async function onRequestGet({ request, env, ctx }) {
  const corsH = corsHeaders(request);
  const url = new URL(request.url);
  const licenseKey = (url.searchParams.get('key') || '').trim();
  const siteName = (url.searchParams.get('site_name') || (env && env.SITE_NAME) || '').trim();

  if (!licenseKey) {
    return jsonResponse({ valid: false, error: 'missing_key', message: '请提供 key 参数' }, 400, corsH);
  }

  const keyHash = await sha256(licenseKey);
  const cacheKey = `ulc:${keyHash}:${siteName.toLowerCase()}`;
  const cacheKV = getCacheKV(env);

  // 缓存查询（仅返回有效缓存，状态查询不缓存无效结果）
  if (cacheKV) {
    try {
      const cached = await cacheKV.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.valid) {
          return jsonResponse({ ...parsed, cached: true }, 200, corsH);
        }
      }
    } catch {
      // 忽略
    }
  }

  // 回源中央 status
  const base = getCentralApi(env).replace(/\/+$/, '');
  try {
    const resp = await fetchWithTimeout(
      `${base}/api/license/status?key=${encodeURIComponent(licenseKey)}`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } },
      REQUEST_TIMEOUT_MS
    );
    const data = await resp.json();
    return jsonResponse({ ...data, cached: false }, 200, corsH);
  } catch (e) {
    return jsonResponse(
      { valid: false, error: 'central_unreachable', message: `中央 API 不可达: ${e.message}` },
      502,
      corsH
    );
  }
}

export default { onRequestGet, onRequestPost, onRequestOptions };
