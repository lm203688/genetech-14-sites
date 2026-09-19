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
// 语义搜索（/v1/search/semantic）
// 依赖：data/search-index.json（由 pipeline-search-index.js 每日构建，
//       每站 top-500 高置信实体，合计 ~13k 实体 / ~6.5MB）
// 鉴权：必须 Pro Key（`gtk_` 前缀）
// ---------------------------------------------------------------------------

const SEARCH_INDEX_URL = 'https://lm203688.github.io/genetech-14-sites/data/search-index.json';
const SEARCH_INDEX_CACHE_KEY = '__SEARCH_INDEX_CACHE__';
const SEARCH_INDEX_TTL_MS = 10 * 60 * 1000; // 10 分钟

function tokenize(s) {
  if (!s) return [];
  return String(s).toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !/^(the|and|for|with|from|that|this|are|was|were|have|has|had|into|over|upon|than|which|their|their|their)$/.test(t));
}

async function getSearchIndex(request) {
  try {
    const cached = globalThis[SEARCH_INDEX_CACHE_KEY];
    if (cached && Date.now() - cached.fetchedAt < SEARCH_INDEX_TTL_MS) return cached.data;
    const cacheCf = await caches.open('search-index-v1');
    const cachedR = await cacheCf.match(SEARCH_INDEX_URL);
    if (cachedR) {
      const data = await cachedR.json();
      globalThis[SEARCH_INDEX_CACHE_KEY] = { data, fetchedAt: Date.now() };
      return data;
    }
    const res = await fetch(SEARCH_INDEX_URL, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const data = await res.json();
    globalThis[SEARCH_INDEX_CACHE_KEY] = { data, fetchedAt: Date.now() };
    return data;
  } catch (e) {
    return null;
  }
}

async function handleSemanticSearch(request) {
  const started = Date.now();
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request', message: 'Body 必须是 JSON' }, 400);
  }
  const query = (body.query || '').trim();
  if (!query || query.length < 2) {
    return json({ error: 'bad_request', message: 'query 至少 2 字符' }, 400);
  }
  const limit = Math.min(parseInt(body.limit, 10) || 20, 50);
  const sites = Array.isArray(body.sites) ? body.sites : (typeof body.sites === 'string' ? [body.sites] : null);
  const source = body.source || null;

  const index = await getSearchIndex(request);
  if (!index || !index.entities) {
    return json({ error: 'index_unavailable', message: '搜索索引不可用，请稍后重试' }, 503);
  }

  const qTokens = tokenize(query);
  if (qTokens.length === 0) {
    return json({ error: 'bad_request', message: 'query 无可搜索 token' }, 400);
  }

  // 打分：name 命中权重最高，tag 次之，snippet 最低；confidence 加权
  const scored = [];
  for (const e of index.entities) {
    if (sites && !sites.includes(e.site)) continue;
    if (source && e.source && e.source !== source) continue;
    const nameTokens = new Set(tokenize(e.name));
    const tagTokens = new Set(e.tags.flatMap((t) => tokenize(t)));
    const snippetTokens = new Set(tokenize(e.snippet));
    let hit = 0;
    for (const qt of qTokens) {
      if (nameTokens.has(qt)) hit += 3;
      else if (tagTokens.has(qt)) hit += 2;
      else if (snippetTokens.has(qt)) hit += 1;
    }
    if (hit === 0) continue;
    const coverage = hit / (qTokens.length * 3);
    const score = coverage * 0.7 + (e.confidence || 0) * 0.3;
    scored.push({
      id: e.id, name: e.name, site: e.site, source: e.source,
      url: e.url, snippet: e.snippet, tags: e.tags,
      publishedDate: e.publishedDate, confidence: e.confidence,
      score: Math.round(score * 10000) / 10000,
    });
  }

  scored.sort((a, b) => b.score - a.score || (b.confidence || 0) - (a.confidence || 0));
  const top = scored.slice(0, limit);

  return json({
    results: top,
    total: scored.length,
    returned: top.length,
    query,
    meta: {
      indexGeneratedAt: index.generatedAt,
      entityCount: index.totalEntities,
      sourceSites: index.sourceSites,
      elapsedMs: Date.now() - started,
      tokenCount: qTokens.length,
    },
  });
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

  // ---- 付费层：/api/pro/* 和 /v1/search/semantic 必须鉴权 ----
  if (path.startsWith('/api/pro/') || path.startsWith('/v1/search/')) {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const site = url.searchParams.get('site') || '';
    if (!token) return json({ error: 'unauthorized', message: 'Pro API 需要 Authorization: Bearer <ProAPIKey>' }, 401);
    const v = await validateProKey(token, site, env);
    if (!v.ok) {
      const msg = { invalid_format: 'Key 格式无效', bad_signature: 'Key 签名验证失败', expired: 'Key 已过期', bad_payload: 'Key 负载无效', remote_unreachable: '许可证服务不可达', server_misconfigured: '服务端未配置' };
      return json({ error: 'forbidden', message: msg[v.error] || 'Pro Key 校验失败' }, 403);
    }

    // 语义搜索端点：内部处理，不走代理转发
    if (path === '/v1/search/semantic' || path === '/api/pro/search/semantic') {
      if (request.method !== 'POST') {
        return json({ error: 'method_not_allowed', message: '仅支持 POST' }, 405);
      }
      return handleSemanticSearch(request);
    }

    const req = new Request(request);
    req.headers.set('X-GeneTech-Tier', 'pro');
    req.headers.set('X-GeneTech-Site', v.site || site);
    return fetch(req);
  }

  // ---- 免费层：静态知识 JSON 限流放行 ----
  if (path.includes('/website/api/') || path.endsWith('.json') || path.startsWith('/v1/')) {
    const rl = await checkFreeRate(env, ip);
    if (!rl.allowed) {
      return json({ error: 'rate_limited', message: `免费层限流：每 IP 每分钟 ${env.PRO_FREE_RATE || DEFAULT_FREE_RATE} 次。升级 Pro 获取更高配额与语义检索/引用导出能力。` }, 429, { 'Retry-After': '60' });
    }

    // /v1/* OpenAPI 路径映射到实际静态文件
    let targetPath = path;
    if (path === '/v1/domains' || path === '/v1/entities/meta') {
      targetPath = '/api/catalog.json';
    } else if (path === '/v1/oss/registry') {
      targetPath = '/data/oss-registry.json';
    } else if (path === '/v1/entities') {
      targetPath = '/api/catalog.json'; // 聚合视图走 catalog（各站 entities 由 catalog.index/entities 字段指向）
    } else if (path.startsWith('/v1/domains/')) {
      const slug = path.slice('/v1/domains/'.length);
      targetPath = `/${slug}/website/api/index.json`;
    }

    const req = new Request(request, { headers: request.headers });
    if (targetPath !== path) {
      // 用改写后的 URL 转发
      const newUrl = new URL(targetPath, request.url);
      const proxyReq = new Request(newUrl, { method: request.method, headers: req.headers });
      proxyReq.headers.set('X-GeneTech-Tier', 'free');
      proxyReq.headers.set('X-GeneTech-OriginalPath', path);
      return fetch(proxyReq);
    }
    req.headers.set('X-GeneTech-Tier', 'free');
    return fetch(req);
  }

  // ---- /health 端点 ----
  if (path === '/health' || path === '/api/health') {
    return json({ ok: true, service: 'genetech-api-guard', time: new Date().toISOString() });
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
    // 构造请求体：/chat/completions 且配置了 LLM_BRIDGE_MODEL 时，强制覆盖模型名，
    // 避免前端写死 gpt-4o-mini 而上游（ATEX/自建网关）无该模型导致 404。
    let bodyBuf;
    if (['GET', 'HEAD'].includes(request.method)) {
      bodyBuf = undefined;
    } else {
      const raw = await request.clone().arrayBuffer();
      if (sub === '/chat/completions' && env.LLM_BRIDGE_MODEL) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(raw));
          parsed.model = env.LLM_BRIDGE_MODEL;
          bodyBuf = new TextEncoder().encode(JSON.stringify(parsed));
        } catch {
          bodyBuf = raw;
        }
      } else {
        bodyBuf = raw;
      }
    }
    const init = {
      method: request.method,
      headers: { 'Content-Type': 'application/json' },
      body: bodyBuf,
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
