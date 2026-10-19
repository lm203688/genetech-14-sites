#!/usr/bin/env node
import process from 'node:process';

const TOKEN = process.env.CF_TOKEN;
const ACCOUNT_ID = '8162aa3b2241c132e43a81f526d7f758';
const ZONE_ID = '7e0473d710a545e7f145651c8a02d721';

async function cf(path, opts = {}) {
  const base = path.startsWith('/') ? path : '/' + path;
  const url = path.startsWith('https://') ? path : `https://api.cloudflare.com/client/v4${base}`;
  const r = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j, url };
}

const log = (...a) => console.log(...a);

log('=== 1. zone 详情 ===');
const z = await cf(`/zones/${ZONE_ID}`);
log(`status=${z.status}`);
log(JSON.stringify(z.body?.result, null, 2));

log('\n=== 2. 账户下 Worker scripts 列表 (用 accounts 路径) ===');
const a1 = await cf(`/accounts/${ACCOUNT_ID}/workers/scripts`);
log(`status=${a1.status}`);
log(JSON.stringify(a1.body?.result, null, 2)?.slice(0, 2000));

log('\n=== 3. 试 GET /zones/:id/workers/routes (已存在的路由) ===');
const routes = await cf(`/zones/${ZONE_ID}/workers/routes`);
log(`status=${routes.status}`);
log(JSON.stringify(routes.body, null, 2)?.slice(0, 1000));

log('\n=== 4. 试另一种路径 /accounts/:id/workers/routes ===');
const accRoutes = await cf(`/accounts/${ACCOUNT_ID}/workers/routes`);
log(`status=${accRoutes.status}`);
log(JSON.stringify(accRoutes.body, null, 2)?.slice(0, 1000));

log('\n=== 5. token permissions 自检 ===');
const v = await cf(`/user/tokens/verify`);
log(JSON.stringify(v.body, null, 2));
