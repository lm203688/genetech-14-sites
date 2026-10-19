// phase8/hypothesis-engine.mjs
// Hypothesis Engine — 关系推断 + 新连接发现
//
// 使用:
//   node phase8/hypothesis-engine.mjs <site> [--limit N] [--min-confidence 0.5]
//
// 输出:
//   hypotheses.json — 推断出的关系列表
//
// 关系类型:
//   - citation: 引用关系
//   - co-author: 共著关系
//   - similar-topic: 主题相似
//   - temporal-successor: 时序承接
//   - cross-domain: 跨领域关联
//
// 设计: 纯 Node, 无外部依赖. 基于规则 + 词向量重叠的启发式推断.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ============== 特征抽取 ==============

function getFeatures(entity) {
  return {
    tags: new Set(entity.tags || []),
    authors: new Set(entity.authors || []),
    year: entity.date ? parseInt(String(entity.date).slice(0, 4)) : null,
    journal: entity.journal || entity.source || null,
    domain: entity._site || entity.domain || null,
    keywords: extractKeywords(entity)
  };
}

function extractKeywords(entity) {
  const text = `${entity.name || ''} ${entity.abstract || ''}`.toLowerCase();
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4);
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w]) => w);
}

// ============== 关系推断规则 ==============

function inferRelations(e1, e2, f1, f2) {
  const relations = [];

  // 1) citation: 检查 abstract 是否提及对方 title
  if (e1.abstract && e2.name && e1.abstract.toLowerCase().includes(e2.name.toLowerCase().slice(0, 30))) {
    relations.push({ type: 'citation', confidence: 0.85, source: 'textual-mention', entity1: e1.id, entity2: e2.id });
  }

  // 2) co-author: 共同作者
  const sharedAuthors = [...f1.authors].filter(a => f2.authors.has(a));
  if (sharedAuthors.length >= 1) {
    relations.push({
      type: 'co-author',
      confidence: Math.min(0.95, 0.5 + sharedAuthors.length * 0.05),
      source: 'shared-authors',
      sharedAuthors,
      entity1: e1.id, entity2: e2.id
    });
  }

  // 3) similar-topic: tag/keyword 重叠
  const sharedTags = [...f1.tags].filter(t => f2.tags.has(t));
  const sharedKeywords = f1.keywords.filter(k => f2.keywords.includes(k));
  const tagScore = sharedTags.length * 0.2;
  const kwScore = sharedKeywords.length * 0.15;
  const topicConf = Math.min(0.9, tagScore + kwScore);
  if (topicConf >= 0.4) {
    relations.push({
      type: 'similar-topic',
      confidence: topicConf,
      source: 'topic-overlap',
      sharedTags,
      sharedKeywords,
      entity1: e1.id, entity2: e2.id
    });
  }

  // 4) temporal-successor: 同 journal 且年份连续
  if (f1.journal && f1.journal === f2.journal && f1.year && f2.year) {
    const yearDiff = Math.abs(f1.year - f2.year);
    if (yearDiff <= 2) {
      const earlier = f1.year < f2.year ? e1 : e2;
      const later = f1.year < f2.year ? e2 : e1;
      relations.push({
        type: 'temporal-successor',
        confidence: 0.6 - yearDiff * 0.1,
        source: 'temporal-continuation',
        earlier: earlier.id,
        later: later.id
      });
    }
  }

  // 5) cross-domain: 不同站但 topic 重叠
  if (f1.domain && f2.domain && f1.domain !== f2.domain && sharedTags.length >= 1) {
    relations.push({
      type: 'cross-domain',
      confidence: 0.4 + Math.min(0.4, sharedTags.length * 0.1),
      source: 'cross-domain-bridge',
      domain1: f1.domain,
      domain2: f2.domain,
      sharedTags,
      entity1: e1.id, entity2: e2.id
    });
  }

  return relations;
}

// ============== 主流程 ==============

export function discoverHypotheses(entities, { minConfidence = 0.5, sampleSize = null } = {}) {
  const sample = sampleSize ? entities.slice(0, sampleSize) : entities;
  const features = sample.map(getFeatures);
  const hypotheses = [];
  const relationCounts = {};

  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < Math.min(i + 100, sample.length); j++) {
      const rels = inferRelations(sample[i], sample[j], features[i], features[j]);
      for (const r of rels) {
        if (r.confidence >= minConfidence) {
          hypotheses.push(r);
          relationCounts[r.type] = (relationCounts[r.type] || 0) + 1;
        }
      }
    }
  }

  hypotheses.sort((a, b) => b.confidence - a.confidence);
  return {
    entityCount: sample.length,
    pairCount: sample.length * (sample.length - 1) / 2,
    hypothesisCount: hypotheses.length,
    relationCounts,
    avgConfidence: hypotheses.length ? (hypotheses.reduce((s, h) => s + h.confidence, 0) / hypotheses.length).toFixed(3) : 0,
    hypotheses
  };
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { site: null, limit: 500, minConfidence: 0.5, out: null };
  const positional = argv.filter(a => !a.startsWith('--'));
  opts.site = positional[0];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') opts.limit = parseInt(argv[++i]);
    else if (argv[i] === '--min-confidence') opts.minConfidence = parseFloat(argv[++i]);
    else if (argv[i] === '--out') opts.out = argv[++i];
  }
  return opts;
}

async function run(opts) {
  if (!opts.site) {
    console.error('Usage: node phase8/hypothesis-engine.mjs <site> [--limit N] [--min-confidence 0.5]');
    process.exit(1);
  }
  const realPath = path.join(ROOT, opts.site, 'website', 'api', 'entities.json');
  const gzPath = path.join(ROOT, '.workbuddy', 'probe', `site-${opts.site}.json.gz`);
  let data;
  if (fs.existsSync(realPath)) { data = JSON.parse(fs.readFileSync(realPath, 'utf-8')); console.log(`  (source: real)`); }
  else if (fs.existsSync(gzPath)) { data = JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)).toString()); console.log(`  (source: gz)`); }
  else { console.error(`✗ data not found: ${opts.site}`); process.exit(1); }
  const entities = (Array.isArray(data) ? data : (data.entities || [])).slice(0, opts.limit);
  entities.forEach(e => { if (!e._site) e._site = opts.site; });

  console.log(`▸ ${opts.site}: ${entities.length} entities → hypothesis discovery`);
  const t0 = performance.now();
  const result = discoverHypotheses(entities, { minConfidence: opts.minConfidence });
  const ms = performance.now() - t0;

  const outDir = opts.out || path.join(ROOT, opts.site, 'hypotheses');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'hypotheses.json');
  fs.writeFileSync(out, JSON.stringify(result, null, 2));

  console.log(`✓ 耗时: ${ms.toFixed(0)}ms`);
  console.log(`✓ 候选对: ${result.pairCount}`);
  console.log(`✓ 假设总数: ${result.hypothesisCount} (≥${opts.minConfidence} 置信度)`);
  console.log(`✓ 平均置信度: ${result.avgConfidence}`);
  console.log(`✓ 关系分布:`);
  for (const [type, count] of Object.entries(result.relationCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type}: ${count}`);
  }
  console.log(`\n▸ Top 5 假设:`);
  for (const h of result.hypotheses.slice(0, 5)) {
    console.log(`  [${(h.confidence * 100).toFixed(0)}%] ${h.type}: ${h.source}`);
  }
  console.log(`\n✓ output: ${out}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  run(parseArgs()).catch(e => { console.error('✗', e); process.exit(1); });
}
