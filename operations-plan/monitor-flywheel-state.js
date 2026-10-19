#!/usr/bin/env node
/**
 * 飞轮状态陈旧 monitor（含告警通道）
 *
 * 目的：飞轮脚本（backfill-cursor / growth-baseline / openalex-citation-cursor）
 *       静默停摆是本项目最贵的故障模式——2026-10-05 血泪教训：39-50 天陈旧
 *       才发现。此脚本每日在 CI 跑一次，超过阈值 exit 1 让 workflow 失败并提醒。
 *
 * F1 升级（2026-10-16 · 报告 §5 F1「告警通道」）：
 *   背景：45 天陈旧是被人读报告才发现的，不是被系统喊出来的——这是报告 §3
 *         点名的最刺眼一条。此脚本此前只让 CI 变红，CI 红本身不触达人眼前。
 *   改造：加 --alert 模式，检测到 stale 时自动在 GitHub 建/更新 Issue，
 *         全部 fresh 时自动关闭既有 Issue。label 固定 flywheel-stale 作幂等锁。
 *   SLO：**飞轮 72 小时无新增实体 = 自动开 Issue**（--warn-days 默认从 14
 *        降到 3，让陈旧一出现当天就被告警，不等月度回顾）。
 *   与 tools/gate-alert.mjs 关系：gate-alert 管"门禁级"告警，本脚本管
 *        "飞轮陈旧"告警，两条独立轨道，label 不同互不覆盖。
 *
 * 用法：
 *   node operations-plan/monitor-flywheel-state.js
 *   node operations-plan/monitor-flywheel-state.js --warn-days 3 --alert
 *   node operations-plan/monitor-flywheel-state.js --local        # 不发 Issue
 *   node operations-plan/monitor-flywheel-state.js --dry-run      # 只打印不真调 gh
 *
 * 输出：
 *   标准 JSON 报告到 stdout（供 CI 拉取存档），同时 human-readable 到 stderr
 *   exit 0 = 全部在阈值内
 *   exit 1 = 至少一个 state 陈旧超阈值（含告警已开）
 *   exit 3 = gh 调用失败（告警通道挂了，需要单独排查）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// 参数解析（提前，供 STATE_DIR / REPORTS_DIR 使用）
const argv = process.argv.slice(2);

// F1 升级：支持 --state-dir 参数，允许测试使用隔离的 state 目录
// 用法：--state-dir=/path/to/test-state 或 --state-dir /path/to/test-state
// 测试场景专用，生产运行时默认用 ROOT/state（行为不变）
const stateDirArg = argv.find((a) => a.startsWith('--state-dir='))?.split('=')[1]
  || argv.find((a) => a.startsWith('--state-dir') && argv[argv.indexOf(a) + 1]);
const STATE_DIR = stateDirArg ? path.resolve(stateDirArg) : path.join(ROOT, 'state');
// 使用 --state-dir 时 reports 也写到 state 目录旁（避免污染真实 reports/）
const REPORTS_DIR = stateDirArg ? path.resolve(path.join(stateDirArg, '..', 'reports.test')) : path.join(ROOT, 'reports');

// F1 升级：默认阈值从 14 天降到 3 天（72h SLO）
const DEFAULT_WARN_DAYS = 3;
const MAX_WARN_DAYS = Number(
  (argv.find((a) => a.startsWith('--warn-days='))?.split('=')[1]
    || argv.find((a) => a.startsWith('--warn-days') && argv[argv.indexOf(a) + 1])
    || DEFAULT_WARN_DAYS)
);
const ALERT_MODE = argv.includes('--alert');
const LOCAL_ONLY = argv.includes('--local');
const DRY_RUN = argv.includes('--dry-run');

// 阈值（天）——超过即视为飞轮冻结
const THRESHOLDS = {
  // 飞轮核心：引用/实体回填游标
  'backfill-cursor.json': 3,
  'growth-baseline.json': 3,
  'openalex-citation-cursor.json': 3,
  'cited-backfill-state.json': 3,
  'pipeline-domain-expansion-state.json': 3,
  'pipeline-intelligence-state.json': 3,
  'academic-datasets-cursor.json': 7, // 学术源按周更新即可
  // 索引与派生
  'academic-refs-cache.json': 14,
};

// Issue 元数据
const LABEL = 'flywheel-stale';
const ISSUE_TITLE = '[Flywheel Stale] 飞轮状态陈旧告警';

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
  sloHours: MAX_WARN_DAYS * 24,
  stateDir: STATE_DIR,
  alertMode: ALERT_MODE,
  dryRun: DRY_RUN,
  items: [],
  summary: { total: 0, fresh: 0, stale: 0, missing: 0 },
};

for (const [name, threshold] of Object.entries(THRESHOLDS)) {
  const r = readMtime(name);
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
process.stderr.write(`阈值: ${MAX_WARN_DAYS} 天 (SLO ${MAX_WARN_DAYS * 24}h) | 扫描: ${report.items.length} 个 state 文件 | 告警: ${ALERT_MODE ? 'ON' : 'OFF'}\n\n`);
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
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
fs.writeFileSync(
  path.join(REPORTS_DIR, `flywheel-state-${new Date().toISOString().slice(0, 10)}.json`),
  JSON.stringify(report, null, 2)
);

// ==================== F1 告警通道 ====================

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf-8', timeout: 30000 });
  return {
    code: r.status,
    stdout: r.stdout?.trim() || '',
    stderr: r.stderr?.trim() || '',
    ok: r.status === 0,
  };
}

function findExistingIssue() {
  if (DRY_RUN || LOCAL_ONLY) return null;
  const r = gh([
    'issue', 'list',
    '--label', LABEL,
    '--state', 'open',
    '--json', 'number,title,url',
    '--limit', '1',
  ]);
  if (!r.ok) return { error: r.stderr || r.stdout };
  try {
    const arr = JSON.parse(r.stdout);
    return arr[0] || null;
  } catch {
    return null;
  }
}

function renderBody(items, summary, generatedAt) {
  const staleItems = items.filter(i => i.effectiveStatus === 'STALE' || i.effectiveStatus === 'missing');
  if (!staleItems.length) {
    return [
      '## ✅ 全部 state 文件新鲜',
      '',
      `- 生成时间：${generatedAt}`,
      `- 阈值：${MAX_WARN_DAYS} 天（SLO ${MAX_WARN_DAYS * 24}h）`,
      `- 扫描：${summary.total} 个 state 文件`,
      '',
      '| state 文件 | 状态 | 天数 | 阈值 |',
      '|---|---|---:|---:|',
      ...items.map(i => `| \`${i.name}\` | ✓ FRESH | ${i.days?.toFixed(1)}d | ${i.thresholdDays}d |`),
      '',
      '---',
      '_本 Issue 由 `operations-plan/monitor-flywheel-state.js --alert` 自动生成。恢复后自动关闭。_',
      '_标签 `flywheel-stale` 用于锁定位——同一时间最多 1 条。_',
    ].join('\n');
  }

  return [
    `## 🔴 ${staleItems.length}/${summary.total} state 文件陈旧（SLO ${MAX_WARN_DAYS * 24}h 超限）`,
    '',
    `- 生成时间：${generatedAt}`,
    `- 阈值：${MAX_WARN_DAYS} 天（SLO ${MAX_WARN_DAYS * 24}h）`,
    `- 摘要：${summary.fresh} fresh / ${summary.stale} stale / ${summary.missing} missing`,
    '',
    '| state 文件 | 状态 | 天数 | 阈值 | mtime |',
    '|---|---|---:|---:|---|',
    ...items.map(i => {
      const icon = i.effectiveStatus === 'FRESH' ? '✅' : i.effectiveStatus === 'STALE' ? '🔴' : '⊘';
      return `| \`${i.name}\` | ${icon} ${i.effectiveStatus} | ${i.days != null ? i.days.toFixed(1) + 'd' : 'N/A'} | ${i.thresholdDays}d | ${i_mtime_short(i)} |`;
    }),
    '',
    '## 影响',
    '',
    '飞轮冻结意味着：数据积累停止、引用边不再扩展、检索基准静默退化。',
    '**2026-10-05 血泪教训：backfill-cursor 39 天陈旧才被人读报告发现——本 Issue 是防止下一个 45 天。**',
    '',
    '## 手动修复步骤',
    '',
    '```bash',
    '# 手动触发 ops-extra workflow 重跑对应 pipeline',
    'gh workflow run ops-extra.yml -f task=all',
    '# 或本地跑：',
    'node operations-plan/pipeline-backfill.js',
    'node operations-plan/pipeline-openalex-citation.js --source=crossref --stride=13',
    '```',
    '',
    '## 恢复后',
    '',
    '下一次 CI 运行时（每日 13:00 UTC），若所有 state 文件均在阈值内，本 Issue 会自动关闭。',
    '',
    '---',
    '_本 Issue 由 `operations-plan/monitor-flywheel-state.js --alert` 自动生成 / 更新。请勿手动编辑正文，否则下次运行会被覆盖。_',
    `_标签 \`${LABEL}\` 用于锁定位——同一时间最多 1 条。_`,
  ].join('\n');
}

function i_mtime_short(item) {
  if (!item.mtime) return 'N/A';
  const d = new Date(item.mtime);
  const now = new Date();
  const daysAgo = Math.floor((now - d) / 86400000);
  if (daysAgo === 0) return `今天 ${d.toISOString().slice(11, 16)}`;
  return `${daysAgo} 天前 (${d.toISOString().slice(0, 10)})`;
}

function createIssue(title, body) {
  if (DRY_RUN) {
    process.stderr.write(`[dry-run] 将创建 Issue: ${title}\n`);
    process.stderr.write('--- body ---\n');
    process.stderr.write(body + '\n');
    return { ok: true, dryRun: true };
  }
  const r = gh(['issue', 'create', '--title', title, '--body', body, '--label', LABEL]);
  return { ok: r.ok, url: r.stdout, stderr: r.stderr };
}

function updateIssue(number, body) {
  if (DRY_RUN) {
    process.stderr.write(`[dry-run] 将更新 Issue #${number}\n`);
    return { ok: true, dryRun: true };
  }
  const r = gh(['issue', 'edit', String(number), '--body', body]);
  return { ok: r.ok, stderr: r.stderr };
}

function closeIssue(number, reason) {
  if (DRY_RUN) {
    process.stderr.write(`[dry-run] 将关闭 Issue #${number}: ${reason}\n`);
    return { ok: true, dryRun: true };
  }
  const r = gh(['issue', 'close', String(number), '--comment', reason]);
  return { ok: r.ok, stderr: r.stderr };
}

function ensureLabel() {
  if (DRY_RUN || LOCAL_ONLY) return { ok: true, dryRun: true };
  // 尝试创建 label，若已存在则忽略
  const r = gh([
    'label', 'create', LABEL,
    '--color', 'd73a4a',
    '--description', '飞轮 state 文件陈旧告警（SLO 72h）',
  ]);
  // label 已存在时 gh 会返回非零，但这是可预期的
  if (r.stdout.includes('already exists') || r.stderr.includes('already exists')) {
    return { ok: true };
  }
  return r;
}

function runAlertFlow() {
  const hasStale = report.summary.stale > 0 || report.summary.missing > 0;
  const allFresh = !hasStale;

  const body = renderBody(report.items, report.summary, report.generatedAt);

  if (LOCAL_ONLY) {
    process.stderr.write('\n[local] 跳过 Issue 操作。\n');
    return;
  }

  process.stderr.write(`\n=== 告警通道 (${ALERT_MODE ? 'ON' : 'OFF'}) ===\n`);

  if (!ALERT_MODE) {
    process.stderr.write('[alert] ALERT_MODE 未开启，跳过 Issue 操作。加 --alert 参数启用。\n');
    return;
  }

  ensureLabel();
  const existing = findExistingIssue();
  if (existing && existing.error) {
    process.stderr.write(`[alert] 查询既有 Issue 失败: ${existing.error}\n`);
    process.exit(3);
  }

  if (allFresh && existing) {
    const reason = `全部 state 文件已恢复（${report.generatedAt}，${report.summary.total}/${report.summary.total} fresh）。`;
    const r = closeIssue(existing.number, reason);
    if (!r.ok) {
      process.stderr.write(`[alert] 关闭 Issue 失败: ${r.stderr}\n`);
      process.exit(3);
    }
    process.stderr.write(`[alert] 已关闭 Issue #${existing.number}（飞轮已恢复）\n`);
    return;
  }

  if (hasStale) {
    if (existing) {
      const r = updateIssue(existing.number, body);
      if (!r.ok) {
        process.stderr.write(`[alert] 更新 Issue 失败: ${r.stderr}\n`);
        process.exit(3);
      }
      process.stderr.write(`[alert] 已更新 Issue #${existing.number}（${report.summary.stale} stale / ${report.summary.missing} missing）\n`);
    } else {
      const r = createIssue(ISSUE_TITLE, body);
      if (!r.ok) {
        process.stderr.write(`[alert] 创建 Issue 失败: ${r.stderr}\n`);
        process.exit(3);
      }
      process.stderr.write(`[alert] 已创建 Issue: ${r.url || '(dry-run)'}\n`);
    }
    return;
  }

  // allFresh 且无 existing，无动作
  process.stderr.write('[alert] 全部 fresh 且无既有 Issue，无动作。\n');
}

runAlertFlow();

// JSON 报告
process.stdout.write(JSON.stringify(report));

process.exit(report.summary.stale > 0 ? 1 : 0);
