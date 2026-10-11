#!/usr/bin/env node
/**
 * 飞轮状态陈旧 monitor
 *
 * 目的：飞轮脚本（backfill-cursor / growth-baseline / openalex-citation-cursor）
 *       静默停摆是本项目最贵的故障模式——2026-10-05 血泪教训：39-50 天陈旧
 *       才发现。此脚本每日在 CI 跑一次，超过阈值 exit 1 让 workflow 失败并提醒。
 *
 * 用法：
 *   node operations-plan/monitor-flywheel-state.js
 *   node operations-plan/monitor-flywheel-state.js --warn-days 14   # 默认 14
 *
 * 输出：
 *   标准 JSON 报告到 stdout（供 CI 拉取存档），同时 human-readable 到 stderr
 *   exit 0 = 全部在阈值内
 *   exit 1 = 至少一个 state 陈旧超阈值
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');

// 阈值（天）——超过即视为飞轮冻结
const THRESHOLDS = {
  // 飞轮核心：引用/实体回填游标
  'backfill-cursor.json': 14,
  'growth-baseline.json': 14,
  'openalex-citation-cursor.json': 14,
  'cited-backfill-state.json': 14,
  'pipeline-domain-expansion-state.json': 14,
  'pipeline-intelligence-state.json': 14,
  'academic-datasets-cursor.json': 21, // 学术源按周更新即可
  // 索引与派生
  'academic-refs-cache.json': 30,
};

const MAX_WARN_DAYS = Number(process.argv.find((a) => a.startsWith('--warn-days='))?.split('=')[1] || 14);

function readMtime(rel) {
  const p = path.join(STATE_DIR, rel);
  if (!fs.existsSync(p)) return { status: 'missing', mtimeMs: 0, days: null };
  const st = fs.statSync(p);
  const days = (Date.now() - st.mtimeMs) / 86400000;
  return {
    status: days > MAX_WARN_DAYS ? 'stale' : 'fresh',
    mtime: new Date(st.mtimeMs).toISOString(),
    mtimeMs: st.mtimeMs,
    size: st.size,
    days: Math.round(days * 10) / 10,
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  thresholdDays: MAX_WARN_DAYS,
  stateDir: STATE_DIR,
  items: [],
  summary: { total: 0, fresh: 0, stale: 0, missing: 0 },
};

for (const [name, threshold] of Object.entries(THRESHOLDS)) {
  const r = readMtime(name);
  const effectiveThreshold = Math.max(threshold, MAX_WARN_DAYS * 0.7); // 阈值取大，避免过严
  r.thresholdDays = threshold;
  r.effectiveStatus = r.status === 'missing' ? 'missing'
    : (r.days > threshold ? 'STALE' : 'FRESH');
  report.items.push({ name, ...r });
  report.summary.total++;
  if (r.effectiveStatus === 'FRESH') report.summary.fresh++;
  else if (r.effectiveStatus === 'STALE') report.summary.stale++;
  else report.summary.missing++;
}

// 输出
process.stderr.write('=== 飞轮状态 monitor ===\n');
process.stderr.write(`阈值: ${MAX_WARN_DAYS} 天 | 扫描: ${report.items.length} 个 state 文件\n\n`);
for (const it of report.items) {
  const icon = it.effectiveStatus === 'FRESH' ? '✓' : it.effectiveStatus === 'STALE' ? '✗' : '⊘';
  process.stderr.write(
    `${icon} ${it.name.padEnd(48)} ${it.effectiveStatus.padEnd(7)} ` +
    `${it.days != null ? it.days.toFixed(1) + 'd' : 'N/A'.padStart(6)} ` +
    `(阈值 ${it.thresholdDays}d)` +
    (it.effectiveStatus === 'STALE' ? '  ← 需手动重触发' : '') + '\n'
  );
}
process.stderr.write(`\n摘要: ${report.summary.fresh} fresh / ${report.summary.stale} stale / ${report.summary.missing} missing\n`);

// JSON 报告
fs.writeFileSync(
  path.join(ROOT, 'reports', `flywheel-state-${new Date().toISOString().slice(0,10)}.json`),
  JSON.stringify(report, null, 2)
);
process.stdout.write(JSON.stringify(report));

process.exit(report.summary.stale > 0 ? 1 : 0);
