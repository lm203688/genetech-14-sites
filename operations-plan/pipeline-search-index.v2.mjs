#!/usr/bin/env node
/**
 * pipeline-search-index.v2.mjs — DataFlow-Agent 风格重构版
 *
 * 与 v1 (pipeline-search-index.js) 保持 API/输出兼容（同 OUT_PATH、同字段、同 version=v2），
 * 内部改用 flow.mjs 的 Operator + Dag + Ledger。
 *
 * 关键改动 vs v1：
 *   - 分片算子化（seed-index / merge-academic / sort / persist），可独立测
 *   - Ledger 每步追溯（每站读取条数、去重丢弃数、最终体积）
 *   - 原子写（tmp+rename）避免崩溃留下半文件
 *   - Report 结构统一（steps[] + elapsedMs + status）
 *
 * 上游：
 *   - 30 站 website/api/entities.json（per-site 实体，各 10K 满容）
 *   - data/academic-entities.json / pubmed-entities.json / crossref-entities.json / s2-entities.json
 * 下游：api-guard worker.js 的 /v1/search/semantic 端点
 *
 * 用法（与 v1 兼容）：
 *   node operations-plan/pipeline-search-index.v2.mjs
 *
 * 导出（供其他脚本复用）：
 *   module.exports = { main, tokenize, extractIndex, discoverSites }  ← v1 保持兼容
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Dag, Operator,
  writeJsonAtomic, readJsonSafe,
  parseArgs,
  PROJECT_ROOT,
} from './flow.mjs';

const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const OUT_PATH = path.join(DATA_DIR, 'search-index.json');
const REPORT_DIR = path.join(PROJECT_ROOT, 'reports');
const SNAPSHOT_PATH = path.join(REPORT_DIR, `search-index-${new Date().toISOString().slice(0, 10)}.json`);

const ACADEMIC_FILES = [
  'data/academic-entities.json',
  'data/pubmed-entities.json',
  'data/crossref-entities.json',
  'data/s2-entities.json',
];

// ============================================================================
// 提取逻辑（复用 v1，行为一致）
// ============================================================================

function discoverSites() {
  const sites = [];
  for (const entry of fs.readdirSync(PROJECT_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entitiesPath = path.join(PROJECT_ROOT, entry.name, 'website', 'api', 'entities.json');
    if (fs.existsSync(entitiesPath)) sites.push(entry.name);
  }
  return sites.sort();
}

function extractIndex(entities, site, { limit = 500, snippetLen = 120 } = {}) {
  const out = [];
  const sorted = [...entities].sort((a, b) => {
    const ac = typeof a?.confidence === 'number' ? a.confidence : 0;
    const bc = typeof b?.confidence === 'number' ? b.confidence : 0;
    return bc - ac;
  });
  for (const e of sorted.slice(0, limit)) {
    if (!e || !e.id) continue;
    const tags = Array.isArray(e.tags) ? e.tags : (typeof e.tags === 'string' ? [e.tags] : []);
    const name = typeof e.name === 'string' ? e.name : (typeof e.title === 'string' ? e.title : '');
    const abstract = typeof e.abstract === 'string' ? e.abstract : '';
    if (!abstract && !name) continue;
    const snippet = abstract.length > snippetLen ? abstract.slice(0, snippetLen) + '…' : (abstract || name.slice(0, snippetLen));
    const sites = Array.isArray(e.sites) ? e.sites : (site ? [site] : []);
    out.push({
      id: e.id,
      name,
      site: sites[0] || site || 'papers',
      sites,
      tags: tags.slice(0, 8),
      snippet,
      url: e.url || '',
      source: e.source || '',
      doi: e.doi || '',
      publishedDate: (e.publishedDate || (e.year ? String(e.year) : '')).slice(0, 10),
      year: typeof e.year === 'number' ? e.year : null,
      confidence: typeof e.confidence === 'number' ? e.confidence : 0,
      citedBy: typeof e.citedBy === 'number' ? e.citedBy : (typeof e.referencedBy === 'number' ? e.referencedBy : 0),
    });
  }
  return out;
}

function extractAcademic(entities, { snippetLen = 120 } = {}) {
  return extractIndex(entities, null, { limit: 100000, snippetLen });
}

function tokenize(s) {
  if (!s) return [];
  return String(s).toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !/^(the|and|for|with|from|that|this|are|was|were|have|has|had|into|over|upon|than|which|their|their|their)$/.test(t));
}

// ============================================================================
// Operators
// ============================================================================

/**
 * Step 1: 从 30 站 per-site entities.json 提取初始 index。
 * items 传入为空数组（seed），本算子返回 per-site 提取的 index 数组。
 */
async function seedIndex(items, ctx) {
  const sites = discoverSites();
  ctx.step(`[seed] 发现 ${sites.length} 站`);
  const out = [];
  const seen = new Set();
  let totalRead = 0;
  let dropped = 0;

  for (const site of sites) {
    const entitiesPath = path.join(PROJECT_ROOT, site, 'website', 'api', 'entities.json');
    try {
      const raw = fs.readFileSync(entitiesPath, 'utf8');
      const entities = JSON.parse(raw);
      totalRead += entities.length;
      const extracted = extractIndex(entities, site);
      for (const e of extracted) {
        if (seen.has(e.id)) { dropped++; continue; }
        seen.add(e.id);
        out.push(e);
      }
      ctx.ledger.record({
        event: 'site-read', runId: ctx.runId, site, read: entities.length, kept: extracted.length,
      });
    } catch (e) {
      ctx.warn(`[${site}] 跳过：${e.message}`);
      ctx.ledger.record({
        event: 'site-error', runId: ctx.runId, site, error: e.message,
      });
    }
  }

  ctx._stats = { totalRead, dropped, sites };
  return out;
}

/**
 * Step 2: 合并 data/ 下 4 个学术数据集（OpenAlex/PubMed/Crossref/S2）。
 * items = 上一步产出的 per-site index。
 * 用 DOI 去重，避免与 per-site 重复。
 */
async function mergeAcademic(items, ctx) {
  const seen = new Set(items.map((e) => e.id));
  const seenDoi = new Set(items.filter((e) => e.doi).map((e) => 'doi:' + e.doi));
  let dropped = 0;
  let academicAdded = 0;

  for (const rel of ACADEMIC_FILES) {
    const p = path.join(PROJECT_ROOT, rel);
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const entities = JSON.parse(raw);
      if (!Array.isArray(entities) || entities.length === 0) {
        ctx.step(`  [academic:${rel}] 跳过（空或不存在）`);
        continue;
      }
      const extracted = extractAcademic(entities);
      let n = 0;
      for (const e of extracted) {
        if (seen.has(e.id)) { dropped++; continue; }
        if (e.doi && seenDoi.has('doi:' + e.doi)) { dropped++; continue; }
        seen.add(e.id);
        if (e.doi) seenDoi.add('doi:' + e.doi);
        items.push(e);
        n++;
      }
      academicAdded += n;
      ctx.step(`  [academic:${rel}] +${n} (total in file: ${entities.length})`);
      ctx.ledger.record({
        event: 'academic-merged', runId: ctx.runId, file: rel, added: n, sourceCount: entities.length,
      });
    } catch (e) {
      // 文件可能不存在（如 s2-entities.json 尚未生成），静默跳过
    }
  }

  ctx.step(`[merge-academic] 学术数据集合并：+${academicAdded}`);
  ctx._stats.academicAdded = academicAdded;
  ctx._stats.dropped += dropped;
  return items;
}

/**
 * Step 3: 排序（confidence desc → publishedDate desc）。
 */
async function sortIndex(items, ctx) {
  items.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return (b.publishedDate || '').localeCompare(a.publishedDate || '');
  });
  ctx.step(`[sort] ${items.length} 条已排序`);
  return items;
}

/**
 * Step 4: 落盘 + 快照。
 */
async function persistIndex(items, ctx) {
  const started = ctx._stats.startedAt || Date.now();
  const output = {
    generatedAt: new Date().toISOString(),
    totalEntities: items.length,
    sourceSites: ctx._stats.sites?.length || 0,
    academicDatasets: ctx._stats.academicAdded || 0,
    entitiesRead: ctx._stats.totalRead || 0,
    dedupDropped: ctx._stats.dropped || 0,
    version: 'v2',
    entities: items,
  };

  if (!ctx.dryRun) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const json = JSON.stringify(output);
    writeJsonAtomic(OUT_PATH, json);  // 紧凑 JSON，与 v1 一致
    const sizeMB = (fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(2);
    const elapsed = Date.now() - started;
    writeJsonAtomic(SNAPSHOT_PATH, {
      generatedAt: output.generatedAt,
      totalEntities: output.totalEntities,
      sourceSites: output.sourceSites,
      entitiesRead: output.entitiesRead,
      dedupDropped: output.dedupDropped,
      sizeMB: parseFloat(sizeMB),
      elapsedMs: elapsed,
    });
    ctx.step(`[persist] ${OUT_PATH} (${sizeMB}MB, ${elapsed}ms)`);
    ctx.ledger.record({
      event: 'persist', runId: ctx.runId, path: OUT_PATH, sizeMB: parseFloat(sizeMB),
    });
    ctx._stats.sizeMB = parseFloat(sizeMB);
    ctx._stats.elapsedMs = elapsed;
  }
  ctx._stats.output = output;
  return items;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { dryRun, flags } = parseArgs(process.argv.slice(2));

  // 用 Operator 直接注册（不用 makePersistOperator，因为需要写快照）
  const dag = new Dag()
    .add(new Operator({ name: 'seed-index', run: seedIndex, describe: '从 30 站 entities.json 提取初始 index' }))
    .add(new Operator({ name: 'merge-academic', run: mergeAcademic, describe: '合并 data/ 下 4 个学术数据集，DOI 去重' }))
    .add(new Operator({ name: 'sort-index', run: sortIndex, describe: 'confidence desc → publishedDate desc' }))
    .add(new Operator({ name: 'persist-index', run: persistIndex, describe: '写 data/search-index.json + 快照' }));

  const report = await dag.run([], {
    pipelineName: 'search-index',
    dryRun,
    args: {},
  });

  const stats = dag.ctx._stats || {};
  console.log(`[search-index v2] ${report.resultCount} 实体 / ${stats.sites?.length || 0} 站 / ${stats.sizeMB || 0}MB / ${report.elapsedMs}ms`);
  if (!dryRun) console.log(`[search-index v2] 快照：${SNAPSHOT_PATH}`);
  console.log(`[ledger] ${report.ledgerPath}`);

  return {
    totalEntities: report.resultCount,
    sourceSites: stats.sites?.length || 0,
    entitiesRead: stats.totalRead || 0,
    dedupDropped: stats.dropped || 0,
    sizeMB: stats.sizeMB || 0,
    elapsedMs: report.elapsedMs,
    outputPath: OUT_PATH,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((r) => {
    process.exitCode = r.totalEntities > 0 ? 0 : 1;
  }).catch((e) => { console.error('[FATAL]', e); process.exit(1); });
}

// 供其他脚本复用（v1 兼容）
export { main, tokenize, extractIndex, extractAcademic, discoverSites };
