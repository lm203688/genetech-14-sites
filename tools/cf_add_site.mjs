import https from 'node:https';
const CF = process.env.CF_TOKEN;
if (!CF) { console.error('NO_CF_TOKEN_SET'); process.exit(2); }
function cf(path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.cloudflare.com', path, method,
      headers: { 'Authorization': `Bearer ${CF}`, 'User-Agent': 'genetech-agent', 'Content-Type': 'application/json' }
    }, (r) => {
      let c = ''; r.on('data', (d) => (c += d));
      r.on('end', () => resolve({ status: r.statusCode, body: c }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
(async () => {
  // 1) 校验 token 并列出可访问账户
  const a = await cf('/client/v4/accounts?per_page=5');
  console.log('ACCOUNTS_STATUS', a.status);
  if (a.status === 200) {
    const j = JSON.parse(a.body);
    j.result.forEach((x) => console.log('  ACCT:', x.name, '|', x.id));
  } else { console.log('  body:', a.body.slice(0, 400)); }

  // 2) 尝试在 61960005 账户添加 genetech.tools（full zone）
  const add = await cf('/client/v4/zones', 'POST', {
    name: 'genetech.tools',
    account: { id: '8162aa3b2241c132e43a81f526d7f758' },
    type: 'full'
  });
  console.log('ADD_ZONE_STATUS', add.status);
  console.log('  body:', add.body.slice(0, 800));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
