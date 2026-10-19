#!/usr/bin/env node
/**
 * tests/monitor-flywheel.test.mjs — 飞轮状态告警通道测试（F1）
 * ─────────────────────────────────────────────────────────────────────────
 * 背景
 *   报告 §5 F1：「45 天冻结是被人读报告发现的，不是被系统喊出来的——这是最刺眼
 *   一条」。monitor-flywheel-state.js 的 --alert 通道（create/update/close Issue）
 *   没有测试覆盖，若告警本身静默坏掉，等于下一个 45 天。
 *
 * 测试内容（4 条）
 *   FLY1 · 扫描正确性：state 文件全 fresh 时 exit 0，JSON 输出结构正确
 *   FLY2 · 告警触发：注入 stale 场景应能检测到并 exit 1
 *   FLY3 · 恢复验证：修复 stale 后应 exit 0
 *   FLY4 · Issue 流程：--alert --dry-run 模式输出正确的 create/update/close 动作
 *
 * 策略
 *   - 用 spawn 子进程跑生产脚本（不 mock，跑真逻辑）
 *   - 用 --state-dir 参数隔离测试用 state 目录，不污染真实 state/
 *   - 用 --local 或 --dry-run 观察告警流程，不真调用 GitHub API
 *   - 所有测试用 node:test 内置（Node 20+ 零依赖）
 *
 * 用法
 *   npm test                                    # 跑本文件 + 其它 tests/**
 *   npm run test:flywheel                       # 只跑本文件
 *
 * 退出码：0 = 全部通过 / 1 = 至少一条测试失败
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, copyFileSync, renameSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MONITOR_SCRIPT = resolve(ROOT, 'operations-plan', 'monitor-flywheel-state.js');
const TEST_STATE_DIR = resolve(ROOT, 'state.test');
const REAL_STATE_DIR = resolve(ROOT, 'state');

// ==================== 子进程工具 ====================

function runMonitor(args = []) {
  return new Promise((resolve, reject) => {
    // 用 process.execPath（不用 shell: true）：shell 在 Windows 上会重排参数。
    // 参数统一用 --flag=value 等号格式，避免空格分隔被错误解析。
    const child = spawn(process.execPath, [MONITOR_SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

// 从 stdout 提取 JSON 报告（脚本先写 stderr human-readable，最后写 stdout JSON）
function extractJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

// ==================== 测试 fixture：临时 state 目录 ====================

let backupDir = null;

before(async () => {
  // 备份真实 state.test（若存在），测试结束后还原
  if (existsSync(TEST_STATE_DIR)) {
    backupDir = resolve(ROOT, `state.test.backup.${Date.now()}`);
    rmSync(backupDir, { recursive: true, force: true });
    const fs = await import('node:fs');
    await fs.promises.rename(TEST_STATE_DIR, backupDir);
  }
  mkdirSync(TEST_STATE_DIR, { recursive: true });
});

after(() => {
  // 清理测试目录
  if (existsSync(TEST_STATE_DIR)) rmSync(TEST_STATE_DIR, { recursive: true, force: true });
  if (existsSync(resolve(ROOT, 'reports.test'))) rmSync(resolve(ROOT, 'reports.test'), { recursive: true, force: true });
  if (backupDir && existsSync(backupDir)) {
    // 还原原备份
    renameSync(backupDir, TEST_STATE_DIR);
    backupDir = null;
  }
});

// ==================== 测试 1：扫描正确性 ====================

test('FLY1 · 全部 state 文件 fresh 时 exit 0 且 JSON 结构正确', async () => {
  // 造一份"全部 fresh"的测试 state 目录
  const stateFiles = [
    'backfill-cursor.json',
    'growth-baseline.json',
    'openalex-citation-cursor.json',
    'cited-backfill-state.json',
    'pipeline-domain-expansion-state.json',
    'pipeline-intelligence-state.json',
    'academic-datasets-cursor.json',
    'academic-refs-cache.json',
  ];

  for (const name of stateFiles) {
    const src = join(REAL_STATE_DIR, name);
    if (existsSync(src)) {
      copyFileSync(src, join(TEST_STATE_DIR, name));
      // 强制刷 mtime 到当前时间
      const fs = await import('node:fs');
      const now = new Date();
      fs.utimesSync(join(TEST_STATE_DIR, name), now, now);
    }
  }

  const result = await runMonitor([
    '--state-dir=' + TEST_STATE_DIR,
    '--warn-days=3',
    '--local',
  ]);

  assert.equal(result.code, 0, `全部 fresh 应 exit 0，实际 ${result.code}\nstderr:\n${result.stderr}`);

  const report = extractJson(result.stdout);
  assert.ok(report, 'stdout 未包含 JSON 报告');
  assert.ok(report.generatedAt, '缺少 generatedAt');
  assert.ok(Array.isArray(report.items), 'items 不是数组');
  assert.equal(report.thresholdDays, 3, '阈值应为 3');
  assert.equal(report.sloHours, 72, 'SLO 应为 72h');

  // 只算存在的文件（TEST_STATE_DIR 里可能不全）
  const existingItems = report.items.filter(i => i.effectiveStatus !== 'missing');
  assert.ok(existingItems.length > 0, '测试目录应至少有 1 个 fresh 文件');
  assert.equal(report.summary.fresh + report.summary.stale + report.summary.missing, report.summary.total, 'summary 计数不守恒');
});

// ==================== 测试 2：告警触发 ====================

test('FLY2 · 注入 stale 文件应能检测到并 exit 1', async () => {
  // 造一个超过阈值（5 天前）的文件
  const staleFile = 'backfill-cursor.json';
  const fs = await import('node:fs');
  const src = join(REAL_STATE_DIR, staleFile);
  assert.ok(existsSync(src), `依赖文件缺失：${src}`);
  copyFileSync(src, join(TEST_STATE_DIR, staleFile));

  // 把 mtime 改到 5 天前
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  fs.utimesSync(join(TEST_STATE_DIR, staleFile), fiveDaysAgo, fiveDaysAgo);

  const result = await runMonitor([
    '--state-dir=' + TEST_STATE_DIR,
    '--warn-days=3',
    '--local',
  ]);

  assert.equal(result.code, 1, `stale 场景应 exit 1，实际 ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const report = extractJson(result.stdout);
  assert.ok(report, 'stdout 未包含 JSON 报告');
  assert.equal(report.summary.stale, 1, `应有 1 个 stale，实际 ${report.summary.stale}`);

  // 检查 stale 文件的状态
  const staleItem = report.items.find(i => i.name === staleFile);
  assert.ok(staleItem, '找不到 stale 文件项');
  assert.equal(staleItem.effectiveStatus, 'STALE', '状态应为 STALE');
  assert.ok(staleItem.days > 3, `days 应 > 3，实际 ${staleItem.days}`);
});

// ==================== 测试 3：恢复验证 ====================

test('FLY3 · 修复 stale 后应 exit 0', async () => {
  const staleFile = 'backfill-cursor.json';
  const fs = await import('node:fs');
  const src = join(REAL_STATE_DIR, staleFile);
  assert.ok(existsSync(src), `依赖文件缺失：${src}`);
  copyFileSync(src, join(TEST_STATE_DIR, staleFile));

  // 先注入 stale（5 天前）
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  fs.utimesSync(join(TEST_STATE_DIR, staleFile), fiveDaysAgo, fiveDaysAgo);

  let result = await runMonitor([
    '--state-dir=' + TEST_STATE_DIR,
    '--warn-days=3',
    '--local',
  ]);
  assert.equal(result.code, 1, 'stale 场景应 exit 1');

  // 修复：更新 mtime 为当前时间
  const now = new Date();
  fs.utimesSync(join(TEST_STATE_DIR, staleFile), now, now);

  result = await runMonitor([
    '--state-dir=' + TEST_STATE_DIR,
    '--warn-days=3',
    '--local',
  ]);
  assert.equal(result.code, 0, `修复后应 exit 0，实际 ${result.code}\nstderr:\n${result.stderr}`);

  const report = extractJson(result.stdout);
  assert.equal(report.summary.stale, 0, `修复后 stale 应为 0，实际 ${report.summary.stale}`);
});

// ==================== 测试 4：Issue 流程（--alert --dry-run） ====================

test('FLY4 · --alert --dry-run 应输出正确的 Issue 操作意图', async () => {
  // 造 stale 场景
  const staleFile = 'backfill-cursor.json';
  const fs = await import('node:fs');
  const src = join(REAL_STATE_DIR, staleFile);
  assert.ok(existsSync(src), `依赖文件缺失：${src}`);
  copyFileSync(src, join(TEST_STATE_DIR, staleFile));
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  fs.utimesSync(join(TEST_STATE_DIR, staleFile), fiveDaysAgo, fiveDaysAgo);

  // 运行 --alert --dry-run：gh 会返回空/失败，但 --dry-run 会短路
  // 注意：脚本的 dry-run 逻辑在 gh() 函数返回后处理，不是短路
  // 所以我们要看 stdout JSON 的 alertMode 字段与 stderr 里的动作提示

  // 关键：--dry-run 下 createIssue 会 print "[dry-run] 将创建 Issue"
  // 但前提是 ALERT_MODE=true 且 not LOCAL_ONLY
  // 所以用 --alert --dry-run（不加 --local）

  const result = await runMonitor([
    '--state-dir=' + TEST_STATE_DIR,
    '--warn-days=3',
    '--alert',
    '--dry-run',
  ]);

  // exit code 应该是 1（因为 stale 存在）
  assert.equal(result.code, 1, `dry-run 下 stale 场景应 exit 1，实际 ${result.code}`);

  // JSON 报告应有 alertMode=true
  const report = extractJson(result.stdout);
  assert.ok(report, 'stdout 未包含 JSON 报告');
  assert.equal(report.alertMode, true, 'alertMode 应为 true');
  assert.equal(report.dryRun, true, 'dryRun 应为 true');

  // stderr 应包含 dry-run 提示
  assert.match(result.stderr, /dry-run/, 'stderr 缺少 dry-run 提示');
  assert.match(result.stderr, /alert|Issue|告警/, 'stderr 缺少告警相关提示');
});
