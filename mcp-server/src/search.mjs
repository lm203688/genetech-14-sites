/**
 * GeneTech 混合检索核心
 * ----------------------------------------------------------------------------
 *  replaces the old pure keyword-weighting `scoreEntity`.
 *
 *  检索管线（默认，零配置即可用）：
 *    1) BM25 倒排索引（真实词频/IDF 相关性，而非朴素 substring includes）
 *    2) 字段加权分数（标题强、标签/作者中、摘要弱，含置信度加权）
 *    3) RRF（Reciprocal Rank Fusion）融合两路排序 → 抗单路噪声
 *
 *  可选向量语义（env 门控，默认关闭，不影响离线/CI 部署）：
 *    设置 GENETECH_EMBED_URL（OpenAI 兼容 /embeddings 端点）后，
 *    首次检索时惰性对实体做嵌入并缓存到 <DATA_DIR>/state/embed-cache.json，
 *    再追加第三路「向量余弦」排序一并 RRF 融合，得到真正的语义召回。
 *
 *  本模块无任何第三方依赖，纯 Node 内置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildGraphIndex, graphSearch } from '../../lib/graph-reason.mjs';

const RRF_K = 60;

// ---------------------------------------------------------------------------
// 分词：英文/数字按词，CJK 按字（兼容中文检索词）
// ---------------------------------------------------------------------------
export function tokenize(text) {
  if (!text) return [];
  const s = String(text).toLowerCase();
  const tokens = [];
  // 英文/数字词
  const latin = s.match(/[a-z0-9]+/g);
  if (latin) tokens.push(...latin);
  // CJK 字符（按字切，简单但能命中中文标签/摘要）
  const cjk = s.match(/[一-鿿]/g);
  if (cjk) tokens.push(...cjk);
  return tokens;
}

function norm(vec) {
  let s = 0;
  for (const v of vec) s += v * v;
  return Math.sqrt(s) || 1;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (norm(a) * norm(b));
}

export class SearchIndex {
  constructor(entities) {
    // entities: 已带 _site 字段的扁平数组
    this.entities = entities;
    this.byId = new Map();
    this.docs = []; // { id, tf: Map, len, fields }
    for (const e of entities) {
      const id = e.id || `${e._site}:${e.name}`;
      this.byId.set(id, e);
      const name = e.name || e.title || '';
      const tags = Array.isArray(e.tags) ? e.tags.join(' ') : '';
      const abstract = e.abstract || '';
      const authors = Array.isArray(e.authors) ? e.authors.join(' ') : '';
      const source = e.source || '';
      const fields = { name, tags, abstract, authors, source };
      const tf = new Map();
      for (const t of tokenize(`${name} ${tags} ${abstract} ${authors} ${source}`)) {
        tf.set(t, (tf.get(t) || 0) + 1);
      }
      this.docs.push({ id, tf, len: tf.size || 1, fields });
    }
    // IDF
    const N = this.docs.length || 1;
    this.idf = new Map();
    const df = new Map();
    for (const d of this.docs) {
      for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    }
    for (const [t, c] of df) this.idf.set(t, Math.log(1 + (N - c + 0.5) / (c + 0.5)));
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / (this.docs.length || 1);
    // 向量缓存（可选）
    this.vectors = null; // Map id -> number[]
    this.embedUrl = '';
    this.embedModel = '';
    this.embedKey = '';
    this.dataDir = '';
    // 图推理（可选，Phase 1）
    this.graphIndex = null; // buildGraphIndex 返回的图索引
    this.useGraph = false;
    this.graphAlpha = 0.85;
    this.graphMaxNodes = 200;
    this.graphWeight = 0.6; // PPR 在 RRF 中的权重
    // Phase 2: tag 精确匹配索引
    this.tagIndex = new Map(); // normalizedTag -> Set<entityId>
    this._buildTagIndex(entities);
  }

  // ---- Phase 2: Tag 精确匹配索引 ----
  /**
   * 构建 tag 倒排索引。每个实体的每个 tag 归一化后建索引。
   * 归一化：lowercase + trim + 去除常见前缀（FOS:, cs., arxiv: 等）
   */
  _buildTagIndex(entities) {
    for (const e of entities) {
      const id = e.id || `${e._site}:${e.name}`;
      if (!e.tags || !Array.isArray(e.tags)) continue;
      for (const tag of e.tags) {
        const normalized = this._normalizeTag(tag);
        for (const key of normalized) {
          if (!this.tagIndex.has(key)) this.tagIndex.set(key, new Set());
          this.tagIndex.get(key).add(id);
        }
      }
    }
  }

  /**
   * 归一化 tag 字符串：返回可匹配的 key 集合。
   * 原始 tag + 去前缀版 + 分词版，确保查询的多种格式都能命中。
   */
  _normalizeTag(tag) {
    const keys = new Set();
    const t = tag.toLowerCase().trim();
    if (!t) return keys;
    // 原始
    keys.add(t);
    // 去除常见前缀
    const stripped = t.replace(/^(fos|arxiv|doi|pmid|cs|q-bio|hep|physics|math|stat|cond-mat|eess|physics\.|astro-ph\.|nucl-)?[-:.]? ?/, '');
    if (stripped && stripped !== t) keys.add(stripped);
    // 分词后的单词组合（处理 "cs.lg" → "cs lg", "cs lg" → "lg"）
    const parts = t.split(/[.\s]+/).filter(Boolean);
    if (parts.length > 1) {
      // 全组合（最多2-gram）
      for (let i = 0; i < parts.length; i++) {
        keys.add(parts[i]);
        if (i < parts.length - 1) keys.add(parts.slice(i, i + 2).join(' '));
      }
    }
    return keys;
  }

  /**
   * Tag 精确匹配打分：查询中的词与实体 tag 精确匹配时给予高分。
   * 比 fieldScore 的 substring 匹配更精准——只有查询词恰好是某个 tag 的 token 时才加分。
   */
  tagScore(query) {
    const qTerms = tokenize(query);
    const out = new Map();
    if (!qTerms.length) return out;
    for (const d of this.docs) {
      let score = 0;
      const ent = this.byId.get(d.id);
      if (!ent || !ent.tags || !Array.isArray(ent.tags)) continue;
      // 构建该实体的归一化 tag 集合
      const entTagKeys = new Set();
      for (const tag of ent.tags) {
        for (const key of this._normalizeTag(tag)) {
          entTagKeys.add(key);
        }
      }
      for (const t of qTerms) {
        if (entTagKeys.has(t)) {
          // 精确 tag token 匹配：+8（远高于 fieldScore 的 +3 substring）
          score += 8;
        }
      }
      // 整查询短语匹配：查询整体是某个 tag 的子串
      const qLower = query.toLowerCase().trim();
      for (const tag of ent.tags) {
        const tl = tag.toLowerCase().trim();
        if (tl.includes(qLower) || qLower.includes(tl)) {
          score += 12; // 短语级匹配额外奖励
          break;
        }
      }
      if (score > 0) {
        out.set(d.id, score);
      }
    }
    return out;
  }

  // ---- BM25 ----
  bm25(query, k = 1.5, b = 0.75) {
    const qTerms = tokenize(query);
    const scores = new Map();
    if (!qTerms.length) return scores;
    for (const d of this.docs) {
      let score = 0;
      for (const t of qTerms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const idf = this.idf.get(t) || 0;
        score += idf * ((f * (k + 1)) / (f + k * (1 - b + b * (d.len / this.avgLen))));
      }
      if (score > 0) scores.set(d.id, score);
    }
    return scores;
  }

  // ---- 字段加权（提升可解释性，命中标题/标签权重更高） ----
  fieldScore(query) {
    const q = tokenize(query);
    const out = new Map();
    if (!q.length) return out;
    for (const d of this.docs) {
      let score = 0;
      const name = d.fields.name.toLowerCase();
      const tags = d.fields.tags.toLowerCase();
      const abstract = d.fields.abstract.toLowerCase();
      const authors = d.fields.authors.toLowerCase();
      const source = d.fields.source.toLowerCase();
      for (const t of q) {
        if (name.includes(t)) score += 6;
        if (tags.includes(t)) score += 3;
        if (authors.includes(t)) score += 2;
        if (source.includes(t)) score += 1;
        if (abstract.includes(t)) score += 1;
      }
      if (score > 0) {
        // 仅在已有命中时追加置信度权重，避免无匹配实体被强加分数
        const ent = this.byId.get(d.id);
        if (ent && typeof ent.confidence === 'number') score += ent.confidence * 2;
        out.set(d.id, score);
      }
    }
    return out;
  }

  // ---- RRF 融合多路 rank（支持加权） ----
  /**
   * @param {Map[]} rankLists  每路 rank → score map
   * @param {number[]} [weights] 每路权重（默认全 1）。
   *   当向量路径启用时，BM25=1.0, field=0.8, cosine=0.5，
   *   避免向量信号稀释 BM25 的强排名。
   */
  rrf(rankLists, weights) {
    const fused = new Map();
    for (let li = 0; li < rankLists.length; li++) {
      const rankList = rankLists[li];
      const w = weights?.[li] ?? 1;
      const arr = [...rankList.entries()].sort((a, b) => b[1] - a[1]);
      arr.forEach(([id], i) => {
        fused.set(id, (fused.get(id) || 0) + w / (RRF_K + i));
      });
    }
    return fused;
  }

  // ---- 惰性建向量（env 门控） ----
  /**
   * @param {Object} opts
   * @param {string} opts.embedUrl      OpenAI 兼容端点
   * @param {string} opts.embedModel    模型名（如 bge-m3）
   * @param {string} opts.embedKey      可选 API Key
   * @param {string} opts.dataDir       数据根目录（用作默认缓存目录）
   * @param {string} [opts.cacheFile]   显式缓存文件路径（优先于 dataDir/state/embed-cache.json）
   *                                    用于分片缓存（每站独立文件，避免大文件合并）
   */
  async enableVector({ embedUrl, embedModel, embedKey, dataDir, cacheFile }) {
    this.embedUrl = embedUrl;
    this.embedModel = embedModel;
    this.embedKey = embedKey || '';
    this.dataDir = dataDir || '';
    this.cacheFile = cacheFile || '';
    await this._loadOrBuildVectors();
  }

  async _embed(text) {
    // Ollama /api/embeddings 单条端点用 prompt；OpenAI 兼容端点用 input。
    // 两者都发，服务端取它认的那个。文本截断 2000 字符防上下文溢出。
    const res = await fetch(this.embedUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.embedKey ? { authorization: `Bearer ${this.embedKey}` } : {}),
      },
      body: JSON.stringify({ model: this.embedModel, prompt: text.slice(0, 2000), input: text.slice(0, 2000) }),
    });
    if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
    const j = await res.json();
    return j.data?.[0]?.embedding || j.embeddings?.[0] || j.embedding;
  }

  async _loadOrBuildVectors() {
    // 缓存路径优先级：显式 cacheFile > dataDir/state/embed-cache.json
    const cachePath = this.cacheFile
      || (this.dataDir ? path.join(this.dataDir, 'state', 'embed-cache.json') : '');
    const cache = new Map();
    if (cachePath && fs.existsSync(cachePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        for (const [id, v] of Object.entries(raw)) cache.set(id, v);
      } catch {
        /* 忽略损坏缓存 */
      }
    }
    const missing = this.docs.filter((d) => !cache.has(d.id));
    if (missing.length) {
      for (const d of missing) {
        const text = `${d.fields.name}. ${d.fields.tags}. ${d.fields.abstract}`;
        try {
          cache.set(d.id, await this._embed(text));
        } catch (e) {
          console.error(`[embed] 跳过 ${d.id}: ${e.message}`);
        }
      }
      if (cachePath) {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(Object.fromEntries(cache)));
      }
    }
    this.vectors = cache;
  }

  // ---- 图推理（Phase 1: PPR 图语义召回） ----
  /**
   * @param {Object} opts
   * @param {string} opts.dataDir       数据根目录（用于定位 knowledge-graph.json）
   * @param {number} [opts.alpha=0.85]  PPR restart probability
   * @param {number} [opts.maxNodes=200] PPR 返回最大节点数
   * @param {number} [opts.weight=0.6]   PPR 在 RRF 融合中的权重
   */
  enableGraph({ dataDir, alpha = 0.85, maxNodes = 200, weight = 0.6 }) {
    this.dataDir = dataDir || this.dataDir || '';
    this.graphAlpha = alpha;
    this.graphMaxNodes = maxNodes;
    this.graphWeight = weight;
    try {
      this.graphIndex = buildGraphIndex(this.dataDir);
      this.useGraph = true;
    } catch (e) {
      console.error(`[graph] 图推理加载失败: ${e.message}`);
      this.useGraph = false;
    }
  }

  // ---- 主入口：混合检索（异步，兼容向量路径） ----
  /**
   * Phase 0.2 + Phase 1: BM25-gated cosine + PPR-as-fallback 图召回
   *
   * 管线：
   *   1) BM25 + field → RRF 融合
   *   2) PPR-as-fallback：仅当 BM25 候选集 < FALLBACK_THRESHOLD 时触发，
   *      用 PPR 扩展候选集（而非全局重排，避免干扰 BM25 强信号）
   *   3) 如果向量可用，对最终候选集计算 cosine 精排
   *   4) 最终分数 = rrfScore × (1 + α_cos × cosine)
   *
   * 设计哲学：PPR 是"兜底召回"而非"全局重排"——
   *   - BM25 强时（abstract-mid / cross-entity）：PPR 不参与，保持词法排序纯净
   *   - BM25 弱时（site-topic / tags-inverse）：PPR 扩展候选集，提供图语义召回
   */
  async hybridSearch(query, { limit = 10, site = null } = {}) {
    const bm25 = this.bm25(query);
    const field = this.fieldScore(query);

    // 信号强度判断：BM25 最大分数
    let maxBm25 = 0;
    for (const sc of bm25.values()) {
      if (sc > maxBm25) maxBm25 = sc;
    }
    // 阈值：BM25 最大分数 > 30 视为强信号（abstract-mid 典型值 52-112）
    // 弱信号时启用 tag 通道（site-topic 典型值 4，tags-inverse 典型值 7-25）
    const STRONG_SIGNAL_THRESHOLD = 30;
    const useTag = maxBm25 < STRONG_SIGNAL_THRESHOLD;

    // 第一步：BM25 + field [+ tag] RRF 融合
    let fusedBf;
    if (useTag) {
      const tag = this.tagScore(query);
      // 弱信号：BM25(1.0) + field(0.8) + tag(0.7)
      fusedBf = this.rrf([bm25, field, tag], [1.0, 0.8, 0.7]);
    } else {
      // 强信号：纯 BM25(1.0) + field(0.8)，不引入 tag 干扰
      fusedBf = this.rrf([bm25, field]);
    }

    // 候选集：取融合后的 top-50
    const CANDIDATE_TOPN = 50;
    const candidateIds = new Set(
      [...fusedBf.entries()].sort((a, b) => b[1] - a[1]).slice(0, CANDIDATE_TOPN).map(([id]) => id)
    );

    // 第二步：PPR-as-fallback —— 仅当 BM25 候选不足时触发
    const FALLBACK_THRESHOLD = 10;
    if (this.useGraph && this.graphIndex && candidateIds.size < FALLBACK_THRESHOLD) {
      try {
        const pprScores = graphSearch(query, this.graphIndex, {
          alpha: this.graphAlpha,
          maxNodes: 200,
        });
        // 将 PPR 结果作为 RRF 的第三路（仅 entity 类型节点）
        const entityPpr = new Map();
        for (const [id, sc] of pprScores) {
          if (this.byId.has(id)) {
            entityPpr.set(id, sc);
          }
        }
        // RRF 融合：BM25(1.0) + field(0.8) + PPR(0.3)
        // PPR 权重低（0.3），确保 BM25 仍是主导信号
        const rankLists = [bm25, field];
        const weights = [1.0, 0.8];
        if (entityPpr.size > 0) {
          rankLists.push(entityPpr);
          weights.push(0.3);
        }
        // 用 RRF 替换 fusedBf（RRF 自动处理候选集扩展）
        Object.assign(fusedBf, this.rrf(rankLists, weights));
        // 更新候选集
        candidateIds.clear();
        for (const [id, sc] of fusedBf) {
          if (sc > 0) candidateIds.add(id);
        }
      } catch (e) {
        console.error(`[graph] PPR fallback 失败: ${e.message}`);
      }
    }

    // 第三步：可选向量精排（tag 已在第一步 RRF 中处理）
    // 向量加成：score = rrfScore × (1 + α_cos × cosine)
    const alphaCos = 0.5;
    let fused;
    if (this.vectors && this.vectors.size && candidateIds.size > 0) {
      try {
        const qv = await this._embed(`${query}`);
        const scored = new Map();
        for (const [id, rrfScore] of fusedBf.entries()) {
          if (!candidateIds.has(id)) {
            scored.set(id, rrfScore);
            continue;
          }
          const v = this.vectors.get(id);
          if (v) {
            const c = cosine(qv, v);
            if (c > 0) {
              scored.set(id, rrfScore * (1 + alphaCos * c));
              continue;
            }
          }
          scored.set(id, rrfScore);
        }
        fused = scored;
      } catch (e) {
        console.error(`[embed] 向量精排失败，回退 BM25+field: ${e.message}`);
        fused = fusedBf;
      }
    } else {
      fused = fusedBf;
    }

    if (site) {
      const filtered = new Map();
      for (const [id, sc] of fused) {
        const ent = this.byId.get(id);
        if (ent && (ent._site === site || (ent.site && ent.site === site))) filtered.set(id, sc);
      }
      fused = filtered;
    }
    const ranked = [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
    return ranked.map(([id, score]) => ({ score: Number(score.toFixed(4)), entity: this.byId.get(id) }));
  }

}
