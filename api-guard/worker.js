/**
 * GeneTech API 鉴权 Worker (genetech-api-guard) — 经典 Service Worker 格式
 * ============================================================================
 * 修复"付费墙形同虚设"：公开 JSON 数据可被直接访问绕过。
 *
 * 职责：
 *   1. 免费层：对静态知识 JSON（<site>/website/api/*.json）放行，但做每 IP 限流
 *      （KV 近似限流，防抓取滥用），并打 X-GeneTech-Tier: free 头。
 *   2. 付费层（/api/pro/*）：必须携带有效的 Pro API Key（Authorization: Bearer），
 *      否则返回 401。Key 采用 HMAC 签名，无状态、可验证、防伪造。
 *   3. 可选远程校验：若配置了 LICENSE_VALIDATE_URL，则改为调用 unified-license
 *      Worker 校验 GUX_ 统一许可证兑换出的 gtk_ 站点 Key（与统一许可体系打通）。
 *
 * 绑定（Cloudflare 侧注入，作为全局变量可用）：
 *   PRO_SECRET            Pro Key 签名密钥（必填，Secrets 注入）
 *   PRO_FREE_RATE        免费层每 IP 每分钟请求上限（默认 60）
 *   PRO_KV               KV 命名空间绑定（限流用，可选；缺失则降级放行）
 *   LICENSE_VALIDATE_URL 可选：unified-license Worker 的 validate 端点
 *   LICENSE_API_SECRET   可选：调用上述端点的共享密钥（X-Admin-Secret）
 */

const DEFAULT_FREE_RATE = 60;

// 把 Cloudflare 注入的绑定整理成统一的 env 对象（缺失时按 undefined 处理，不抛错）
function getEnv() {
  return {
    PRO_SECRET: typeof PRO_SECRET !== 'undefined' ? PRO_SECRET : undefined,
    PRO_KV: typeof PRO_KV !== 'undefined' ? PRO_KV : undefined,
    PRO_FREE_RATE: typeof PRO_FREE_RATE !== 'undefined' ? PRO_FREE_RATE : undefined,
    LICENSE_VALIDATE_URL: typeof LICENSE_VALIDATE_URL !== 'undefined' ? LICENSE_VALIDATE_URL : undefined,
    LICENSE_API_SECRET: typeof LICENSE_API_SECRET !== 'undefined' ? LICENSE_API_SECRET : undefined,
    LLM_BRIDGE_BASE: typeof LLM_BRIDGE_BASE !== 'undefined' ? LLM_BRIDGE_BASE : undefined,
    LLM_BRIDGE_KEY: typeof LLM_BRIDGE_KEY !== 'undefined' ? LLM_BRIDGE_KEY : undefined,
    LLM_BRIDGE_MODEL: typeof LLM_BRIDGE_MODEL !== 'undefined' ? LLM_BRIDGE_MODEL : undefined,
    LLM_FREE_RATE: typeof LLM_FREE_RATE !== 'undefined' ? LLM_FREE_RATE : undefined,
  };
}

// ---------------------------------------------------------------------------
// 工具：HMAC / 常量时间比较
// ---------------------------------------------------------------------------

async function hmacSign(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
}

// ---------------------------------------------------------------------------
// Pro Key 校验（无状态 HMAC）
// token 格式：gtk_<base64urlPayload>.<hexSig>
//   payload = base64url(JSON{ site, exp })
// ---------------------------------------------------------------------------

async function validateProKeyLocal(token, env) {
  if (!env.PRO_SECRET) return { ok: false, error: 'server_misconfigured' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, error: 'invalid_format' };
  const [payloadB64, sig] = parts;
  const expected = await hmacSign(payloadB64, env.PRO_SECRET);
  if (!constantTimeEqual(expected, sig)) return { ok: false, error: 'bad_signature' };
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64));
  } catch {
    return { ok: false, error: 'bad_payload' };
  }
  if (!payload.exp || Date.now() > payload.exp) return { ok: false, error: 'expired' };
  return { ok: true, site: payload.site };
}

// 可选：远程校验 unified-license 体系下发的 gtk_ Key
async function validateProKeyRemote(token, site, env) {
  try {
    const res = await fetch(env.LICENSE_VALIDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(env.LICENSE_API_SECRET ? { 'X-Admin-Secret': env.LICENSE_API_SECRET } : {}) },
      body: JSON.stringify({ key: token, site_name: site }),
    });
    const data = await res.json();
    return { ok: !!data.valid, site: data.sites?.[0] || site };
  } catch {
    return { ok: false, error: 'remote_unreachable' };
  }
}

async function validateProKey(token, site, env) {
  if (env.LICENSE_VALIDATE_URL) return validateProKeyRemote(token, site, env);
  return validateProKeyLocal(token, env);
}

// ---------------------------------------------------------------------------
// 免费层限流（KV 近似）
// ---------------------------------------------------------------------------

async function checkFreeRate(env, ip) {
  const limit = parseInt(env.PRO_FREE_RATE || String(DEFAULT_FREE_RATE), 10);
  if (!env.PRO_KV || !ip || ip === 'unknown') return { allowed: true };
  const bucket = Math.floor(Date.now() / 60000);
  const key = `free:${ip}:${bucket}`;
  try {
    const raw = await env.PRO_KV.get(key);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= limit) return { allowed: false };
    await env.PRO_KV.put(key, String(count + 1), { expirationTtl: 120 });
    return { allowed: true };
  } catch {
    return { allowed: true }; // 降级放行
  }
}

function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() || 'unknown';
}

// ---- LLM 免费层限流（独立桶，避免污染知识 JSON 限流统计） ----
async function checkLlmRate(env, ip) {
  const limit = parseInt(env.LLM_FREE_RATE || '20', 10);
  if (!env.PRO_KV || !ip || ip === 'unknown') return { allowed: true };
  const bucket = Math.floor(Date.now() / 60000);
  const key = `llm:${ip}:${bucket}`;
  try {
    const raw = await env.PRO_KV.get(key);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= limit) return { allowed: false };
    await env.PRO_KV.put(key, String(count + 1), { expirationTtl: 120 });
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}

// ---------------------------------------------------------------------------
// 主处理器
// ---------------------------------------------------------------------------

function json(data, status, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

async function handleRequest(request) {
  const env = getEnv();
  const url = new URL(request.url);
  const path = url.pathname;
  const ip = getClientIp(request);

  // ---- 付费层：/api/pro/* 必须鉴权 ----
  if (path.startsWith('/api/pro/')) {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const site = url.searchParams.get('site') || '';
    if (!token) return json({ error: 'unauthorized', message: 'Pro API 需要 Authorization: Bearer <ProAPIKey>' }, 401);
    const v = await validateProKey(token, site, env);
    if (!v.ok) {
      const msg = { invalid_format: 'Key 格式无效', bad_signature: 'Key 签名验证失败', expired: 'Key 已过期', bad_payload: 'Key 负载无效', remote_unreachable: '许可证服务不可达', server_misconfigured: '服务端未配置' };
      return json({ error: 'forbidden', message: msg[v.error] || 'Pro Key 校验失败' }, 403);
    }
    const req = new Request(request);
    req.headers.set('X-GeneTech-Tier', 'pro');
    req.headers.set('X-GeneTech-Site', v.site || site);
    return fetch(req);
  }

  // ---- 免费层：静态知识 JSON 限流放行 ----
  if (path.includes('/website/api/') || path.endsWith('.json')) {
    const rl = await checkFreeRate(env, ip);
    if (!rl.allowed) {
      return json({ error: 'rate_limited', message: `免费层限流：每 IP 每分钟 ${env.PRO_FREE_RATE || DEFAULT_FREE_RATE} 次。升级 Pro 获取更高配额与语义检索/引用导出能力。` }, 429, { 'Retry-After': '60' });
    }
    const req = new Request(request);
    req.headers.set('X-GeneTech-Tier', 'free');
    return fetch(req);
  }

  // ---- LLM 桥接：/api/llm/* 转发到上游 OpenAI 兼容网关 ----
  // 设计：
  //   - 仅放行 /api/llm/chat/completions（OpenAI 兼容）与 /api/llm/embeddings
  //   - 其余 /api/llm/* 路径返回 404
  //   - 未配置 LLM_BRIDGE_BASE 直接 503，避免请求泄漏到任何默认上游
  //   - 默认限流每 IP 每分钟 20 次；可通过 LLM_FREE_RATE 调整
  if (path.startsWith('/api/llm/')) {
    const base = (env.LLM_BRIDGE_BASE || '').replace(/\/+$/, '');
    if (!base) {
      return json({ error: 'llm_not_configured', message: 'LLM 桥接未配置（请在 wrangler [vars] 或 secret 中设置 LLM_BRIDGE_BASE）。' }, 503);
    }
    const llmRl = await checkLlmRate(env, ip);
    if (!llmRl.allowed) {
      return json({ error: 'rate_limited', message: `LLM 免费层限流：每 IP 每分钟 ${env.LLM_FREE_RATE || 20} 次。` }, 429, { 'Retry-After': '60' });
    }
    let sub = path.slice('/api/llm'.length); // => "/chat/completions" 或 "/embeddings"
    if (sub !== '/chat/completions' && sub !== '/embeddings') {
      return json({ error: 'not_found', message: `LLM 网关路径 ${sub} 未开放` }, 404);
    }
    const target = base + sub + (url.search || '');
    const init = {
      method: request.method,
      headers: { 'Content-Type': 'application/json' },
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.clone().arrayBuffer(),
    };
    if (env.LLM_BRIDGE_KEY) init.headers.Authorization = `Bearer ${env.LLM_BRIDGE_KEY}`;
    try {
      const upstream = await fetch(target, init);
      const buf = await upstream.arrayBuffer();
      const headers = new Headers(upstream.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'no-store');
      return new Response(buf, { status: upstream.status, headers });
    } catch (e) {
      return json({ error: 'upstream_unreachable', message: String(e.message || e) }, 502);
    }
  }

  // 其他路径直接转发
  return fetch(request);
}

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});
