#!/usr/bin/env node
/**
 * pipeline-search-index.js
 * ======================
 * 构建语义搜索索引：从 30 站的 entities.json 抽取紧凑元数据，
 * 产出 data/search-index.json 供 api-guard 的 /v1/search/semantic 端点消费。
 *
 * 设计原则：
 *   - 只保留检索必要字段（id/name/tags/site/snippet/url/publishedDate/confidence）
 *   - 不做 TF-IDF 预计算（Worker 端做 token 匹配即可）
 *   - 输出 <5MB（原 30 站 entities.json 合计 ~40MB）
 *   - 幂等：全量重建（30 站合计 300k 实体，本地 <10s）
 *
 * 触发：CI 每日跑（ops-extra.yml）；也可本地手动 `node operations-plan/pipeline-search-index.js`
 * 幂等：无游标，每次全量重建（数据量 <100k 可接受）
 *
 * 上游：各站 entities.json
 * 下游：api-guard worker.js 的 /v1/search/semantic 端点
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SITE_GLOB = path.join(ROOT, '*/website/api/entities.json');

function discoverSites() {
  const sites = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entitiesPath = path.join(ROOT, entry.name, 'website', 'api', 'entities.json');
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

// 提取 data/ 下学术数据集（OpenAlex/PubMed/Crossref/S2）进索引
// 与 per-site 不同：无 limit 截断（量级远小于 30 站），但需做 DOI/paperId 去重避免与 per-site 重复
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

function main() {
  const started = Date.now();
  const sites = discoverSites();
  console.log(`[search-index] 发现 ${sites.length} 站`);

  const index = [];
  const seen = new Set();
  let totalRead = 0;
  let dropped = 0;

  for (const site of sites) {
    const entitiesPath = path.join(ROOT, site, 'website', 'api', 'entities.json');
    try {
      const raw = fs.readFileSync(entitiesPath, 'utf8');
      const entities = JSON.parse(raw);
      totalRead += entities.length;
      const extracted = extractIndex(entities, site);
      for (const e of extracted) {
        if (seen.has(e.id)) { dropped++; continue; }
        seen.add(e.id);
        index.push(e);
      }
      console.log(`  [${site}] +${extracted.length}`);
    } catch (e) {
      console.warn(`  [${site}] 跳过：${e.message}`);
    }
  }

  // 合并 data/ 下学术数据集（OpenAlex/PubMed/Crossref/S2）进索引
  // 这些是 per-site 30 站已 ALL-AT-CAP 之外的独立扩展，体积受控
  const academicFiles = [
    'data/academic-entities.json',
    'data/pubmed-entities.json',
    'data/crossref-entities.json',
    'data/s2-entities.json',
  ];
  let academicAdded = 0;
  for (const rel of academicFiles) {
    const p = path.join(ROOT, rel);
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const entities = JSON.parse(raw);
      if (!Array.isArray(entities) || entities.length === 0) continue;
      const extracted = extractAcademic(entities);
      let n = 0;
      for (const e of extracted) {
        if (seen.has(e.id)) { dropped++; continue; }
        // 用 DOI 也做一次去重（避免与 per-site 同 DOI 重复）
        if (e.doi && seen.has('doi:' + e.doi)) { dropped++; continue; }
        seen.add(e.id);
        if (e.doi) seen.add('doi:' + e.doi);
        index.push(e);
        n++;
      }
      academicAdded += n;
      console.log(`  [academic:${rel}] +${n} (total in file: ${entities.length})`);
    } catch (e) {
      // 文件可能不存在（如 s2-entities.json 尚未生成），静默跳过
    }
  }
  console.log(`[search-index] 学术数据集合并：+${academicAdded}`);

  // 排序：confidence desc → publishedDate desc
  index.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return (b.publishedDate || '').localeCompare(a.publishedDate || '');
  });

  // 分片：>5MB 拆成 search-index-0.json / search-index-1.json ...
  // 但 Worker 端会拉全部，所以先单文件输出
  const output = {
    generatedAt: new Date().toISOString(),
    totalEntities: index.length,
    sourceSites: sites.length,
    academicDatasets: academicAdded,
    entitiesRead: totalRead,
    dedupDropped: dropped,
    version: 'v2',
    entities: index,
  };

  const dataDir = path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const outPath = path.join(dataDir, 'search-index.json');
  const json = JSON.stringify(output);
  fs.writeFileSync(outPath, json);

  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
  const elapsed = Date.now() - started;

  // 写快照
  const reportsDir = path.join(ROOT, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const snapshotPath = path.join(reportsDir, `search-index-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify({
    generatedAt: output.generatedAt,
    totalEntities: output.totalEntities,
    sourceSites: output.sourceSites,
    entitiesRead: output.entitiesRead,
    dedupDropped: output.dedupDropped,
    sizeMB: parseFloat(sizeMB),
    elapsedMs: elapsed,
  }));

  console.log(`\n[search-index] 完成：${output.totalEntities} 实体 / ${output.sourceSites} 站 / ${sizeMB}MB / ${elapsed}ms`);
  console.log(`[search-index] 输出：${outPath}`);
  console.log(`[search-index] 快照：${snapshotPath}`);

  return {
    totalEntities: output.totalEntities,
    sourceSites: output.sourceSites,
    entitiesRead: output.entitiesRead,
    dedupDropped: output.dedupDropped,
    sizeMB: parseFloat(sizeMB),
    elapsedMs: elapsed,
    outputPath: outPath,
  };
}

if (require.main === module) {
  const result = main();
  process.exitCode = result.totalEntities > 0 ? 0 : 1;
}

module.exports = { main, tokenize, extractIndex, discoverSites };
