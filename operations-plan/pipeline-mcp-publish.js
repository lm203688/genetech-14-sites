#!/usr/bin/env node
/**
 * MCP 发布校验：pipeline-mcp-publish.js
 * 校验 mcp-server/glama.json 结构合法，并比对版本号；版本变更则标记需发布，
 * 供 .github/workflows/ops-extra.yml 的 mcp-publish job 提交 + 提醒发布。
 * 用法：node pipeline-mcp-publish.js [--dry-run]
 */
const fs = require('fs').promises;
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const GLAMA = path.join(PROJECT_ROOT, 'mcp-server', 'glama.json');

async function readJsonSafe(p) { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } }

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const g = await readJsonSafe(GLAMA);
  const report = { pipeline: 'mcp-publish', timestamp: new Date().toISOString(), dryRun, valid: false, publishNeeded: false };

  if (!g) { report.error = 'glama.json 缺失'; }
  else {
    const required = ['name', 'description', 'version', 'capabilities'];
    const missing = required.filter((k) => !g[k]);
    report.valid = missing.length === 0;
    report.error = missing.length ? `缺少字段: ${missing.join(',')}` : null;
    report.version = g.version;

    const last = await readJsonSafe(path.join(STATE_DIR, 'last-mcp-version.json'));
    if (!last || last.version !== g.version) {
      report.publishNeeded = true;
      report.previousVersion = last?.version || null;
      if (!dryRun) {
        await fs.mkdir(STATE_DIR, { recursive: true });
        await fs.writeFile(path.join(STATE_DIR, 'last-mcp-version.json'), JSON.stringify({ version: g.version, publishedAt: report.timestamp }, null, 2), 'utf-8');
      }
    }
  }

  if (!dryRun) {
    await fs.mkdir(REPORTS_DIR, { recursive: true });
    await fs.writeFile(path.join(REPORTS_DIR, `report-mcp-publish-${Date.now()}.json`), JSON.stringify(report, null, 2), 'utf-8');
  }
  console.log(`[mcp-publish] 合法=${report.valid} 需发布=${report.publishNeeded} 版本=${report.version || '?'}` + (dryRun ? ' (dry-run)' : ''));
}
main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
