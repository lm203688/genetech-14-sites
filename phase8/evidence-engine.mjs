// phase8/evidence-engine.mjs
// Evidence Engine — 证据抽取 + 冲突标记 + 证据图谱构建
//
// 使用:
//   node phase8/evidence-engine.mjs <site-dir> [--limit N] [--out path]
//
// 输出:
//   <out>/evidence.json       — 实体 → 证据片段集合
//   <out>/conflicts.json      — 冲突证据列表
//   <out>/evidence-graph.json — 节点/边图
//
// 设计: 纯 Node 标准库, 0 外部依赖.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ============== 证据抽取 ==============

export function extractEvidence(entity) {
  const evidence = [];

  if (entity.abstract && entity.abstract.length > 100) {
    const sents = splitSentences(entity.abstract);
    if (sents[0]) evidence.push({ type: 'abstract-lead', text: sents[0], weight: 0.9 });
    if (sents.length > 1) evidence.push({ type: 'abstract-conclusion', text: sents[sents.length - 1], weight: 0.85 });
    for (let i = 1; i < sents.length - 1; i++) {
      if (/\d+(\.\d+)?\s?(%|percent|\$|USD|million|billion|×|fold|kb|MB|GB)/i.test(sents[i])) {
        evidence.push({ type: 'abstract-numeric', text: sents[i], weight: 0.95 });
      }
    }
  }

  const pubDate = entity.publishedDate || entity.date;
  if (pubDate) evidence.push({ type: 'metadata-date', text: pubDate, weight: 1.0 });
  if (entity.license) evidence.push({ type: 'metadata-license', text: entity.license, weight: 1.0 });
  if (entity.doi) evidence.push({ type: 'metadata-doi', text: entity.doi, weight: 1.0 });
  if (entity.impactFactor) evidence.push({ type: 'metadata-impact', text: `IF=${entity.impactFactor}`, weight: 0.9 });
  if (entity.quality_tier) evidence.push({ type: 'metadata-quality', text: `tier=${entity.quality_tier}`, weight: 0.8 });
  if (entity.citationCount) evidence.push({ type: 'metadata-citation', text: `citations=${entity.citationCount}`, weight: 0.9 });
  if (entity.name) evidence.push({ type: 'metadata-name', text: entity.name, weight: 0.7 });
  if (entity.authors && Array.isArray(entity.authors) && entity.authors.length > 0) {
    evidence.push({ type: 'metadata-authors', text: entity.authors.join(', '), weight: 0.8 });
  }
  if (entity.tags) {
    for (const t of entity.tags.slice(0, 5)) {
      evidence.push({ type: 'metadata-tag', text: t, weight: 0.75 });
    }
  }

  return evidence;
}

export function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+/).filter(s => s.length > 15);
}

// ============== 冲突检测 ==============

export function detectConflict(evidenceA, evidenceB) {
  const conflicts = [];
  const numsA = extractNumbers(evidenceA.text);
  const numsB = extractNumbers(evidenceB.text);
  if (numsA.length > 0 && numsB.length > 0) {
    const shared = sharedWords(evidenceA.text, evidenceB.text);
    if (shared.length >= 2) {
      const different = numsA.filter(n => !numsB.includes(n));
      if (different.length > 0 && numsA.length <= 5) {
        conflicts.push({
          type: 'numeric-conflict',
          evidenceA: { text: evidenceA.text, type: evidenceA.type },
          evidenceB: { text: evidenceB.text, type: evidenceB.type },
          numbersA: numsA,
          numbersB: numsB,
          sharedContext: shared,
          severity: 'medium'
        });
      }
    }
  }
  return conflicts;
}

function extractNumbers(text) {
  return (text.match(/-?\d+\.?\d*/g) || []).map(Number).filter(n => !isNaN(n));
}

function sharedWords(a, b) {
  const aTokens = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length >= 4));
  const bTokens = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length >= 4));
  return [...aTokens].filter(w => bTokens.has(w));
}

// ============== 证据图谱 ==============

export function buildEvidenceGraph(entities, evidences) {
  const nodes = [];
  const edges = [];
  const seen = new Set();

  for (const e of entities) {
    const id = `entity:${e.id}`;
    if (!seen.has(id)) {
      nodes.push({ id, type: 'entity', label: e.name, source: 'entity' });
      seen.add(id);
    }
    for (const ev of evidences[e.id] || []) {
      const evId = `evidence:${e.id}:${ev.type}:${ev.text.slice(0, 60)}`;
      if (!seen.has(evId)) {
        nodes.push({ id: evId, type: 'evidence', label: ev.text.slice(0, 120), weight: ev.weight, source: ev.type });
        seen.add(evId);
      }
      edges.push({ from: id, to: evId, type: 'has-evidence', weight: ev.weight });
    }
  }

  return { nodes, edges, stats: { nodeCount: nodes.length, edgeCount: edges.length } };
}

// ============== CLI ==============

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { site: null, limit: 500, out: null };
  const positional = argv.filter(a => !a.startsWith('--'));
  opts.site = positional[0];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') opts.limit = parseInt(argv[++i]);
    else if (argv[i] === '--out') opts.out = argv[++i];
  }
  return opts;
}

async function run(opts) {
  const siteDir = path.join(ROOT, opts.site);
  const outDir = opts.out || path.join(siteDir, 'evidence-graph');
  if (!fs.existsSync(siteDir)) {
    console.error(`✗ site not found: ${opts.site}`);
    process.exit(1);
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // 优先读 site/website/api/entities.json (30 站真实数据, 全字段)
  // 回退到 .workbuddy/probe/site-X.json.gz (3 站抽样, 精简字段)
  const realPath = path.join(ROOT, opts.site, 'website', 'api', 'entities.json');
  const gzPath = path.join(ROOT, '.workbuddy', 'probe', `site-${opts.site}.json.gz`);
  let data;
  if (fs.existsSync(realPath)) {
    data = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
    console.log(`  (source: ${realPath})`);
  } else if (fs.existsSync(gzPath)) {
    data = JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)).toString());
    console.log(`  (source: ${gzPath})`);
  } else {
    console.error(`✗ data not found: tried ${realPath} and ${gzPath}`);
    process.exit(1);
  }
  const entities = Array.isArray(data) ? data : data.entities || [];
  const sample = entities.slice(0, opts.limit);

  console.log(`▸ ${opts.site}: ${sample.length} entities → evidence extraction`);

  const evidences = {};
  let totalEvidence = 0;
  const evidenceTypes = {};
  for (const e of sample) {
    const evs = extractEvidence(e);
    evidences[e.id] = evs;
    totalEvidence += evs.length;
    for (const ev of evs) {
      evidenceTypes[ev.type] = (evidenceTypes[ev.type] || 0) + 1;
    }
  }

  // 冲突检测: 每 100 实体抽样 5 对
  const conflicts = [];
  const step = Math.max(1, Math.floor(sample.length / 100));
  for (let i = 0; i < sample.length; i += step) {
    for (let j = i + 1; j < Math.min(i + 5, sample.length); j++) {
      const evsA = evidences[sample[i].id] || [];
      const evsB = evidences[sample[j].id] || [];
      for (const a of evsA) {
        for (const b of evsB) {
          if (a.type === b.type && (a.type === 'abstract-numeric' || a.type === 'metadata-impact')) {
            conflicts.push(...detectConflict(a, b));
          }
        }
      }
    }
  }

  const graph = buildEvidenceGraph(sample, evidences);

  const evOut = path.join(outDir, 'evidence.json');
  const cfOut = path.join(outDir, 'conflicts.json');
  const gpOut = path.join(outDir, 'evidence-graph.json');
  fs.writeFileSync(evOut, JSON.stringify({ entityCount: sample.length, evidenceCount: totalEvidence, evidenceTypes, evidences }, null, 2));
  fs.writeFileSync(cfOut, JSON.stringify({ conflictCount: conflicts.length, conflicts }, null, 2));
  fs.writeFileSync(gpOut, JSON.stringify(graph));

  console.log(`✓ evidence: ${totalEvidence} (${Object.entries(evidenceTypes).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}=${v}`).join(', ')})`);
  console.log(`✓ conflicts: ${conflicts.length}`);
  console.log(`✓ graph: ${graph.stats.nodeCount} nodes / ${graph.stats.edgeCount} edges`);
  console.log(`✓ output: ${outDir}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  run(parseArgs()).catch(e => { console.error('✗', e); process.exit(1); });
}
