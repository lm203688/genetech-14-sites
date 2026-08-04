#!/usr/bin/env node
/**
 * 能力域⑤-专业库对接：pipeline-pro-db-sync.js
 * 对接开放专业数据源（OpenAlex / Crossref），建立标准标识符映射，
 * 为实体补充 DOI→OpenAlex ID、概念→领域等可溯源标识。
 * 用法：node pipeline-pro-db-sync.js [--dry-run]
 */
const fs = require('fs').promises;
const path = require('path');
const https = require('https');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
async function readJsonSafe(p) { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } }

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const mapping = (await readJsonSafe(path.join(STATE_DIR, 'pro-db-mapping.json'))) || { dois: {}, concepts: {} };
  const report = { pipeline: 'pro-db-sync', timestamp: new Date().toISOString(), dryRun, fetched: 0, mapped: 0 };

  // 从各部署站点收集 DOI，去重后向 OpenAlex 反查 openalex_id（标准标识符）
  const entries = await fs.readdir(PROJECT_ROOT, { withFileTypes: true });
  const dois = new Set();
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const livePath = path.join(PROJECT_ROOT, e.name, 'website', 'api', 'entities.json');
    const data = await readJsonSafe(livePath);
    if (!Array.isArray(data)) continue;
    for (const x of data) if (x.doi) dois.add(x.doi);
  }
  report.fetched = dois.size;

  const ua = { 'User-Agent': 'GeneTechBot/1.0 (mailto:ops@genetech.example)' };
  let done = 0;
  for (const doi of dois) {
    if (mapping.dois[doi]) { done++; continue; } // 已映射，跳过
    if (done >= 200) break; // 每次增量上限，避免超时；下次继续
    try {
      const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`;
      const res = await httpGet(url, ua);
      if (res.status === 200) {
        const w = JSON.parse(res.body);
        mapping.dois[doi] = { openalex_id: w.id, title: w.display_name, concepts: (w.concepts || []).map((c) => c.display_name) };
        for (const c of w.concepts || []) mapping.concepts[c.display_name] = (mapping.concepts[c.display_name] || 0) + 1;
        done++; report.mapped++;
      }
    } catch { /* 网络错误忽略，下次重试 */ }
    await new Promise((r) => setTimeout(r, 120));
  }

  if (!dryRun) {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(path.join(STATE_DIR, 'pro-db-mapping.json'), JSON.stringify(mapping, null, 2), 'utf-8');
    await fs.writeFile(path.join(REPORTS_DIR, `report-pro-db-sync-${Date.now()}.json`), JSON.stringify(report, null, 2), 'utf-8');
  }
  console.log(`[pro-db-sync] DOI=${report.fetched} 本次新增映射=${report.mapped}` + (dryRun ? ' (dry-run)' : ''));
}
main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
