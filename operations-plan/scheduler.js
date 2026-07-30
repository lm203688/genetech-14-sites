#!/usr/bin/env node
/**
 * 定时任务编排器
 * scheduler.js
 *
 * 功能：
 *   1. 使用 node-cron 风格定时表达式编排 5 个闭环 pipeline 的执行
 *   2. 支持立即运行、定时运行、循环运行模式
 *   3. 管理 pipeline 之间的依赖和状态传递
 *   4. 统一日志和错误处理
 *   5. 支持 graceful shutdown
 *
 * 使用方式：
 *   node scheduler.js [--run-now=<pipeline>] [--daemon] [--dry-run]
 *
 * 定时任务（UTC+8）：
 *   - 数据积累流水线: 每日 02:00
 *   - 领域开拓机制: 每周一 06:00
 *   - 技术采纳闭环: 每周三 04:00
 *   - 推广技术应用: 每日 08:00, 18:00
 *   - 竞品情报收集: 每周五 05:00
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

// ==================== 配置区 ====================

/** 本脚本所在目录 */
const SCRIPT_DIR = __dirname;

/** 项目根目录 */
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

/** 状态与日志目录 */
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const LOG_DIR = path.join(PROJECT_ROOT, 'logs');

/**
 * 定时任务定义
 * cron 格式: 秒 分 时 日 月 周 (此处兼容标准 6 位或 5 位 cron)
 * 使用 UTC+8 时间
 */
const JOBS = [
  {
    id: 'data-accumulation',
    name: '闭环一：数据积累流水线',
    script: 'pipeline-data-accumulation.js',
    // 每日 02:00:00
    cron: '0 0 2 * * *',
    // 标准 5 位 cron 备用: '0 2 * * *'
    enabled: true,
    // 超时时间（毫秒）
    timeoutMs: 30 * 60 * 1000,
    // 失败后重试次数
    retries: 2,
  },
  {
    id: 'domain-expansion',
    name: '闭环二：领域开拓机制',
    script: 'pipeline-domain-expansion.js',
    // 每周一 06:00:00
    cron: '0 0 6 * * 1',
    enabled: true,
    timeoutMs: 20 * 60 * 1000,
    retries: 1,
  },
  {
    id: 'tech-adoption',
    name: '闭环三：技术采纳闭环',
    script: 'pipeline-tech-adoption.js',
    // 每周三 04:00:00
    cron: '0 0 4 * * 3',
    enabled: true,
    timeoutMs: 40 * 60 * 1000,
    retries: 1,
  },
  {
    id: 'promotion',
    name: '闭环四：推广技术应用',
    script: 'pipeline-promotion.js',
    // 每日 08:00:00 和 18:00:00
    cron: '0 0 8,18 * * *',
    enabled: true,
    timeoutMs: 15 * 60 * 1000,
    retries: 1,
  },
  {
    id: 'intelligence',
    name: '闭环五：竞品情报收集',
    script: 'pipeline-intelligence.js',
    // 每周五 05:00:00
    cron: '0 0 5 * * 5',
    enabled: true,
    timeoutMs: 20 * 60 * 1000,
    retries: 1,
  },
];

/** 是否启用秒级精度（true 则 cron 为 6 位，false 则 5 位） */
const CRON_WITH_SECONDS = true;

// ==================== 工具函数 ====================

function getISOTime() {
  return new Date().toISOString();
}

function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function ensureDir(dirPath) {
  try { await fs.mkdir(dirPath, { recursive: true }); } catch {}
}

async function appendLog(filePath, line) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, line + '\n', 'utf-8');
}

/**
 * 解析 cron 表达式并计算下一次执行时间
 * 支持 5 位或 6 位 cron
 */
function parseCron(cronExpr, withSeconds = true) {
  const parts = cronExpr.trim().split(/\s+/);
  if (withSeconds && parts.length === 5) {
    parts.unshift('0'); // 默认秒为 0
  }
  if ((!withSeconds) && parts.length === 6) {
    parts.shift(); // 去掉秒位
  }
  return parts;
}

/**
 * 简易 cron 匹配：判断当前时间是否满足 cron 条件
 * 仅支持数字、*、逗号分隔的列表（如 8,18）
 */
function matchesCron(cronParts, date) {
  const [s, m, h, dom, mon, dow] = cronParts;
  const values = [
    date.getSeconds(),
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1, // cron 月从 1 开始
    date.getDay(),       // JS 周日从 0 开始，cron 也是从 0(日) 到 6(六)
  ];

  for (let i = 0; i < 6; i++) {
    if (!matchesField(cronParts[i], values[i])) return false;
  }
  return true;
}

function matchesField(field, value) {
  if (field === '*') return true;
  // 支持逗号分隔的列表
  const parts = field.split(',');
  for (const p of parts) {
    if (p.includes('-')) {
      const [start, end] = p.split('-').map(Number);
      if (value >= start && value <= end) return true;
    } else if (p.includes('/')) {
      const [base, step] = p.split('/');
      if (base !== '*' && Number(base) > value) continue;
      if (value % Number(step) === 0) return true;
    } else {
      if (Number(p) === value) return true;
    }
  }
  return false;
}

// ==================== Pipeline 执行器 ====================

/**
 * 执行单个 pipeline 脚本
 * @param {object} job - 任务配置
 * @param {boolean} dryRun - 是否 dry-run 模式
 * @returns {Promise<{success:boolean,exitCode:number,logFile:string}>}
 */
async function runPipeline(job, dryRun = false) {
  const scriptPath = path.join(SCRIPT_DIR, job.script);
  const logFile = path.join(LOG_DIR, `run-${job.id}-${getTimestamp()}.log`);
  const startTime = Date.now();

  const args = [scriptPath];
  if (dryRun) args.push('--dry-run');

  const cmdLine = `node ${args.join(' ')}`;
  console.log(`\n[Scheduler] 启动: ${job.name}`);
  console.log(`[Scheduler] 命令: ${cmdLine}`);
  console.log(`[Scheduler] 日志: ${logFile}`);

  await appendLog(logFile, `[${getISOTime()}] START ${job.id}`);
  await appendLog(logFile, `[${getISOTime()}] CMD ${cmdLine}`);

  return new Promise((resolve) => {
    const child = spawn('node', args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text); // 实时输出到控制台
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    // 超时处理
    const timeoutId = setTimeout(() => {
      console.error(`[Scheduler] ${job.name} 执行超时 (${job.timeoutMs}ms)，强制终止`);
      child.kill('SIGTERM');
      // 5 秒后若仍未退出则强制 kill
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, job.timeoutMs);

    child.on('close', async (code) => {
      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;
      const success = code === 0;

      const endLine = `[${getISOTime()}] END ${job.id} exit=${code} duration=${duration}ms success=${success}`;
      await appendLog(logFile, stdout);
      await appendLog(logFile, stderr);
      await appendLog(logFile, endLine);

      console.log(`[Scheduler] ${job.name} 结束，退出码: ${code}，耗时: ${duration}ms`);
      resolve({ success, exitCode: code, logFile, duration });
    });
  });
}

/**
 * 带重试的执行
 */
async function runWithRetry(job, dryRun) {
  let lastResult = null;
  for (let attempt = 0; attempt <= job.retries; attempt++) {
    if (attempt > 0) {
      console.log(`[Scheduler] ${job.name} 第 ${attempt + 1} 次重试...`);
      await new Promise(r => setTimeout(r, 5000 * attempt));
    }
    lastResult = await runPipeline(job, dryRun);
    if (lastResult.success) break;
  }
  return lastResult;
}

// ==================== 调度引擎 ====================

class Scheduler {
  constructor(options = {}) {
    this.dryRun = options.dryRun || false;
    this.isDaemon = options.daemon || false;
    this.runningJobs = new Map(); // jobId -> {startTime, child}
    this.lastRunTimes = {};
    this.tickIntervalMs = 1000; // 每秒检查一次
    this.timer = null;
    this.shuttingDown = false;
  }

  async init() {
    await ensureDir(STATE_DIR);
    await ensureDir(LOG_DIR);

    // 读取上次运行状态
    const statePath = path.join(STATE_DIR, 'scheduler-state.json');
    try {
      const content = await fs.readFile(statePath, 'utf-8');
      const state = JSON.parse(content);
      this.lastRunTimes = state.lastRunTimes || {};
    } catch {
      this.lastRunTimes = {};
    }

    console.log('[Scheduler] 初始化完成');
    console.log('[Scheduler] 已配置任务:');
    for (const job of JOBS) {
      const cronParts = parseCron(job.cron, CRON_WITH_SECONDS);
      console.log(`  [${job.enabled ? '启用' : '禁用'}] ${job.name}`);
      console.log(`    脚本: ${job.script}`);
      console.log(`    Cron: ${cronParts.join(' ')}`);
    }
  }

  async saveState() {
    const statePath = path.join(STATE_DIR, 'scheduler-state.json');
    await fs.writeFile(statePath, JSON.stringify({
      lastRunTimes: this.lastRunTimes,
      updatedAt: getISOTime(),
    }, null, 2), 'utf-8');
  }

  /**
   * 单次 tick：检查哪些任务需要执行
   */
  async tick() {
    const now = new Date();
    for (const job of JOBS) {
      if (!job.enabled) continue;
      if (this.runningJobs.has(job.id)) continue; // 已在运行中
      if (this.shuttingDown) continue;

      const cronParts = parseCron(job.cron, CRON_WITH_SECONDS);
      if (matchesCron(cronParts, now)) {
        // 避免同一分钟内重复执行（基于 lastRunTimes）
        const lastRun = this.lastRunTimes[job.id];
        const thisMinute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
        if (lastRun === thisMinute) continue;

        this.lastRunTimes[job.id] = thisMinute;
        await this.saveState();

        // 异步执行，不阻塞 tick
        this.executeJob(job);
      }
    }
  }

  async executeJob(job) {
    console.log(`\n[Scheduler] [${getISOTime()}] 触发任务: ${job.name}`);
    this.runningJobs.set(job.id, { startTime: Date.now() });

    try {
      const result = await runWithRetry(job, this.dryRun);
      if (result.success) {
        console.log(`[Scheduler] 任务成功: ${job.name}`);
      } else {
        console.error(`[Scheduler] 任务最终失败: ${job.name} (exit=${result.exitCode})`);
      }
    } catch (err) {
      console.error(`[Scheduler] 任务异常: ${job.name} - ${err.message}`);
    } finally {
      this.runningJobs.delete(job.id);
    }
  }

  /**
   * 立即运行指定 pipeline（用于手动触发或测试）
   */
  async runNow(jobId, dryRun = false) {
    const job = JOBS.find(j => j.id === jobId);
    if (!job) {
      console.error(`[Scheduler] 未知任务 ID: ${jobId}`);
      console.error(`可用任务: ${JOBS.map(j => j.id).join(', ')}`);
      process.exit(1);
    }
    console.log(`[Scheduler] 手动触发: ${job.name}`);
    await this.executeJob(job);
  }

  /**
   * 启动守护模式
   */
  start() {
    console.log('[Scheduler] 守护模式已启动，按 Ctrl+C 停止');
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
  }

  /**
   * 优雅停止
   */
  async stop() {
    console.log('\n[Scheduler] 正在停止...');
    this.shuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // 等待运行中的任务完成（最多 60 秒）
    const waitStart = Date.now();
    while (this.runningJobs.size > 0 && Date.now() - waitStart < 60000) {
      console.log(`[Scheduler] 等待 ${this.runningJobs.size} 个任务完成...`);
      await new Promise(r => setTimeout(r, 2000));
    }

    await this.saveState();
    console.log('[Scheduler] 已安全停止');
    process.exit(0);
  }
}

// ==================== 主入口 ====================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const daemon = args.includes('--daemon');
  const runNowArg = args.find(a => a.startsWith('--run-now='));
  const runNowId = runNowArg ? runNowArg.split('=')[1] : null;

  const scheduler = new Scheduler({ dryRun, daemon });
  await scheduler.init();

  // 注册信号处理
  process.on('SIGINT', () => scheduler.stop());
  process.on('SIGTERM', () => scheduler.stop());

  if (runNowId) {
    // 立即运行指定任务
    await scheduler.runNow(runNowId, dryRun);
    process.exit(0);
  } else if (daemon) {
    // 守护模式
    scheduler.start();
  } else {
    // 默认：执行一次 tick（检查并触发当前应运行的任务），然后退出
    console.log('[Scheduler] 单次模式：检查并执行到期任务...');
    await scheduler.tick();

    // 如果当前没有任务被触发，给出提示
    if (scheduler.runningJobs.size === 0) {
      console.log('[Scheduler] 当前无到期任务，请使用 --daemon 启动守护模式，或使用 --run-now=<id> 手动触发');
    } else {
      // 等待运行中的任务完成
      while (scheduler.runningJobs.size > 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    await scheduler.saveState();
    process.exit(0);
  }
}

main().catch(err => {
  console.error('[FATAL] Scheduler 异常:', err);
  process.exit(1);
});
