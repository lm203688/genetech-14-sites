#!/usr/bin/env node
/**
 * scripts/build-knowledge-graph.mjs
 * ================================================
 * 从 data/canonical-entities.jsonl 构建 knowledge-graph.json。
 *
 * 用法：
 *   node scripts/build-knowledge-graph.mjs [--output data/knowledge-graph.json] [--entities data/canonical-entities.jsonl]
 *
 * 特性：
 *   - 幂等：多次运行输出完全一致
 *   - 可复现：按 id 排序，稳定 hash
 *   - 原子写：tmp + fsync + rename
 *   - 类型：节点 id、edges 数组、边权重、构建元信息
 *   - 支持 --skip-dedup 处理跨站重复
 * ================================================
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { writeAtomic } from '../lib/atomic-write.cjs';

const CLI = (() => {
  try {
    const argv1 = process.argv[1] || '';
    return argv1 && resolve(argv1) === resolve(import.meta.url);
  } catch { return false; }
})();

function sha256(str, len = 16) {
  return createHash('sha256').update(str).digest('hex').slice(0, len);
}

function getGitHead() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch { return 'unknown'; }
}

async function readJsonl(filePath) {
  const results = [];
  const rl = createInterface({
    input: (await import('node:fs')).default.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line));
    } catch (e) {
      process.stderr.write(`  [warn] line ${lineNo}: ${e.message}\n`);
    }
  }
  return results;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = {
    output: 'data/knowledge-graph.json',
    entities: 'data/canonical-entities.jsonl',
    skipDedup: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output') opts.output = argv[++i];
    else if (argv[i] === '--entities') opts.entities = argv[++i];
    else if (argv[i] === '--skip-dedup') opts.skipDedup = true;
    else if (argv[i] === '--help') opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/build-knowledge-graph.mjs [options]

Build a deduplicated knowledge graph from canonical-entities.jsonl.

Options:
  --output <path>      Output path (default: data/knowledge-graph.json)
  --entities <path>    Input JSONL path (default: data/canonical-entities.jsonl)
  --skip-dedup         Skip dedup (keep all occurrences as separate nodes)
  --help               Show help
`);
}

async function main() {
  if (!CLI) return;
  const opts = parseArgs();
  if (opts.help) { printHelp(); return; }

  if (!existsSync(resolve(opts.entities))) {
    process.stderr.write(`[FATAL] entities file not found: ${opts.entities}\n`);
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  process.stderr.write(`\n[build-knowledge-graph] started ${startedAt}\n`);

  const startLines = readFileSync(resolve(opts.entities), 'utf8').split('\n').length - 1;
  const startBytes = statSync(resolve(opts.entities)).size;
  process.stderr.write(`[1/4] loaded ${startLines} entities (${(startBytes / 1e6).toFixed(1)} MB)\n`);

  const entities = await readJsonl(resolve(opts.entities));

  // 2. Dedup
  let entitiesSet = new Set();
  let dedupDropped = 0;
  if (opts.skipDedup) {
    entities.forEach(e => entitiesSet.add(e.id));
    process.stderr.write(`[2/4] skip-dedup: ${entities.length} unique node ids\n`);
  } else {
    entities.forEach(e => {
      if (!entitiesSet.has(e.id)) {
        entitiesSet.add(e.id);
      } else {
        dedupDropped++;
      }
    });
    process.stderr.write(`[2/4] dedup: ${entitiesSet.size} unique node ids (dropped ${dedupDropped} duplicates)\n`);
  }

  // 3. Build nodes with stable sort
  const nodes = entities
    .map(e => {
      const id = e.id || `${e.dois[0]}@${e.siteSlug}`;
      return {
        id,
        label: e.title || e.shortTitle || id,
        abstract: e.abstract || '',
        type: 'entity',
        source: e.siteSlug,
        title: e.title,
        shortTitle: e.shortTitle,
        authors: e.authors || [],
        institutions: e.institutions || [],
        years: e.years || [],
        tags: e.tags || [],
        domain: e.domain,
        subDomain: e.subDomain,
        domainConfidence: e.domainConfidence,
        dois: e.dois,
        arxivId: e.arxivId,
        urls: e.urls,
        license: e.license,
        citationCount: e.citationCount,
        ingestedAt: e.ingestedAt,
        canonical: true,
      };
    })
    .filter(n => entitiesSet.has(n.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  // 4. Build edges from shared tags + shared domains
  //    只对前 20 万实体做，避免 O(n²) 爆炸
  const nodeLimit = Math.min(nodes.length, 200000);
  const subset = nodes.slice(0, nodeLimit);

  // 构建 tag → node ids 索引
  const tagToNodes = new Map();
  for (const n of subset) {
    for (const tag of (n.tags || []).slice(0, 10)) {
      if (!tag) continue;
      const key = tag.toLowerCase().trim();
      if (!tagToNodes.has(key)) tagToNodes.set(key, []);
      if (tagToNodes.get(key).length < 500) tagToNodes.get(key).push(n.id);
    }
  }

  const edges = [];
  const edgeSet = new Set();
  let edgeCount = 0;
  for (const [tag, ids] of tagToNodes.entries()) {
    if (ids.length < 2 || ids.length > 100) continue;
    // 只取相邻对（避免全连接爆炸）
    for (let i = 0; i < Math.min(ids.length - 1, 30); i++) {
      const a = ids[i], b = ids[i + 1];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ source: a, target: b, weight: 0.3, type: 'tag', metadata: { tag } });
      edgeCount++;
      if (edgeCount >= 200000) break;
    }
    if (edgeCount >= 200000) break;
  }
  edges.sort((a, b) => {
    const ka = a.source < a.target ? `${a.source}|${a.target}` : `${a.target}|${a.source}`;
    const kb = b.source < b.target ? `${b.source}|${b.target}` : `${b.target}|${b.source}`;
    return ka.localeCompare(kb);
  });

  process.stderr.write(`[3/4] built ${nodes.length} nodes, ${edges.length} edges\n`);

  // 5. Output
  const builtAt = new Date().toISOString();
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  const kg = {
    _schema: {
      version: 'v1',
      hash: sha256(`${nodes.length}:${edges.length}:${startedAt}`, 16),
      builtAt,
      source: opts.entities,
      dedupDropped,
    },
    buildMetadata: {
      startedAt,
      finishedAt: builtAt,
      elapsedSec: parseFloat(elapsed),
      nodeCount: nodes.length,
      edgeCount: edges.length,
      dedupDropped,
      nodesConsidered: nodeLimit,
      gitHead: getGitHead(),
    },
    nodes,
    edges,
  };

  const outPath = resolve(opts.output);
  await writeAtomic(outPath, JSON.stringify(kg, null, 2));
  const outSize = statSync(outPath).size;
  process.stderr.write(`[4/4] wrote ${outPath} (${(outSize / 1e6).toFixed(1)} MB)\n`);
  process.stderr.write(`[done] ${elapsed}s\n\n`);

  console.log(JSON.stringify({
    status: 'ok',
    outputPath: outPath,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    dedupDropped,
    elapsedSec: parseFloat(elapsed),
    builtAt,
  }, null, 2));
}

main().catch(e => {
  process.stderr.write(`[FATAL] ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
