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
const UPSTREAM_BASE = 'https://data.swarmlabs.tools';

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
    INTEL_KV: typeof INTEL_KV !== 'undefined' ? INTEL_KV : undefined,
    INTEL_ADMIN_KEY: typeof INTEL_ADMIN_KEY !== 'undefined' ? INTEL_ADMIN_KEY : null,
  };
}

// Admin fallback（仅用于 /v1/intel/consumer/create 和 list）。生产建议通过 CF Secret 覆盖。
const INTEL_ADMIN_FALLBACK = 'gtk-intel-admin-3f7b9e2a1c4d8f5e';

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
  // 接受完整 token（含 gtk_ 前缀）或裸 payload.sig
  const bare = token.replace(/^gtk_/, '');
  const parts = bare.split('.');
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

const SEARCH_INDEX_URL = `${UPSTREAM_BASE}/data/search-index.json`;
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
    const res = await fetch(SEARCH_INDEX_URL, { signal: AbortSignal.timeout(30000) });
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
// Intel API (Sprint 1)：共享情报服务
// 职责：消费方提交 DemandSpec → 引擎匹配现有 30 站索引 → 返回结构化结果
// 鉴权：Pro Key（gtk_ 前缀），/v1/intel/health 免鉴权
// 存储：INTEL_KV 优先；未绑定时降级到 memory（单实例、重启丢失）
// ---------------------------------------------------------------------------

const INTEL_KEY_PREFIX = 'intel:demand:';
const INTEL_LIST_PREFIX = 'intel:list:';
const INTEL_DEMAND_TTL = 60 * 60 * 24 * 30; // 30 天
const INTEL_LIST_TTL = 60 * 60 * 24 * 90;   // 90 天
const INTEL_MEMORY_FALLBACK = new Map();

// Consumer Key (ckn_) —— 独立于站点 Pro Key (gtk_)，只用于 /v1/intel/* 端点
// 格式：ckn_<base64urlPayload>.<hexHmac>
// payload = { cid: consumer_id, tier, exp, rate }
const INTEL_CONSUMER_PREFIX = 'intel:consumer:';
const INTEL_CONSUMER_TTL = 60 * 60 * 24 * 365; // 1 年
const INTEL_ADMIN_PREFIX = 'intel:admin:';
const INTEL_CONSUMER_KEY_PREFIX = 'ckn_';

function genConsumerId() {
  const r = (crypto.getRandomValues(new Uint8Array(6)) || new Uint8Array(6));
  return 'csm_' + Array.from(r).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signConsumerKey(env, payload) {
  const p = JSON.stringify(payload);
  const pB64 = btoa(p).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const sig = await hmacSign(pB64, env.PRO_SECRET);
  return INTEL_CONSUMER_KEY_PREFIX + pB64 + '.' + sig;
}

async function validateConsumerKey(token, env) {
  if (!env.PRO_SECRET || !token) return { ok: false, error: 'server_misconfigured' };
  if (!token.startsWith(INTEL_CONSUMER_KEY_PREFIX)) return { ok: false, error: 'invalid_format' };
  const parts = token.slice(INTEL_CONSUMER_KEY_PREFIX.length).split('.');
  if (parts.length !== 2) return { ok: false, error: 'invalid_format' };
  const [pB64, sig] = parts;
  const expected = await hmacSign(pB64, env.PRO_SECRET);
  if (!constantTimeEqual(expected, sig)) return { ok: false, error: 'bad_signature' };
  let payload;
  try {
    const padded = pB64.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (padded.length % 4)) % 4;
    payload = JSON.parse(atob(padded + '='.repeat(pad)));
  } catch {
    return { ok: false, error: 'bad_payload' };
  }
  if (!payload.exp || Date.now() > payload.exp) return { ok: false, error: 'expired' };
  return { ok: true, ...payload };
}

function getIntelStore(env) {
  // 优先级：INTEL_KV > PRO_KV（用 intel: 前缀避免与 rate limit key 冲突） > memory fallback
  if (env.INTEL_KV) return env.INTEL_KV;
  if (env.PRO_KV) return env.PRO_KV;
  return {
    get: async (k) => INTEL_MEMORY_FALLBACK.get(k) || null,
    put: async (k, v) => { INTEL_MEMORY_FALLBACK.set(k, v); },
    delete: async (k) => { INTEL_MEMORY_FALLBACK.delete(k); },
  };
}

function parseWindowDays(w) {
  if (!w) return 30;
  const m = String(w).match(/^(\d+)\s*d$/);
  return m ? Math.min(parseInt(m[1], 10), 365) : 30;
}

function genDemandId() {
  return 'dm_' + Date.now().toString(16) + '_' + Math.random().toString(16).slice(2, 10);
}

function searchEntities(index, spec) {
  const { sites, keywords = [], sources = [], minConfidence = 0, maxEntities = 500 } = spec || {};
  const kwTokens = keywords.flatMap((k) => tokenize(String(k)));
  if (kwTokens.length === 0) return [];
  const cap = Math.min(parseInt(maxEntities, 10) || 500, 5000);

  const matches = [];
  for (const e of index.entities || []) {
    if (sites && !sites.includes(e.site)) continue;
    if (sources.length && e.source && !sources.includes(e.source)) continue;
    if ((e.confidence || 0) < (minConfidence || 0)) continue;

    const nameTokens = new Set(tokenize(e.name));
    const tagTokens = new Set((e.tags || []).flatMap((t) => tokenize(t)));
    const snippetTokens = new Set(tokenize(e.snippet));
    let hits = 0;
    for (const qt of kwTokens) {
      if (nameTokens.has(qt)) hits += 3;
      else if (tagTokens.has(qt)) hits += 2;
      else if (snippetTokens.has(qt)) hits += 1;
    }
    if (hits === 0) continue;

    const coverage = hits / (kwTokens.length * 3);
    const score = coverage * 0.7 + (e.confidence || 0) * 0.3;
    matches.push({
      id: e.id, name: e.name, site: e.site, source: e.source,
      url: e.url, snippet: e.snippet, tags: e.tags,
      publishedDate: e.publishedDate, confidence: e.confidence,
      score: Math.round(score * 10000) / 10000,
    });
  }
  matches.sort((a, b) => b.score - a.score || (b.confidence || 0) - (a.confidence || 0));
  return matches.slice(0, cap);
}

async function handleIntelDemandPost(request, env, identity) {
  try {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'bad_request', message: 'Body 必须是 JSON' }, 400); }

  const consumer = (body.consumer || '').toString().trim();
  if (!consumer) return json({ error: 'bad_request', message: 'consumer 字段必填（消费方标识）' }, 400);

  const q = body.query || {};
  const delivery = body.delivery || {};
  const mode = ['pull', 'push', 'subscribe'].includes(delivery.mode) ? delivery.mode : 'pull';
  const timeWindowDays = parseWindowDays(q.time_window);

  const index = await getSearchIndex(request);
  const coverage = index
    ? { local: true, entityCount: index.totalEntities, generatedAt: index.generatedAt, sourceSites: index.sourceSites }
    : { local: false, reason: '搜索索引暂不可用' };

  let results = null;
  const started = Date.now();
  if (index) {
    try {
      const matches = searchEntities(index, {
        sites: q.sites,
        keywords: q.keywords,
        sources: q.sources,
        minConfidence: q.min_confidence || 0,
        maxEntities: q.max_entities || 500,
      });
      results = { matches, total: matches.length, scanned: index.totalEntities, elapsedMs: Date.now() - started };
    } catch (e) {
      results = { error: e && e.message ? e.message : String(e) };
    }
  }

  const demand = {
    id: genDemandId(),
    consumer,
    priority: ['high', 'medium', 'low'].includes(body.priority) ? body.priority : 'medium',
    query: { ...q, time_window_days: timeWindowDays },
    delivery: { ...delivery, mode },
    coverage,
    results,
    status: results && results.matches ? 'completed' : 'index_unavailable',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const store = getIntelStore(env);
  let persisted = false;
  try {
    await store.put(INTEL_KEY_PREFIX + demand.id, JSON.stringify(demand), { expirationTtl: INTEL_DEMAND_TTL });
    persisted = true;
    const listKey = INTEL_LIST_PREFIX + consumer;
    const listRaw = await store.get(listKey);
    const list = listRaw ? JSON.parse(listRaw) : { consumer, count: 0, recent: [] };
    list.recent = [demand.id, ...(list.recent || [])].slice(0, 50);
    list.count = (list.count || 0) + 1;
    list.updated_at = new Date().toISOString();
    await store.put(listKey, JSON.stringify(list), { expirationTtl: INTEL_LIST_TTL });
  } catch (e) {
    // KV 写入失败：降级到 memory fallback（跨实例不可见，但同一实例可查）
    console.log(`[intel] KV put failed (${e.message}), falling back to memory`);
    try {
      INTEL_MEMORY_FALLBACK.set(INTEL_KEY_PREFIX + demand.id, JSON.stringify(demand));
      const listKey = INTEL_LIST_PREFIX + consumer;
      const listRaw = INTEL_MEMORY_FALLBACK.get(listKey);
      const list = listRaw ? JSON.parse(listRaw) : { consumer, count: 0, recent: [] };
      list.recent = [demand.id, ...(list.recent || [])].slice(0, 50);
      list.count = (list.count || 0) + 1;
      list.updated_at = new Date().toISOString();
      INTEL_MEMORY_FALLBACK.set(listKey, JSON.stringify(list));
    } catch {}
  }

  if (persisted) {
    return json({
      demand_id: demand.id,
      status: demand.status,
      coverage: demand.coverage,
      results_preview: results && results.matches ? results.matches.slice(0, 5) : null,
      results_total: results && results.total ? results.total : 0,
      delivery_mode: mode,
      created_at: demand.created_at,
      _full_demand: demand,
      _next: {
        fetch_full: `https://api.swarmlabs.tools/v1/intel/demand/${demand.id}`,
        note: '完整结果通过 GET 拉取（pull 模式）；push/subscribe 模式 Sprint 2 上线。若 GET 404，用 _full_demand 本地保存。',
      },
    }, 200);
  }

  // KV 不可用：降级为无持久化模式，结果直接返回
  return json({
    demand_id: demand.id,
    status: demand.status,
    coverage: demand.coverage,
    results: results && results.matches ? results.matches.slice(0, 200) : null,
    results_total: results && results.total ? results.total : 0,
    delivery_mode: mode,
    created_at: demand.created_at,
    _full_demand: demand,
    _persistence: 'memory_only',
    _note: '存储暂不可用（PRO_KV 日写入限额）。本次结果已直接返回。GET demand/{id} 可能 404——请用 _full_demand 本地持久化。Sprint 2 引入外部状态文件解决。',
  }, 200);
  } catch (e) {
    return json({ error: 'internal_error', message: 'Intel demand 处理失败：' + (e && e.message ? e.message : String(e)), stack: e && e.stack ? String(e.stack).slice(0, 500) : null }, 500);
  }
}

async function handleIntelDemandGet(env, demandId) {
  if (!demandId || !/^[a-f0-9_]+$/.test(demandId)) {
    return json({ error: 'bad_request', message: 'demand_id 格式无效' }, 400);
  }
  const store = getIntelStore(env);
  const raw = await store.get(INTEL_KEY_PREFIX + demandId);
  if (!raw) {
    // 检查 memory fallback 是否有（跨实例可能丢失）
    const memRaw = INTEL_MEMORY_FALLBACK.get(INTEL_KEY_PREFIX + demandId);
    if (memRaw) {
      try { return json(JSON.parse(memRaw), 200); } catch {}
    }
    return json({
      error: 'not_found',
      message: `demand ${demandId} 不存在或已过期`,
      _hint: 'Sprint 1 存储限于单 Worker 实例 memory。如果 POST 之后 Worker 实例重启/迁移，GET 会 404。请改用 POST 响应里的 _full_demand 字段做本地持久化。Sprint 2 将引入外部状态文件。',
    }, 404);
  }
  try { return json(JSON.parse(raw), 200); }
  catch { return json({ error: 'corrupted', message: 'demand 记录损坏' }, 500); }
}

// Admin only: dump 当前 memory 状态，用于 Sprint 2 外部持久化
async function handleIntelAdminState(env, adminToken) {
  const demands = [];
  const lists = [];
  const consumers = [];
  for (const [k, v] of INTEL_MEMORY_FALLBACK) {
    try {
      if (k.startsWith(INTEL_KEY_PREFIX)) {
        const d = JSON.parse(v);
        demands.push({ id: d.id, consumer: d.consumer, status: d.status, created_at: d.created_at, results_total: d.results?.total || 0 });
      } else if (k.startsWith(INTEL_LIST_PREFIX)) {
        const l = JSON.parse(v);
        lists.push({ consumer: l.consumer, count: l.count, recent: (l.recent || []).slice(0, 10) });
      } else if (k.startsWith(INTEL_CONSUMER_PREFIX)) {
        const c = JSON.parse(v);
        consumers.push({ cid: c.cid, project_name: c.project_name, tier: c.tier, has_key: !!c.key, created_at: c.created_at });
      }
    } catch {}
  }
  return json({
    admin: (adminToken || '').slice(0, 12),
    timestamp: new Date().toISOString(),
    demands: demands,
    consumer_lists: lists,
    consumers: consumers,
    counts: { demands: demands.length, lists: lists.length, consumers: consumers.length },
    _storage: env.PRO_KV ? 'memory_only_kv_quota_exhausted' : 'memory_only_no_kv',
  }, 200);
}

// ---------------------------------------------------------------------------
// 主处理器
// ---------------------------------------------------------------------------

// ============ Consumer Application (申请 → 派 Key) ============

async function handleIntelApply(request, env) {
  try {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'bad_request', message: 'Body 必须是 JSON' }, 400); }

    const name = (body.project_name || body.project || '').toString().trim();
    const owner = (body.contact || body.owner || '').toString().trim();
    const purpose = (body.purpose || body.use_case || '').toString().trim();
    if (!name || !owner || !purpose) {
      return json({ error: 'bad_request', message: 'project_name / contact / purpose 三项必填' }, 400);
    }

    const cid = genConsumerId();
    const exp = Date.now() + 365 * 86400 * 1000;
    const application = {
      id: cid,
      project_name: name,
      contact: owner,
      purpose,
      priority: ['high', 'medium', 'low'].includes(body.priority) ? body.priority : 'medium',
      status: 'pending_review',
      created_at: new Date().toISOString(),
      _next: {
        message: '申请已登记，等待管理员分配 consumer key',
        hint: '把这份 application JSON 发给管理员（GitHub issue / 邮件），管理员用 POST /v1/intel/consumer/create 生成 key',
      },
    };

    // 尝试写入 KV（限额可能失败，降级到 memory）
    const store = getIntelStore(env);
    let persisted = false;
    try {
      await store.put(INTEL_CONSUMER_PREFIX + cid, JSON.stringify({
        ...application,
        application_body: body,
      }), { expirationTtl: INTEL_CONSUMER_TTL });
      persisted = true;
    } catch (e) {
      console.log(`[intel:apply] KV put failed (${e.message}), falling back to memory`);
      try {
        INTEL_MEMORY_FALLBACK.set(INTEL_CONSUMER_PREFIX + cid, JSON.stringify({ ...application, application_body: body }));
      } catch {}
    }

    return json({
      application_id: cid,
      status: 'pending_review',
      persisted,
      _note: persisted
        ? '申请已入库，等待管理员派 Key'
        : '申请已受理，但 KV 存储临时不可用（日写入限额）；application_id 仍可用，请管理员凭 application_id + application JSON 派 Key',
    }, 201);
  } catch (e) {
    return json({ error: 'internal_error', message: '申请处理失败：' + (e && e.message ? e.message : String(e)) }, 500);
  }
}

async function handleIntelVerify(request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json({ error: 'unauthorized', message: '需要 Authorization: Bearer <ckn_ 或 gtk_ key>' }, 401);

  // 优先尝试 consumer key
  if (token.startsWith(INTEL_CONSUMER_KEY_PREFIX)) {
    const v = await validateConsumerKey(token, getEnv());
    if (v.ok) {
      return json({
        valid: true, key_type: 'consumer', cid: v.cid, tier: v.tier,
        consumer_name: v.name, expires_at: new Date(v.exp).toISOString(),
        rate_per_min: v.rate,
      }, 200);
    }
    return json({ valid: false, key_type: 'consumer', error: v.error }, 401);
  }

  // 回退到 Pro Key：完整传 token（含 gtk_ 前缀），validateProKeyLocal 内部会 split
  const v = await validateProKey(token, '', getEnv());
  if (v.ok) {
    return json({ valid: true, key_type: 'pro', site: v.site }, 200);
  }
  return json({ valid: false, key_type: 'pro', error: v.error }, 401);
}

// Admin only: 用 admin key 从 application 生成 consumer key
async function handleIntelCreateConsumer(request, env, adminToken) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'bad_request', message: 'Body 必须是 JSON' }, 400); }

  const cid = (body.application_id || '').toString().trim();
  const name = (body.project_name || '').toString().trim();
  const tier = ['free', 'pro', 'enterprise'].includes(body.tier) ? body.tier : 'pro';
  if (!cid || !name) {
    return json({ error: 'bad_request', message: 'application_id + project_name 必填' }, 400);
  }

  const rate = body.rate_per_min || (tier === 'enterprise' ? 600 : tier === 'pro' ? 120 : 30);
  const ttlDays = tier === 'enterprise' ? 365 : tier === 'pro' ? 180 : 30;
  const exp = Date.now() + ttlDays * 86400 * 1000;

  const payload = { cid, name, tier, exp, rate, admin: adminToken.slice(0, 12) };
  const key = await signConsumerKey(env, payload);

  const record = {
    cid, project_name: name, tier,
    rate_per_min: rate,
    created_at: new Date().toISOString(),
    expires_at: new Date(exp).toISOString(),
    application_body: body.application_body || null,
    created_by_admin: adminToken.slice(0, 12),
  };

  const store = getIntelStore(env);
  let persisted = false;
  try {
    await store.put(INTEL_CONSUMER_PREFIX + cid, JSON.stringify({ ...record, key }), { expirationTtl: INTEL_CONSUMER_TTL });
    persisted = true;
  } catch (e) {
    console.log(`[intel:create] KV put failed (${e.message}), falling back to memory`);
    try {
      INTEL_MEMORY_FALLBACK.set(INTEL_CONSUMER_PREFIX + cid, JSON.stringify({ ...record, key }));
    } catch {}
  }

  return json({
    application_id: cid,
    consumer_key: key,
    tier,
    rate_per_min: rate,
    expires_at: record.expires_at,
    persisted,
    _note: persisted
      ? 'Consumer 已入库。请把 consumer_key 发给申请方，之后所有 /v1/intel/* 请求用 Authorization: Bearer <consumer_key>'
      : 'Consumer 已签发。KV 存储暂不可用（日写入限额），但 key 可直接使用——档案会由 memory fallback 保存（单实例）',
  }, 200);
}

async function handleIntelListConsumers(env, adminToken) {
  const store = getIntelStore(env);
  if (!store || typeof store.list !== 'function') {
    return json({
      admin: (adminToken || '').slice(0, 12),
      consumers: [],
      count: 0,
      _note: 'KV list() 不可用（memory fallback）。用 GET /v1/intel/consumer/{cid} 单点查询。',
    }, 200);
  }
  try {
    const res = await store.list({ prefix: INTEL_CONSUMER_PREFIX });
    const items = (res && Array.isArray(res.list)) ? res.list : (Array.isArray(res) ? res : []);
    const out = [];
    for (const item of items) {
      try {
        const r = JSON.parse(item.value);
        out.push({
          cid: r.cid, project_name: r.project_name, tier: r.tier,
          created_at: r.created_at, expires_at: r.expires_at,
          has_key: !!r.key,
        });
      } catch { /* skip */ }
    }
    return json({ admin: (adminToken || '').slice(0, 12), consumers: out, count: out.length }, 200);
  } catch (e) {
    return json({ error: 'list_failed', message: e.message, admin: (adminToken || '').slice(0, 12) }, 500);
  }
}

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

  // ---- Intel API (Sprint 1)：共享情报服务，独立路由 ----
  if (path.startsWith('/v1/intel/')) {
    if (path === '/v1/intel/health') {
      return json({
        status: 'ok',
        service: 'GeneTech Intel API',
        version: '1.0.0-sprint1.1',
        endpoints: {
          apply: 'POST /v1/intel/apply (免鉴权，登记申请)',
          verify: 'GET /v1/intel/verify (免鉴权，验 key)',
          demand: 'POST /v1/intel/demand (需 ckn_ 或 gtk_)',
          demandGet: 'GET /v1/intel/demand/{id} (需 ckn_ 或 gtk_)',
          adminCreate: 'POST /v1/intel/consumer/create (需 admin key)',
          adminList: 'GET /v1/intel/consumer (需 admin key)',
          adminState: 'GET /v1/intel/admin/state (需 admin key，导出 memory 状态)',
        },
        auth: 'Consumer Key (ckn_) 或 Pro Key (gtk_)；admin key 仅用于 consumer 管理端点',
        storage: 'PRO_KV (日写入限额) + memory fallback. POST 响应含 _full_demand 字段，消费方应自行持久化。',
      }, 200);
    }

    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();

    // 免鉴权：申请入口（任何项目都可以登记）
    if (path === '/v1/intel/apply') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed', message: '仅支持 POST' }, 405);
      return handleIntelApply(request, env);
    }
    // 免鉴权：Key 验真（消费方自检用）
    if (path === '/v1/intel/verify') {
      return handleIntelVerify(request);
    }
    // Admin only：从申请生成 consumer key / 列出所有 consumer
    if (path === '/v1/intel/consumer/create') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed', message: '仅支持 POST' }, 405);
      const adminKey = env.INTEL_ADMIN_KEY || INTEL_ADMIN_FALLBACK;
      if (!token || token !== adminKey) {
        return json({ error: 'forbidden', message: '需要 admin key（X-Admin-Key 或 Authorization: Bearer <admin_key>）' }, 403);
      }
      const xAdmin = request.headers.get('X-Admin-Key') || '';
      const finalAdmin = (xAdmin || token) === adminKey ? adminKey : '';
      return handleIntelCreateConsumer(request, env, finalAdmin);
    }
    if (path === '/v1/intel/consumer') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed', message: '仅支持 GET' }, 405);
      const adminKey = env.INTEL_ADMIN_KEY || INTEL_ADMIN_FALLBACK;
      if (!token || token !== adminKey) {
        return json({ error: 'forbidden', message: '需要 admin key' }, 403);
      }
      return handleIntelListConsumers(env, token);
    }
    // Admin only：导出当前 memory 状态（供 Sprint 2 外部持久化脚本消费）
    if (path === '/v1/intel/admin/state') {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed', message: '仅支持 GET' }, 405);
      const adminKey = env.INTEL_ADMIN_KEY || INTEL_ADMIN_FALLBACK;
      if (!token || token !== adminKey) {
        return json({ error: 'forbidden', message: '需要 admin key' }, 403);
      }
      return handleIntelAdminState(env, token);
    }

    // 数据端点：接受 consumer key (ckn_) 或 Pro Key (gtk_)
    if (!token) return json({ error: 'unauthorized', message: 'Intel API 需要 Consumer Key (ckn_...) 或 Pro Key (gtk_...)' }, 401);

    let identity;
    if (token.startsWith(INTEL_CONSUMER_KEY_PREFIX)) {
      const v = await validateConsumerKey(token, env);
      if (!v.ok) {
        const msg = { invalid_format: 'Key 格式无效', bad_signature: 'Key 签名验证失败', expired: 'Key 已过期', bad_payload: 'Key 负载无效', server_misconfigured: '服务端未配置' };
        return json({ error: 'forbidden', detail: v.error, message: msg[v.error] || 'Consumer Key 校验失败' }, 403);
      }
      identity = { type: 'consumer', cid: v.cid, tier: v.tier, name: v.name };
    } else {
      // Pro Key：validateProKeyLocal 期望完整 token（含 gtk_ 前缀，HMAC 覆盖完整字符串）
      const v = await validateProKey(token, '', env);
      if (!v.ok) {
        const msg = { invalid_format: 'Key 格式无效', bad_signature: 'Key 签名验证失败', expired: 'Key 已过期', bad_payload: 'Key 负载无效', remote_unreachable: '许可证服务不可达', server_misconfigured: '服务端未配置' };
        return json({ error: 'forbidden', detail: v.error, message: msg[v.error] || 'Pro Key 校验失败' }, 403);
      }
      identity = { type: 'pro', site: v.site };
    }

    if (path === '/v1/intel/demand') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed', message: '仅支持 POST' }, 405);
      return handleIntelDemandPost(request, env, identity);
    }
    const m = path.match(/^\/v1\/intel\/demand\/([a-f0-9_]+)$/);
    if (m && request.method === 'GET') return handleIntelDemandGet(env, m[1], identity);
    return json({ error: 'not_found', message: `Intel 端点 ${path} 不存在` }, 404);
  }

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
    const proxyUrl = new URL(path + url.search, UPSTREAM_BASE);
    return fetch(new Request(proxyUrl, { method: request.method, headers: req.headers }));
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
      const newUrl = new URL(targetPath + url.search, UPSTREAM_BASE);
      const proxyReq = new Request(newUrl, { method: request.method, headers: req.headers });
      proxyReq.headers.set('X-GeneTech-Tier', 'free');
      proxyReq.headers.set('X-GeneTech-OriginalPath', path);
      return fetch(proxyReq);
    }
    // 未映射的 /v1/* 路径返回 404（避免自指循环）
    if (path.startsWith('/v1/')) {
      return json({ error: 'not_found', message: `OpenAPI 端点 ${path} 不存在。可用端点：/v1/domains, /v1/entities, /v1/oss/registry, /v1/search/semantic, /v1/intel/demand` }, 404);
    }
    const upstreamUrl = new URL(path + url.search, UPSTREAM_BASE);
    const proxyReq = new Request(upstreamUrl, { method: request.method, headers: request.headers });
    proxyReq.headers.set('X-GeneTech-Tier', 'free');
    return fetch(proxyReq);
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

  // 根路径：欢迎页
  if (path === '/' || path === '') {
    return json({
      ok: true,
      service: 'genetech-api-guard',
      endpoints: ['/health', '/v1/domains', '/v1/entities', '/v1/oss/registry', '/v1/search/semantic', '/v1/intel/demand', '/v1/intel/health'],
      docs: 'https://data.swarmlabs.tools/',
      openapi: 'https://data.swarmlabs.tools/openapi.yaml',
    });
  }

  // 其他路径：转发到上游（避免自指循环）
  const upstreamUrl = new URL(path + url.search, UPSTREAM_BASE);
  return fetch(new Request(upstreamUrl, { method: request.method, headers: request.headers }));
}

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request).catch(async (err) => {
    const body = JSON.stringify({
      error: 'internal_error',
      message: err && err.message ? err.message : String(err),
      path: event.request.url,
      stack: err && err.stack ? String(err.stack).slice(0, 800) : null,
    });
    return new Response(body, { status: 500, headers: { 'Content-Type': 'application/json' } });
  }));
});
