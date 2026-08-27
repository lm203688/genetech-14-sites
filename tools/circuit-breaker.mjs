#!/usr/bin/env node
/**
 * Circuit Breaker — 自适应熔断器
 *
 * 用途：backfill 引擎中每个数据源独立熔断，防止单个源故障拖垮全量管线。
 *
 * 三态：CLOSED（正常） → OPEN（熔断，快速失败） → HALF_OPEN（试探恢复）
 *
 * 用法：
 *   const breaker = new CircuitBreaker({threshold: 3, cooldownMs: 30_000});
 *   const data = await breaker.execute(() => fetchArxiv(query));
 *
 * 与 resilience4j / Hystrix 语义对齐，零外部依赖。
 */

export class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'unnamed';
    this.failures = 0;
    this.successes = 0;
    this.state = 'CLOSED';          // CLOSED | OPEN | HALF_OPEN
    this.threshold = options.threshold || 5;
    this.cooldownMs = options.cooldownMs || 60_000;
    this.halfOpenLimit = options.halfOpenLimit || 3;
    this.timeoutMs = options.timeoutMs || 0;       // 0 = 不超时
    this.lastFailure = null;
    this.lastStateChange = Date.now();
    this.halfOpenCalls = 0;
  }

  /** 执行 fn，按当前状态决定是否放行 */
  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > this.cooldownMs) {
        this._setState('HALF_OPEN');
        this.halfOpenCalls = 0;
      } else {
        throw new Error(`[CB:${this.name}] OPEN: ${this.failures} failures, cooldown until ${new Date(this.lastFailure + this.cooldownMs).toISOString()}`);
      }
    }
    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (e) {
      this._onFailure(e);
      throw e;
    }
  }

  _onSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.halfOpenCalls++;
      if (this.halfOpenCalls >= this.halfOpenLimit) {
        this._setState('CLOSED');
        this.failures = 0;
      }
    } else {
      this.failures = 0;
      this.successes++;
    }
  }

  _onFailure(e) {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.state === 'HALF_OPEN') {
      this._setState('OPEN');
    } else if (this.failures >= this.threshold) {
      this._setState('OPEN');
    }
  }

  _setState(newState) {
    const old = this.state;
    this.state = newState;
    this.lastStateChange = Date.now();
    if (this.onStateChange) {
      this.onStateChange(old, newState);
    }
  }

  /** 重置熔断器 */
  reset() {
    this._setState('CLOSED');
    this.failures = 0;
    this.successes = 0;
    this.halfOpenCalls = 0;
  }

  get metrics() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastStateChange: this.lastStateChange,
      cooldownRemaining: this.state === 'OPEN'
        ? Math.max(0, this.cooldownMs - (Date.now() - this.lastFailure))
        : 0
    };
  }
}

/**
 * 6 源并发采集 + 独立熔断
 *
 * 用法：
 *   const breakers = {
 *     arxiv: new CircuitBreaker({name:'arxiv', threshold:3, cooldownMs:30_000}),
 *     pubmed: new CircuitBreaker({name:'pubmed', threshold:5, cooldownMs:60_000}),
 *     // ...
 *   };
 *   const results = await runWithBreakers(breakers, sources);
 */
export async function runWithBreakers(breakers, sources) {
  const results = {};
  const errors = {};

  const promises = Object.entries(breakers).map(async ([name, breaker]) => {
    const source = sources[name];
    if (!source) {
      results[name] = null;
      return;
    }
    try {
      results[name] = await breaker.execute(source.fetch);
    } catch (e) {
      errors[name] = {error: e.message, breaker: breaker.metrics};
    }
  });

  await Promise.allSettled(promises);

  return {results, errors, breakers: Object.fromEntries(Object.entries(breakers).map(([n, b]) => [n, b.metrics]))};
}

// 冒烟测试
if (import.meta.url === `file://${process.argv[1]}`) {
  const cb = new CircuitBreaker({name: 'test', threshold: 3, cooldownMs: 1000});
  let calls = 0;

  console.log('--- Test: CLOSED → OPEN → HALF_OPEN → CLOSED ---');

  // 3 次失败 → OPEN
  for (let i = 0; i < 3; i++) {
    try {
      await cb.execute(() => { calls++; if (calls < 4) throw new Error('fail'); return 'ok'; });
    } catch (e) { console.log(`  fail #${calls}: ${cb.metrics.state}`); }
  }
  console.log(`  after 3 failures: state=${cb.metrics.state}, failures=${cb.metrics.failures}`);

  // 立即调用 → OPEN 拒绝
  try {
    await cb.execute(() => 'should not run');
  } catch (e) { console.log(`  OPEN rejected: ${e.message.slice(0, 50)}...`); }

  // 等 cooldown → HALF_OPEN
  await new Promise(r => setTimeout(r, 1100));
  let ok = 0;
  for (let i = 0; i < 5; i++) {
    try {
      await cb.execute(() => { ok++; return 'ok'; });
      console.log(`  HALF_OPEN call ${ok}: state=${cb.metrics.state}`);
    } catch (e) { console.log(`  HALF_OPEN fail: ${e.message.slice(0, 50)}`); break; }
  }

  console.log(`\nFinal: ${JSON.stringify(cb.metrics)}`);
}
