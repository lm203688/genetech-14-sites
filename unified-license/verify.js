/**
 * GeneTech 14站知识引擎 — 统一许可证校验客户端模块 (ES Module)
 *
 * 用途：14 个站点各自引入本模块，校验用户出示的 GUX_ 统一许可证密钥，
 *       并为当前站点兑换获得站点专属 API Key。
 *
 * 本模块为纯网络调用（无本地缓存），适用于浏览器端或服务端。
 * 若需要本地缓存与代理，请使用配套的 site-adapter.js（Cloudflare Pages Function）。
 *
 * 使用方式：
 *
 *   import { verifyUnifiedLicense, isUnifiedKey } from './verify.js';
 *
 *   const result = await verifyUnifiedLicense(userKey, 'site1', 'site1.genetech.io');
 *   if (result.valid) {
 *     console.log(result.api_key, result.credits, result.plan);
 *   } else {
 *     console.error(result.error);
 *   }
 *
 * 返回值：
 *   成功 -> { valid: true, api_key, credits, plan }
 *   失败 -> { error: '<reason>' }
 *
 * 说明：credits 为许可证剩余可用积分（-1 表示无限/终身版）。
 */

// ============================================================================
// 配置：中央许可证 API 地址（单一真源 shared/endpoints.json，杜绝三处漂移）
// ============================================================================

import endpoints from '../shared/endpoints.json' with { type: 'json' };

export const UNIFIED_APIS = endpoints.license;

// 统一许可证密钥前缀
const UNIFIED_KEY_PREFIX = 'GUX_';

// 请求超时（毫秒）
const REQUEST_TIMEOUT_MS = 10000;

// ============================================================================
// 工具函数
// ============================================================================

/** 判断是否为统一许可证密钥（GUX_ 前缀） */
export function isUnifiedKey(key) {
  return typeof key === 'string' && key.startsWith(UNIFIED_KEY_PREFIX);
}

/**
 * 带超时的 fetch 封装
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 多端点兜底：依次尝试所有中央 API 基址，哪个可达用哪个。
 */
async function fetchUnified(path, options, timeoutMs) {
  let lastErr;
  for (const base of UNIFIED_APIS) {
    try {
      const resp = await fetchWithTimeout(base + path, options, timeoutMs);
      if (resp.ok || resp.status < 500) return resp;
      lastErr = new Error('HTTP ' + resp.status);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('所有许可证端点均不可达');
}

/**
 * 调用中央 API 校验许可证（只读，返回站点列表与积分）
 * @returns {Promise<object|null>} 校验结果对象；网络异常返回 null
 */
async function callValidate(licenseKey, siteName, siteDomain) {
  const body = JSON.stringify({
    key: licenseKey,
    site_name: siteName,
    site_domain: siteDomain || undefined,
  });
  try {
    const resp = await fetchUnified(
      '/api/license/validate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
      REQUEST_TIMEOUT_MS
    );
    return await resp.json();
  } catch (e) {
    console.error('[verify] validate 请求失败:', e.message);
    return null;
  }
}

/**
 * 调用中央 API 兑换许可证，获得站点专属 API Key
 * @returns {Promise<object|null>} 兑换结果对象；网络异常返回 null
 */
async function callRedeem(licenseKey, siteName, siteDomain) {
  const body = JSON.stringify({
    key: licenseKey,
    site_name: siteName,
    site_domain: siteDomain || undefined,
  });
  try {
    const resp = await fetchUnified(
      '/api/license/redeem',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
      REQUEST_TIMEOUT_MS
    );
    return await resp.json();
  } catch (e) {
    console.error('[verify] redeem 请求失败:', e.message);
    return null;
  }
}

// ============================================================================
// 核心函数：verifyUnifiedLicense
// ============================================================================

/**
 * 校验统一许可证密钥并为当前站点兑换，返回站点专属 API Key。
 *
 * 流程：
 *   1. 调用 /api/license/validate 校验密钥有效性、积分与已兑换站点
 *   2. 若有效，调用 /api/license/redeem 为当前站点兑换，获得 api_key
 *   3. 返回合并结果 { valid, api_key, credits, plan }
 *
 * @param {string} licenseKey  用户出示的 GUX_ 密钥
 * @param {string} siteName    当前站点名（须在中央 ALLOWED_SITES 内）
 * @param {string} [siteDomain] 当前站点域名（可选，用于审计）
 * @returns {Promise<{valid: true, api_key: string, credits: number, plan: string} | {error: string}>}
 */
export async function verifyUnifiedLicense(licenseKey, siteName, siteDomain) {
  // 1. 基础参数校验
  if (!licenseKey || typeof licenseKey !== 'string') {
    return { error: 'missing_key' };
  }
  if (!siteName || typeof siteName !== 'string') {
    return { error: 'missing_site' };
  }
  if (!isUnifiedKey(licenseKey)) {
    return { error: 'not_unified_key' };
  }

  // 2. 校验许可证
  const validateData = await callValidate(licenseKey, siteName, siteDomain);
  if (!validateData) {
    return { error: 'central_unreachable' };
  }
  if (!validateData.valid && validateData.success !== true) {
    // validate 失败（格式/不存在/吊销/过期）
    return { error: validateData.error || 'invalid' };
  }
  // 兼容中央返回 { success: true, valid: true, ... }
  if (validateData.valid === false) {
    return { error: validateData.error || 'invalid' };
  }

  // 3. 兑换获得站点专属 API Key
  const redeemData = await callRedeem(licenseKey, siteName, siteDomain);
  if (!redeemData) {
    // validate 已通过但 redeem 网络失败：仍返回有效信息，但缺少 api_key
    return {
      error: 'redeem_unreachable',
      valid: true,
      plan: validateData.plan,
      credits: validateData.credits_remaining,
    };
  }
  if (redeemData.valid === false) {
    return { error: redeemData.error || 'redeem_failed' };
  }

  // 4. 返回合并结果
  return {
    valid: true,
    api_key: redeemData.api_key,
    credits: redeemData.credits, // 剩余积分（-1 = 无限）
    plan: redeemData.plan || validateData.plan,
  };
}

// ============================================================================
// 辅助函数：仅校验不兑换（只读查询）
// ============================================================================

/**
 * 仅校验许可证状态（不兑换，不修改中央状态）。
 * 适用于在兑换前展示许可证信息给用户确认。
 *
 * @param {string} licenseKey
 * @param {string} [siteName]
 * @returns {Promise<object|null>} 中央返回的校验结果，网络异常返回 null
 */
export async function checkLicenseStatus(licenseKey, siteName) {
  if (!licenseKey || !isUnifiedKey(licenseKey)) return null;
  return callValidate(licenseKey, siteName || null, null);
}

export default verifyUnifiedLicense;
