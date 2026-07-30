#!/usr/bin/env node
/**
 * GeneTech 14站知识引擎 — 闭环调度器 v2.0
 * scheduler-v2.js
 *
 * 编排 6 个闭环的定时执行，每个闭环包含完整六阶段：
 *   收集 → 分析 → 决策 → 开发 → 测试 → 部署
 *
 * 闭环清单：
 *   1. data-accumulation   数据积累（增加数据量）      每日 02:00
 *   2. domain-expansion    领域开拓（增加板块）        每周一 06:00
 *   3. tech-adoption       技术能力提升（能力提升）    每周三 04:00
 *   4. promotion           推广增长（指导工作方向）    每日 08:00, 18:00
 *   5. intelligence        竞品情报（指导工作方向）    每周五 05:00
 *   6. monetization        变现拓展（增加变现渠道）    每月 1 日 09:00
 *
 * 用法：
 *   node scheduler-v2.js [--daemon]           # 守护模式，按定时执行
 *   node scheduler-v2.js --run-now=<loop-id>  # 立即执行指定闭环
 *   node scheduler-v2.js --list               # 列出所有闭环和时间表
 *   node scheduler-v2.js --dry-run            # 全部预览
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPT_DIR = __dirname;
const ENGINE_SCRIPT = path.join(SCRIPT_DIR, 'closed-loop-engine.js');
const LOG_DIR = path.join(SCRIPT_DIR, 'logs');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ============================================================
// 闭环调度配置
// ============================================================

const LOOPS = [
  {
    id: 'data-accumulation',
    name: '数据积累闭环',
    purpose: '增加数据量',
    cron: '0 2 * * *',
    cronHuman: '每日 02:00',
    timeoutMin: 30,
    retries: 2,
    enabled: true,
    dependsOn: [],
    feedsTo: ['promotion', 'intelligence'],
  },
  {
    id: 'domain-expansion',
    name: '领域开拓闭环',
    purpose: '增加板块',
    cron: '0 6 * * 1',
    cronHuman: '每周一 06:00',
    timeoutMin: 20,
    retries: 1,
    enabled: true,
    dependsOn: ['intelligence'],
    feedsTo: ['data-accumulation', 'promotion'],
  },
  {
    id: 'tech-adoption',
    name: '技术能力提升闭环',
    purpose: '能力提升',
    cron: '0 4 * * 3',
    cronHuman: '每周三 04:00',
    timeoutMin: 40,
    retries: 1,
    enabled: true,
    dependsOn: ['intelligence'],
    feedsTo: ['data-accumulation'],
  },
  {
    id: 'promotion',
    name: '推广增长闭环',
    purpose: '指导工作方向',
    cron: '0 8,18 * * *',
    cronHuman: '每日 08:00, 18:00',
    timeoutMin: 15,
    retries: 2,
    enabled: true,
    dependsOn: ['data-accumulation'],
    feedsTo: ['intelligence'],
  },
  {
    id: 'intelligence',
    name: '竞品情报闭环',
    purpose: '指导工作方向',
    cron: '0 5 * * 5',
    cronHuman: '每周五 05:00',
    timeoutMin: 25,
    retries: 1,
    enabled: true,
    dependsOn: ['promotion'],
    feedsTo: ['domain-expansion', 'tech-adoption', 'monetization'],
  },
  {
    id: 'monetization',
    name: '变现拓展闭环',
    purpose: '增加变现渠道',
    cron: '0 9 1 * *',
    cronHuman: '每月 1 日 09:00',
    timeoutMin: 30,
    retries: 1,
    enabled: true,
    dependsOn: ['intelligence'],
    feedsTo: ['promotion'],
  },
];

// ============================================================
// 日志
// ============================================================

function log(msg, level = 'info') {
  const ts = new Date().toISOString();
  const icons = { info: 'ℹ', ok: '✓', warn: '⚠', error: '✗' };
  const colors = { info: '\x1b[36m', ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
  const line = `[${ts}] ${icons[level]} ${msg}`;
  console.log(`${colors[level] || ''}${line}\x1b[0m`);
  fs.appendFileSync(path.join(LOG_DIR, `scheduler-${new Date().toISOString().slice(0, 10)}.log`), line + '\n');
}

// ============================================================
// 闭环执行
// ============================================================

function runLoop(loopId, dryRun = false) {
  const loop = LOOPS.find((l) => l.id === loopId);
  if (!loop) {
    log(`未知闭环: ${loopId}`, 'error');
    return;
  }

  log(`启动闭环: ${loop.name}（${loop.purpose}）`);

  const args = ['closed-loop-engine.js', `--loop=${loopId}`];
  if (dryRun) args.push('--dry-run');

  const child = spawn('node', args, {
    cwd: SCRIPT_DIR,
    stdio: 'inherit',
    env: { ...process.env, PROJECT_ROOT: path.resolve(SCRIPT_DIR, '..') },
  });

  // 超时保护
  const timer = setTimeout(() => {
    log(`闭环 ${loop.name} 超时（${loop.timeoutMin}分钟），终止`, 'error');
    child.kill('SIGTERM');
  }, loop.timeoutMin * 60 * 1000);

  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) {
      log(`闭环 ${loop.name} 执行成功`, 'ok');
      // 通知下游闭环
      loop.feedsTo.forEach((target) => {
        log(`→ 通知下游闭环: ${target}（数据已就绪）`, 'info');
      });
    } else {
      log(`闭环 ${loop.name} 执行失败（exit ${code}）`, 'error');
      if (loop.retries > 0) {
        log(`将在 5 分钟后重试（剩余 ${loop.retries} 次）`, 'warn');
        setTimeout(() => runLoop(loopId, dryRun), 5 * 60 * 1000);
      }
    }
  });
}

// ============================================================
// cron 解析（简化版，支持 5 位标准 cron）
// ============================================================

function parseCron(cronStr) {
  const parts = cronStr.split(/\s+/);
  if (parts.length !== 5) return null;
  return {
    minute: parts[0],
    hour: parts[1],
    dayOfMonth: parts[2],
    month: parts[3],
    dayOfWeek: parts[4],
  };
}

function shouldRunNow(cronStr, date = new Date()) {
  const c = parseCron(cronStr);
  if (!c) return false;

  const match = (cronPart, value) => {
    if (cronPart === '*') return true;
    return cronPart.split(',').some((p) => {
      if (p === '*') return true;
      if (p.includes('/')) {
        const [range, step] = p.split('/');
        const base = range === '*' ? 0 : parseInt(range);
        return (value - base) % parseInt(step) === 0;
      }
      return parseInt(p) === value;
    });
  };

  return (
    match(c.minute, date.getMinutes()) &&
    match(c.hour, date.getHours()) &&
    match(c.dayOfMonth, date.getDate()) &&
    match(c.month, date.getMonth() + 1) &&
    match(c.dayOfWeek, date.getDay())
  );
}

// ============================================================
// 守护模式
// ============================================================

function daemon() {
  log('╔═══════════════════════════════════════════════════╗');
  log('║  GeneTech 闭环调度器 v2.0 — 守护模式启动         ║');
  log('║  6 个闭环 × 6 阶段 = 完整自动化运营飞轮          ║');
  log('╚═══════════════════════════════════════════════════╝');

  // 每分钟检查一次
  setInterval(() => {
    const now = new Date();
    for (const loop of LOOPS) {
      if (!loop.enabled) continue;
      if (shouldRunNow(loop.cron, now)) {
        log(`⏰ 定时触发: ${loop.name}（${loop.cronHuman}）`);
        runLoop(loop.id);
      }
    }
  }, 60 * 1000);

  log('调度器运行中，每分钟检查定时任务...（Ctrl+C 退出）');
}

// ============================================================
// 列表展示
// ============================================================

function listLoops() {
  console.log('\nGeneTech 闭环调度系统 — 6 个闭环\n');
  console.log('┌────────────────────┬──────────────────────┬────────────────┬──────────────────┬──────────────┐');
  console.log('│ 闭环ID             │ 名称                 │ 定时           │ 目标             │ 上下游       │');
  console.log('├────────────────────┼──────────────────────┼────────────────┼──────────────────┼──────────────┤');
  for (const loop of LOOPS) {
    const id = loop.id.padEnd(18);
    const name = loop.name.padEnd(20);
    const cron = loop.cronHuman.padEnd(14);
    const purpose = loop.purpose.padEnd(16);
    const deps = (loop.dependsOn.length ? '← ' + loop.dependsOn.join(',') : '').padEnd(6);
    const feeds = (loop.feedsTo.length ? '→ ' + loop.feedsTo.join(',') : '');
    console.log(`│ ${id} │ ${name} │ ${cron} │ ${purpose} │ ${deps}${feeds}│`);
  }
  console.log('└────────────────────┴──────────────────────┴────────────────┴──────────────────┴──────────────┘');

  console.log('\n闭环飞轮：');
  console.log('  数据积累 → 推广增长 → 竞品情报 → 领域开拓/技术提升/变现拓展 → 回到数据积累');
  console.log('\n每个闭环包含六阶段：');
  console.log('  收集 → 分析 → 决策 → 开发 → 测试 → 部署\n');
}

// ============================================================
// 主入口
// ============================================================

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    listLoops();
    process.exit(0);
  }

  if (args.includes('--daemon')) {
    daemon();
    return;
  }

  const runNow = args.find((a) => a.startsWith('--run-now='));
  if (runNow) {
    const loopId = runNow.split('=')[1];
    runLoop(loopId, args.includes('--dry-run'));
    return;
  }

  const dryRun = args.includes('--dry-run');
  if (dryRun) {
    log('DRY-RUN 模式：预览所有闭环执行');
    for (const loop of LOOPS) {
      runLoop(loop.id, true);
    }
    return;
  }

  // 默认显示帮助
  listLoops();
  console.log('用法:');
  console.log('  node scheduler-v2.js --daemon              # 守护模式，按定时执行');
  console.log('  node scheduler-v2.js --run-now=<loop-id>   # 立即执行指定闭环');
  console.log('  node scheduler-v2.js --dry-run             # 全部预览');
  console.log('  node scheduler-v2.js --list                # 列出所有闭环');
}

main();
