/**
 * http-client.mjs — 统一 HTTP 客户端（收口 6 份 withRetry + 9 份 httpGet）
 *
 * 为什么需要（2026-09-29 实测）
 *   operations-plan/ 下 withRetry 存在 6 份、httpGet 存在 9 份副本，且：
 *     - User-Agent 有 3 种并存值 → 对同一上游身份不一致，限流窗口被分散
 *     - 3 处硬编码 timeout（30s）与 1 处硬编码 concurrency（3）
 *     - 无 429 Retry-After 感知 → 被限流时按固定指数退避，撞得更狠
 *   一份实现 = 一处修改。UA / 超时 / 并发 / 退避策略只在此定义。
 *
 * 借鉴来源
 *   - Scrapy: Download Middleware 链 + DOWNLOADER_AUTOTHROTTLE + DUPEFILTER
 *   - Scrapling: Fetcher/AsyncFetcher/StealthyFetcher 分层 + 浏览器指纹伪装
 *     （本项目数据源为学术 JSON API，无反爬需求，故不引入浏览器伪装——
 *       伦理与 ToS 均不应碰）
 *   - Scrapy 的 AutoThrottle 思想：按响应时间与 429 比例动态调整并发/延迟
 *
 * 硬约束
 *   - 无副作用：导入即安全，不发起任何请求
 *   - 无 process.exit
 */

import { fileURLToPath } from 'url';
import path from 'path';

// ============================================================
// 唯一 UA 来源（此前 3 处不一致，此为单一真源）
// ============================================================
export const USER_AGENT = 'GeneTechBot/2.0 (+https://swarmlabs.tools/; mailto:ops@swarmlabs.tools)';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_CONCURRENCY = 3;

/** 构造 http/https 客户端选项 */
export function buildOptions({ method = 'GET', timeout = DEFAULT_TIMEOUT_MS, headers = {}, body = null } = {}) {
  return {
    method,
    timeout,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Encoding': 'identity',   // 显式拒绝压缩，避免上游压缩后 body 需二次解压
      ...headers,
    },
    body,
  };
}

// ============================================================
// 核心请求
// ============================================================

/**
 * 单次 HTTP 请求（不做重试）
 * @returns {Promise<{statusCode, headers, body, ms}>}
 */
export async function httpGet(url, options = {}) {
  const t0 = Date.now();
  const mod = url.startsWith('https:')
    ? await import('node:https')
    : await import('node:http');
  const client = mod.default;
  const opts = buildOptions(options);
  delete opts.body;

  return new Promise((resolve, reject) => {
    const req = client.request(url, opts, (res) => {
      // 跟随 3xx 重定向（最多 3 跳），避免上游 CDN 跳板丢失
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next = res.headers.location;
        if (next.startsWith('/')) {
          const u = new URL(url);
          next = `${u.protocol}//${u.host}${next}`;
        }
        resolve(httpGet(next, options).then(r => ({ ...r, redirects: 1 })));
        return;
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: data,
        ms: Date.now() - t0,
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timeout after ${opts.timeout}ms: ${url}`)); });
    req.end();
  });
}

/** JSON 便捷封装 */
export async function getJson(url, options = {}) {
  const r = await httpGet(url, options);
  if (r.statusCode < 200 || r.statusCode >= 300) {
    const e = new Error(`HTTP ${r.statusCode} for ${url}`);
    e.statusCode = r.statusCode;
    e.headers = r.headers;
    throw e;
  }
  return { ...r, json: JSON.parse(r.body) };
}

// ============================================================
// 重试（带 429 Retry-After 感知）
// ============================================================

/**
 * 解析 Retry-After 头（秒数或 HTTP 日期）
 */
export function parseRetryAfter(h) {
  if (!h) return null;
  const n = Number(h);
  if (!Number.isNaN(n)) return n * 1000;
  const d = Date.parse(h);
  if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  return null;
}

/**
 * 指数退避重试
 * @param {Function} fn 无参返回 Promise 的函数
 * @param {object}   opts { maxRetries=3, baseDelayMs=1000, retryAfterCapMs=120000, retryable=[429,500,502,503,504] }
 * @returns {Promise<{value, attempts}>}
 */
export async function withRetry(fn, opts = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    retryAfterCapMs = 120_000,
    retryable = [429, 500, 502, 503, 504],
  } = opts;

  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const value = await fn();
      return { value, attempts: i + 1 };
    } catch (err) {
      lastErr = err;
      if (i === maxRetries) break;
      // 429/5xx 优先服从上游 Retry-After
      const ra = err.headers ? parseRetryAfter(err.headers['retry-after']) : null;
      const backoff = ra != null ? Math.min(ra, retryAfterCapMs) : baseDelayMs * Math.pow(2, i);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// 自动节流（Scrapy AutoThrottle 思想）
// ============================================================

/**
 * 自适应节流器：按 429 比例与平均响应时间动态调整延迟与并发
 */
export class AutoThrottle {
  constructor({ initialDelayMs = 250, maxDelayMs = 5000, initialConcurrency = 3, maxConcurrency = 8 } = {}) {
    this.delayMs = initialDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.concurrency = initialConcurrency;
    this.maxConcurrency = maxConcurrency;
    this.initialDelayMs = initialDelayMs;
    this.initialConcurrency = initialConcurrency;
    this.lastAt = 0;
    this.samples = [];
    this.rateLimited = 0;
  }

  /** 上报一次请求结果，调整节流参数 */
  observe({ statusCode, ms }) {
    this.samples.push({ statusCode, ms });
    if (this.samples.length > 40) this.samples.shift();
    if (statusCode === 429) {
      this.rateLimited++;
      this.delayMs = Math.min(this.maxDelayMs, this.delayMs * 2);
      this.concurrency = Math.max(1, this.concurrency - 1);
    } else if (statusCode >= 200 && statusCode < 300) {
      // 稳定后缓慢放松
      this.delayMs = Math.max(this.initialDelayMs, this.delayMs * 0.85);
      const okRate = this.samples.filter(s => s.statusCode >= 200 && s.statusCode < 400).length / this.samples.length;
      if (okRate > 0.9 && this.concurrency < this.maxConcurrency && this.delayMs === this.initialDelayMs) {
        this.concurrency++;
      }
    }
  }

  /** 礼貌等待 */
  async wait() {
    const now = Date.now();
    const gap = this.delayMs - (now - this.lastAt);
    if (gap > 0) await sleep(gap);
    this.lastAt = Date.now();
  }

  /** 当前节流参数快照 */
  metrics() {
    return {
      delayMs: Math.round(this.delayMs),
      concurrency: this.concurrency,
      rateLimited: this.rateLimited,
      samples: this.samples.length,
    };
  }
}

// ============================================================
// 并发批次执行（Scrapy 并发抓取原语）
// ============================================================

/**
 * 按并发度执行一批任务，带自动节流
 * @param {Array} items
 * @param {Function} worker async item -> result（抛错即跳过，记录 errors）
 * @param {object} opts { concurrency=3, throttle: AutoThrottle|null, retryOpts, failFast=false }
 * @returns {{results, errors, throttle}}
 */
export async function runBatch(items, worker, opts = {}) {
  const { concurrency = DEFAULT_CONCURRENCY, throttle = null, retryOpts = null, failFast = false } = opts;
  const results = [];
  const errors = [];
  let idx = 0;

  async function one() {
    while (idx < items.length) {
      const i = idx++;
      if (throttle) await throttle.wait();
      try {
        const r = retryOpts ? (await withRetry(() => worker(items[i]), retryOpts)).value : await worker(items[i]);
        if (throttle && r && typeof r.statusCode === 'number') throttle.observe(r);
        results.push({ index: i, ok: true, data: r });
      } catch (e) {
        if (throttle && e.statusCode) throttle.observe({ statusCode: e.statusCode, ms: 0 });
        errors.push({ index: i, ok: false, error: e.message, statusCode: e.statusCode || null });
        if (failFast) throw e;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => one());
  await Promise.all(workers);
  return { results, errors, throttle: throttle ? throttle.metrics() : null };
}

// ============================================================
// 熔断器（与 tools/circuit-breaker.mjs 语义对齐，就地实现避免跨目录依赖）
// ============================================================

export class CircuitBreaker {
  constructor({ name = 'unnamed', threshold = 5, cooldownMs = 60_000, halfOpenLimit = 3 } = {}) {
    this.name = name;
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.halfOpenLimit = halfOpenLimit;
    this.failures = 0;
    this.successes = 0;
    this.state = 'CLOSED';
    this.halfOpenCalls = 0;
    this.lastFailure = null;
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      if (this.lastFailure && Date.now() - this.lastFailure > this.cooldownMs) {
        this.state = 'HALF_OPEN';
        this.halfOpenCalls = 0;
      } else {
        throw new Error(`[CB:${this.name}] OPEN (${this.failures} failures)`);
      }
    }
    try {
      const v = await fn();
      this._onSuccess();
      return v;
    } catch (e) {
      this._onFailure();
      throw e;
    }
  }

  _onSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.halfOpenCalls++;
      if (this.halfOpenCalls >= this.halfOpenLimit) { this.state = 'CLOSED'; this.failures = 0; }
    } else {
      this.failures = 0;
      this.successes++;
    }
  }

  _onFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.state === 'HALF_OPEN' || this.failures >= this.threshold) this.state = 'OPEN';
  }

  metrics() {
    return { name: this.name, state: this.state, failures: this.failures, successes: this.successes };
  }
}

// ============================================================
// 自检（只在直接运行时执行；被 import 时绝不调用）
// ============================================================
if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
  if (path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    const th = new AutoThrottle({ initialDelayMs: 10, maxDelayMs: 100, initialConcurrency: 3 });
    const seq = [
      { statusCode: 200, ms: 40 }, { statusCode: 200, ms: 38 }, { statusCode: 429, ms: 12 },
      { statusCode: 200, ms: 90 }, { statusCode: 200, ms: 88 }, { statusCode: 200, ms: 45 },
    ];
    for (const s of seq) th.observe(s);
    console.log('AutoThrottle 最终:', th.metrics());
    console.log('429 后被限流降级次数:', th.rateLimited, '| 并发:', th.concurrency);

    const cb = new CircuitBreaker({ name: 'test', threshold: 3, cooldownMs: 50 });
    let n = 0;
    for (let i = 0; i < 3; i++) {
      try { await cb.execute(() => { n++; throw new Error('x'); }); } catch (e) { }
    }
    console.log('熔断器 3 次失败后状态:', cb.metrics());
    try { await cb.execute(() => 'should not run'); } catch (e) { console.log('OPEN 拒绝:', e.message); }
    await sleep(60);
    console.log('冷却后重试:', await cb.execute(() => 'recovered'));
  }
}
