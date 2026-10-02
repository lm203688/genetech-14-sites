#!/usr/bin/env node
/**
 * verify-content.mjs — 内容级复验：远端文件内容 vs 本地文件内容
 *
 * 为什么不能用 sha 判定
 *   推送走 Contents API 上传 CRLF，远端 tree 里的 blob sha 是 LF 归一化后的，
 *   与本地文件的 sha1 天然不同。只看 sha 会得出「没推上去」的假结论（反之亦然）。
 *   唯一可信判定：下载远端解码后的字节，与本地字节逐字节比（并额外报一次
 *   「去 \r 后再比」的结果，用来区分 CRLF 归一化 vs 真内容不同）。
 *
 * 用法: node .workbuddy/probe/verify-content.mjs pathA pathB ...
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = process.argv.slice(2);
if (!files.length) { console.error('[fail] 未指定文件'); process.exit(1); }

function loadToken() {
  try {
    const sec = JSON.parse(fs.readFileSync(path.join(ROOT, '.workbuddy', 'secrets.json'), 'utf8'));
    return String(sec.GITHUB_TOKEN || '').trim();
  } catch { return ''; }
}
const TOKEN = loadToken();

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', path: urlPath, method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'genetech-content-verify',
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    });
    req.on('error', reject);
    // blob API 走 raw 才吐原始字节；默认 JSON 会把大 blob 包成 `{sha, size}` 壳
    req.setHeader('Accept', urlPath.includes('/git/blobs/') ? 'application/vnd.github.raw' : 'application/vnd.github+json');
    req.end();
  });
}

let bad = 0;
for (const rel of files) {
  const local = path.join(ROOT, rel);
  if (!fs.existsSync(local)) { console.log(`✗ 本地缺失        ${rel}`); bad++; continue; }
  const lb = fs.readFileSync(local);
  const r = await get(`/repos/lm203688/genetech-14-sites/contents/${encodeURIComponent(rel)}?ref=master`);
  if (r.status !== 200) { console.log(`✗ 远端 ${r.status}         ${rel}`); bad++; continue; }
  const j = JSON.parse(r.body);
  // 2026-10-02 修复（工具 bug，必现）：Contents API 对 **>1MB 的文件不内联 base64**，
  // 返回 `"encoding":"none"` + `"content":""`。原实现直接拿 j.content 解码，
  // 于是任何 >1MB 的数据文件（本仓库每天推的 data/*.json 都是这个量级）
  // 恒被判成「远端 0B / 内容不同」—— 假报一次「推送丢了数据」，实际什么都没丢。
  // 正确做法：走 git blob API，`Accept: application/vnd.github.raw` 直接拿原始字节，不分大小。
  let rb;
  if (j.encoding === 'base64' && j.content) {
    rb = Buffer.from(String(j.content), 'base64');
  } else if (j.sha) {
    const b = await get(`/repos/lm203688/genetech-14-sites/git/blobs/${j.sha}`);
    if (b.status !== 200 || !b.headers) {
      console.log(`✗ 远端 blob ${b.status}      ${rel}`); bad++; continue;
    }
    // raw 响应返回的是 utf8 字符串，Buffer.compare 要求两侧都是 Buffer/Uint8Array
    rb = Buffer.from(b.body, 'utf8');
  } else {
    console.log(`✗ 远端无 content/sha    ${rel}`); bad++; continue;
  }
  const exact = Buffer.compare(lb, rb) === 0;
  const norm = Buffer.compare(Buffer.from(lb.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'),
                              Buffer.from(rb.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')) === 0;
  if (exact) console.log(`✓ 内容一致(逐字节) ${rel}  ${lb.length}B`);
  else if (norm) console.log(`~ 仅 CRLF 差异     ${rel}  本地 ${lb.length}B / 远端 ${rb.length}B`);
  else { console.log(`✗ 内容不同！       ${rel}  本地 ${lb.length}B / 远端 ${rb.length}B`); bad++; }
}
console.log(bad === 0 ? `\n全部一致（${files.length}/${files.length}）` : `\n不一致 ${bad} 个`);
process.exit(bad === 0 ? 0 : 1);
