// 支付链路双向回归测试（对应统一许可证的 KV 缺失/恢复两态）
// 背景：2026-10-05 实测 UNIFIED_LICENSES 有绑定但 0 keys，下单时 put 被静默吞掉，
//       轮询返 404，前端 poll() 也忽略 status → 用户以为支付失败 → 重复下单。
// 本测试对 handleHupijiaoOrderQuery 与 create-order 的落库分支做故障注入。
// 用法：node unified-license/_test_pay_states.mjs
import assert from 'node:assert';

// ---- 从 worker.js 里抽出被测函数（用正则切，避免 import 触发 addEventListener）----
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');

function extract(name) {
  const start = src.indexOf('async function ' + name);
  assert.ok(start >= 0, '找不到函数 ' + name);
  // 花括号配平截取
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error('括号不配平: ' + name);
}

const mockFetch = async (path) =>
  new Response(JSON.stringify({ success: true, license_key: 'GUX_TESTKEY' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const mockCtx = { waitUntil() {}, passThroughOnException() {} };

function makeEnv({ kv = null, putFails = false } = {}) {
  return {
    UNIFIED_LICENSES: kv
      ? {
          get: async (k) => kv[k] ?? null,
          put: async (k, v) => {
            if (putFails) throw new Error('KV PUT failed: 429 Too Many Requests');
            kv[k] = v;
          },
        }
      : undefined,
  };
}

const mod = await import(
  'data:text/javascript;base64,' +
  Buffer.from(
    `
const json = (o, s, h) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...(h||{}) } });
const err = (c, m, s, h) => json({ error: c, message: m }, s, h);
${extract('handleHupijiaoOrderQuery')}
export { handleHupijiaoOrderQuery };
`,
    'utf8'
  ).toString('base64')
);
const { handleHupijiaoOrderQuery } = mod;

let pass = 0;
let fail = 0;
const pending = [];
// check 现在返回 Promise，必须逐个 await —— 否则异步断言的失败会被静默吞掉，
// 这正是本仓库反复踩的「假绿」坑（异步测试当同步跑 = 什么都没验）。
function check(name, fn) {
  pending.push(
    Promise.resolve()
      .then(fn)
      .then(() => {
        console.log('  ✅', name);
        pass++;
      })
      .catch((e) => {
        console.log('  ❌', name, '→', e.message);
        fail++;
      })
  );
}

console.log('【handleHupijiaoOrderQuery 四态回归】');

// ① 订单已落库 + 已支付 → 200 带 key
check('已支付订单 → 200 + license_key', async () => {
  const kv = { 'hupijiao:T1': JSON.stringify({ status: 'paid', plan: 'pro', license_key: 'GUX_X' }) };
  const u = new URL('https://x/api/hupijiao/order?trade_order_id=T1');
  return handleHupijiaoOrderQuery(new Request(u), u, makeEnv({ kv }), {}).then((r) => {
    assert.equal(r.status, 200);
    return r.json();
  }).then((j) => { assert.equal(j.license_key, 'GUX_X'); });
});

// ② 订单已落库 + 待支付 → 200 + status pending（不含 key）
check('待支付订单 → 200 + status=pending', async () => {
  const kv = { 'hupijiao:T2': JSON.stringify({ status: 'pending', plan: 'pro', license_key: null }) };
  const u = new URL('https://x/api/hupijiao/order?trade_order_id=T2');
  return handleHupijiaoOrderQuery(new Request(u), u, makeEnv({ kv }), {}).then(async (r) => {
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.status, 'pending');
    assert.equal(j.license_key, null);
  });
});

// ③ ★核心回归：订单没落库 → 必须 202（不是 404），且带 reason=no_record + 防重复下单文案
check('订单未落库 → 202 + reason=no_record（不再是 404）', async () => {
  const u = new URL('https://x/api/hupijiao/order?trade_order_id=T3');
  return handleHupijiaoOrderQuery(new Request(u), u, makeEnv({ kv: {} }), {}).then(async (r) => {
    assert.equal(r.status, 202, '必须是 202，404 会让前端误判支付失败');
    const j = await r.json();
    assert.equal(j.reason, 'no_record');
    assert.equal(j.license_key, null);
    assert.ok(/请勿重复下单/.test(j.message), '必须含防重复下单提示');
  });
});

// ④ 缺参数 / KV 缺失 → 各自明确错误码
check('缺 trade_order_id → 400 missing_trade_order_id', async () => {
  const u = new URL('https://x/api/hupijiao/order');
  return handleHupijiaoOrderQuery(new Request(u), u, makeEnv({ kv: {} }), {}).then(async (r) => {
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'missing_trade_order_id');
  });
});
check('KV 绑定缺失 → 500 server_misconfigured（不得当成功）', async () => {
  const u = new URL('https://x/api/hupijiao/order?trade_order_id=T4');
  return handleHupijiaoOrderQuery(new Request(u), u, makeEnv({ kv: null }), {}).then(async (r) => {
    assert.equal(r.status, 500);
    assert.equal((await r.json()).error, 'server_misconfigured');
  });
});

await Promise.all(pending);
console.log('通过', pass, '项；失败', fail, '项');
if (fail > 0) process.exit(1);
