#!/usr/bin/env node
/**
 * 盈利化可观测：pipeline-finance-track.js
 * 采集收入/转化数据形成 MRR/ARPU 看板。
 *   - 若配置 CREEM_API_KEY：调用 Creem API 拉取订阅/收入
 *   - 否则：聚合 unified-license KV 统计（若 LICENSE_STATS_URL 可达）或输出骨架看板
 * 用法：node pipeline-finance-track.js [--dry-run]
 */
const fs = require('fs').promises;
const path = require('path');
const https = require('https');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');

function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const apiKey = process.env.CREEM_API_KEY || '';
  const licenseStatsUrl = process.env.LICENSE_STATS_URL || '';
  const dashboard = { pipeline: 'finance-track', timestamp: new Date().toISOString(), dryRun, mrr: 0, activeLicenses: 0, source: 'scaffold' };

  if (apiKey) {
    try {
      const res = await httpGetJson('https://api.creem.io/v1/subscriptions', { Authorization: `Bearer ${apiKey}` });
      if (res.status === 200) {
        const subs = res.data.data || res.data || [];
        dashboard.mrr = subs.reduce((s, x) => s + (x.amount || 0) / 100, 0);
        dashboard.activeLicenses = subs.filter((x) => x.status === 'active').length;
        dashboard.source = 'creem';
      }
    } catch (e) { console.warn('[finance] Creem 拉取失败:', e.message); }
  } else if (licenseStatsUrl) {
    try {
      const res = await httpGetJson(licenseStatsUrl);
      if (res.status === 200) { dashboard.activeLicenses = res.data.active || 0; dashboard.source = 'unified-license'; }
    } catch (e) { console.warn('[finance] license 统计拉取失败:', e.message); }
  }

  if (!dryRun) {
    await fs.mkdir(REPORTS_DIR, { recursive: true });
    await fs.writeFile(path.join(REPORTS_DIR, `report-finance-${Date.now()}.json`), JSON.stringify(dashboard, null, 2), 'utf-8');
  }
  console.log(`[finance-track] MRR=$${dashboard.mrr} 活跃许可=${dashboard.activeLicenses} 数据源=${dashboard.source}` + (dryRun ? ' (dry-run)' : ''));
  if (dashboard.source === 'scaffold') console.log('  提示：配置 CREEM_API_KEY 或 LICENSE_STATS_URL 可拉取真实收入数据。');
}
main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
