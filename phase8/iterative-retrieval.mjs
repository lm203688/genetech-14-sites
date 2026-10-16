// phase8/iterative-retrieval.mjs
// Iterative Retrieval - 递归检索
//
// 目标：初检索 → gap 检测 → 补检索 → 融合
//
// 流程：
//   1. 用 query-decomposer 分解查询
//   2. 对每个子查询跑一次混合检索
//   3. 检查 gap: 覆盖度、多样性、置信度分布
//   4. 若有 gap，用剩余未尝试的关键词补检索
//   5. 融合：加权合并去重结果
//
// 使用：
//   node phase8/iterative-retrieval.mjs --query "AI safety and autonomous agents" --limit 10
//   node phase8/iterative-retrieval.mjs --query "quantum computing" --site quantum-computing

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

import { decomposeQuery } from './query-decomposer.mjs';
import { buildHybridRetriever } from './retrieval-engine.mjs';

const SITE_DIRS = ['robot-parts', 'bionic-ai', 'agent-ecosystem', 'ai4science', 'biomed-ai',
  'quantum-computing', 'neuromorphic', 'edge-ai', 'ai-safety', 'semiconductor',
  'deep-sea-tech', 'nuclear-energy', 'brain-science', 'life-science'];

function loadEntities(site) {
  const realPath = path.join(ROOT, site, 'website', 'api', 'entities.json');
  const gzPath = path.join(ROOT, '.workbuddy', 'probe', `site-${site}.json.gz`);
  let d;
  if (fs.existsSync(realPath)) d = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
  else if (fs.existsSync(gzPath)) d = JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)).toString());
  else return [];
  const arr = Array.isArray(d) ? d : (d.entities || []);
  arr.forEach(e => { if (!e._site) e._site = site; });
  return arr;
}

export async function iterativeRetrieve(query, { limit = 10, maxIter = 3, minCoverage = 0.3, site = null } = {}) {
  const entities = site ? loadEntities(site) : SITE_DIRS.flatMap(loadEntities);
  if (!entities.length) return { error: 'no entities loaded' };

  const retriever = buildHybridRetriever(entities);
  const subs = decomposeQuery(query);
  if (!subs.length) {
    // 分解失败则直接检索原查询
    const results = retriever.search(query, { limit });
    return { query, subQueries: [{ text: query, weight: 1 }], iterations: 1, gap: false, results };
  }

  const seen = new Set();
  let allResults = [];
  const iterations = [];
  let gapDetected = false;

  // 迭代 1: 按子查询检索
  for (let i = 0; i < subs.length && i < maxIter; i++) {
    const sq = subs[i];
    const hits = retriever.search(sq.text, { limit });
    const fresh = hits.filter(h => !seen.has(h.entity.id));
    fresh.forEach(h => seen.add(h.entity.id));
    iterations.push({ step: i + 1, query: sq.text, weight: sq.weight, hits: hits.length, fresh: fresh.length });
    allResults = allResults.concat(fresh.map(h => ({ ...h, weight: sq.weight })));
    if (allResults.length >= limit) break;
  }

  // gap 检测
  const coverage = subs.length > 0 ? allResults.length / (subs.length * limit) : 0;
  if (coverage < minCoverage) gapDetected = true;

  // 补检索：用原查询整体再检一次
  if (gapDetected && iterations.length < maxIter) {
    const hits = retriever.search(query, { limit });
    const fresh = hits.filter(h => !seen.has(h.entity.id));
    fresh.forEach(h => seen.add(h.entity.id));
    iterations.push({ step: 'gap-fill', query: query, weight: 0.5, hits: hits.length, fresh: fresh.length });
    allResults = allResults.concat(fresh.map(h => ({ ...h, weight: 0.5 })));
  }

  // 融合：按加权 score 排序
  allResults.sort((a, b) => (b.score * b.weight) - (a.score * a.weight));
  allResults = allResults.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));

  return {
    query, subQueries: subs, iterations, gapDetected,
    resultCount: allResults.length,
    coverage: coverage.toFixed(3),
    stats: retriever.stats(),
    results: allResults.map(r => ({
      entity: { id: r.entity.id, name: r.entity.name, _site: r.entity._site },
      score: r.score.toFixed(3), weight: r.weight, rank: r.rank,
    })),
  };
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { query: null, limit: 10, maxIter: 3, minCoverage: 0.3, site: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--query') opts.query = argv[++i];
    else if (argv[i] === '--limit') opts.limit = parseInt(argv[++i]);
    else if (argv[i] === '--max-iter') opts.maxIter = parseInt(argv[++i]);
    else if (argv[i] === '--min-coverage') opts.minCoverage = parseFloat(argv[++i]);
    else if (argv[i] === '--site') opts.site = argv[++i];
  }
  return opts;
}

async function run(opts) {
  if (!opts.query) {
    console.error('Usage: node phase8/iterative-retrieval.mjs --query "text" [--limit N] [--site site]');
    process.exit(1);
  }
  const t0 = performance.now();
  const r = await iterativeRetrieve(opts.query, opts);
  const ms = performance.now() - t0;

  console.log('query: ' + opts.query);
  console.log('sub-queries: ' + r.subQueries.length);
  console.log('gap: ' + r.gapDetected + ', coverage: ' + r.coverage + ', iterations: ' + r.iterations.length);
  console.log('ms: ' + ms.toFixed(0));
  console.log('top ' + r.resultCount + ':');
  for (const r2 of r.results.slice(0, 10)) {
    console.log('  ' + r2.rank + '. [' + (r2.entity._site||"?") + '] ' + r2.entity.name + ' (score=' + r2.score + ')');
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  run(parseArgs()).catch(e => { console.error('ERR', e); process.exit(1); });
}
