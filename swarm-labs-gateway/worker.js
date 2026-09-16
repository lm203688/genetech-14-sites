/**
 * SwarmLabs Data Gateway — 独立数据网关 Worker
 * ============================================================================
 * 目的：把 SwarmLabs 14 站 × 10 站（共 30 领域 / ~300K 实体）科研结构化数据
 *       通过独立 API Key 体系提供给**外部项目**（如"蜂群科研数据"），
 *       与 SwarmLabs 自身 Pro 定价鉴权（api-guard / unified-license）完全解耦。
 *
 * 独立性设计：
 *   1. Key 前缀 `slb_` 与 Pro Key 前缀 `gtk_` 严格区隔，HMAC 用**独立密钥** GATEWAY_SECRET。
 *   2. 吊销单个 partner 只改本 worker 的 KV，不影响 api-guard 的 Pro 用户，反之亦然。
 *   3. 限流桶独立（`gw:<clientId>:<min>`），与 Pro 限流互不干扰。
 *   4. 数据源走同源上游 CDN（`https://lm203688.github.io/genetech-14-sites/<domain>/website/api/entities.json`），
 *      上游不动则本 worker 不动，SwarmLabs 主站更新数据后本网关**自动同步**。
 *
 * 端点：
 *   GET /api/v1/health                                免鉴权，健康检查
 *   GET /api/v1/domains                               需 slb_ key，返回领域清单
 *   GET /api/v1/entities?domain=X&limit=&offset=&q=   需 slb_ key，实体分页/关键词过滤
 *   GET /api/v1/entities/<id>?domain=X                需 slb_ key，单实体查询
 *
 * 绑定：
 *   GATEWAY_SECRET        Key 签名密钥（Secrets 注入）
 *   GATEWAY_UPSTREAM      数据源根 URL（默认 https://lm203688.github.io/genetech-14-sites）
 *   GW_KV                 KV 命名空间（限流 + key 吊销列表）
 *   GW_QUOTA_PER_MIN      默认每 key 每分钟请求上限（默认 120）
 *
 * 部署：
 *   wrangler deploy  →  https://swarm-labs-gateway.<account>.workers.dev
 */

const DEFAULT_QUOTA_PER_MIN = 120;
const DEFAULT_UPSTREAM = 'https://lm203688.github.io/genetech-14-sites';

// ---------- 领域清单（与仓库根 30 个 <domain>/website 目录一一对应） ----------
const DOMAINS = [
  'agritech', 'ai-safety', 'ai4science', 'alien-minerals', 'biocomputing',
  'biomed-ai', 'bionic-ai', 'brain-science', 'carbon-neutral', 'deep-sea-tech',
  'digital-twin', 'edge-ai', 'embodied-ai', 'exo-science', 'life-science',
  'low-altitude', 'neuromorphic', 'new-energy', 'nuclear-energy', 'privacy-computing',
  'quantum-computing', 'quantum-materials', 'robot-parts', 'sat-6g',
  'semiconductor', 'spatial-computing', 'synbio-manufacturing', 'tcm-tools',
  'agent-ecosystem', 'genetech-tools',
];

function getEnv() {
  return {
    GATEWAY_SECRET: typeof GATEWAY_SECRET !== 'undefined' ? GATEWAY_SECRET : undefined,
    GATEWAY_UPSTREAM: typeof GATEWAY_UPSTREAM !== 'undefined' ? GATEWAY_UPSTREAM : undefined,
    GW_KV: typeof GW_KV !== 'undefined' ? GW_KV : undefined,
    GW_QUOTA_PER_MIN: typeof GW_QUOTA_PER_MIN !== 'undefined' ? GW_QUOTA_PER_MIN : undefined,
  };
}

// ---------- 工具 ----------
async function hmacSign(msg, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
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
  return new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)));
}

function json(data, status, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

// ---------- Key 校验 ----------
// 格式：slb_<base64url(JSON payload)>.<hexSig>
// payload = { client: string, exp: number(ms), scopes: string[], quota?: number }
async function validateGatewayKey(token, env) {
  if (!env.GATEWAY_SECRET) return { ok: false, error: 'server_misconfigured' };
  if (!token || !token.startsWith('slb_')) return { ok: false, error: 'invalid_prefix' };
  const raw = token.slice(4);
  const parts = raw.split('.');
  if (parts.length !== 2) return { ok: false, error: 'invalid_format' };
  const [payloadB64, sig] = parts;
  const expected = await hmacSign(payloadB64, env.GATEWAY_SECRET);
  if (!constantTimeEqual(expected, sig)) return { ok: false, error: 'bad_signature' };
  let payload;
  try { payload = JSON.parse(b64urlDecode(payloadB64)); }
  catch { return { ok: false, error: 'bad_payload' }; }
  if (!payload.client || typeof payload.exp !== 'number') return { ok: false, error: 'bad_payload' };
  if (Date.now() > payload.exp) return { ok: false, error: 'expired' };

  // 检查吊销列表
  if (env.GW_KV) {
    try {
      const revoked = await env.GW_KV.get(`revoked:${payload.client}`);
      if (revoked) return { ok: false, error: 'revoked' };
    } catch { /* ignore */ }
  }
  return { ok: true, client: payload.client, scopes: payload.scopes || [], quota: payload.quota };
}

// ---------- 限流（独立桶） ----------
async function checkRate(env, clientId) {
  const limit = parseInt(env.GW_QUOTA_PER_MIN || String(DEFAULT_QUOTA_PER_MIN), 10);
  if (!env.GW_KV || !clientId) return { allowed: true };
  const bucket = Math.floor(Date.now() / 60000);
  const key = `gw:${clientId}:${bucket}`;
  try {
    const raw = await env.GW_KV.get(key);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= limit) return { allowed: false };
    await env.GW_KV.put(key, String(count + 1), { expirationTtl: 120 });
    return { allowed: true };
  } catch { return { allowed: true }; }
}

function hasScope(scopes, required) {
  if (!scopes || !scopes.length) return true; // 空 scopes = 默认放行
  return scopes.includes(required);
}

// ---------- 数据抓取（带内存缓存 60s） ----------
const _cache = new Map();
const CACHE_TTL = 60 * 1000;

async function fetchEntities(domain, env) {
  const cacheKey = domain;
  const hit = _cache.get(cacheKey);
  if (hit && hit.exp > Date.now()) return hit.data;
  const upstream = (env.GATEWAY_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/+$/, '');
  const url = `${upstream}/${domain}/website/api/entities.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`upstream_${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.entities || []);
    _cache.set(cacheKey, { data: list, exp: Date.now() + CACHE_TTL });
    return list;
  } catch (e) {
    if (hit) return hit.data; // stale fallback
    throw e;
  }
}

// ---------- 端点处理 ----------

function handleHealth() {
  return json({
    ok: true,
    service: 'swarm-labs-gateway',
    version: '1.0.0',
    domains: DOMAINS.length,
    upstream: DEFAULT_UPSTREAM,
    note: 'Partner-access data gateway; independent of SwarmLabs Pro tier.',
  });
}

async function handleDomains(env) {
  return json({
    count: DOMAINS.length,
    domains: DOMAINS,
    per_domain_entities: 10000,
    total_entities: DOMAINS.length * 10000,
    data_contract: {
      entity: ['id', 'name', 'source', 'abstract', 'authors', 'year', 'tags', 'related'],
      note: 'Schema is domain-agnostic; some fields may be null in sparse domains.',
    },
  });
}

async function handleEntities(url, env) {
  const domain = url.searchParams.get('domain') || '';
  if (!domain) return json({ error: 'bad_request', message: 'domain query param required' }, 400);
  if (!DOMAINS.includes(domain)) {
    return json({ error: 'unknown_domain', message: `domain "${domain}" not found`, available: DOMAINS }, 404);
  }
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 500);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();

  let all;
  try { all = await fetchEntities(domain, env); }
  catch (e) { return json({ error: 'upstream_unreachable', message: String(e.message || e) }, 502); }

  // 关键词过滤：命中 id / name / abstract / tags
  let filtered = all;
  if (q) {
    filtered = all.filter(e =>
      (e.id || '').toLowerCase().includes(q) ||
      (e.name || '').toLowerCase().includes(q) ||
      (e.abstract || '').toLowerCase().includes(q) ||
      (Array.isArray(e.tags) && e.tags.join(' ').toLowerCase().includes(q))
    );
  }

  const total = filtered.length;
  const slice = filtered.slice(offset, offset + limit);
  return json({
    domain,
    total,
    limit,
    offset,
    hasMore: offset + limit < total,
    nextOffset: offset + limit < total ? offset + limit : null,
    entities: slice,
  });
}

async function handleEntityById(id, url, env) {
  const domain = url.searchParams.get('domain') || '';
  if (!domain || !DOMAINS.includes(domain)) {
    return json({ error: 'unknown_domain', message: 'domain query param required', available: DOMAINS }, 404);
  }
  let all;
  try { all = await fetchEntities(domain, env); }
  catch (e) { return json({ error: 'upstream_unreachable', message: String(e.message || e) }, 502); }
  const found = all.find(e => e.id === id);
  if (!found) return json({ error: 'not_found', message: `entity "${id}" not in ${domain}` }, 404);
  return json({ domain, entity: found });
}

// ---------- 主入口 ----------

async function handleRequest(request) {
  const env = getEnv();
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS 预检（外部项目跨域调用）
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Gateway-Client',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  const CORS = { 'Access-Control-Allow-Origin': '*', 'X-Gateway-Service': 'swarm-labs-gateway' };

  // 免鉴权
  if (path === '/api/v1/health' || path === '/health') {
    return json(handleHealth(), 200, CORS);
  }

  // 以下端点必须携带 slb_ key
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return json({ error: 'unauthorized', message: '需要 Authorization: Bearer slb_<key>' }, 401, CORS);
  }
  const v = await validateGatewayKey(token, env);
  if (!v.ok) {
    const msg = {
      server_misconfigured: '网关未配置密钥',
      invalid_prefix: 'Key 必须以 slb_ 开头',
      invalid_format: 'Key 格式无效',
      bad_signature: 'Key 签名验证失败',
      bad_payload: 'Key 负载无效',
      expired: 'Key 已过期',
      revoked: 'Key 已被吊销',
    };
    return json({ error: 'forbidden', message: msg[v.error] || 'Key 校验失败' }, 403, CORS);
  }

  // 限流
  const rl = await checkRate(env, v.client);
  if (!rl.allowed) {
    return json({ error: 'rate_limited', message: `每 key 每分钟 ${env.GW_QUOTA_PER_MIN || DEFAULT_QUOTA_PER_MIN} 次上限` }, 429, { ...CORS, 'Retry-After': '60' });
  }

  const headers = {
    ...CORS,
    'X-Gateway-Client': v.client,
    'X-Gateway-Tier': 'partner',
  };

  // 路由分发
  try {
    if (path === '/api/v1/domains') {
      if (!hasScope(v.scopes, 'domains:read')) return json({ error: 'forbidden', message: '缺少 domains:read scope' }, 403, headers);
      return json(await handleDomains(env), 200, headers);
    }
    if (path === '/api/v1/entities') {
      if (!hasScope(v.scopes, 'entities:read')) return json({ error: 'forbidden', message: '缺少 entities:read scope' }, 403, headers);
      return json(await handleEntities(url, env), 200, headers);
    }
    const m = path.match(/^\/api\/v1\/entities\/([^/?]+)$/);
    if (m) {
      if (!hasScope(v.scopes, 'entities:read')) return json({ error: 'forbidden', message: '缺少 entities:read scope' }, 403, headers);
      const id = decodeURIComponent(m[1]);
      return json(await handleEntityById(id, url, env), 200, headers);
    }
    return json({ error: 'not_found', message: `未知路径 ${path}` }, 404, headers);
  } catch (e) {
    return json({ error: 'internal', message: String(e.message || e) }, 500, headers);
  }
}

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});
