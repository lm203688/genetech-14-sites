/**
 * SwarmLabs Data Gateway — 数据需求 intake 端点
 * --------------------------------------------------------------------------
 * 为下游独立项目（蜂群科研数据 / RoboParts / AIShield / 付费客户）提供
 * 结构化数据需求提交与查询接口，写入 state/data-requests.json。
 *
 * 新增端点：
 *   POST /api/v1/requests         — 提交数据需求（免鉴权，记录 project_name/contact）
 *   GET  /api/v1/requests          — 查询需求列表（需 slb_ key，或 anonymous 限 20 条）
 *   GET  /api/v1/requests/:id      — 查询单个需求详情
 *   POST /api/v1/requests/:id/fulfill   — 标记需求为 fulfilled（仅 admin key，预留）
 *
 * 数据落点：state/data-requests.json（与 MCP server 的 submit_request/retrieve_requests 共享）
 */

const DEFAULT_QUOTA_PER_MIN = 120;
const DEFAULT_UPSTREAM = 'https://lm203688.github.io/genetech-14-sites';
const REQUESTS_FILE = 'data/data-requests.json'; // 相对路径，部署时指向仓库根

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
    ADMIN_KEY: typeof ADMIN_KEY !== 'undefined' ? ADMIN_KEY : undefined,
  };
}

function json(data, status, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

// ---------- Key 校验（复用 gateway 原有逻辑）----------
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
  if (env.GW_KV) {
    try {
      const revoked = await env.GW_KV.get(`revoked:${payload.client}`);
      if (revoked) return { ok: false, error: 'revoked' };
    } catch { /* ignore */ }
  }
  return { ok: true, client: payload.client, scopes: payload.scopes || [], quota: payload.quota };
}

function hasScope(scopes, required) {
  if (!Array.isArray(scopes) || scopes.length === 0) return false;
  return scopes.includes(required);
}

// ---------- requests.json 读写 ----------
async function readRequests() {
  try {
    const resp = await fetch(`${DEFAULT_UPSTREAM}/${REQUESTS_FILE}`);
    if (!resp.ok) return [];
    return await resp.json();
  } catch { return []; }
}

async function writeRequests(reqs) {
  // 通过 CF Pages Functions 或直接写 KV；此处采用 KV 持久化
  if (typeof GW_KV !== 'undefined' && GW_KV) {
    await GW_KV.put('data-requests', JSON.stringify(reqs.slice(0, 300)), { expirationTtl: 86400 * 7 });
  }
}

function genRequestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `req_${hex.slice(0, 8)}_${hex.slice(8)}`;
}

function specFingerprint(spec) {
  const parts = [
    (spec.domains || []).join(','),
    (spec.keywords || []).join(','),
    spec.time_range?.from || '',
    spec.time_range?.to || '',
    String(spec.min_confidence || 0.5),
    String(spec.target_count || 50),
  ].join('|');
  return new TextEncoder().encode(parts).toString('base64').slice(0, 32);
}

// ---------- 端点处理 ----------

async function handlePostRequests(body, env) {
  try {
    const { project_name, contact, purpose, priority = 'medium', spec } = body;
    if (!project_name || !contact || !purpose || !spec) {
      return json({ ok: false, error: 'missing_required_fields', message: '必填字段：project_name, contact, purpose, spec' }, 400);
    }
    const validPriorities = ['low', 'medium', 'high', 'urgent'];
    if (!validPriorities.includes(priority)) {
      return json({ ok: false, error: 'invalid_priority' }, 400);
    }

    let reqs = await readRequests();
    const fp = specFingerprint(spec);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const dup = reqs.find(r =>
      r._fingerprint === fp &&
      r.submitted_at >= sevenDaysAgo &&
      r.project_name === project_name
    );
    if (dup) {
      return json({
        ok: false, error: 'duplicate_request',
        message: '7 天内已有相同规格的需求',
        existing_request_id: dup.request_id
      }, 409);
    }

    const entry = {
      request_id: genRequestId(),
      submitted_at: new Date().toISOString(),
      submitted_by: contact,
      project_name,
      project_type: 'consumer',
      status: 'pending_review',
      priority,
      purpose,
      spec,
      delivery_preference: spec.delivery_preference || 'pull',
      assigned_key: null,
      fulfilled_at: null,
      fulfillment_notes: null,
      export_url: null,
      rejection_reason: null,
      _fingerprint: fp,
    };

    reqs.unshift(entry);
    await writeRequests(reqs);

    return json({
      ok: true,
      request_id: entry.request_id,
      status: entry.status,
      message: '需求已提交，等待管理员审批',
    }, 201);
  } catch (e) {
    return json({ ok: false, error: 'internal', message: String(e.message) }, 500);
  }
}

async function handleGetRequests(url, env) {
  try {
    let reqs = await readRequests();

    // 匿名查询最多 20 条
    let limit = parseInt(url.searchParams.get('limit') || '20', 10);
    limit = Math.min(Math.max(limit, 1), 100);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

    const statusFilter = url.searchParams.get('status');
    const projectFilter = url.searchParams.get('project');

    if (statusFilter) reqs = reqs.filter(r => r.status === statusFilter);
    if (projectFilter) reqs = reqs.filter(r => r.project_name === projectFilter);

    const total = reqs.length;
    const page = reqs.slice(offset, offset + limit);
    // 去掉内部字段后返回
    const safe = page.map(({ _fingerprint, ...rest }) => rest);

    const byStatus = {};
    const byPriority = {};
    const byProject = {};
    for (const r of reqs) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      byPriority[r.priority] = (byPriority[r.priority] || 0) + 1;
      byProject[r.project_name] = (byProject[r.project_name] || 0) + 1;
    }

    return json({
      ok: true, total, returned: safe.length, offset, limit,
      summary: { byStatus, byPriority, byProject },
      requests: safe,
    });
  } catch (e) {
    return json({ ok: false, error: 'internal', message: String(e.message) }, 500);
  }
}

async function handleGetRequestById(requestId, env) {
  try {
    const reqs = await readRequests();
    const req = reqs.find(r => r.request_id === requestId);
    if (!req) {
      return json({ ok: false, error: 'not_found', message: `需求 ${requestId} 不存在` }, 404);
    }
    const { _fingerprint, ...safe } = req;
    return json({ ok: true, request: safe });
  } catch (e) {
    return json({ ok: false, error: 'internal', message: String(e.message) }, 500);
  }
}

// ---------- 主入口 ----------

async function handleRequest(request) {
  const env = getEnv();
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Gateway-Client',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  const CORS = { 'Access-Control-Allow-Origin': '*', 'X-Gateway-Service': 'swarm-labs-gateway' };

  // 免鉴权端点
  if (path === '/api/v1/health' || path === '/health') {
    return json({ ok: true, service: 'swarm-labs-gateway', version: '1.1.0', endpoints: ['health','domains','entities','requests'] }, 200, CORS);
  }

  // ---- /api/v1/requests ----
  if (path === '/api/v1/requests') {
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400, CORS); }
      return await handlePostRequests(body, env);
    }
    if (request.method === 'GET') {
      return await handleGetRequests(url, env);
    }
    return json({ error: 'method_not_allowed' }, 405, CORS);
  }

  // ---- /api/v1/requests/:id ----
  const reqMatch = path.match(/^\/api\/v1\/requests\/([^/?]+)$/);
  if (reqMatch) {
    const id = decodeURIComponent(reqMatch[1]);
    if (request.method === 'GET') {
      return await handleGetRequestById(id, env);
    }
    if (request.method === 'POST') {
      // 预留：fulfill / reject 操作
      return json({ ok: false, error: 'not_implemented_yet', message: 'fulfill/reject 端点待实现' }, 501, CORS);
    }
    return json({ error: 'method_not_allowed' }, 405, CORS);
  }

  // 原有端点（domains, entities）
  if (path === '/api/v1/domains') {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const v = await validateGatewayKey(token, env);
    if (!v.ok) return json({ error: 'forbidden', message: '需要 slb_ key' }, 403, CORS);
    if (!hasScope(v.scopes, 'domains:read')) return json({ error: 'forbidden', message: '缺少 domains:read scope' }, 403, { ...CORS, 'X-Gateway-Client': v.client });
    return json({ count: DOMAINS.length, domains: DOMAINS, per_domain_entities: 10000, total_entities: DOMAINS.length * 10000 }, 200, { ...CORS, 'X-Gateway-Client': v.client });
  }

  if (path === '/api/v1/entities') {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const v = await validateGatewayKey(token, env);
    if (!v.ok) return json({ error: 'forbidden', message: '需要 slb_ key' }, 403, CORS);
    if (!hasScope(v.scopes, 'entities:read')) return json({ error: 'forbidden', message: '缺少 entities:read scope' }, 403, { ...CORS, 'X-Gateway-Client': v.client });
    // 复用原有 entities 逻辑
    const domain = url.searchParams.get('domain') || '';
    if (!domain) return json({ error: 'bad_request', message: 'domain query param required' }, 400, { ...CORS, 'X-Gateway-Client': v.client });
    if (!DOMAINS.includes(domain)) return json({ error: 'unknown_domain', message: `domain "${domain}" not found`, available: DOMAINS }, 404, { ...CORS, 'X-Gateway-Client': v.client });
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 500);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const upstream = (env.GATEWAY_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/+$/, '');
    const entitiesUrl = `${upstream}/${domain}/website/api/entities.json`;
    try {
      const res = await fetch(entitiesUrl);
      if (!res.ok) throw new Error(`upstream_${res.status}`);
      const data = await res.json();
      const all = Array.isArray(data) ? data : (data.entities || []);
      let filtered = all;
      if (q) filtered = all.filter(e =>
        (e.id || '').toLowerCase().includes(q) ||
        (e.name || '').toLowerCase().includes(q) ||
        (e.abstract || '').toLowerCase().includes(q) ||
        (Array.isArray(e.tags) && e.tags.join(' ').toLowerCase().includes(q))
      );
      const slice = filtered.slice(offset, offset + limit);
      return json({ domain, total: filtered.length, limit, offset, hasMore: offset + limit < filtered.length, nextOffset: offset + limit < filtered.length ? offset + limit : null, entities: slice }, 200, { ...CORS, 'X-Gateway-Client': v.client });
    } catch (e) {
      return json({ error: 'upstream_unreachable', message: String(e.message) }, 502, { ...CORS, 'X-Gateway-Client': v.client });
    }
  }

  const entityMatch = path.match(/^\/api\/v1\/entities\/([^/?]+)$/);
  if (entityMatch) {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    const v = await validateGatewayKey(token, env);
    if (!v.ok) return json({ error: 'forbidden', message: '需要 slb_ key' }, 403, CORS);
    if (!hasScope(v.scopes, 'entities:read')) return json({ error: 'forbidden', message: '缺少 entities:read scope' }, 403, { ...CORS, 'X-Gateway-Client': v.client });
    const id = decodeURIComponent(entityMatch[1]);
    const domain = url.searchParams.get('domain') || '';
    if (!domain || !DOMAINS.includes(domain)) return json({ error: 'unknown_domain', message: 'domain query param required', available: DOMAINS }, 404, { ...CORS, 'X-Gateway-Client': v.client });
    const upstream = (env.GATEWAY_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/+$/, '');
    try {
      const res = await fetch(`${upstream}/${domain}/website/api/entities.json`);
      if (!res.ok) throw new Error(`upstream_${res.status}`);
      const data = await res.json();
      const all = Array.isArray(data) ? data : (data.entities || []);
      const found = all.find(e => e.id === id);
      if (!found) return json({ error: 'not_found', message: `entity "${id}" not in ${domain}` }, 404, { ...CORS, 'X-Gateway-Client': v.client });
      return json({ domain, entity: found }, 200, { ...CORS, 'X-Gateway-Client': v.client });
    } catch (e) {
      return json({ error: 'upstream_unreachable', message: String(e.message) }, 502, { ...CORS, 'X-Gateway-Client': v.client });
    }
  }

  return json({ error: 'not_found', message: `未知路径 ${path}` }, 404, CORS);
}

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});
