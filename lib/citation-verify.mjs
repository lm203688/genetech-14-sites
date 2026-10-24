/**
 * lib/citation-verify.mjs — Citation Verification 独立端点共用逻辑
 * ============================================================================
 * P1-2 落地（2026-10-24）：把 MCP 的 verify_entity 能力抽成环境无关的
 * 独立函数，让两条通道消费同一实现：
 *   - MCP：mcp-server/src/index.mjs 的 verify_entity 工具
 *   - HTTP：api-guard/worker.js 的 POST /v1/citation/verify 端点
 *
 * 设计要点：
 *   1. 环境无关：只依赖传入的 edges/gaps 参数，不 import fs/net
 *      → Node 环境由 MCP 从本地文件 load 后传入
 *      → CF Worker 环境由 handler 从 upstream fetch 后传入
 *   2. 结果级 TTL 由 caller 决定（本模块只算事实，不写缓存头）
 *   3. 分类结果：
 *      - resolved     = 有引用边（in or out）
 *      - resolved_outgoing_only = 只有出向边
 *      - resolved_incoming_only = 只有入向边
 *      - not_in_database = 无任何边
 *
 * 输入约定：edges 数组每项是 4 元数组 [sDoi, tDoi, sSite, tSite]
 *           （历史 F8 之前的老格式；新格式 {citing,cited,fromSite,toSite}
 *           在 load 端统一 transform）
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const VERIFY_CACHE_TTL_MS = 300_000; // 5 分钟（edges 数据小时级刷新）
export const VERIFY_MAX_DOIS = 50;
export const VERIFY_ENDPOINT_VERSION = 'v1';

// ---------------------------------------------------------------------------
// DOI 归一化（跨 MCP / worker 一致，防止两条通道对同 DOI 得不同结论）
// ---------------------------------------------------------------------------

export function normDoi(v) {
  if (v == null || v === '') return '';
  let s = String(v).trim();
  s = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  s = s.replace(/^doi:/i, '');
  s = s.toLowerCase();
  // 去除末尾版本标记（罕见但存在于 arXiv DOI）
  s = s.replace(/v\d+$/, '');
  return s;
}

// ---------------------------------------------------------------------------
// Edges 索引构建（一次构建，多次查询）
// ---------------------------------------------------------------------------

let _cache = null;

/**
 * 从 edges 数组构建两个索引：
 *   bySource: doi -> 该 DOI 作为 citing 的出向引用列表
 *   byTarget: doi -> 该 DOI 作为 cited 的入向引用列表
 *
 * 每条边格式：{ citing, cited, fromSite, toSite, at, method } 或
 *   legacy 4 元数组 [sDoi, tDoi, sSite, tSite]
 *
 * 返回值：{ bySource, byTarget, totalEdges, builtAt, edgeVersion }
 */
export function buildVerifierIndex(edges) {
  const bySource = new Map();
  const byTarget = new Map();
  let totalEdges = 0;

  for (const raw of edges || []) {
    // 兼容两种格式
    let citing, cited, fromSite, toSite;
    if (Array.isArray(raw) && raw.length >= 2) {
      [citing, cited, fromSite, toSite] = raw;
    } else if (raw && typeof raw === 'object') {
      citing = raw.citing || raw.s || raw.source;
      cited = raw.cited || raw.t || raw.target;
      fromSite = raw.fromSite || raw.sSite || raw.ss;
      toSite = raw.toSite || raw.tSite || raw.ts;
    }
    if (!citing || !cited) continue;
    totalEdges++;

    const sk = normDoi(citing);
    const tk = normDoi(cited);
    const row = {
      citing, cited,
      fromSite, toSite,
      direction: sk === tk ? 'self' : 'cross',
    };

    if (!bySource.has(sk)) bySource.set(sk, []);
    bySource.get(sk).push(row);
    if (!byTarget.has(tk)) byTarget.set(tk, []);
    byTarget.get(tk).push(row);
  }

  return {
    bySource,
    byTarget,
    totalEdges,
    builtAt: new Date().toISOString(),
  };
}

/** 简易 TTL 缓存：edges 引用不变则复用索引 */
export function getCachedIndex(edges) {
  if (_cache && _cache.edges === edges && _cache.index.builtAt) {
    const age = Date.now() - new Date(_cache.index.builtAt).getTime();
    if (age < VERIFY_CACHE_TTL_MS) return _cache.index;
  }
  const index = buildVerifierIndex(edges);
  _cache = { edges, index };
  return index;
}

// ---------------------------------------------------------------------------
// 单条 DOI 验证
// ---------------------------------------------------------------------------

/**
 * 验证单个 DOI。
 *
 * @param {string} doiRaw 原始 DOI 字符串
 * @param {object} index buildVerifierIndex 返回值
 * @returns {object} 结构化结果
 */
export function verifySingle(doiRaw, index) {
  const key = normDoi(doiRaw);
  const out = index.bySource.get(key) || [];
  const inc = index.byTarget.get(key) || [];

  // 收集出现过的站点集合
  const sites = new Set();
  for (const r of out) { if (r.fromSite) sites.add(r.fromSite); if (r.toSite) sites.add(r.toSite); }
  for (const r of inc) { if (r.fromSite) sites.add(r.fromSite); if (r.toSite) sites.add(r.toSite); }

  const hasOut = out.length > 0;
  const hasIn = inc.length > 0;
  const status = hasOut && hasIn ? 'resolved'
    : hasOut ? 'resolved_outgoing_only'
    : hasIn ? 'resolved_incoming_only'
    : 'not_in_database';

  return {
    doi: doiRaw,
    status,
    sites: Array.from(sites).sort(),
    siteCount: sites.size,
    citationsInDatabase: {
      incoming: inc.length,
      outgoing: out.length,
      total: inc.length + out.length,
    },
    duplicateIngestion: sites.size > 1 ? Array.from(sites) : [],
    sampleEdges: {
      outgoing: out.slice(0, 5),
      incoming: inc.slice(0, 5),
    },
  };
}

// ---------------------------------------------------------------------------
// 批量验证（供 HTTP API 消费）
// ---------------------------------------------------------------------------

/**
 * 批量验证。
 *
 * @param {string[]} dois DOI 数组，最多 VERIFY_MAX_DOIS 条
 * @param {object} index buildVerifierIndex 返回值
 * @returns {object} 汇总 + 明细
 */
export function verifyBatch(dois, index) {
  if (!Array.isArray(dois)) {
    return { error: 'invalid_input', message: 'dois must be an array' };
  }
  if (dois.length === 0) {
    return { error: 'empty_input', message: 'dois must not be empty' };
  }
  if (dois.length > VERIFY_MAX_DOIS) {
    return {
      error: 'too_many',
      message: `max ${VERIFY_MAX_DOIS} DOIs per request, got ${dois.length}`,
      limit: VERIFY_MAX_DOIS,
    };
  }

  const results = dois.map((d) => verifySingle(d, index));
  const summary = {
    total: results.length,
    resolved: results.filter((r) => r.status === 'resolved' || r.status === 'resolved_outgoing_only' || r.status === 'resolved_incoming_only').length,
    resolvedStrict: results.filter((r) => r.status === 'resolved').length,
    notInDatabase: results.filter((r) => r.status === 'not_in_database').length,
    duplicated: results.filter((r) => r.duplicateIngestion.length > 1).length,
    totalIncoming: results.reduce((s, r) => s + r.citationsInDatabase.incoming, 0),
    totalOutgoing: results.reduce((s, r) => s + r.citationsInDatabase.outgoing, 0),
  };

  return {
    endpoint: `/v1/citation/verify@${VERIFY_ENDPOINT_VERSION}`,
    cacheHint: { ttlMs: VERIFY_CACHE_TTL_MS, cacheScope: 'public' },
    edgeVersion: index.builtAt,
    edgeCount: index.totalEdges,
    summary,
    results,
  };
}
