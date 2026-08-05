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

  // ---- RRF 融合多路 rank ----
  rrf(rankLists) {
    const fused = new Map();
    for (const rankList of rankLists) {
      const arr = [...rankList.entries()].sort((a, b) => b[1] - a[1]);
      arr.forEach(([id], i) => {
        fused.set(id, (fused.get(id) || 0) + 1 / (RRF_K + i));
      });
    }
    return fused;
  }

  // ---- 惰性建向量（env 门控） ----
  async enableVector({ embedUrl, embedModel, embedKey, dataDir }) {
    this.embedUrl = embedUrl;
    this.embedModel = embedModel;
    this.embedKey = embedKey || '';
    this.dataDir = dataDir || '';
    await this._loadOrBuildVectors();
  }

  async _embed(text) {
    const res = await fetch(this.embedUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.embedKey ? { authorization: `Bearer ${this.embedKey}` } : {}),
      },
      body: JSON.stringify({ model: this.embedModel, input: text.slice(0, 2000) }),
    });
    if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
    const j = await res.json();
    return j.data?.[0]?.embedding || j.embedding;
  }

  async _loadOrBuildVectors() {
    const cachePath = this.dataDir
      ? path.join(this.dataDir, 'state', 'embed-cache.json')
      : '';
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

  // ---- 主入口：混合检索（异步，兼容向量路径） ----
  async hybridSearch(query, { limit = 10, site = null } = {}) {
    const bm25 = this.bm25(query);
    const field = this.fieldScore(query);
    const rankLists = [bm25, field];

    if (this.vectors && this.vectors.size) {
      try {
        const qv = await this._embed(`${query}`);
        const cos = new Map();
        for (const [id, v] of this.vectors) {
          const c = cosine(qv, v);
          if (c > 0) cos.set(id, c);
        }
        rankLists.push(cos);
      } catch (e) {
        console.error(`[embed] 向量检索失败，回退纯词法: ${e.message}`);
      }
    }

    let fused = this.rrf(rankLists);
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
