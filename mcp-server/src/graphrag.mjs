/**
 * GeneTech 图遍历检索（GraphRAG）
 * ---------------------------------------------------------------------------
 * 参考 nonatofabio/local_graphrag_mcp：anchor + hop 两阶段图检索。
 *
 * 核心思路：
 *   1) 用 hybridSearch 找 anchor（与 query 语义/词法相关的节点）
 *   2) 从 anchor 出发沿关系边跳 1~2 步，收集多跳关联实体
 *   3) 返回 {anchor, reached, paths}，reached 按 hop 距离+原始分数排序
 *
 * 设计要点：
 *   - 纯 Node 内置，零依赖，Map+邻接表实现，不引入 networkx/igraph。
 *   - 有向 + 无向两种遍历（默认双向，可切换）。
 *   - 边带 relation/label，返回时保留路径供解释。
 *   - 与 SearchIndex.hybridSearch 松耦合：本模块只做图遍历，检索交给外部。
 *
 * 数据结构（data/knowledge-graph-entities.json）：
 *   nodes: [{id, name, category, domain, url}]
 *   edges: [{source, target, relation, label, sourceDomain, targetDomain}]
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 邻接表图
// ---------------------------------------------------------------------------
export class KnowledgeGraph {
  /**
   * @param {object} data  包含 nodes 和 edges 的 JSON 对象
   */
  constructor(data) {
    this.nodes = new Map();     // id -> node
    this.outEdges = new Map();  // id -> [{to, relation, label, edge}]
    this.inEdges = new Map();   // id -> [{from, relation, label, edge}]
    this.allEdges = [];
    this.stats = null;

    if (data) this.load(data);
  }

  load(data) {
    this.nodes.clear();
    this.outEdges.clear();
    this.inEdges.clear();
    this.allEdges = [];

    for (const n of data.nodes || []) {
      const id = n.id || n.name;
      this.nodes.set(id, n);
      if (!this.outEdges.has(id)) this.outEdges.set(id, []);
      if (!this.inEdges.has(id)) this.inEdges.set(id, []);
    }

    for (const e of data.edges || []) {
      const s = e.source || e.from || e.src;
      const t = e.target || e.to || e.dst;
      if (!s || !t) continue;
      const edge = {
        from: s,
        to: t,
        relation: e.relation || e.type || 'related',
        label: e.label || '',
        meta: e,
      };
      this.allEdges.push(edge);
      this.outEdges.get(s)?.push({ to: t, relation: edge.relation, label: edge.label, edge });
      this.inEdges.get(t)?.push({ from: s, relation: edge.relation, label: edge.label, edge });
    }

    this.stats = {
      nodes: this.nodes.size,
      edges: this.allEdges.length,
      domains: new Set([...this.nodes.values()].map((n) => n.domain).filter(Boolean)).size,
      relationTypes: (() => {
        const t = new Map();
        for (const e of this.allEdges) t.set(e.relation, (t.get(e.relation) || 0) + 1);
        return t;
      })(),
    };
  }

  static fromFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return new KnowledgeGraph(JSON.parse(raw));
  }

  static fromPathOrDefault(dataDir) {
    // 优先读 knowledge-graph-entities.json（大版本，4075 节点）
    // 回退到 knowledge-graph.json（小版本，98 节点）
    const candidates = [
      path.join(dataDir, 'knowledge-graph-entities.json'),
      path.join(dataDir, 'knowledge-graph.json'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        try { return KnowledgeGraph.fromFile(p); }
        catch { /* try next */ }
      }
    }
    return new KnowledgeGraph({ nodes: [], edges: [] });
  }

  getNodeId(id) {
    return this.nodes.has(id) ? id : null;
  }

  getNeighbors(nodeId, { directed = false, maxPerHop = 50 } = {}) {
    const result = { outgoing: [], incoming: [] };
    const out = this.outEdges.get(nodeId);
    if (out) result.outgoing = out.slice(0, maxPerHop);
    if (!directed) {
      const inc = this.inEdges.get(nodeId);
      if (inc) result.incoming = inc.slice(0, maxPerHop);
    }
    return result;
  }

  /**
   * 从 anchor 集合出发，做 BFS 图遍历
   * @param {string[]} anchorIds  起点节点 ID
   * @param {{hops?: number, maxNodes?: number, directed?: boolean}} opts
   * @returns {{reached: Map<string, number>, paths: Map<string, Array>>}}
   *   reached: nodeId -> hop 距离（1, 2, ...）
   *   paths:   nodeId -> [{from, to, relation, label}] 最短路径
   */
  traverse(anchorIds, { hops = 1, maxNodes = 200, directed = false } = {}) {
    const reached = new Map();
    const paths = new Map();
    const visited = new Set(anchorIds);
    let frontier = [...anchorIds];

    for (let h = 1; h <= hops; h++) {
      const nextFrontier = [];
      for (const id of frontier) {
        if (reached.size >= maxNodes) break;
        const neighbors = this.getNeighbors(id, { directed, maxPerHop: 100 });
        const all = [
          ...neighbors.outgoing.map((n) => ({ nextId: n.to, from: id, relation: n.relation, label: n.label })),
          ...neighbors.incoming.map((n) => ({ nextId: n.from, from: id, relation: n.relation, label: n.label })),
        ];
        for (const n of all) {
          if (visited.has(n.nextId)) continue;
          if (!this.nodes.has(n.nextId)) continue; // 边指向不存在的节点，跳过
          visited.add(n.nextId);
          reached.set(n.nextId, h);
          const existingPath = paths.get(n.nextId);
          // 保留最短路径（h 越大越早被 set，第一次即最短）
          if (!existingPath) {
            const parentPath = paths.get(id) || [];
            paths.set(n.nextId, [
              ...parentPath,
              { from: id, to: n.nextId, relation: n.relation, label: n.label },
            ]);
          }
          nextFrontier.push(n.nextId);
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    return { reached, paths };
  }
}

// ---------------------------------------------------------------------------
// GraphRAG：anchor + hop 组合检索
// ---------------------------------------------------------------------------
export class GraphRAG {
  /**
   * @param {KnowledgeGraph} graph
   * @param {SearchIndex} searchIndex  用于找 anchor 的混合检索器
   */
  constructor(graph, searchIndex) {
    this.graph = graph;
    this.index = searchIndex;
  }

  /**
   * 找 degree 最高的 hub 节点（图中心节点，几乎必含 edge endpoint）
   * @param {number} top 返回前 N 个
   */
  _hubAnchors(top = 5) {
    const deg = new Map();
    for (const [id] of this.graph.nodes) {
      const out = (this.graph.outEdges.get(id) || []).length;
      const inc = (this.graph.inEdges.get(id) || []).length;
      const d = out + inc;
      if (d > 0) deg.set(id, d);
    }
    return [...deg.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([id]) => id);
  }

  /**
   * anchor + hop 检索
   * @param {string} query
   * @param {{anchorLimit?: number, hops?: number, maxReached?: number, directed?: boolean, site?: string|null, includeHubs?: boolean}} opts
   * @returns {Promise<{anchors, reached, paths, meta}>}
   */
  async search(query, opts = {}) {
    const {
      anchorLimit = 5,
      hops = 1,
      maxReached = 50,
      directed = false,
      site = null,
      includeHubs = hops > 0, // 默认：启用 hop 时自动加 hub anchor
    } = opts;

    // 阶段 1：anchor 检索（用 hybridSearch 找 top-K 相关节点）
    const anchorResults = await this.index.hybridSearch(query, {
      limit: anchorLimit,
      site,
    });
    const anchors = anchorResults.map((r) => r.entity).filter(Boolean);
    const anchorIds = anchors.map((a) => a.id || `${a._site}:${a.name}`).filter(Boolean);

    // 阶段 1.5：hub 增强——图只有稀疏边（本图谱 50 条），
    // anchor 若不包含真正有边的节点就无法遍历。保证至少带 3 个 hub anchor。
    if (includeHubs && anchorIds.length > 0) {
      const anchorHasEdge = anchorIds.some(
        (id) => (this.graph.outEdges.get(id)?.length || 0) + (this.graph.inEdges.get(id)?.length || 0) > 0,
      );
      if (!anchorHasEdge) {
        for (const hub of this._hubAnchors(3)) {
          if (!anchorIds.includes(hub)) anchorIds.push(hub);
        }
      }
    }

    // 阶段 2：图遍历
    const { reached, paths } = this.graph.traverse(anchorIds, {
      hops,
      maxNodes: maxReached,
      directed,
    });

    // 组装结果
    const reachedList = [...reached.entries()]
      .map(([id, hop]) => ({
        entity: this.graph.nodes.get(id),
        hop,
        path: paths.get(id) || [],
      }))
      .sort((a, b) => a.hop - b.hop);

    return {
      anchors,
      anchorIds,
      reached: reachedList,
      paths,
      meta: {
        query,
        anchorLimit,
        hops,
        maxReached,
        directed,
        graphStats: this.graph.stats,
        anchorCount: anchorIds.length,
        reachedCount: reachedList.length,
      },
    };
  }

  /**
   * 给定节点 ID，直接查邻居（不经检索）
   */
  neighbors(nodeId, { hops = 1, maxNodes = 50 } = {}) {
    const { reached, paths } = this.graph.traverse([nodeId], { hops, maxNodes });
    return {
      nodeId,
      node: this.graph.nodes.get(nodeId),
      reached: [...reached.entries()].map(([id, hop]) => ({
        entity: this.graph.nodes.get(id),
        hop,
        path: paths.get(id) || [],
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// 便捷：给 SearchIndex 加 graphHop 参数（monkey-patch 风格）
// ---------------------------------------------------------------------------
export async function hybridSearchWithGraph(
  searchIndex,
  graph,
  query,
  { limit = 10, site = null, graphHop = false, hops = 1, maxReached = 20 } = {},
) {
  // 先走标准 hybridSearch 拿主结果
  const mainResults = await searchIndex.hybridSearch(query, { limit, site });

  if (!graphHop) return mainResults;

  // 再走图遍历扩召回
  const topIds = mainResults.slice(0, 5).map((r) => r.entity?.id || `${r.entity?._site}:${r.entity?.name}`).filter(Boolean);
  const { reached, paths } = graph.traverse(topIds, { hops, maxNodes: maxReached });

  const graphResults = [...reached.entries()]
    .map(([id, hop]) => ({
      score: 0.5 / hop, // hop 越大分越低
      entity: { ...(graph.nodes.get(id) || {}), _graph_hop: hop, _graph_path: paths.get(id) || [] },
      _source: 'graph',
    }));

  // 合并：主结果在前，图扩展在后（去重）
  const seen = new Set(mainResults.map((r) => r.entity?.id));
  const merged = [...mainResults, ...graphResults.filter((r) => !seen.has(r.entity?.id))];
  return merged;
}

// ---------------------------------------------------------------------------
// CLI 自检
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('graphrag.mjs')) {
  (async () => {
    const dataDir = process.argv[2] || '../../../data';
    console.log(`[graphrag] loading from ${dataDir}`);
    const graph = KnowledgeGraph.fromPathOrDefault(dataDir);
    console.log(`[graphrag] nodes=${graph.nodes.size}, edges=${graph.stats?.edges}, domains=${graph.stats?.domains}`);
    console.log(`[graphrag] relation types:`, Object.fromEntries(graph.stats?.relationTypes || []));

    // 找一个度最高的节点做邻居查询演示
    let hub = null, hubDeg = 0;
    for (const [id, node] of graph.nodes) {
      const out = (graph.outEdges.get(id) || []).length;
      const inc = (graph.inEdges.get(id) || []).length;
      const deg = out + inc;
      if (deg > hubDeg) { hubDeg = deg; hub = id; }
    }
    if (hub) {
      console.log(`\n[graphrag] hub node: ${hub} (degree=${hubDeg})`);
      const nbrs = new GraphRAG(graph, null).neighbors(hub, { hops: 1, maxNodes: 10 });
      for (const n of nbrs.reached.slice(0, 5)) {
        console.log(`  hop${n.hop}: ${n.entity?.name || n.entity?.id} (${n.entity?.category || '?'})`);
      }
    }

    // 演示 traverse
    const { reached } = graph.traverse([hub], { hops: 2, maxNodes: 20 });
    console.log(`\n[graphrag] 2-hop traverse from hub: reached ${reached.size} nodes`);
  })().catch((e) => {
    console.error('[graphrag] ERROR:', e.message);
    process.exit(1);
  });
}
