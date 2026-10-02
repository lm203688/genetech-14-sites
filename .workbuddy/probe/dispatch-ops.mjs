// 手动触发 ops-extra 的某个任务并打印 run 号与结论。
// 用途：本地跑通不算数，必须让 CI 真跑一遍（尤其是新增的任务）。
// 用法: node .workbuddy/probe/dispatch-ops.mjs citations [academic]
import fs from 'node:fs';
import https from 'node:https';

const TOKEN = String(JSON.parse(fs.readFileSync('.workbuddy/secrets.json', 'utf8')).GITHUB_TOKEN || '').trim();
const tasks = process.argv.slice(2);
if (!tasks.length) { console.error('用法: node dispatch-ops.mjs <task> [<task>...]'); process.exit(1); }

function req(method, p, body, raw = false) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: 'api.github.com', path: p, method,
      headers: Object.assign({
        Authorization: `Bearer ${TOKEN}`,
        Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
        'User-Agent': 'dispatch-ops',
        'Content-Type': 'application/json',
      }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    }, (x) => {
      let b = ''; x.on('data', (c) => (b += c));
      x.on('end', () => resolve({ s: x.statusCode, t: b }));
    });
    r.on('error', (e) => resolve({ s: -1, t: String(e) }));
    if (data) r.write(data);
    r.end();
  });
}

for (const task of tasks) {
  const d = await req('POST', '/repos/lm203688/genetech-14-sites/actions/workflows/ops-extra.yml/dispatches', { ref: 'master', inputs: { task } });
  console.log(`dispatch ${task} → HTTP ${d.s} ${d.s === 204 ? '(已入队)' : d.t.slice(0, 200)}`);
}

await new Promise((r) => setTimeout(r, 8000));
const runs = JSON.parse((await req('GET', '/repos/lm203688/genetech-14-sites/actions/workflows/ops-extra.yml/runs?per_page=6')).t).workflow_runs;
console.log('\n最近 runs:');
for (const r of runs) {
  console.log(`  #${r.id}  ${r.status}/${r.conclusion ?? '-'}  ${new Date(r.created_at).toISOString()}  ${r.display_title}`);
}
