#!/usr/bin/env node
/**
 * GitHub REST API 推送备用通道（健壮版）
 *
 * 用途：当 github.com 的 git 传输端口不可达、但 api.github.com 仍可访问时
 * （国内网络常见的间歇性阻断），用 REST API 把本地已提交的内容同步到远端。
 *
 * 关键改进（相较旧版）：
 *   旧版依赖本地 `origin/master` 引用计算差异；当该引用因“经 API 推送”而
 *   与远端分叉、又未 fetch 对齐时，会算出错误的文件集 → HTTP 422 BadObjectState。
 *   本版**完全不信任本地 origin/master**：直接拉取远端真实 base tree，与本地
 *   HEAD tree 逐路径比对（path→sha 映射），只对“内容不同/新增”的文件造 blob，
 *   在远端 base tree 之上建新 tree → 永不产生与远端冲突的差异。
 *
 * 凭据来源：git credential helper（不接受命令行传入 token，避免泄漏到进程列表/日志）。
 *
 * 用法：
 *   node tools/api-push.mjs            # 推送本地 HEAD 相对远端真实 base 的全部改动
 *   node tools/api-push.mjs --dry-run  # 只打印将要推送的文件
 *
 * 注意：本工具用 API 直接在远端造 commit，本地历史会与远端分叉。
 * 网络恢复后建议执行 git fetch origin && git reset --hard origin/master 对齐。
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
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const out = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n\n',
    cwd: ROOT,
    encoding: 'utf8',
  });
  const m = out.match(/^password=(.*)$/m);
  if (!m) throw new Error('未能从 git credential helper 获取凭据');
  return m[1].trim();
}

function apiOnce(token, method, urlPath, body) {
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
        timeout: 60000,
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
          else reject(new Error(`HTTP ${res.statusCode} ${method} ${urlPath}: ${buf.slice(0, 800)}`));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带指数退避的 API 调用。
 * 本机到 api.github.com 的长连接在上传大 blob（单站 entities.json 可达 3MB+，
 * base64 后约 4MB）时经常被中途 reset（ECONNRESET / TLS socket disconnected）。
 * 这类是纯瞬时网络故障，重试即可成功；HTTP 4xx（鉴权/参数错）则立即失败不重试。
 */
async function api(token, method, urlPath, body, attempts = 6) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await apiOnce(token, method, urlPath, body);
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message);
      // 4xx 为确定性错误（除 429 限流外），重试无意义
      const httpCode = /^HTTP (\d{3})/.exec(msg);
      if (httpCode) {
        const code = Number(httpCode[1]);
        if (code >= 400 && code < 500 && code !== 429) throw err;
      }
      if (i === attempts) break;
      const wait = Math.min(1000 * 2 ** (i - 1), 15000);
      console.log(`[retry ${i}/${attempts - 1}] ${method} ${urlPath.slice(0, 60)} → ${msg.slice(0, 80)}；${wait}ms 后重试`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** 本地 HEAD 的 tree 映射：path -> sha（raw UTF-8 路径，关闭 quotepath 避免中文被八进制转义） */
function localTreeMap() {
  const out = execSync('git -c core.quotepath=false ls-tree -r HEAD', { cwd: ROOT, encoding: 'utf8' });
  const map = new Map();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/.exec(line);
    if (m) map.set(m[4], m[3]);
  }
  return map;
}

/** 远端 base tree 映射：path -> sha（递归拉取；超大仓库会 truncated，本仓库不会） */
async function remoteTreeMap(token, baseTreeSha) {
  const map = new Map();
  const r = await api(token, 'GET', `/repos/${OWNER}/${REPO}/git/trees/${baseTreeSha}?recursive=1`);
  for (const e of r.tree || []) if (e.type === 'blob') map.set(e.path, e.sha);
  if (r.truncated) console.warn('[warn] 远端 tree 过大被截断，部分文件可能未纳入对比');
  return map;
}

/** 仅返回“内容不同/新增”的文件（不做删除，避免误删远端其他来源的文件） */
function changedFiles(localMap, remoteMap) {
  const changed = [];
  for (const [p, sha] of localMap) {
    if (remoteMap.get(p) !== sha) changed.push({ status: 'M', file: p });
  }
  changed.sort((a, b) => a.file.localeCompare(b.file));
  return changed;
}

async function main() {
  const token = getToken();

  const ref = await api(token, 'GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const baseSha = ref.object.sha;
  const baseCommit = await api(token, 'GET', `/repos/${OWNER}/${REPO}/git/commits/${baseSha}`);
  const baseTreeSha = baseCommit.tree.sha;

  const localMap = localTreeMap();
  const remoteMap = await remoteTreeMap(token, baseTreeSha);
  const files = changedFiles(localMap, remoteMap);

  if (!files.length) {
    console.log('[ok] 本地 HEAD 树与远端 base 一致，无待推送变更');
    return;
  }
  console.log(`待推送 ${files.length} 个文件（base=${baseSha.slice(0, 7)}）：`);
  files.forEach((f) => console.log(`  ${f.status}  ${f.file}`));
  if (DRY) return;

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
    base_tree: baseTreeSha,
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
