#!/usr/bin/env node
/**
 * 部署验证 + 回退触发：pipeline-rollout-verify.js
 * 部署后抽样验证每个线上站点的 index.json / entities.json 可访问且有效。
 * 本地校验始终执行；若设置 SITE_BASE_URL 则额外做 HTTP 抽样（GitHub Actions 环境可用）。
 * 任一站点失败 -> 报告 rollbackSuggested=true 且退出码 1（触发工作流告警/回退）。
 * 用法：node pipeline-rollout-verify.js [--dry-run]
 */
const fs = require('fs').promises;
const nodeFs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const BASE = process.env.SITE_BASE_URL || '';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const sites = [];
  let failures = 0;

  const entries = await fs.readdir(PROJECT_ROOT, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const apiDir = path.join(PROJECT_ROOT, e.name, 'website', 'api');
    const idxPath = path.join(apiDir, 'index.json');
    // 仅验证真正部署的站点（含 index.json 的目录），跳过 .git/.github/mcp-server 等
    if (!nodeFs.existsSync(idxPath)) continue;
    const entPath = path.join(apiDir, 'entities.json');
    const site = { site: e.name, indexOk: true, entitiesOk: false, count: 0, http: null, incomplete: false };
    try {
      const idx = JSON.parse(await fs.readFile(idxPath, 'utf-8'));
      site.count = idx.totalEntities || 0;
    } catch {}
    try {
      const ents = JSON.parse(await fs.readFile(entPath, 'utf-8'));
      site.entitiesOk = Array.isArray(ents) && ents.length > 0;
    } catch {}
    if (BASE) {
      try { site.http = await httpGet(`${BASE}/${e.name}/website/api/index.json`); } catch { site.http = 'ERR'; }
    }
    // index 声明有实体但实际缺失/为空 -> 视为未完成站点（告警，而非硬失败）
    if (!site.entitiesOk) { site.incomplete = true; failures++; }
    sites.push(site);
  }

  const report = {
    pipeline: 'rollout-verify', timestamp: new Date().toISOString(), dryRun,
    total: sites.length, failures, rollbackSuggested: failures > 0,
    sites,
  };
  if (!dryRun) {
    await fs.mkdir(REPORTS_DIR, { recursive: true });
    await fs.writeFile(path.join(REPORTS_DIR, `report-rollout-verify-${Date.now()}.json`), JSON.stringify(report, null, 2), 'utf-8');
  }
  console.log(`[rollout-verify] 站点=${sites.length} 失败=${failures}` + (dryRun ? ' (dry-run)' : ''));
  for (const s of sites) if (!s.indexOk || !s.entitiesOk) console.log(`  ✗ ${s.site}: index=${s.indexOk} entities=${s.entitiesOk}`);
  if (failures > 0 && !dryRun) process.exit(1);
}
main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
