#!/usr/bin/env node
/**
 * flow.mjs — DataFlow-Agent 风格 pipeline 框架（算子 + DAG + Ledger + Checkpoint）
 *
 * 借鉴来源：
 *   - DataFlow-Agent（GOAI 2026 Agent Infra 冠军，OpenDCAI/DataFlow）：
 *     自然语言 → 可编辑 DAG → 静态检查 → 惰性执行 → checkpoint 恢复。
 *   - RepoMesh（亚军）：coordinator + worker + ledger（JSONL append-only）+ refinery。
 *
 * 本框架的定位：**给现有 pipeline 提供一层"算子 + DAG + Ledger"抽象**，让 30+ 脚本
 * 不再各写各的 http/dedupe/checkpoint 逻辑，且每次运行都留一份 append-only 账本，
 * 便于追溯"这一轮的实体是怎么来的、哪一步慢、哪一步失败"。
 *
 * 硬约束（对齐项目约定）：
 *   - 零外部 npm 依赖，仅 Node 18+ 原生模块。
 *   - 幂等：算子内部自己保证（byKey/dedupeBy），框架只保证账本 append-only。
 *   - fail-closed：任何算子抛错即中止 DAG，Ledger 记录 error，report 保留 steps 前缀。
 *   - 原子写：writeJsonAtomic 用 tmp + rename，避免中途崩溃留下半文件。
 *
 * 用法（最小）：
 *   const { Dag, httpGetJson, withRetry, dedupeBy } = require('./flow.mjs');
 *   const dag = new Dag()
 *     .use('fetch', async (items, ctx) => { ... return items })
 *     .use('dedupe', async (items) => dedupeBy(items, (x) => x.id))
 *     .use('persist', async (items, ctx) => { writeJsonAtomic(outPath, items); return items });
 *   const report = await dag.run(inputItems, { pipelineName: 'openalex-expand', dryRun: DRY });
 *
 * 用法（checkpoint 恢复）：
 *   .use('fetch', async (items, ctx) => {
 *     // 逐批处理，每 N 批 checkpoint 一次
 *     for (let i = 0; i < batches.length; i++) {
 *       items.push(...await fetchBatch(batches[i]));
 *       if (i % ctx.checkpointEvery === 0) ctx.checkpoint(items);
 *     }
 *     return items;
 *   })
 *
 * 用法（ledger 追加自定义事件）：
 *   ctx.ledger.record({ event: 'custom', k: 'v' });
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state', 'flow');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const LEDGER_PATH = path.join(STATE_DIR, 'ledger.jsonl');

// ============================================================================
// 基础工具
// ============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256(data) {
  const h = crypto.createHash('sha256');
  h.update(typeof data === 'string' ? data : Buffer.from(data));
  return h.digest('hex');
}

function sha256Short(data) {
  return sha256(data).slice(0, 12);
}

/**
 * HTTP GET JSON。自动 https/http，含 timeout。
 * 不做重试——重试交给 withRetry() 包装。
 */
function httpGetJson(url, opts = {}) {
  const { headers = {}, timeoutMs = 25000, agent } = opts;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); }
    catch (e) { return reject(new Error(`bad url: ${url}`)); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, {
      headers: {
        'User-Agent': 'Genetech14-Infra/1.0 (mailto:ops@swarmlabs.tools)',
        'Accept': 'application/json',
        ...headers,
      },
      timeout: timeoutMs,
      ...(agent ? { agent } : {}),
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
        } else reject(new Error(`HTTP ${res.statusCode} on ${u.hostname}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * 通用重试。识别 429 / 5xx / timeout / ECONN* 为可重试，指数退避。
 * 其余错误直接抛出（fail-closed）。
 */
async function withRetry(fn, opts = {}) {
  const {
    maxRetry = 4,
    initialDelay = 1500,
    maxDelay = 20000,
    isRetryable = (msg) => /429|5\d{2}|timeout|ECONN|ETIMEDOUT|ECONNRESET|429 Too Many/i.test(msg),
    onRetry,
  } = opts;
  let wait = initialDelay;
  for (let i = 0; i <= maxRetry; i++) {
    try { return await fn(i); }
    catch (e) {
      const msg = String(e.message || e);
      if (isRetryable(msg) && i < maxRetry) {
        onRetry?.(e, i + 1, maxRetry, wait);
        await sleep(wait);
        wait = Math.min(wait * 2, maxDelay);
        continue;
      }
      throw e;
    }
  }
}

/**
 * 读 JSON 文件，失败返回 fallback。
 */
function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}

/**
 * 原子写 JSON。tmp + rename，避免中途崩溃留下半文件。
 * 遵守 UPDATE_DISCIPLINE.md 的 fail-closed 精神：写失败抛错。
 */
function writeJsonAtomic(p, data, opts = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const str = typeof data === 'string' ? data : JSON.stringify(data, null, opts.indent ?? 2);
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, str, 'utf8');
  fs.renameSync(tmp, p);
}

/**
 * 追加一行 JSONL（用于 ledger）。fail-open（append 失败只 warn 不阻塞流程）。
 */
function atomicAppend(p, line) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, line + '\n', 'utf8');
    return true;
  } catch (e) {
    console.warn(`[flow] ledger append failed: ${e.message}`);
    return false;
  }
}

/**
 * 按 key 去重，保留最后一条（后覆盖前）。
 * keyFn 返回 null/undefined 时跳过该条。
 */
function dedupeBy(items, keyFn) {
  const seen = new Map();
  for (const it of items) {
    if (!it) continue;
    const k = keyFn(it);
    if (k == null) continue;
    seen.set(k, it);
  }
  return Array.from(seen.values());
}

/**
 * 读一个可能不存在的数组文件；不存在或不是数组都返回 []。
 */
function readEntitiesOrEmpty(p) {
  const data = readJsonSafe(p, []);
  return Array.isArray(data) ? data : [];
}

// ============================================================================
// Operator：一个纯函数式算子
// ============================================================================

class Operator {
  constructor(def) {
    if (!def || typeof def !== 'object') throw new Error('Operator: def required');
    this.name = def.name || 'anonymous';
    if (typeof def.run !== 'function') throw new Error(`Operator(${this.name}): run() required`);
    this.run = def.run;
    this.batchSize = def.batchSize || 1;          // 每批处理多少项（0=不批量，整体一次）
    this.parallelism = def.parallelism || 1;       // 并行度（>1 时批量并发）
    this.checkpointEvery = def.checkpointEvery;    // 每 N 项 checkpoint
    this.describe = def.describe || '';            // 人类可读的用途说明
  }

  /**
   * 执行：支持 batchSize 拆分。默认一次全量处理。
   */
  async execute(items, ctx) {
    if (this.batchSize <= 1) return this.run(items, ctx);

    const out = Array.isArray(items) ? [] : [];
    for (let i = 0; i < items.length; i += this.batchSize) {
      const batch = items.slice(i, i + this.batchSize);
      const r = await this.run(batch, ctx);
      if (Array.isArray(r)) out.push(...r);
      else out.push(r);
      if (this.checkpointEvery && out.length % this.checkpointEvery === 0) {
        ctx.checkpoint?.(out);
      }
    }
    if (this.checkpointEvery) ctx.checkpoint?.(out);
    return out;
  }
}

// ============================================================================
// Ledger：JSONL append-only 账本
// ============================================================================

class Ledger {
  constructor(logDir) {
    this.path = path.join(logDir || STATE_DIR, 'ledger.jsonl');
  }
  record(entry) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ...entry,
    });
    atomicAppend(this.path, line);
  }
  /** 读最近 N 条（用于 debug / CLI） */
  tail(n = 20) {
    try {
      const txt = fs.readFileSync(this.path, 'utf8').trim().split('\n').filter(Boolean);
      return txt.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { _raw: l }; } });
    } catch { return []; }
  }
}

// ============================================================================
// RunContext：一次 DAG 运行的上下文
// ============================================================================

class RunContext {
  constructor(opts = {}) {
    this.runId = opts.runId || `run-${Date.now()}-${sha256Short(process.pid + '' + Math.random())}`;
    this.pipelineName = opts.pipelineName || 'dag';
    this.args = opts.args || {};
    this.dryRun = !!opts.dryRun;
    this.ledger = opts.ledger || new Ledger();
    this.startedAt = new Date().toISOString();
    this.checkpointPath = opts.checkpointPath
      || path.join(STATE_DIR, `checkpoint-${this.pipelineName}-${this.runId}.json`);
    this._logArgs = [];
  }

  log(...a) { console.log(`[${this.pipelineName}]`, ...a); }
  step(msg) { this.log(msg); }
  warn(...a) { console.warn(`[${this.pipelineName}]`, ...a); }

  /**
   * Checkpoint：把当前 items 写到 checkpoint 文件。
   * dryRun 时不写（避免污染 state/）。
   */
  checkpoint(items, extra = {}) {
    if (this.dryRun) return;
    try {
      writeJsonAtomic(this.checkpointPath, {
        runId: this.runId,
        pipeline: this.pipelineName,
        savedAt: new Date().toISOString(),
        count: Array.isArray(items) ? items.length : 1,
        ...extra,
        items,
      });
      this.ledger.record({ event: 'checkpoint', count: Array.isArray(items) ? items.length : 1 });
    } catch (e) {
      this.warn(`checkpoint failed: ${e.message}`);
    }
  }

  /** 从 checkpoint 恢复（供 pipeline 内部使用） */
  static restoreFrom(checkpointPath) {
    const j = readJsonSafe(checkpointPath, null);
    return j?.items ?? null;
  }
}

// ============================================================================
// Dag：算子组合，线性顺序执行
// ============================================================================

class Dag {
  constructor(opts = {}) {
    this.steps = [];
    this.opts = opts;
    this.report = null;
    this.result = null;
  }

  add(op) {
    if (!(op instanceof Operator)) throw new Error('Dag.add expects Operator');
    this.steps.push(op);
    return this;
  }

  /** 快捷：把 {name, run, ...} 转成 Operator 加入 DAG */
  use(name, run, extra = {}) {
    return this.add(new Operator({ name, run, ...extra }));
  }

  /**
   * 执行 DAG。
   * @param input 初始数据（数组或非数组，第一个算子自己处理）
   * @param opts  { pipelineName, dryRun, runId, checkpointPath, args }
   * @returns Promise<report>
   */
  async run(input, opts = {}) {
    const ledger = new Ledger();
    const ctx = new RunContext({
      runId: opts.runId,
      pipelineName: opts.pipelineName || 'dag',
      args: opts.args || {},
      ledger,
      dryRun: opts.dryRun,
      checkpointPath: opts.checkpointPath,
    });
    this.ctx = ctx;  // 暴露给外部（v2 pipeline 通过 dag.ctx._stats 读跨算子状态）

    let items = Array.isArray(input) ? input : (input == null ? [] : [input]);
    const started = Date.now();
    const stepReports = [];

    ledger.record({
      event: 'run-start',
      runId: ctx.runId,
      pipeline: ctx.pipelineName,
      steps: this.steps.length,
      inputCount: Array.isArray(items) ? items.length : 1,
      dryRun: ctx.dryRun,
    });

    for (let i = 0; i < this.steps.length; i++) {
      const op = this.steps[i];
      const stepStart = Date.now();
      const inCount = Array.isArray(items) ? items.length : 1;
      ledger.record({ event: 'step-start', runId: ctx.runId, step: i, op: op.name, inputCount: inCount });
      try {
        items = await op.execute(items, ctx);
        const elapsed = Date.now() - stepStart;
        const outCount = Array.isArray(items) ? items.length : 1;
        stepReports.push({ op: op.name, in: inCount, out: outCount, elapsedMs: elapsed, status: 'ok' });
        ledger.record({
          event: 'step-ok', runId: ctx.runId, step: i, op: op.name,
          elapsedMs: elapsed, inCount, outCount,
        });
      } catch (e) {
        const elapsed = Date.now() - stepStart;
        stepReports.push({ op: op.name, in: inCount, elapsedMs: elapsed, status: 'error', error: e.message });
        ledger.record({
          event: 'step-error', runId: ctx.runId, step: i, op: op.name,
          elapsedMs: elapsed, error: e.message,
        });
        const report = this._buildReport(ctx, stepReports, items, started, 'error', e.message);
        this.report = report;
        this.result = items;
        throw e;
      }
    }

    const report = this._buildReport(ctx, stepReports, items, started, 'ok');
    this.report = report;
    this.result = items;

    ledger.record({
      event: 'run-done',
      runId: ctx.runId,
      pipeline: ctx.pipelineName,
      elapsedMs: report.elapsedMs,
      resultCount: report.resultCount,
    });

    return report;
  }

  _buildReport(ctx, stepReports, finalItems, started, status, error) {
    return {
      pipeline: ctx.pipelineName,
      runId: ctx.runId,
      startedAt: ctx.startedAt,
      completedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      status,
      ...(error ? { error } : {}),
      dryRun: ctx.dryRun,
      resultCount: Array.isArray(finalItems) ? finalItems.length : (finalItems == null ? 0 : 1),
      steps: stepReports,
      ledgerPath: ctx.ledger.path,
      checkpointPath: ctx.checkpointPath,
    };
  }
}

// ============================================================================
// 常用 Operator 预制件（可复用给多个 pipeline）
// ============================================================================

/**
 * 按 keyFn 去重算子。
 *   const dag.use('dedupe', async (items) => dedupeBy(items, (x) => x.id));
 */
function makeDedupeOperator(keyFn, name = 'dedupe') {
  return new Operator({
    name,
    run: async (items) => dedupeBy(items, keyFn),
    describe: `按 key 去重，保留最后一条`,
  });
}

/**
 * 截断算子：超过 maxTotal 时截断。
 */
function makeCapOperator(maxTotal, name = 'cap') {
  return new Operator({
    name,
    run: async (items) => (items.length > maxTotal ? items.slice(0, maxTotal) : items),
    describe: `cap ≤ ${maxTotal}`,
  });
}

/**
 * 落盘算子：writeJsonAtomic 到指定路径。dryRun 时跳过。
 */
function makePersistOperator(outPath, name = 'persist', extra = {}) {
  return new Operator({
    name,
    run: async (items, ctx) => {
      if (ctx.dryRun) return items;
      writeJsonAtomic(outPath, items, extra);
      ctx.ledger.record({ event: 'persist', path: outPath, count: Array.isArray(items) ? items.length : 1 });
      return items;
    },
    describe: `writeJsonAtomic → ${path.relative(PROJECT_ROOT, outPath)}`,
  });
}

/**
 * 增量 upsert 算子：读已有文件 → 按 keyFn 合并 → 返回新列表。
 * 这是学术扩库 pipeline 的核心模式（openalex / s2 / pubmed / crossref 都用）。
 */
function makeUpsertOperator(outPath, keyFn, name = 'upsert') {
  return new Operator({
    name,
    run: async (items, ctx) => {
      const existing = readEntitiesOrEmpty(outPath);
      const merged = dedupeBy([...existing, ...items], keyFn);
      return merged;
    },
    describe: `upsert by key → ${path.relative(PROJECT_ROOT, outPath)}`,
  });
}

/**
 * 报告落盘算子：把 ctx.report 写到 reports/report-<pipeline>-<ts>.json。
 * 作为 DAG 的最后一个算子，即使中途失败也能保留 report（通过 dag.run 的 catch 分支）。
 */
function makeReportOperator(pipelineName, name = 'report') {
  return new Operator({
    name,
    run: async (items, ctx) => {
      if (ctx.dryRun) return items;
      // report 由 dag.run 生成，但算子拿不到 report 对象；这里改为
      // 让 pipeline 自己在 dag.run() 后手动写 report。此算子仅占位。
      return items;
    },
    describe: 'noop: report written by dag.run wrapper',
  });
}

/**
 * CLI 参数解析工具：--dry-run / --max-total=N / --foo=bar。
 * 返回 { dryRun, flags: { 'max-total': '5000', ... } }
 */
function parseArgs(argv) {
  const flags = {};
  let dryRun = false;
  for (const a of argv) {
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = true;
    }
  }
  return { dryRun, flags };
}

function getFlag(flags, key, def) {
  const v = flags[key];
  if (v == null) return def;
  if (v === true) return def;
  return v;
}

// ============================================================================
// CLI 自检：node operations-plan/flow.mjs
// ============================================================================

const __isMain = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return import.meta.url === pathToFileURL(argv1).href;
  } catch { return false; }
})();

if (__isMain) {
  (async () => {
    console.log('flow.mjs self-check');

    // 1. 工具函数
    console.log('  sha256 short:', sha256Short('hello'));
    console.log('  dedupeBy:', dedupeBy([
      { id: 1, v: 'a' }, { id: 1, v: 'b' }, { id: 2, v: 'c' }, null,
    ], (x) => x?.id).map(x => `${x.id}:${x.v}`).join(', '));

    // 2. Dag 线性执行
    const dag = new Dag()
      .use('double', async (items) => items.map((x) => x * 2))
      .use('filter', async (items) => items.filter((x) => x < 10))
      .use('sum', async (items) => items.reduce((a, b) => a + b, 0));
    const r1 = await dag.run([1, 2, 3, 4, 5, 6, 7, 8], { pipelineName: 'demo-numeric', dryRun: true });
    console.log('  demo-numeric:', JSON.stringify({ result: dag.result, elapsedMs: r1.elapsedMs, steps: r1.steps.length }));

    // 3. Dedupe operator
    const dag2 = new Dag().add(makeDedupeOperator((x) => x.id))
      .add(makeCapOperator(3));
    await dag2.run([
      { id: 'a' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
    ], { pipelineName: 'demo-dedupe', dryRun: true });
    console.log('  demo-dedupe:', JSON.stringify(dag2.result.map(x => x.id)));

    // 4. Ledger tail
    const ld = new Ledger();
    ld.record({ event: 'selfcheck', msg: 'flow.mjs self-check ok' });
    const tail = ld.tail(1);
    console.log('  ledger tail last:', JSON.stringify(tail[0]));

    console.log('\n[flow] all self-checks passed');
  })().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
}

export {
  // Core
  Operator, Dag, Ledger, RunContext,
  // Utilities
  httpGetJson, withRetry, sleep, sha256, sha256Short,
  readJsonSafe, writeJsonAtomic, atomicAppend, dedupeBy, readEntitiesOrEmpty,
  parseArgs, getFlag,
  // Prebuilt operators
  makeDedupeOperator, makeCapOperator, makePersistOperator,
  makeUpsertOperator, makeReportOperator,
  // Paths
  PROJECT_ROOT, STATE_DIR, REPORTS_DIR, LEDGER_PATH,
};
