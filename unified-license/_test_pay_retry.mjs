// 下单落库退避重试的回归测试。
//
// 设计原则（吃过亏才定下来的）：**不用文本截取复制生产代码**。
// 第一版把 worker.js 里的落库逻辑截出来做 harness，连续踩了四个坑：
//   ① indexOf('try {') 截到重试循环内部的 try，截出半个 for 循环；
//   ② 只做花括号配平会停在 if 的 } 上，else 分支被切掉（少验一条路径却仍显示全绿）；
//   ③ data: / blob: URL 都不是真 ESM，export 直接语法错；
//   ④ 补 env 时写在 block 之后 → TDZ，ReferenceError: env is not defined。
// 截出来的代码不是被测对象，只是长得像的复制品—— 所以这一版直接把
// **真实的 handleHupijiaoCreateOrder** 抽出来跑，只打桩它的外部依赖。
//
// 用法：node unified-license/_test_pay_retry.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'worker.js'), 'utf8');

// 花括号配平抽函数（配平本身可靠；第一版的错在"截哪些"）
// 注意：helper 是**同步** function，handler 是 **async** function，
// 只找 'async function X' 会漏掉一半依赖。
function extractFn(name) {
  const keys = ['async function ' + name, 'function ' + name];
  let start = -1;
  for (const k of keys) {
    start = src.indexOf(k);
    if (start >= 0) break;
  }
  assert.ok(start >= 0, '找不到函数 ' + name);
  const braceAt = src.indexOf('{', start);
  let depth = 0;
  for (let j = braceAt; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error('花括号不配平: ' + name);
}

// PLANS / DEFAULT_HUPIJIAO_PRICE_MAP 在真实文件里是顶层 const，按行抽
// （比整个对象字面量重写更可信 —— 复制品测不出真问题）
function extractConst(name) {
  const start = src.indexOf('const ' + name + ' = {');
  assert.ok(start >= 0, '找不到常量 ' + name);
  const end = src.indexOf('\n};', start) + 3;
  assert.ok(end > start, '常量 ' + name + ' 截取失败');
  return src.slice(start, end);
}

// 抽出真实 handler + 全部依赖，只桩外部网络
const HARNESS = `
${extractConst('PLANS')}
${extractConst('DEFAULT_HUPIJIAO_PRICE_MAP')}
${extractFn('getHupijiaoChannels')}
${extractFn('getHupijiaoPriceMap')}
${extractFn('handleHupijiaoCreateOrder')}
// 只桩外部网络：真实签名 / 订单号生成 / 价格校验全部保留在被测路径上
async function createHupijiaoOrder(o) {
  if (!o.appId || !o.appSecret) throw new Error('missing credentials');
  return { qrcode: 'https://example.test/qr.png', payUrl: 'https://example.test/pay' };
}
const json = (o, s, h) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...(h || {}) } });
const err = (c, m, s, h) => json({ error: c, message: m }, s, h);
export { handleHupijiaoCreateOrder };
`;

const tmp = path.join(here, '_tmp_real_handler.mjs');
fs.writeFileSync(tmp, HARNESS);
const M = await import('./_tmp_real_handler.mjs');
fs.unlinkSync(tmp);

let putAttempts = 0;
function makeEnv(kvPut) {
  putAttempts = 0;
  return {
    UNIFIED_LICENSES: {
      get: async () => null,
      put: async (k, v, o) => {
        putAttempts++;
        if (kvPut) return kvPut(k, v, o, putAttempts);
      },
    },
    HUPIJIAO_APP_ID: 'app1',
    HUPIJIAO_APP_SECRET: 'sec1',
  };
}

async function createOrder(env) {
  putAttempts = 0; // 每次下单独立计数：check() 是并发跑的，共享计数会互相污染
  const body = { plan: 'pro', email: 't@example.com' };
  const req = new Request('https://license.swarmlabs.tools/api/hupijiao/create-order', { method: 'POST' });
  return M.handleHupijiaoCreateOrder(req, JSON.stringify(body), body, env, {});
}

let pass = 0,
  fail = 0;
const cases = [];
function check(name, fn) {
  cases.push([name, fn]);
}

console.log('【下单落库退避重试回归 · 打桩真实 handler】');

check('KV 首写成功 → order_persisted=true 且不重试', async () => {
  const env = makeEnv(null);
  const res = await createOrder(env);
  assert.equal(res.status, 200, '下单应 200，实际 ' + res.status);
  const j = await res.json();
  assert.equal(j.order_persisted, true);
  assert.equal(j.confirm_mode, 'poll');
  assert.equal(putAttempts, 1, '不该重试，实际 ' + putAttempts);
});

check('瞬时失败(429)×2 → 必须重试到成功', async () => {
  const env = makeEnv((k, v, o, n) => {
    if (n <= 2) throw new Error('KV PUT failed: 429 Too Many Requests');
  });
  const j = await (await createOrder(env)).json();
  assert.equal(j.order_persisted, true, '应重试到成功');
  assert.equal(putAttempts, 3, '应尝试 3 次，实际 ' + putAttempts);
});

check('瞬时失败×3 → persisted=false + confirm_mode=async + 带错误', async () => {
  const env = makeEnv(() => {
    throw new Error('KV PUT failed: 429 Too Many Requests');
  });
  const j = await (await createOrder(env)).json();
  assert.equal(j.order_persisted, false);
  assert.equal(j.confirm_mode, 'async');
  assert.ok(/429/.test(j.persist_error || ''), '必须带可诊断错误，实际: ' + j.persist_error);
  assert.equal(putAttempts, 3);
});

check('非瞬时错误 → 只试 1 次（不做无谓重试）', async () => {
  const env = makeEnv(() => {
    throw new Error('KV PUT failed: invalid argument');
  });
  const j = await (await createOrder(env)).json();
  assert.equal(j.order_persisted, false);
  assert.equal(putAttempts, 1, '非瞬时应只试 1 次，实际 ' + putAttempts);
});

for (const [name, fn] of cases) {
  try {
    await fn();
    console.log("  ✅", name);
    pass++;
  } catch (e) {
    console.log("  ❌", name, "→", e.message);
    fail++;
  }
}
console.log('通过', pass, '项；失败', fail, '项');
if (fail > 0) process.exit(1);
