#!/usr/bin/env node
/**
 * graphrag.mjs — 实体关系图（KnowledgeGraph）+ 图遍历检索（GraphRAG）
 *
 * ⚠️ 这个文件在 2026-10-02 之前**根本不存在**，而 src/index.mjs:31 却在 import 它
 *    （第 162 号任务「给 hybridSearch 加图遍历 GraphRAG」只写了调用方，没写实现）。
 *    后果：MCP server 一启动就 ERR_MODULE_NOT_FOUND 直接退出 —— 所谓「核心护城河」
 *    的对外接口其实是死的，而此前的检查（本地跑过一次、CI 没有这项门禁）都没发现。
 *    本文件按 index.mjs 的调用契约补齐（见下方 "契约" 小节），并纳入冒烟测试。
 *
 * 契约（由 index.mjs 反推，改动务必同步）：
 *   KnowledgeGraph.fromPathOrDefault(dir) → 实例，需有 .nodes（Map<id,node>）
 *   new GraphRAG(graph, searchIndex)      → 实例，需有 .search()
 *   rag.search(query, {anchorLimit,hops,maxReached,directed,site,includeHubs})
 *        → { anchorIds, anchors[], reached[], meta }
 *        anchors[i] / reached[i].entity 需有 { id, name, category, domain }
 *        reached[i] 还需有 { hop, path[] }
 *   rag.unavailable 需可 falsy（index.mjs 用 `rag?.unavailable` 判断降级）
 *
 * 图数据：data/*.json，schema genetech-knowledge-graph/v3
 *   nodes: [{id, name, type}]        type ∈ station / arxiv-* / tag:*
 *   edges: [{source, target, relation, weight}]  relation ∈ cross_site / shared_tag / co_topic / entity_entity
 */
import fs from 'node:fs';
import path from 'node:path';

const KG_FILENAMES = ['knowledge-graph-entities.json', 'knowledge-graph.json'];

export class KnowledgeGraph {
  /**
   * 从 data/ 目录载入图谱。两个候选文件同 schema，优先 entities 版（只含节点/边，更轻）。
   * 都找不到就抛错——调用方（index.mjs）已经 try/catch 并降级，这里不静默返回空图：
   * 静默空图会让 graph_search 永远返回「图数据为空」，同样看不出根因。
   */
  static fromPathOrDefault(dir) {
    let lastErr = null;
    for (const f of KG_FILENAMES) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return KnowledgeGraph.fromObject(j, p);
      } catch (e) {
        lastErr = new Error(`${f}: ${e.message}`);
      }
    }
    throw new Error(
      `知识图谱不可用（未找到或解析失败 ${KG_FILENAMES.join(' / ')}）${lastErr ? ' | ' + lastErr.message : ''}`
    );
  }

  static fromObject(j, srcPath = '(memory)') {
    if (!j || !Array.isArray(j.nodes)) throw new Error(`图谱 ${srcPath} 缺少 nodes 数组`);

    const nodes = new Map();
    const list = [];
    // 别名索引：节点 id / name / 冒号后段三者任一命中即可解析 anchor。
    // 图谱里的节点 id 形如 "arxiv-2607.29626v1"、"tag:cs.ai"、"station:agent-ecosystem"，
    // 而检索器返回的实体 id 未必带站前缀，硬相等会一个 anchor 都匹配不上。
    const alias = new Map();
    const addAlias = (key, id) => {
      if (key == null) return;
      const k = String(key).trim().toLowerCase();
      if (!k || alias.has(k)) return;
      alias.set(k, id);
    };

    for (const n of j.nodes) {
      if (!n || n.id == null) continue;
      const id = String(n.id);
      if (nodes.has(id)) continue;
      const type = n.type != null ? String(n.type) : 'entity';
      const node = { id, name: n.name != null ? String(n.name) : id, type };
      nodes.set(id, node);
      list.push(node);
      addAlias(id, id);
      addAlias(node.name, id);
      const ci = id.indexOf(':');
      if (ci > 0) addAlias(id.slice(ci + 1), id);
    }

    // 无向邻接（双向都写），以及有向出边（directed=true 时用）
    const adj = new Map();
    const outAdj = new Map();
    let edgeCount = 0;
    let crossSiteEdges = 0;
    const droppedEdges = [];

    for (const e of j.edges || []) {
      if (!e || e.source == null || e.target == null) continue;
      const sRaw = String(e.source);
      const tRaw = String(e.target);
      const sid = nodes.has(sRaw) ? sRaw : alias.get(sRaw.toLowerCase());
      const tid = nodes.has(tRaw) ? tRaw : alias.get(tRaw.toLowerCase());
      if (sid == null || tid == null) { droppedEdges.push([sRaw, tRaw]); continue; }
      if (sid === tid) continue;
      edgeCount++;
      const relation = e.relation != null ? String(e.relation) : 'related';
      if (relation === 'cross_site') crossSiteEdges++;
      const rec = { to: tid, relation, weight: e.weight == null ? 1 : e.weight };
      if (!adj.has(sid)) adj.set(sid, []);
      adj.get(sid).push(rec);
      const recOut = { to: tid, relation, weight: rec.weight };
      if (!outAdj.has(sid)) outAdj.set(sid, []);
      outAdj.get(sid).push(recOut);
    }

    const degree = new Map();
    for (const [id, arr] of adj) degree.set(id, arr.length);

    const graph = new KnowledgeGraph();
    graph.srcPath = srcPath;
    graph._alias = alias; // resolve() 走它；构造函数里默认空 Map，避免未 load 时炸
    graph.nodes = nodes;
    graph.nodeList = list;
    graph.adj = adj;
    graph.outAdj = outAdj;
    graph.degree = degree;
    graph.edgeCount = edgeCount;
    graph.crossSiteEdges = crossSiteEdges;
    graph.droppedEdges = droppedEdges;
    graph.stats = j.stats && typeof j.stats === 'object' ? j.stats : {};
    graph.stats.nodes = nodes.size;
    graph.stats.edges = edgeCount;
    return graph;
  }

  /** 节点 id / name / 别名 → 图谱节点 id；解析不到返回 null */
  resolve(key) {
    if (key == null) return null;
    const k = String(key).trim();
    if (this.nodes.has(k)) return k;
    const c = aliasOf(this, k);
    return c;
  }

  /** 图中心节点（degree 最高），includeHubs 时用于补 anchor */
  hubNodes(limit) {
    return [...this.degree.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => this.nodes.get(id))
      .filter(Boolean);
  }
}

function aliasOf(graph, key) {
  const k = key.toLowerCase();
  for (const [k2, id] of graph._alias) if (k2 === k) return id;
  return null;
}

export class GraphRAG {
  constructor(graph, searchIndex) {
    this.graph = graph;
    this.searchIndex = searchIndex;
    this._alias = graph ? graph._alias : new Map();
  }

  /**
   * 先 hybridSearch 找 anchor，再沿边 BFS 多跳遍历。
   * 返回 reached 时保留完整 path（anchor → ... → 当前节点），便于前端/消费方解释
   * 「这条结果是怎么被捞出来的」——可解释性是本项目对外交付的一部分。
   */
  async search(query, opts = {}) {
    const {
      anchorLimit = 5,
      hops = 2,
      maxReached = 50,
      directed = false,
      site = null,
      includeHubs = true,
    } = opts;

    const g = this.graph;
    const graph = { anchorIds: [], anchors: [], reached: [], meta: {} };
    if (!g || !g.nodes || g.nodes.size === 0) {
      graph.meta = { unavailable: '图数据为空' };
      return graph;
    }

    // ---- 1. anchors ----
    const picked = new Map(); // nodeId → node
    if (this.searchIndex) {
      let hits = [];
      try {
        hits = await this.searchIndex.hybridSearch(query, { limit: anchorLimit, site });
      } catch (e) {
        // 检索器挂了不该让整个图检索失败，降级成「只有 hub anchor」
        console.error(`[graphrag] anchor 检索失败: ${e.message}`);
      }
      for (const h of hits || []) {
        const ent = h && h.entity ? h.entity : h;
        if (!ent) continue;
        const nid = g.resolve(ent.id != null ? ent.id : ent.name);
        if (!nid) continue;
        if (!picked.has(nid)) picked.set(nid, g.nodes.get(nid));
      }
    }
    // includeHubs：补高 degree 节点，保证图中心（而非只有 query 命中点）也被遍历到
    if (includeHubs) {
      const have = new Set(picked.keys());
      const budget = Math.max(0, anchorLimit - picked.size);
      if (budget > 0) {
        for (const h of g.hubNodes(anchorLimit * 4)) {
          if (picked.size >= anchorLimit) break;
          if (have.has(h.id)) continue;
          picked.set(h.id, h);
        }
      }
    }

    for (const [id, n] of picked) {
      graph.anchorIds.push(id);
      graph.anchors.push(shape(n));
    }

    // ---- 2. BFS ----
    const table = directed ? g.outAdj : g.adj;
    const seen = new Set(picked.keys());
    const reached = [];
    let frontier = [...picked.keys()];
    let truncated = false;

    for (let hop = 1; hop <= Math.max(1, hops); hop++) {
      const next = [];
      for (const from of frontier) {
        const nb = table.get(from);
        if (!nb) continue;
        for (const e of nb) {
          if (seen.has(e.to)) continue;
          seen.add(e.to);
          const node = g.nodes.get(e.to);
          if (!node) continue;
          reached.push({
            entity: shape(node),
            hop,
            path: [from, e.to],
            relation: e.relation,
            weight: e.weight,
          });
          next.push(e.to);
          if (reached.length >= maxReached) { truncated = true; break; }
        }
        if (reached.length >= maxReached) break;
      }
      frontier = next;
      if (truncated || !frontier.length) break;
    }

    // 同跳数内优先保留度数高的（信息量更大），再按 maxReached 截断
    reached.sort((a, b) => a.hop - b.hop || (g.degree.get(a.entity.id) || 0) - (g.degree.get(b.entity.id) || 0));
    graph.reached = reached.slice(0, maxReached);
    graph.meta = {
      graphNodes: g.nodes.size,
      graphEdges: g.edgeCount,
      anchorsUsed: graph.anchorIds.length,
      reachedCount: graph.reached.length,
      truncated,
      directed,
      hops,
      maxReached,
      srcPath: g.srcPath,
    };
    return graph;
  }
}

/** index.mjs 期望 anchors[i].entity 带 {id,name,category,domain} */
function shape(node) {
  return {
    id: node.id,
    name: node.name,
    category: node.type,
    // station:* 节点的 name 就是站 slug；其余（arxiv/tag）没有归属站的语义
    domain: node.type === 'station' ? node.name : null,
  };
}
