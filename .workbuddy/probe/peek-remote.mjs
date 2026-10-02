#!/usr/bin/env node
// 打印远端文件尾部若干行（用于确认 CI 实际 checkout 到的是哪一版）。
// 用法: node peek-remote.mjs <path> [tailLines]
import fs from 'node:fs';
const T = String(JSON.parse(fs.readFileSync('.workbuddy/secrets.json', 'utf8')).GITHUB_TOKEN || '').trim();
const O = JSON.parse(fs.readFileSync('.workbuddy/secrets.json', 'utf8')).OWNER || 'lm203688';
const R = JSON.parse(fs.readFileSync('.workbuddy/secrets.json', 'utf8')).REPO || 'genetech-14-sites';
const p = process.argv[2] || '';
const tailN = Number(process.argv[3] || 20);
if (!p) { console.error('用法: node peek-remote.mjs <path> [tailLines]'); process.exit(1); }
const r = await fetch(`https://api.github.com/repos/${O}/${R}/contents/${p}?ref=master`, {
  headers: { Authorization: `Bearer ${T}`, Accept: 'application/vnd.github+json', 'User-Agent': 'peek' },
});
const j = await r.json();
console.log(`status=${r.status} size=${j.size} sha=${String(j.sha || '').slice(0, 12)}`);
const txt = Buffer.from(String(j.content || ''), 'base64').toString('utf8');
console.log(`--- 远端尾部 ${tailN} 行 ---`);
console.log(txt.split('\n').slice(-tailN).join('\n'));
