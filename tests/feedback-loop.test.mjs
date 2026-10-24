/**
 * tests/feedback-loop.test.mjs — P1-4 反馈闭环集成测试
 * ============================================================================
 * 验证 api-guard/worker.js 里的 /api/feedback 三按钮 + ledger 端到端工作：
 *   1. POST 三种 vote（helpful / unhelpful / need_more）
 *   2. 无效 vote 被拒（400 invalid_vote）
 *   3. 超长 body 被截断（question 300 / answerPreview 200 / userAgent 200）
 *   4. GET /v1/feedback/stats 汇总准确
 *   5. 限流：每 IP 每分钟 30 次
 *
 * 因为 worker.js 是 CF 经典 SW（无 export），本测试直接复制 handler 里的核心
 * 逻辑（appendFeedback/readFeedbackStats/checkFeedbackRate）作为被测对象。
 * 改 worker 时两处需同步（与 lib/citation-verify.mjs 同规则）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ---- 被测逻辑（与 api-guard/worker.js 保持同步）----

const FEEDBACK_RATE = 30;
const FEEDBACK_RATE_PREFIX = 'fb:rl:';
const FEEDBACK_ENTRY_PREFIX = 'fb:e:';
const FEEDBACK_COUNTER_PREFIX = 'fb:cnt:';
const FEEDBACK_TTL = 60 * 60 * 24 * 365;

const ALLOWED_VOTES = ['helpful', 'unhelpful', 'need_more'];

function _feedbackKV(env) {
  if (env.FEEDBACK_KV) return { kv: env.FEEDBACK_KV, storage: 'feedback_kv' };
  if (env.INTEL_KV) return { kv: env.INTEL_KV, storage: 'intel_kv_fallback' };
  return { kv: null, storage: 'memory_only' };
}

function makeMemoryKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v, opts) {
      store.set(k, v);
      if (opts && opts.expirationTtl) {
        // 记录 TTL 供断言，不真删
        store.set('__ttl:' + k, opts.expirationTtl);
      }
    },
    async list({ prefix = '', limit = 10 }) {
      const keys = [];
      for (const k of store.keys()) {
        if (k.startsWith('__')) continue;
        if (k.startsWith(prefix) && keys.length < limit) keys.push({ name: k });
      }
      return { keys };
    },
    _store: store,
  };
}

const _fbMemory = { counter: 0, entries: [], rl: new Map() };

async function checkFeedbackRate(env, ip) {
  const now = Math.floor(Date.now() / 60000);
  const { kv } = _feedbackKV(env);
  const key = FEEDBACK_RATE_PREFIX + ip + ':' + now;
  if (kv) {
    const raw = await kv.get(key);
    const n = raw ? parseInt(raw, 10) : 0;
    if (n >= FEEDBACK_RATE) return { allowed: false, count: n, limit: FEEDBACK_RATE };
    await kv.put(key, String(n + 1), { expirationTtl: 120 });
    return { allowed: true, count: n + 1, limit: FEEDBACK_RATE };
  }
  const bucket = FEEDBACK_RATE_PREFIX + ip + ':' + now;
  const n = (_fbMemory.rl.get(bucket) || 0);
  if (n >= FEEDBACK_RATE) return { allowed: false, count: n, limit: FEEDBACK_RATE };
  _fbMemory.rl.set(bucket, n + 1);
  return { allowed: true, count: n + 1, limit: FEEDBACK_RATE };
}

function normalizeEntry(body, at) {
  return {
    kind: 'ask_feedback',
    vote: String(body.vote || '').trim(),
    question: String(body.question || '').slice(0, 300),
    answerPreview: String(body.answerPreview || '').slice(0, 200),
    model: body.model ? String(body.model).slice(0, 60) : null,
    sourceCount: Number.isFinite(body.sourceCount) ? Number(body.sourceCount) : 0,
    userAgent: String(body.userAgent || '').slice(0, 200),
    referrer: body.referrer ? String(body.referrer).slice(0, 200) : null,
    at: at || body.at || new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  };
}

async function appendFeedback(entry, env) {
  const { kv, storage } = _feedbackKV(env);
  entry.seq = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  entry.storage = storage;
  const json = JSON.stringify(entry);
  if (!kv) {
    _fbMemory.counter += 1;
    entry.seq = _fbMemory.counter;
    entry.storage = 'memory_only';
    _fbMemory.entries.push(entry);
    return { ok: true, storage, seq: entry.seq };
  }
  const eKey = FEEDBACK_ENTRY_PREFIX + entry.seq;
  await kv.put(eKey, json, { expirationTtl: FEEDBACK_TTL });
  try {
    const cKey = FEEDBACK_COUNTER_PREFIX + 'all';
    const raw = await kv.get(cKey);
    const c = raw ? JSON.parse(raw) : { total: 0, byVote: { helpful: 0, unhelpful: 0, need_more: 0 }, byDay: {} };
    c.total += 1;
    c.byVote[entry.vote] = (c.byVote[entry.vote] || 0) + 1;
    const day = entry.at.slice(0, 10);
    c.byDay[day] = (c.byDay[day] || 0) + 1;
    await kv.put(cKey, JSON.stringify(c), { expirationTtl: FEEDBACK_TTL });
  } catch {}
  return { ok: true, storage, seq: entry.seq };
}

async function readFeedbackStats(env) {
  const { kv, storage } = _feedbackKV(env);
  if (!kv) {
    const byVote = { helpful: 0, unhelpful: 0, need_more: 0 };
    for (const e of _fbMemory.entries) if (byVote[e.vote] !== undefined) byVote[e.vote] += 1;
    return { storage, total: _fbMemory.entries.length, byVote, recent: _fbMemory.entries.slice(-20).reverse() };
  }
  const cKey = FEEDBACK_COUNTER_PREFIX + 'all';
  const raw = await kv.get(cKey);
  if (!raw) return { storage, total: 0, byVote: { helpful: 0, unhelpful: 0, need_more: 0 }, byDay: {}, recent: [] };
  const c = JSON.parse(raw);
  const list = await kv.list({ prefix: FEEDBACK_ENTRY_PREFIX, limit: 20 });
  const recent = [];
  for (const k of list.keys || []) {
    const v = await kv.get(k.name);
    if (v) recent.push(JSON.parse(v));
  }
  recent.sort((a, b) => (a.receivedAt || '').localeCompare(b.receivedAt || ''));
  return { storage, total: c.total || 0, byVote: c.byVote || { helpful: 0, unhelpful: 0, need_more: 0 }, byDay: c.byDay || {}, recent: recent.slice(-20).reverse() };
}

// ---- 模拟 handler（抽出核心业务逻辑）----

async function handleFeedback(request, env) {
  if (request.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
  const ip = request.headers.get('x-forwarded-for') || 'test-ip';
  const fbRl = await checkFeedbackRate(env, ip);
  if (!fbRl.allowed) return { status: 429, body: { error: 'rate_limited' } };
  let body;
  try { body = JSON.parse(request.body); }
  catch { return { status: 400, body: { error: 'bad_json' } }; }
  if (!ALLOWED_VOTES.includes(body.vote)) {
    return { status: 400, body: { error: 'invalid_vote' } };
  }
  const entry = normalizeEntry(body);
  const stored = await appendFeedback(entry, env);
  return { status: 200, body: { ok: true, vote: body.vote, storage: stored.storage, seq: stored.seq } };
}

// ---- 测试 ----

function reset() {
  _fbMemory.counter = 0;
  _fbMemory.entries = [];
  _fbMemory.rl = new Map();
}

test('POST helpful 落 KV 并返回 ok', async () => {
  reset();
  const kv = makeMemoryKV();
  const env = { FEEDBACK_KV: kv };
  const r = await handleFeedback({
    method: 'POST',
    headers: { get: (k) => k === 'x-forwarded-for' ? '1.2.3.4' : null },
    body: JSON.stringify({
      vote: 'helpful',
      question: '量子计算趋势?',
      answerPreview: '2026 年量子...',
      model: 'gpt-4o-mini',
      sourceCount: 3,
      userAgent: 'Mozilla/5.0',
      referrer: 'https://example.com/ask.html',
      at: '2026-10-24T12:00:00.000Z',
    }),
  }, env);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.storage, 'feedback_kv');
  // KV 中应有 1 条 entry + 1 条 counter
  const store = kv._store;
  let entryCount = 0, counterCount = 0;
  for (const k of store.keys()) {
    if (k.startsWith(FEEDBACK_ENTRY_PREFIX)) entryCount++;
    if (k.startsWith(FEEDBACK_COUNTER_PREFIX)) counterCount++;
  }
  assert.equal(entryCount, 1);
  assert.equal(counterCount, 1);
});

test('无效 vote 被 400 拒', async () => {
  reset();
  const env = { FEEDBACK_KV: makeMemoryKV() };
  for (const bad of ['', 'awesome', 'BAD', 'HELPFUL', 'need-more', '👍']) {
    const r = await handleFeedback({
      method: 'POST',
      headers: { get: () => '1.2.3.4' },
      body: JSON.stringify({ vote: bad, question: 'q' }),
    }, env);
    assert.equal(r.status, 400, `vote=${JSON.stringify(bad)} 应返 400`);
    assert.equal(r.body.error, 'invalid_vote');
  }
});

test('question/answerPreview/userAgent 被截断', async () => {
  reset();
  const env = { FEEDBACK_KV: makeMemoryKV() };
  const r = await handleFeedback({
    method: 'POST',
    headers: { get: () => '1.2.3.4' },
    body: JSON.stringify({
      vote: 'helpful',
      question: 'x'.repeat(500),
      answerPreview: 'y'.repeat(500),
      userAgent: 'z'.repeat(500),
    }),
  }, env);
  assert.equal(r.status, 200);
  // 落盘的 entry 里字段长度应被截断
  const kv = env.FEEDBACK_KV;
  const keys = await kv.list({ prefix: FEEDBACK_ENTRY_PREFIX });
  const entry = JSON.parse(await kv.get(keys.keys[0].name));
  assert.equal(entry.question.length, 300);
  assert.equal(entry.answerPreview.length, 200);
  assert.equal(entry.userAgent.length, 200);
});

test('三种 vote 汇总到 stats.byVote', async () => {
  reset();
  const kv = makeMemoryKV();
  const env = { FEEDBACK_KV: kv };
  const mkReq = (vote) => ({
    method: 'POST',
    headers: { get: () => '5.6.7.8' },
    body: JSON.stringify({ vote, question: 'q-' + vote, answerPreview: 'a', at: '2026-10-24T12:00:00.000Z' }),
  });
  await handleFeedback(mkReq('helpful'), env);
  await handleFeedback(mkReq('helpful'), env);
  await handleFeedback(mkReq('unhelpful'), env);
  await handleFeedback(mkReq('need_more'), env);
  const stats = await readFeedbackStats(env);
  assert.equal(stats.total, 4);
  assert.equal(stats.byVote.helpful, 2);
  assert.equal(stats.byVote.unhelpful, 1);
  assert.equal(stats.byVote.need_more, 1);
  assert.ok(stats.byDay['2026-10-24'] >= 4);
});

test('限流：每 IP 每分钟 30 次上限', async () => {
  reset();
  const env = { FEEDBACK_KV: makeMemoryKV() };
  const mkReq = () => ({
    method: 'POST',
    headers: { get: () => 'same-ip' },
    body: JSON.stringify({ vote: 'helpful', question: 'q', answerPreview: 'a', at: '2026-10-24T12:00:00.000Z' }),
  });
  // 前 30 次都通过
  for (let i = 0; i < FEEDBACK_RATE; i++) {
    const r = await handleFeedback(mkReq(), env);
    assert.equal(r.status, 200, `第 ${i + 1} 次应通过`);
  }
  // 第 31 次被限流
  const blocked = await handleFeedback(mkReq(), env);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
});

test('不同 IP 独立限流', async () => {
  reset();
  const env = { FEEDBACK_KV: makeMemoryKV() };
  const mkReq = (ip) => ({
    method: 'POST',
    headers: { get: (k) => k === 'x-forwarded-for' ? ip : null },
    body: JSON.stringify({ vote: 'helpful', question: 'q', answerPreview: 'a', at: '2026-10-24T12:00:00.000Z' }),
  });
  // IP-A 用满 30 次
  for (let i = 0; i < FEEDBACK_RATE; i++) await handleFeedback(mkReq('ip-a'), env);
  // IP-A 第 31 次被限
  assert.equal((await handleFeedback(mkReq('ip-a'), env)).status, 429);
  // IP-B 第 1 次仍通过
  assert.equal((await handleFeedback(mkReq('ip-b'), env)).status, 200);
});

test('GET /api/feedback 拒 405', async () => {
  const env = { FEEDBACK_KV: makeMemoryKV() };
  const r = await handleFeedback({
    method: 'GET',
    headers: { get: () => 'x' },
    body: '',
  }, env);
  assert.equal(r.status, 405);
  assert.equal(r.body.error, 'method_not_allowed');
});

test('bad JSON body 返 400', async () => {
  const env = { FEEDBACK_KV: makeMemoryKV() };
  const r = await handleFeedback({
    method: 'POST',
    headers: { get: () => 'x' },
    body: '{invalid json',
  }, env);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad_json');
});

test('KV 未绑定时降级到 memory（storage=memory_only）', async () => {
  reset();
  const env = {};
  const r = await handleFeedback({
    method: 'POST',
    headers: { get: () => 'x' },
    body: JSON.stringify({ vote: 'helpful', question: 'q', answerPreview: 'a', at: '2026-10-24T12:00:00.000Z' }),
  }, env);
  assert.equal(r.status, 200);
  assert.equal(r.body.storage, 'memory_only');
});

// ---- 不变量 ----

test('INVARIANT: 所有 vote 都在白名单内', () => {
  const allowed = new Set(['helpful', 'unhelpful', 'need_more']);
  for (const v of ALLOWED_VOTES) assert.ok(allowed.has(v));
});

test('INVARIANT: entry 落盘后字段完整性', async () => {
  reset();
  const kv = makeMemoryKV();
  const env = { FEEDBACK_KV: kv };
  await handleFeedback({
    method: 'POST',
    headers: { get: () => 'x' },
    body: JSON.stringify({
      vote: 'helpful',
      question: 'q1',
      answerPreview: 'a1',
      model: 'gpt-4o-mini',
      sourceCount: 5,
      userAgent: 'ua',
      referrer: 'https://ref.com',
      at: '2026-10-24T12:00:00.000Z',
    }),
  }, env);
  const keys = await kv.list({ prefix: FEEDBACK_ENTRY_PREFIX });
  const entry = JSON.parse(await kv.get(keys.keys[0].name));
  // 必备字段
  for (const f of ['kind', 'vote', 'question', 'answerPreview', 'at', 'receivedAt', 'seq', 'storage']) {
    assert.ok(f in entry, `缺字段 ${f}`);
  }
  // 字段值正确
  assert.equal(entry.kind, 'ask_feedback');
  assert.equal(entry.vote, 'helpful');
  assert.equal(entry.sourceCount, 5);
  // 截断生效
  assert.ok(entry.question.length <= 300);
  assert.ok(entry.answerPreview.length <= 200);
  assert.ok(entry.userAgent.length <= 200);
});
