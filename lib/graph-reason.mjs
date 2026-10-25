/**
 * lib/graph-reason.mjs — Personalized PageRank (PPR) 图推理引擎
 *
 * 用途：为 GeneTech 检索管线提供图语义召回通道。
 *      当查询命中 tag/station/entity 节点时，以这些节点为种子运行 PPR，
 *      图邻域内的实体获得 "graph proximity" 分数，作为 RRF 的补充通道。
 *
 * 核心算法：
 *   Personalized PageRank with restart (PPR):
 *     v_{t+1} = α * M * v_t + (1-α) * e_seed
 *   其中 M 是列归一化转移矩阵，e_seed 是种子分布。
 *   迭代至收敛或最大步数。
 *
 * 复杂度：O(∇E ∇T) 每次查询，其中 E 是边数，T 是迭代轮数（默认 20）。
 *        对于 98,795 边 / 20 轮 ≈ 2M 操作，单次查询 < 5ms。
 *
 * 零第三方依赖，纯 Node 内置。
 */

import fs from 'node:fs';
import path from 'node:path';

// ── 默认参数 ──────────────────────────────────────────────
const DEFAULT_ALPHA = 0.85;   // restart probability (higher = more local)
const DEFAULT_MAX_ITER = 20;  // 通常 15-20 轮即收敛
const DEFAULT_TOL = 1e-6;     // L1 收敛阈值

/**
 * 从 knowledge-graph.json 构建图索引
 * @param {string} dataDir  数据根目录
 * @param {Object} opts
 * @param {string} [opts.graphFile]  图文件路径（默认 data/knowledge-graph.json）
 * @param {string[]} [opts.relations]  纳入的边关系类型（默认全部）
 */
export function buildGraphIndex(dataDir, opts = {}) {
  const graphFile = opts.graphFile
    || path.join(dataDir, 'data', 'knowledge-graph.json');
  const raw = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  const nodes = new Map();   // id -> {type, name, ...}
  const adj = new Map();     // id -> [{target, relation, weight, tier}]

  for (const n of raw.nodes) {
    nodes.set(n.id, { type: n.type, name: n.name, ...n });
  }

  const relations = opts.relations || null;
  // 双向邻接表：forward = source→target, reverse = target→source
  // tag/station 节点是图的汇聚点（entity→tag），种子在 tag 上需要用 reverse 向外扩散
  const radj = new Map(); // reverse adjacency: target → [{source, relation, weight, tier}]
  for (const e of raw.edges) {
    if (relations && !relations.includes(e.relation)) continue;
    const w = e.weight || 1;
    const tier = e.tier || 0;
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source).push({ target: e.target, relation: e.relation, weight: w, tier });
    if (!radj.has(e.target)) radj.set(e.target, []);
    radj.get(e.target).push({ source: e.source, relation: e.relation, weight: w, tier });
  }

  // 预计算列归一化（每个 target 的入边权重和）
  const inWeight = new Map();
  for (const [, edges] of adj) {
    for (const { target, weight } of edges) {
      inWeight.set(target, (inWeight.get(target) || 0) + weight);
    }
  }

  // 预计算所有节点 ID 列表（包括无出边的节点）
  const allIds = new Set();
  for (const id of nodes.keys()) allIds.add(id);
  for (const id of adj.keys()) allIds.add(id);
  for (const id of radj.keys()) allIds.add(id);

  return {
    nodes,
    adj,
    radj,
    inWeight,
    allIds,
    stats: {
      nodeCount: nodes.size,
      edgeCount: raw.edges.length,
      filteredEdges: Array.from(adj.values()).reduce((s, v) => s + v.length, 0),
      nodesWithEdges: adj.size,
      reverseEdges: Array.from(radj.values()).reduce((s, v) => s + v.length, 0),
    },
  };
}

/**
 * 解析查询字符串 → 种子节点列表
 *
 * 支持多种种子来源（取并集）：
 *   1. 精确 tag 节点匹配：tag:<query terms>
 *   2. 精确 station 节点匹配：station:<query terms>
 *   3. 精确 entity 节点匹配：entity:<query terms>
 *   4. 子串匹配：query terms 出现在节点 name 中
 *
 * @param {string} query  查询字符串
 * @param {Object} graph  buildGraphIndex 返回的图索引
 * @param {Object} opts
 * @param {string[]} [opts.seeds]  手动指定种子节点 ID 列表（优先于 query 解析）
 * @param {string} [opts.seedTypes]  种子节点类型过滤（默认不限）
 * @param {number} [opts.maxSeeds=20]  最大种子数（防止过度扩散）
 * @returns {string[]}  种子节点 ID 列表
 */
export function resolveSeeds(query, graph, opts = {}) {
  const { seeds: manualSeeds, seedTypes, maxSeeds = 20 } = opts;

  // 手动种子优先
  if (manualSeeds && manualSeeds.length > 0) {
    return manualSeeds.slice(0, maxSeeds);
  }

  const found = [];
  const qLower = query.toLowerCase().trim();
  const qTokens = qLower.split(/[\s,/]+/).filter(Boolean);

  // 构建所有 n-gram 短语（1-gram 到 3-gram），用于精确短语匹配
  const phrases = [];
  for (let n = 1; n <= Math.min(3, qTokens.length); n++) {
    for (let i = 0; i <= qTokens.length - n; i++) {
      phrases.push(qTokens.slice(i, i + n).join(' '));
    }
  }
  // 长短语优先（更精确）
  phrases.sort((a, b) => b.length - a.length);

  // 建立 node 的 name 索引（name → id 列表），加速匹配
  const nameIndex = new Map();
  for (const [id, node] of graph.nodes) {
    if (seedTypes && !seedTypes.includes(node.type)) continue;
    const name = (node.name || '').toLowerCase();
    const idLower = id.toLowerCase();
    if (!nameIndex.has(name)) nameIndex.set(name, []);
    nameIndex.get(name).push({ id, idLower, node });
  }

  for (const phrase of phrases) {
    // 策略 1：精确匹配 tag:<phrase> / station:<phrase>
    for (const prefix of ['tag:', 'station:', 'entity:']) {
      const target = prefix + phrase;
      const match = nameIndex.get(phrase); // tag:x 的 name 就是 x
      if (match) {
        for (const { id } of match) {
          if (id.toLowerCase() === target) {
            found.push(id);
          }
        }
      }
    }
    // 策略 2：精确匹配 node name == phrase
    const nameMatch = nameIndex.get(phrase);
    if (nameMatch) {
      for (const { id } of nameMatch) {
        // 只接受 type 为 tag/station/entity 的精确匹配
        const node = graph.nodes.get(id);
        if (node && (node.type === 'tag' || node.type === 'station')) {
          found.push(id);
        }
      }
    }
    // 策略 3：子串匹配（仅限 2-gram 以上的短语，避免单词过度匹配）
    if (phrase.length >= 4 && phrase.split(' ').length >= 2) {
      for (const [name, entries] of nameIndex) {
        if (name !== phrase && name.includes(phrase)) {
          for (const { id, node } of entries) {
            if (node && (node.type === 'tag' || node.type === 'station')) {
              found.push(id);
            }
          }
        }
      }
    }
  }

  // 去重 + 限制
  const unique = [...new Set(found)].slice(0, maxSeeds);
  return unique;
}

/**
 * Personalized PageRank 计算
 *
 * @param {Object} graph  buildGraphIndex 返回的图索引
 * @param {string[]} seeds  种子节点 ID 列表
 * @param {Object} opts
 * @param {number} [opts.alpha=0.85]     restart probability
 * @param {number} [opts.maxIter=20]     最大迭代轮数
 * @param {number} [opts.tol=1e-6]       收敛阈值
 * @param {number} [opts.maxNodes=500]   最大参与节点数（Top-K 裁剪，控制延迟）
 * @returns {Map<string, number>}  节点 ID → PPR 分数
 */
export function personalizedPageRank(graph, seeds, opts = {}) {
  const { alpha = DEFAULT_ALPHA, maxIter = DEFAULT_MAX_ITER, tol = DEFAULT_TOL, maxNodes = 500 } = opts;

  if (!seeds || seeds.length === 0) return new Map();

  const { adj, radj, nodes } = graph;

  // 判断种子类型：tag/station 节点是汇聚点（forward 无出边），需用 reverse 遍历
  // entity 节点有 forward 出边，用 forward 遍历
  let useReverse = false;
  let mixed = false;
  for (const s of seeds) {
    const node = nodes.get(s);
    const type = node?.type || '';
    const hasForward = adj.has(s) && adj.get(s).length > 0;
    const hasReverse = radj.has(s) && radj.get(s).length > 0;
    if (type === 'tag' || type === 'station') {
      if (hasForward) mixed = true; // tag/station 有 forward 边（少见但存在）
      if (hasReverse) useReverse = true;
    } else if (type === 'entity') {
      if (hasForward) { /* use forward */ }
      else if (hasReverse) useReverse = true;
      else { /* no edges at all */ }
    }
  }

  // 统一邻接表：根据种子类型选择 forward 或 reverse
  // 如果混合类型，优先用 reverse（因为 tag/station 是主要种子类型）
  const getNeighbors = (nodeId) => {
    if (useReverse) {
      const rev = radj.get(nodeId);
      return rev ? rev.map(e => ({ target: e.source, weight: e.weight })) : [];
    } else {
      const fwd = adj.get(nodeId);
      return fwd ? fwd.map(e => ({ target: e.target, weight: e.weight })) : [];
    }
  };

  // 种子分布（均匀分布）
  const seedDist = new Map();
  const seedWeight = 1 / seeds.length;
  for (const s of seeds) seedDist.set(s, seedWeight);

  // 初始向量 = 种子分布
  let scores = new Map(seedDist);

  // 预计算每个节点的出边权重和（用于归一化）
  const outDegree = new Map();
  for (const nodeId of scores.keys()) {
    const neighbors = getNeighbors(nodeId);
    let total = 0;
    for (const e of neighbors) total += e.weight;
    outDegree.set(nodeId, total || 1);
  }

  for (let iter = 0; iter < maxIter; iter++) {
    const next = new Map();

    // 对每个有分数的节点，分散其分数到邻居
    for (const [id, score] of scores) {
      if (score < 1e-10) continue;
      const neighbors = getNeighbors(id);
      if (!neighbors || neighbors.length === 0) {
        // 无出边 → 将分数加回种子（teleport）
        for (const s of seeds) {
          next.set(s, (next.get(s) || 0) + score);
        }
        continue;
      }
      const totalW = outDegree.get(id) || 1;
      for (const { target, weight } of neighbors) {
        const contribution = alpha * score * (weight / totalW);
        next.set(target, (next.get(target) || 0) + contribution);
        // 为新节点计算 outDegree（下一轮可能需要）
        if (!outDegree.has(target)) {
          const tNeighbors = getNeighbors(target);
          let t = 0;
          for (const e of tNeighbors) t += e.weight;
          outDegree.set(target, t || 1);
        }
      }
    }

    // 加入 restart 分量
    const restartCoeff = 1 - alpha;
    for (const [s, w] of seedDist) {
      next.set(s, (next.get(s) || 0) + restartCoeff * w);
    }

    // 检查收敛
    let l1Diff = 0;
    for (const [id, newVal] of next) {
      const oldVal = scores.get(id) || 0;
      l1Diff += Math.abs(newVal - oldVal);
    }
    scores = next;

    if (l1Diff < tol) break;
  }

  // 取 Top-K 节点（控制输出大小），排除种子本身（种子是"已知"，我们要找的是邻居）
  const seedSet = new Set(seeds);
  const ranked = [...scores.entries()]
    .filter(([id]) => !seedSet.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxNodes);

  return new Map(ranked);
}

/**
 * 一站式图推理查询
 *
 * @param {string} query  查询字符串
 * @param {Object} graph  buildGraphIndex 返回的图索引
 * @param {Object} opts
 * @param {string[]} [opts.seeds]  手动种子
 * @param {string[]} [opts.seedTypes]  种子类型过滤
 * @param {number} [opts.alpha]  restart probability
 * @param {number} [opts.maxNodes]  返回最大节点数
 * @param {number} [opts.maxIter]  最大迭代轮数
 * @param {string[]} [opts.relations]  边关系过滤（默认全部）
 * @returns {Map<string, number>}  节点 ID → 归一化 PPR 分数 [0, 1]
 */
export function graphSearch(query, graph, opts = {}) {
  const {
    seeds,
    seedTypes,
    alpha = DEFAULT_ALPHA,
    maxNodes = 500,
    maxIter = DEFAULT_MAX_ITER,
  } = opts;

  // 1. 解析种子
  const seedList = resolveSeeds(query, graph, { seeds, seedTypes });
  if (seedList.length === 0) return new Map();

  // 2. PPR 计算
  const rawScores = personalizedPageRank(graph, seedList, { alpha, maxIter, maxNodes });

  // 3. 归一化到 [0, 1]
  if (rawScores.size === 0) return rawScores;
  const maxScore = Math.max(...rawScores.values());
  if (maxScore === 0) return rawScores;

  const normalized = new Map();
  for (const [id, score] of rawScores) {
    normalized.set(id, score / maxScore);
  }

  return normalized;
}

// ── CLI 自检 ──────────────────────────────────────────────
// 确保 ESM 导入本模块时不自动执行
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.url)) {
  const args = process.argv.slice(2);
  const dataDir = path.resolve('.');
  console.log('[graph-reason] 构建图索引...');
  const graph = buildGraphIndex(dataDir);
  console.log('  stats:', JSON.stringify(graph.stats));

  // 测试查询
  const queries = args.length > 0 ? args : ['neural network', 'deep learning', 'quantum computing'];
  for (const q of queries) {
    console.log(`\n[query] "${q}"`);
    const t0 = performance.now();
    const scores = graphSearch(q, graph, { maxNodes: 10 });
    const elapsed = (performance.now() - t0).toFixed(1);
    console.log(`  耗时: ${elapsed}ms, 返回 ${scores.size} 节点`);
    for (const [id, sc] of [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      const node = graph.nodes.get(id);
      console.log(`  ${sc.toFixed(4)}  ${id} (${node?.type || '?'})`);
    }
  }
}