// phase8/retrieval-engine.mjs
// Retrieval Engine — 混合检索编排 (BM25 + TF-IDF + 结构化过滤)
//
// 使用:
//   node phase8/retrieval-engine.mjs --query "AI safety" [--site ai4science] [--limit 10]
//   node phase8/retrieval-engine.mjs --query "semiconductor" --filter domain=semiconductor
//
// 设计: 纯 Node 标准库, 0 外部依赖, 支持多站联合检索.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ============== Tokenizer ==============

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall',
  'of', 'in', 'to', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'and', 'or', 'but', 'not', 'so', 'if', 'while', 'than', 'that', 'this', 'these', 'those',
  'it', 'its', 'i', 'we', 'you', 'he', 'she', 'they', 'me', 'him', 'her', 'them',
  'which', 'who', 'whom', 'what', 'when', 'where', 'why', 'how',
  's', 't', 'd', 'll', 're', 've', 'm', 'also', 'more', 'most', 'very', 'too',
  'just', 'now', 'then', 'such', 'no', 'nor', 'all', 'any', 'both', 'each', 'every',
  'some', 'other', 'another', 'only', 'own', 'same', 'about', 'over', 'under', 'up',
  'down', 'out', 'off', 'above', 'below', 'between', 'before', 'after', 'here', 'there',
  'one', 'two', 'new', 'first', 'last', 'using', 'use', 'used',
]);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOPWORDS.has(w));
}

// ============== BM25 ==============

export class BM25Index {
  constructor(entities) {
    this.entities = entities;
    this.N = entities.length;
    this.k1 = 1.5;
    this.b = 0.75;
    this.docTokens = entities.map(e => tokenize((e.name || '') + ' ' + (e.abstract || '') + ' ' + (e.tags || []).join(' ')));
    this.docLengths = this.docTokens.map(t => t.length);
    this.avgDl = this.docLengths.reduce((a, b) => a + b, 0) / Math.max(1, this.N);
    this.df = new Map();
    this.tf = [];
    for (const tokens of this.docTokens) {
      const freq = new Map();
      for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
      this.tf.push(freq);
      for (const t of freq.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
  }

  idf(term) {
    const d = this.df.get(term) || 0;
    if (d === 0) return 0;
    return Math.log((this.N - d + 0.5) / (d + 0.5) + 1);
  }

  score(query) {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return new Array(this.N).fill(0);
    const scores = new Array(this.N).fill(0);
    for (const term of qTokens) {
      const idf = this.idf(term);
      if (idf <= 0) continue;
      for (let i = 0; i < this.N; i++) {
        const tf = this.tf[i].get(term) || 0;
        if (tf === 0) continue;
        const dl = this.docLengths[i];
        scores[i] += idf * (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (dl / this.avgDl)));
      }
    }
    return scores;
  }
}

// ============== 结构化过滤 ==============

export function applyFilter(entities, filterStr) {
  if (!filterStr) return entities;
  return entities.filter(e => {
    for (const part of filterStr.split('&')) {
      const [k, v] = part.split('=');
      if (!k || !v) continue;
      const val = e[k];
      if (Array.isArray(val)) {
        if (!val.some(x => String(x).toLowerCase().includes(v.toLowerCase()))) return false;
      } else if (val != null) {
        if (!String(val).toLowerCase().includes(v.toLowerCase())) return false;
      } else {
        return false;
      }
    }
    return true;
  });
}

// ============== 混合检索编排 ==============

export function buildHybridRetriever(entities) {
  const bm25 = new BM25Index(entities);
  return {
    search(query, { limit = 10, filter = null } = {}) {
      const candidates = filter ? applyFilter(entities, filter) : entities;
      const scores = bm25.score(query);
      const qTokens = tokenize(query);

      const results = [];
      for (let i = 0; i < entities.length; i++) {
        if (candidates.indexOf(entities[i]) === -1) continue;
        let s = scores[i];
        const e = entities[i];
        // 结构化加分
        if (e.doi && qTokens.some(t => e.doi.toLowerCase().includes(t))) s += 1;
        const pd = e.publishedDate || e.date; if (pd && qTokens.includes(String(pd).slice(0, 4))) s += 0.5;
        if (s > 0) results.push({ entity: e, score: s, rank: 0 });
      }

      results.sort((a, b) => b.score - a.score).slice(0, limit);
      return results.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));
    },
    stats: () => ({ N: bm25.N, terms: bm25.df.size, avgDocLen: bm25.avgDl })
  };
}

// ============== CLI ==============

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { query: null, site: null, limit: 10, filter: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--query') opts.query = argv[++i];
    else if (argv[i] === '--site') opts.site = argv[++i];
    else if (argv[i] === '--limit') opts.limit = parseInt(argv[++i]);
    else if (argv[i] === '--filter') opts.filter = argv[++i];
  }
  return opts;
}

async function run(opts) {
  if (!opts.query) {
    console.error('Usage: node phase8/retrieval-engine.mjs --query "text" [--site ai4science] [--limit N] [--filter key=value]');
    process.exit(1);
  }

  const allEntities = [];
  const sites = [];
  if (opts.site) {
    const realPath = path.join(ROOT, opts.site, 'website', 'api', 'entities.json');
    const gzPath = path.join(ROOT, '.workbuddy', 'probe', `site-${opts.site}.json.gz`);
    let d;
    if (fs.existsSync(realPath)) d = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
    else if (fs.existsSync(gzPath)) d = JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)).toString());
    else { console.error(`✗ data not found for ${opts.site}`); process.exit(1); }
    (Array.isArray(d) ? d : (d.entities || [])).forEach(e => { if (!e._site) e._site = opts.site; allEntities.push(e); });
    sites.push(opts.site);
  } else {
    // 优先扫描 site/website/api/entities.json (30 站)
    // 回退到 .workbuddy/probe/site-*.json.gz (3 站)
    const siteDirs = fs.readdirSync(ROOT).filter(d => {
      try { return fs.statSync(path.join(ROOT, d)).isDirectory(); } catch { return false; }
    });
    for (const name of siteDirs) {
      const realPath = path.join(ROOT, name, 'website', 'api', 'entities.json');
      const gzPath = path.join(ROOT, '.workbuddy', 'probe', `site-${name}.json.gz`);
      let d = null;
      if (fs.existsSync(realPath)) {
        d = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
      } else if (fs.existsSync(gzPath)) {
        d = JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)).toString());
      }
      if (d) {
        (Array.isArray(d) ? d : (d.entities || [])).forEach(e => { if (!e._site) e._site = name; allEntities.push(e); });
        sites.push(name);
      }
    }
  }

  console.log(`▸ 加载 ${allEntities.length} 实体 (${sites.length} 站)`);
  const t0 = performance.now();
  const retriever = buildHybridRetriever(allEntities);
  const buildMs = performance.now() - t0;
  const stats = retriever.stats();
  console.log(`▸ 索引构建: ${buildMs.toFixed(0)}ms, avgDocLen=${stats.avgDocLen.toFixed(1)} tokens`);

  const q0 = performance.now();
  const results = retriever.search(opts.query, { limit: opts.limit, filter: opts.filter });
  const qMs = performance.now() - q0;
  console.log(`\n▸ 查询: "${opts.query}" — ${qMs.toFixed(1)}ms, ${results.length} 结果\n`);

  results.forEach((r, i) => {
    const e = r.entity;
    const name = e.name || e.id;
    const doi = e.doi ? ` DOI=${e.doi}` : '';
    const year = e.date ? ` ${String(e.date).slice(0, 4)}` : '';
    console.log(`  ${i + 1}. [${(r.score * 100).toFixed(1)}] ${name}${doi}${year}`);
  });

  if (opts.filter) console.log(`  (filter: ${opts.filter})`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  run(parseArgs()).catch(e => { console.error('✗', e); process.exit(1); });
}
