#!/usr/bin/env node
// 探测 zone 归属 + 探测能不能加 Worker 路由
import process from 'node:process';

const TOKEN = process.env.CF_TOKEN;
const ACCOUNT_ID = '8162aa3b2241c132e43a81f526d7f758';

async function cf(path, opts = {}) {
  const r = await fetch(`https://api.cloudflare.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

const log = (...a) => console.log(...a);

log('=== 1. 列 61960005 账户 zones ===');
const zonesRes = await cf(`/client/v4/zones?account.id=${ACCOUNT_ID}&per_page=50`);
log(`status=${zonesRes.status}`);
if (zonesRes.body?.result) {
  for (const z of zonesRes.body.result) {
    log(`  ${z.name.padEnd(25)} id=${z.id} status=${z.status}`);
  }
}

log('\n=== 2. 直接按名查 genetech.tools ===');
const direct = await cf(`/client/v4/zones?name=genetech.tools`);
log(`status=${direct.status} total=${direct.body?.result_info?.total_count}`);
if (direct.body?.result?.length) {
  const z = direct.body.result[0];
  log(`  zone_id=${z.id} account_id=${z.account?.id} status=${z.status}`);
}

log('\n=== 3. 试探加 Worker 路由 (license.genetech.tools/*) ===');
// 先拿 unified-license script 的 ref
const scriptsRes = await cf(`/accounts/${ACCOUNT_ID}/workers/scripts/unified-license`);
log(`script lookup status=${scriptsRes.status}`);

// 直接尝试添加路由
const zone = (direct.body?.result || [])[0];
if (zone) {
  log(`\n=== 4. POST /zones/${zone.id}/workers/routes ===`);
  const addRes = await cf(`/zones/${zone.id}/workers/routes`, {
    method: 'POST',
    body: JSON.stringify({
      pattern: 'license.genetech.tools/*',
      script: 'unified-license',
    }),
  });
  log(`status=${addRes.status}`);
  log(JSON.stringify(addRes.body, null, 2));
}
