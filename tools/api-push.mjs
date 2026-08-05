#!/usr/bin/env node
/**
 * GitHub REST API 推送备用通道
 *
 * 用途：当 github.com 的 git 传输端口不可达、但 api.github.com 仍可访问时
 * （国内网络常见的间歇性阻断），用 REST API 把本地已提交的变更同步到远端。
 *
 * 凭据来源：git credential helper（不接受命令行传入 token，避免泄漏到进程列表/日志）。
 *
 * 用法：
 *   node tools/api-push.mjs                 # 推送 HEAD 相对 origin/master 的全部改动文件
 *   node tools/api-push.mjs --dry-run       # 只打印将要推送的文件
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');

const OWNER = 'lm203688';
const REPO = 'genetech-14-sites';
const BRANCH = 'master';

/** 从 git credential helper 读取 token，绝不打印 */
function getToken() {
  const out = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n\n',
    cwd: ROOT,
    encoding: 'utf8',
  });
  const m = out.match(/^password=(.*)$/m);
  if (!m) throw new Error('未能从 git credential helper 获取凭据');
  return m[1].trim();
}

function api(token, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: urlPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'genetech-ops-bot',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
        timeout: 45000,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(buf);
          } catch {
            /* 非 JSON 响应 */
          }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`HTTP ${res.statusCode} ${method} ${urlPath}: ${(parsed?.message || buf).slice(0, 300)}`));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function changedFiles() {
  // HEAD 相对远端分支的差异；若无远端引用则退回最后一次提交
  let range = `origin/${BRANCH}..HEAD`;
  try {
    execSync(`git rev-parse --verify origin/${BRANCH}`, { cwd: ROOT, stdio: 'ignore' });
  } catch {
    range = 'HEAD~1..HEAD';
  }
  const out = execSync(`git diff --name-status ${range}`, { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status: status[0], file: rest[rest.length - 1] };
    });
}

async function main() {
  const files = changedFiles();
  if (!files.length) {
    console.log('[ok] 无待推送变更');
    return;
  }
  console.log(`待推送 ${files.length} 个文件：`);
  files.forEach((f) => console.log(`  ${f.status}  ${f.file}`));
  if (DRY) return;

  const token = getToken();

  const ref = await api(token, 'GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const baseSha = ref.object.sha;
  const baseCommit = await api(token, 'GET', `/repos/${OWNER}/${REPO}/git/commits/${baseSha}`);

  const tree = [];
  for (const f of files) {
    if (f.status === 'D') {
      tree.push({ path: f.file, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const abs = path.join(ROOT, f.file);
    const content = fs.readFileSync(abs);
    const blob = await api(token, 'POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: content.toString('base64'),
      encoding: 'base64',
    });
    tree.push({ path: f.file, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await api(token, 'POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    base_tree: baseCommit.tree.sha,
    tree,
  });

  const msg = execSync('git log -1 --pretty=%B', { cwd: ROOT, encoding: 'utf8' }).trim();
  const commit = await api(token, 'POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: msg,
    tree: newTree.sha,
    parents: [baseSha],
  });

  await api(token, 'PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    sha: commit.sha,
    force: false,
  });

  console.log(`[ok] 已通过 API 推送，远端 commit ${commit.sha.slice(0, 7)}`);
  console.log('提示：本地请执行 git fetch origin && git reset --hard origin/master 对齐历史');
}

main().catch((e) => {
  console.error('[fail]', e.message);
  process.exit(1);
});
