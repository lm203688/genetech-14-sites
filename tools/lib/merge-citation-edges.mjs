/**
 * tools/lib/merge-citation-edges.mjs
 *
 * 把 data/citation-edges.json 的引用边并入知识图谱，形成
 * relation:"citation" 的第四类边（原图谱只有 cross_site / shared_tag / co_topic）。
 *
 * 为什么放在 lib/ 而不是只做一次性 patch
 *   data/knowledge-graph.json 的**唯一权威写入者**是 tools/build-knowledge-graph.mjs
 *   （它每天在 CI 的 kgbuild 任务里重建，并带退化护栏）。若只做一次性 JSON patch，
 *   下一次重建就会把引用边抹掉——报告 B1 的 ROI 会变成零。所以合并逻辑必须是
 *   纯函数、可被 builder 与 CLI 共同调用。
 *
 * 两种模式（实测驱动的取舍，数字见 pipeline-merge-citation-edges.js 的输出）
 *   link   —— 只加「两端节点都已存在」的引用边，不新建任何节点。零膨胀、零风险，
 *             但当前图谱覆盖率极低（实测 45 / 28,001），几乎不产生价值。
 *   extend —— 为引用边里尚未入库的 DOI 补占位节点（kind:"doi-stub"），再加全部引用边。
 *             这是唯一能达到「引用边占比 ≥20%」验收判据的模式。占位节点不是空壳：
 *             citation-edges 自带 [doiFrom, doiTo, siteFrom, siteTo]，所以 stub 节点
 *             带有真实的 sites 溯源，等飞轮把元数据补齐后自然升级为完整实体。
 *
 * 幂等性
 *   函数不修改入参 graph；返回新的 { graph, report }。同一输入重复调用结果一致。
 */

const RELATION = 'citation';

/** 归一化 DOI：去空白、转小写。DOI 本身大小写不敏感，用于对齐图谱节点 id。 */
export function normDoi(doi) {
  return typeof doi === 'string' ? doi.trim().toLowerCase() : '';
}

/** 图谱节点 id 约定：`doi:<归一化 DOI>`（与 build-knowledge-graph.mjs 一致）。 */
export function nodeIdForDoi(doi) {
  return 'doi:' + normDoi(doi);
}

/**
 * 为缺失的 DOI 生成占位节点。
 * @param {string} doi        原始 DOI
 * @param {string[]} sites    引用边给出的所属站（siteFrom / siteTo），真实溯源信息
 */
export function stubNodeForDoi(doi, sites) {
  const clean = normDoi(doi);
  return {
    id: 'doi:' + clean,
    name: '(元数据未入库，仅 DOI 已知)',
    type: 'entity',
    kind: 'doi-stub',
    url: 'https://doi.org/' + clean,
    sites: Array.from(new Set((sites || []).filter(Boolean))),
  };
}

/**
 * 合并引用边。
 *
 * @param {object} graph  现有图谱 { nodes, edges, stats, ... }
 * @param {object} ce     data/citation-edges.json 解析结果，edges 为 [doiFrom, doiTo, siteFrom, siteTo]
 * @param {object} opts   { mode: 'link'|'extend', limitEdges?: number }
 * @returns {{graph: object, report: object}}
 */
export function mergeCitationEdges(graph, ce, opts = {}) {
  const mode = opts.mode === 'extend' ? 'extend' : 'link';
  const limitEdges = Number.isFinite(opts.limitEdges) ? opts.limitEdges : Infinity;

  const nodes = graph.nodes || [];
  const existingEdges = graph.edges || [];
  const byId = new Map();
  for (const n of nodes) byId.set(n.id, n);

  const outNodes = nodes.slice();
  let nodesById = byId;

  const srcEdgeIds = new Set();
  for (const e of existingEdges) {
    if (e && e.source && e.target) srcEdgeIds.add(e.source + '→' + e.target);
  }

  const edges = existingEdges.slice();
  const report = {
    mode,
    inputCitationEdges: 0,
    addedCitationEdges: 0,
    skippedAlreadyPresent: 0,
    skippedSelfEdge: 0,
    skippedMalformed: 0,
    skippedLimit: 0,
    nodesBefore: outNodes.length,
    stubNodesAdded: 0,
    resolvableOnly: null,
    citationEdgeShare: null,
  };

  const src = ce && Array.isArray(ce.edges) ? ce.edges : [];
  report.inputCitationEdges = src.length;
  let added = 0;

  // F8+F10 兼容（2026-10-17）：citation-edges 现在有两种格式
  //   数组格式（legacy v1）: [doiFrom, doiTo, siteFrom, siteTo]
  //   对象格式（v4/v5）: {citing, cited, fromSite, toSite, resolvedAt, method, validFrom, validTo, tier}
  // 两种格式都要能合并，否则 F8 迁移后引用边会全部被 skip 掉。
  for (const raw of src) {
    let doiFrom, doiTo, siteFrom, siteTo, edgeMeta = {};

    if (Array.isArray(raw)) {
      // Legacy 数组格式
      if (raw.length < 4) { report.skippedMalformed++; continue; }
      doiFrom = normDoi(raw[0]);
      doiTo = normDoi(raw[1]);
      siteFrom = raw[2];
      siteTo = raw[3];
      edgeMeta = { method: 'v1-migration', tier: 4, validFrom: null, validTo: null };
    } else if (typeof raw === 'object' && raw !== null) {
      // F8 对象格式（v4+）
      const citingRaw = raw.citing;
      const citedRaw = raw.cited;
      doiFrom = normDoi(citingRaw);
      doiTo = normDoi(citedRaw);
      siteFrom = raw.fromSite;
      siteTo = raw.toSite;
      edgeMeta = {
        resolvedAt: raw.resolvedAt || null,
        method: raw.method || 'v4-migration',
        tier: Number.isInteger(raw.tier) ? raw.tier : 4,
        validFrom: raw.validFrom || raw.resolvedAt || null,
        validTo: ('validTo' in raw) ? raw.validTo : null,
      };
    } else {
      report.skippedMalformed++;
      continue;
    }

    if (!doiFrom || !doiTo) { report.skippedMalformed++; continue; }
    if (doiFrom === doiTo) { report.skippedSelfEdge++; continue; }
    if (added >= limitEdges) { report.skippedLimit++; continue; }

    let s = nodesById.get('doi:' + doiFrom);
    let t = nodesById.get('doi:' + doiTo);

    if (mode === 'link') {
      if (!s || !t) continue; // link 模式：不建节点，直接跳过
    } else {
      // extend 模式：为缺失端点补占位节点（带真实 sites 溯源）
      if (!s) {
        s = stubNodeForDoi(doiFrom, [siteFrom]);
        outNodes.push(s);
        nodesById.set(s.id, s);
        report.stubNodesAdded++;
      }
      if (!t) {
        t = stubNodeForDoi(doiTo, [siteTo]);
        outNodes.push(t);
        nodesById.set(t.id, t);
        report.stubNodesAdded++;
      }
    }

    const key = s.id + '→' + t.id;
    if (srcEdgeIds.has(key)) { report.skippedAlreadyPresent++; continue; }
    srcEdgeIds.add(key);

    // F7 双戳 + F10 tier：引用边也带生命周期和来源分级
    const now = new Date().toISOString();
    edges.push({
      source: s.id,
      target: t.id,
      relation: RELATION,
      weight: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      tier: edgeMeta.tier, // F10 来源分级透传
      validFrom: edgeMeta.validFrom || now,
      validTo: edgeMeta.validTo,
      method: edgeMeta.method,
      resolvedAt: edgeMeta.resolvedAt || now,
    });
    added++;
  }

  report.addedCitationEdges = added;
  report.nodesAfter = outNodes.length;
  // link 模式下能落地的边 / 全部输入边 = 图谱对引用网络的覆盖率
  report.resolvableOnly = src.length ? added / src.length : 0;
  report.citationEdgeShare = edges.length ? added / edges.length : 0;
  report.totalEdgesAfter = edges.length;

  const stats = Object.assign({}, graph.stats || {}, {
    nodes: outNodes.length,
    edges: edges.length,
    citationEdges: edges.filter((e) => e.relation === RELATION).length,
    citationEdgeShare: Math.round(report.citationEdgeShare * 10000) / 10000,
    stubNodes: report.stubNodesAdded,
  });

  return {
    graph: Object.assign({}, graph, { nodes: outNodes, edges, stats }),
    report,
  };
}

export default { mergeCitationEdges, normDoi, nodeIdForDoi, stubNodeForDoi, RELATION };
