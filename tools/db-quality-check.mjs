#!/usr/bin/env node
/**
 * db-quality-check.mjs — GeneTech 14站 数据质量巡检
 *
 * 计算跨源数据质量指标（供「每日数据库扩张健康巡检」自动化调用，写入健康日志）：
 *   - 实体总量 / 站点数
 *   - 溯源 URL 完整度（% 实体带非空 url）
 *   - 摘要完整度（% 实体 abstract 长度 > 20）
 *   - DOI 可溯源度（% 实体带 doi）
 *   - 跨源去重率（unique dedupeKey / total）
 *   - 来源分布
 *
 * 用法：node tools/db-quality-check.mjs [--json]
 *   默认打印一行人类可读摘要；--json 打印完整 JSON（供自动化解析）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function dedupeKey(e) {
  const doi = String(e.doi || '').toLowerCase().replace(/^doi:/, '').replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();
  if (doi) return 'doi:' + doi;
  const name = String(e.name || '').toLowerCase().replace(/[^a-z0-9一-龥]/g, '');
  const firstAuthor = String((e.authors && e.authors[0]) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (name) return 'n:' + name.slice(0, 64) + '|' + (firstAuthor.slice(0, 14) || 'x');
  return 'id:' + (e.id || Math.random().toString(36));
}

function loadSites() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, 'website/api/entities.json')))
    .map((d) => d.name);
}

function main() {
  const sites = loadSites();
  let total = 0;
  let withUrl = 0, withAbstract = 0, withDoi = 0;
  const keys = new Set();
  const bySource = {};
  const perSite = [];

  for (const s of sites) {
    let arr;
    try { arr = JSON.parse(fs.readFileSync(path.join(ROOT, s, 'website/api/entities.json'), 'utf8')); }
    catch { arr = []; }
    if (!Array.isArray(arr)) arr = arr.entities || [];
    let su = 0, sa = 0, sd = 0;
    for (const e of arr) {
      total++;
      if (e.url && String(e.url).trim()) { withUrl++; su++; }
      if (e.abstract && String(e.abstract).trim().length > 20) { withAbstract++; sa++; }
      if (e.doi && String(e.doi).trim()) { withDoi++; sd++; }
      keys.add(dedupeKey(e));
      const src = e.source || 'unknown';
      bySource[src] = (bySource[src] || 0) + 1;
    }
    perSite.push({ site: s, count: arr.length, urlPct: arr.length ? Math.round((su / arr.length) * 100) : 0, abstractPct: arr.length ? Math.round((sa / arr.length) * 100) : 0, doiPct: arr.length ? Math.round((sd / arr.length) * 100) : 0 });
  }

  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const report = {
    date: new Date().toISOString().slice(0, 10),
    totalEntities: total,
    sites: sites.length,
    urlCompleteness: pct(withUrl),
    abstractCompleteness: pct(withAbstract),
    doiTraceability: pct(withDoi),
    dedupRate: total ? Math.round((keys.size / total) * 100) : 0,
    uniqueKeys: keys.size,
    bySource,
    perSite,
  };

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(
      `数据质量 ${report.date} | 实体 ${report.totalEntities} / ${report.sites} 站 | ` +
      `溯源URL ${report.urlCompleteness}% | 摘要 ${report.abstractCompleteness}% | ` +
      `DOI ${report.doiTraceability}% | 去重率 ${report.dedupRate}%\n`
    );
  }
  return report;
}

main();
