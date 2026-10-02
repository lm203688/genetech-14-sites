// 把远端 master 上的单个文件拉到工作区（本地克隆落后时的必要动作）。
// 用法：node .workbuddy/probe/pull-remote-file.mjs <repo-path> <local-out>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { GITHUB_TOKEN } = JSON.parse(fs.readFileSync(path.join(ROOT, '.workbuddy/secrets.json'), 'utf8'));

const [, , repoPath, outArg] = process.argv;
if (!repoPath) { console.error('usage: pull-remote-file.mjs <repo-path> [local-out]'); process.exit(1); }
const out = outArg || path.join(ROOT, repoPath);

const res = await fetch(`https://api.github.com/repos/lm203688/genetech-14-sites/contents/${encodeURIComponent(repoPath)}?ref=master`, {
  headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'probe', Accept: 'application/vnd.github+json' },
});
if (!res.ok) { console.error('FAIL', res.status, await res.text()); process.exit(1); }
const meta = await res.json();
if (!meta.content) { console.error('not a file:', meta.type); process.exit(1); }

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(meta.content, 'base64'));
console.log(`OK ${repoPath} -> ${path.relative(ROOT, out)} (${meta.size} B, sha ${(meta.sha || '').slice(0, 12)})`);
