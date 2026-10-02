// 核对远端 tree 上这些脚本到底存不存在（本地克隆可能过期，09-29 已踩过）。
// 用法：node .workbuddy/probe/check-remote-script-existence.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { GITHUB_TOKEN } = JSON.parse(fs.readFileSync(path.join(ROOT, '.workbuddy/secrets.json'), 'utf8'));

const TARGETS = [
  'operations-plan/pipeline-cite-check.js',
  'operations-plan/pipeline-oss-scan.js',
  'operations-plan/pipeline-abstract-backfill.js',
  'operations-plan/pipeline-search-index.js',
  'operations-plan/pipeline-openalex-expand.js',
  'openapi.yaml',
  'docs/consumer-onboarding.md',
  'data/search-index.json',
  'data/knowledge-graph-baseline.json',
];

const res = await fetch('https://api.github.com/repos/lm203688/genetech-14-sites/git/trees/master?recursive=0', {
  headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'probe', Accept: 'application/vnd.github+json' },
});
if (!res.ok) { console.error('tree API', res.status, await res.text()); process.exit(1); }
const tree = await res.json();

for (const t of TARGETS) {
  const hit = tree.tree.find((n) => n.path === t);
  console.log(`${hit ? 'PRESENT' : 'ABSENT '}  ${t}${hit ? `  (${hit.size} B)` : ''}`);
}
