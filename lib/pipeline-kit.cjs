'use strict';
/**
 * lib/pipeline-kit.cjs — Pipeline 幂等三件套（F3）
 * ─────────────────────────────────────────────────────────────────────────
 * 背景
 *   报告 §3 实测：49 个 pipeline 脚本中**只有 8 个带 cursor**；
 *   retry/backoff 关键词只在 8 个文件出现——大部分采集/加工脚本
 *   中断即重头，或重跑即重复。
 *
 * 幂等三件套（报告 §3 · 硬骨头动作 2）
 *   1. 输入指纹（fingerprint）——source+query+参数哈希。
 *   2. 断点 cursor——每次成功推进后落盘，中断后从这里续跑。
 *   3. 写入前去重键（dedupKey）——同一批内按 dedupKey 去重。
 *
 * 验收目标（报告 §3）
 *   "任一脚本连跑两次，产物字节一致。"
 *
 * 用法示例
 *   const { withIdempotency } = require('../../lib/pipeline-kit.cjs');
 *
 *   const run = withIdempotency({
 *     fingerprint: { source: 'openalex', query: args.query },
 *     cursorPath: 'state/openalex-citation-cursor.json',
 *     dedupKey: (item) => item.doi,
 *     onRun: async (ctx) => {
 *       for (const doi of ctx.cursor.remaining || []) {
 *         const item = await fetchOne(doi);
 *         if (ctx.seen(item.doi)) continue;
 *         ctx.emit(item);
 *       }
 *       ctx.markDone({ remaining: [] });
 *     },
 *   });
 *   await run();
 */

const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { resolve } = require('node:path');
const { atomicWriteJson } = require('./atomic-write.cjs');

function computeFingerprint(obj) {
  const canonical = JSON.stringify(obj, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted = {};
      for (const k of Object.keys(v).sort()) sorted[k] = v[k];
      return sorted;
    }
    return v;
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

async function readCursor(cursorPath, root = process.cwd()) {
  try {
    const p = resolve(root, cursorPath);
    const txt = await fs.readFile(p, 'utf-8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function withIdempotency(cfg) {
  const { fingerprint, cursorPath, dedupKey, onRun, opts = {}, dryRun = false, root = process.cwd() } = cfg;

  const fp = computeFingerprint(fingerprint);
  const cursor = await readCursor(cursorPath, root);
  const lastFingerprint = cursor?.fingerprint;
  const emitted = [];
  const seen = new Set();

  if (lastFingerprint === fp && cursor?.completed) {
    return { skipped: true, reason: 'fingerprint-matched-and-completed', emitted: 0, fingerprint: fp };
  }

  const ctx = {
    fingerprint: fp,
    cursor: cursor || {},
    seen: (k) => seen.has(String(k)),
    emit: (item) => {
      if (!dedupKey) { emitted.push(item); return true; }
      const k = dedupKey(item);
      if (seen.has(String(k))) return false;
      seen.add(String(k));
      emitted.push(item);
      return true;
    },
    markDone: (extra = {}) => {
      ctx.cursor.fingerprint = fp;
      ctx.cursor.completed = true;
      ctx.cursor.completedAt = new Date().toISOString();
      Object.assign(ctx.cursor, extra);
    },
  };

  try {
    await onRun(ctx);
    ctx.cursor.emittedCount = (ctx.cursor.emittedCount || 0) + emitted.length;
    if (!dryRun) {
      await atomicWriteJson(resolve(root, cursorPath), ctx.cursor, opts);
    }
    return { skipped: false, reason: 'ran', emitted: emitted.length, fingerprint: fp };
  } catch (err) {
    if (!dryRun) {
      ctx.cursor.error = err.message;
      ctx.cursor.lastErrorAt = new Date().toISOString();
      await atomicWriteJson(resolve(root, cursorPath), ctx.cursor, opts).catch(() => {});
    }
    throw err;
  }
}

async function withRetry(fn, opts = {}) {
  const { maxRetries = 3, baseDelayMs = 500, isQuotaExhausted = () => false, onRetry = () => {} } = opts;
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      const status = err.status || err.statusCode || (err.response && err.response.status);
      const shouldRetry = status === 429 || (status >= 500 && status < 600);
      if (!shouldRetry || i === maxRetries) throw err;
      if (isQuotaExhausted(err)) throw err;
      const delay = baseDelayMs * Math.pow(2, i) + Math.floor(Math.random() * 100);
      onRetry(err, i + 1, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = { computeFingerprint, readCursor, withIdempotency, withRetry };
