#!/usr/bin/env node
/**
 * 能力域④-用户反馈升级：pipeline-user-feedback.js
 * 采集页面纠错/订阅信号：扫描站点是否含反馈入口；汇总 state/feedback-*.json
 * （前端埋点上报的纠错/订阅 JSON）；产出报告并建议生成 GitHub Issue 供人工跟进。
 * 用法：node pipeline-user-feedback.js [--dry-run]
 */
const fs = require('fs').promises;
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');

async function readJsonSafe(p) { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } }
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const sitesWithFeedback = [];
  const corrections = [];
  const subscriptions = 0;

  // 1) 扫描部署站点是否有反馈入口（feedback.html / ?feedback / 表单）
  const entries = await fs.readdir(PROJECT_ROOT, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hasFeedback = await exists(path.join(PROJECT_ROOT, e.name, 'feedback.html')) ||
      await exists(path.join(PROJECT_ROOT, e.name, 'website', 'feedback.html'));
    if (hasFeedback) sitesWithFeedback.push(e.name);
  }

  // 2) 汇总 state/feedback-*.json
  let fbFiles = [];
  try { fbFiles = (await fs.readdir(STATE_DIR)).filter((f) => f.startsWith('feedback-') && f.endsWith('.json')); } catch {}
  for (const f of fbFiles) {
    const arr = await readJsonSafe(path.join(STATE_DIR, f));
    if (Array.isArray(arr)) for (const it of arr) {
      if (it.type === 'correction') corrections.push(it);
    }
  }

  const report = {
    pipeline: 'user-feedback', timestamp: new Date().toISOString(), dryRun,
    sitesWithFeedbackEntry: sitesWithFeedback, correctionSignals: corrections.length,
    recommendation: sitesWithFeedback.length === 0
      ? '建议：在 14 站添加 feedback.html 纠错/订阅入口并上报至 state/feedback-*.json'
      : `已发现 ${sitesWithFeedback.length} 个站点具备反馈入口；待处理纠错 ${corrections.length} 条`,
  };

  if (!dryRun) {
    await fs.writeFile(path.join(REPORTS_DIR, `report-user-feedback-${Date.now()}.json`), JSON.stringify(report, null, 2), 'utf-8');
  }
  console.log(`[user-feedback] 反馈入口站点=${sitesWithFeedback.length} 纠错信号=${corrections.length}` + (dryRun ? ' (dry-run)' : ''));
  if (corrections.length) console.log('  待处理纠错样本:', corrections.slice(0, 3).map((c) => c.id || c.entity).join(', '));
}
main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
