// 直查远端 data/citation-edges.json 是否真的落了 2MB 内容。
// 复用 verify-content.mjs 的失败：它读到远端 0B，需要确认是「上传丢了内容」
// 还是「读取路径取错了字段」。
import fs from 'node:fs';
import https from 'node:https';

const TOKEN = String(JSON.parse(fs.readFileSync('.workbuddy/secrets.json', 'utf8')).GITHUB_TOKEN || '').trim();

function get(p) {
  return new Promise((res) => {
    const r = https.request({
      hostname: 'api.github.com', path: p, method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'probe-citation-remote' },
    }, (x) => {
      let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ s: x.statusCode, t: b }));
    });
    r.on('error', (e) => res({ s: -1, t: String(e) }));
    r.end();
  });
}

const meta = JSON.parse((await get('/repos/lm203688/genetech-14-sites/contents/data/citation-edges.json?ref=master')).t);
console.log('contents.size =', meta.size, '| sha =', String(meta.sha).slice(0, 12));
console.log('contents.encoding =', meta.encoding, '| content 长度 =', (meta.content || '').length);

const dl = await get(meta.download_url);
console.log('raw download status =', dl.s, '| payload len =', dl.t.length);
console.log('head =', dl.t.slice(0, 200));
console.log('tail =', dl.t.slice(-120));
