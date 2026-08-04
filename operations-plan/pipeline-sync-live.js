#!/usr/bin/env node
/**
 * 同步桥接：把数据积累 pipeline 的产物并入线上站点真实路径
 * pipeline-sync-live.js
 *
 * 背景（修复报告"部署断链 + pipeline 路径不匹配"）：
 *   - data-accumulation 写到 sites/<site>/_data/entities.json（pipeline 内部路径）
 *   - 线上站点实际消费 <site>/website/api/entities.json（不同 schema）
 * 本脚本作为桥梁：
 *   1. 扫描所有"已部署站点"（含 website/api/entities.json 的目录）
 *   2. 归一化其实体字段为统一 schema（name/confidence/sites/addedAt...）
 *   3. 若同名的 sites/<site>/_data/entities.json 存在，按 id 合并进线上站点
 *   4. 回写 website/api/entities.json 并修正 index.json（totalEntities/lastUpdated）
 * 仅写入已存在的部署站点，绝不新建伪站点，避免污染线上结构。
 *
 * 用法：node pipeline-sync-live.js [--dry-run]
 */

const fs = require('fs').promises;
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');

const SOURCE_CONFIDENCE = {
  pubmed: 0.82, arxiv: 0.78, openalex: 0.72, crossref: 0.7,
  github: 0.6, huggingface: 0.6,
};

function normalizeEntity(e, site) {
  const id = e.id || e.arxivId || e.pmid || e.openAlexId || e.githubFullName || e.huggingfaceId ||
    (e.doi ? `doi:${e.doi}` : null) || `t:${Buffer.from(String(e.title || e.name || '')).toString('base64').slice(0, 12)}`;
  return {
    id,
    name: e.name || e.title || '',
    source: e.source || '',
    abstract: e.abstract || e.summary || e.description || '',
    url: e.url || e.pdfUrl || '',
    authors: e.authors || [],
    tags: e.tags || e.categories || e.topics || [],
    confidence: typeof e.confidence === 'number' ? e.confidence : (SOURCE_CONFIDENCE[e.source] || 0.5),
    sites: Array.isArray(e.sites) && e.sites.length ? e.sites : [site],
    publishedDate: e.publishedDate || e.published || e.pubDate || e.updatedAt || '',
    addedAt: e.addedAt || e.fetchedAt || new Date().toISOString(),
  };
}

async function readJsonSafe(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const report = { pipeline: 'sync-live', timestamp: new Date().toISOString(), dryRun, sites: [] };

  const entries = await fs.readdir(PROJECT_ROOT, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const site = e.name;
    const apiDir = path.join(PROJECT_ROOT, site, 'website', 'api');
    const livePath = path.join(apiDir, 'entities.json');
    const indexPath = path.join(apiDir, 'index.json');
    let liveEntities = [];
    try { liveEntities = JSON.parse(await fs.readFile(livePath, 'utf-8')); } catch { continue; }

    // 归一化线上实体
    const map = new Map();
    for (const ent of liveEntities) map.set(ent.id || ent.name, normalizeEntity(ent, site));

    // 合并 pipeline 产物（仅当同名部署站点存在）
    const pipePath = path.join(PROJECT_ROOT, 'sites', site, '_data', 'entities.json');
    let merged = 0;
    const pipeData = await readJsonSafe(pipePath);
    if (Array.isArray(pipeData)) {
      for (const pe of pipeData) {
        const ne = normalizeEntity(pe, site);
        if (!map.has(ne.id)) { map.set(ne.id, ne); merged++; }
      }
    }

    const all = Array.from(map.values());
    const now = new Date().toISOString();
    const cats = [...new Set(all.flatMap((x) => x.tags || []))].slice(0, 20);

    if (!dryRun) {
      await fs.mkdir(apiDir, { recursive: true });
      await fs.writeFile(livePath, JSON.stringify(all, null, 2), 'utf-8');
      await fs.writeFile(indexPath, JSON.stringify({
        site, totalEntities: all.length, lastUpdated: now, categories: cats,
      }, null, 2), 'utf-8');
    }
    report.sites.push({ site, total: all.length, mergedFromPipe: merged });
  }

  const reportPath = path.join(REPORTS_DIR, `report-sync-live-${Date.now()}.json`);
  if (!dryRun) await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[sync-live] 处理 ${report.sites.length} 个部署站点` + (dryRun ? ' (dry-run)' : ''));
  for (const s of report.sites) console.log(`  ${s.site}: ${s.total} 实体 (合并 +${s.mergedFromPipe})`);
}

main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
