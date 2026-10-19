import https from 'node:https';
const CF = process.env.CF_TOKEN;
function cf(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.cloudflare.com', path, method: 'GET',
      headers: { 'Authorization': `Bearer ${CF}`, 'User-Agent': 'genetech-agent' }
    }, (r) => {
      let c = ''; r.on('data', (d) => (c += d));
      r.on('end', () => resolve({ status: r.statusCode, body: c }));
    });
    req.on('error', reject);
    req.end();
  });
}
(async () => {
  // 全局按域名精确查 genetech.tools 落在哪个账户
  const byName = await cf('/client/v4/zones?name=genetech.tools');
  console.log('BY_NAME_STATUS', byName.status);
  console.log('  body:', byName.body.slice(0, 800));

  // 463102527 账户下所有 zone
  const a1 = await cf('/client/v4/zones?account.id=17d33015cf3217441296baa17813bfa1&per_page=50');
  console.log('A_463102527_STATUS', a1.status);
  if (a1.status === 200) { const j = JSON.parse(a1.body); console.log('  463102527 zones:', j.result.map((z) => z.name).join(', ') || '(none)'); }
  else console.log('  ', a1.body.slice(0, 300));

  // 61960005 账户下所有 zone
  const a2 = await cf('/client/v4/zones?account.id=8162aa3b2241c132e43a81f526d7f758&per_page=50');
  console.log('A_61960005_STATUS', a2.status);
  if (a2.status === 200) { const j = JSON.parse(a2.body); console.log('  61960005 zones:', j.result.map((z) => z.name).join(', ') || '(none)'); }
  else console.log('  ', a2.body.slice(0, 300));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
