#!/usr/bin/env node
/**
 * tools/push-api.mjs — 独立推送脚本（Node https 直连，绕过 TLS 代理）
 *
 * 用途：github.com:443 被封，api.github.com 经 TLS 代理可达但 curl 被拦截。
 *        用 Node.js https（rejectUnauthorized:false）直连，完全绕过代理。
 *
 * 用法：
 *   GH_TOKEN=ghp_xxx node tools/push-api.mjs --push
 *   GH_TOKEN=ghp_xxx node tools/push-api.mjs --dry-run
 */
import {execSync} from 'child_process';
import {readFileSync, writeFileSync} from 'fs';
import https from 'https';
import {dirname, resolve} from 'path';
import {fileURLToPath} from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'lm203688';
const REPO = 'genetech-14-sites';
const BRANCH = 'master';

function getCwdRoot() { return ROOT; }

function apiOnce(token, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const host = 'api.github.com';
    const headers = {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'genetech-ops-bot',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const isPost = method === 'POST' || method === 'PUT' || method === 'PATCH';
    if (isPost && body) {
      headers['Content-Type'] = 'application/json';
    }
    const bodyStr = isPost && body ? JSON.stringify(body) : null;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request({
      hostname: host,
      path: urlPath,
      method,
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = null;
        if (d) {
          try { parsed = JSON.parse(d); } catch {}
        }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error(`HTTP ${res.statusCode} ${method} ${urlPath}: ${d.slice(0, 600)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error(`timeout ${method} ${urlPath}`)); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function api(token, method, urlPath, body, attempts = 6) {
  let lastErr;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 已知 TLS 代理对 /git/trees POST 返回假 404（连接耗尽），视为可重试
  const isTreePost = method === 'POST' && urlPath.endsWith('/git/trees');
  for (let i = 1; i <= attempts; i++) {
    try { return await apiOnce(token, method, urlPath, body); }
    catch (err) {
      lastErr = err;
      const m = /^HTTP (\d{3})/.exec(String(err && err.message));
      const code = m ? parseInt(m[1], 10) : 0;
      // 非 404 的 4xx（除了 tree POST 的假 404）立即抛错
      const isRetryable404 = isTreePost && code === 404;
      if (!isRetryable404 && code >= 400 && code < 500 && code !== 429) throw err;
      if (i === attempts) break;
      const wait = isRetryable404
        ? Math.min(3000 * 2 ** (i - 1), 30000)
        : Math.min(1000 * 2 ** (i - 1), 15000);
      console.log(`[retry ${i}/${attempts - 1}] ${method} ${urlPath.slice(0, 50)} → ${String(err.message).slice(0, 60)}; ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

function localTreeMap() {
  const out = execSync('git -c core.quotepath=false ls-tree -r HEAD', {cwd: ROOT, encoding: 'utf8'});
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/.exec(line);
    if (m) map.set(m[4], m[3]);
  }
  return map;
}

function localContent(p) {
  return readFileSync(resolve(ROOT, p));
}

async function remoteTreeMap(token, baseTreeSha) {
  const map = new Map();
  const r = await api(token, 'GET', `/repos/${OWNER}/${REPO}/git/trees/${baseTreeSha}?recursive=1`);
  for (const e of r.tree || []) if (e.type === 'blob') map.set(e.path, e.sha);
  if (r.truncated) console.warn('[warn] 远端 tree 过大被截断');
  return map;
}

function changedFiles(localMap, remoteMap) {
  const changed = [];
  for (const [p, sha] of localMap) {
    if (remoteMap.get(p) !== sha) changed.push({status: 'M', file: p});
  }
  changed.sort((a, b) => a.file.localeCompare(b.file));
  return changed;
}

async function main() {
  const token = process.env.GH_TOKEN;
  if (!token) { console.log('[fail] GH_TOKEN 未设置'); process.exit(1); }
  const doPush = process.argv.includes('--push');
  const dryRun = process.argv.includes('--dry-run');

  console.log('[1/5] 拉远端 base tree...');
  const ref = await api(token, 'GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const baseSha = ref.object.sha;
  const baseCommit = await api(token, 'GET', `/repos/${OWNER}/${REPO}/git/commits/${baseSha}`);
  const baseTreeSha = baseCommit.tree.sha;
  console.log(`  远端 HEAD: ${baseSha.slice(0, 12)}`);
  console.log(`  远端 base tree: ${baseTreeSha.slice(0, 12)}`);

  console.log('[2/5] 对比本地 vs 远端...');
  const localMap = localTreeMap();
  const remoteMap = await remoteTreeMap(token, baseTreeSha);
  const changes = changedFiles(localMap, remoteMap);
  console.log(`  发现 ${changes.length} 个变更文件`);

  if (dryRun) {
    for (const c of changes) console.log(`  +${c.file}`);
    console.log('\n[dry-run] 以上文件将被推送（无实际写入）');
    return;
  }

  // 3+4. 交错造 blob + tree（每 5 个 blob 就造一次 tree，控制单次上传字节数，防TLS代理限制）
  console.log('[3+4/5] 交错造 blob + tree...');
  const BATCH_BLOBS = 5;
  let currentBase = baseTreeSha;
  let blobsCreated = 0;
  let treeBatches = 0;

  for (let i = 0; i < changes.length; ) {
    const batchEnd = Math.min(i + BATCH_BLOBS, changes.length);
    const batchChanges = changes.slice(i, batchEnd);

    // 造 blob
    const batchBlobs = [];
    for (const c of batchChanges) {
      const content = localContent(c.file);
      const blob = await api(token, 'POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
        content: content.toString('base64'),
        encoding: 'base64',
      });
      batchBlobs.push({path: c.file, sha: blob.sha, mode: '100644', type: 'blob'});
    }
    blobsCreated += batchBlobs.length;

    // 造 tree（分批嵌套，workflows 单条）
    // 代理对 /git/trees POST 有约 7 次/秒连接限制，每次 tree 后延迟 1000ms
    for (let j = 0; j < batchBlobs.length; ) {
      const b = batchBlobs[j];
      const hasWorkflow = b.path.includes('.github/workflows/') ||
        (j + 1 < batchBlobs.length && batchBlobs[j + 1].path.includes('.github/workflows/'));
      const sz = hasWorkflow ? 1 : Math.min(2, batchBlobs.length - j);
      const treeBatch = batchBlobs.slice(j, j + sz);
      let t;
      try {
        t = await api(token, 'POST', `/repos/${OWNER}/${REPO}/git/trees`, {
          base_tree: currentBase,
          tree: treeBatch,
        });
        // tree POST 间加延迟防代理假 404
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        if (sz > 1) {
          for (const item of treeBatch) {
            t = await api(token, 'POST', `/repos/${OWNER}/${REPO}/git/trees`, {
              base_tree: currentBase,
              tree: [item],
            });
            currentBase = t.sha;
            await new Promise(r => setTimeout(r, 1000));
          }
          j += sz;
          treeBatches++;
          continue;
        }
        throw err;
      }
      currentBase = t.sha;
      j += sz;
      treeBatches++;
    }

    // 批量间 2s 延迟（blob 批与 blob 批之间）
    if (batchEnd < changes.length) await new Promise(r => setTimeout(r, 2000));

    if (blobsCreated % 10 === 0 || batchEnd >= changes.length) {
      console.log(`    blobs=${blobsCreated}/${changes.length} treeBatches=${treeBatches}`);
    }

    i = batchEnd;
  }
  console.log(`  最终 tree: ${currentBase.slice(0, 12)}`);

  // 5. 造 commit + 更新 ref
  console.log('[5/5] 造 commit + 更新 ref...');
  const commitMsg = execSync('git log -1 --pretty=%B', {cwd: ROOT, encoding: 'utf8'}).trim();
  const commit = await api(token, 'POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: commitMsg,
    tree: currentBase,
    parents: [baseSha],
  });
  console.log(`  新 commit: ${commit.sha.slice(0, 12)}`);

  if (doPush) {
    await api(token, 'PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
      sha: commit.sha,
      force: false,
    });
    console.log(`[done] ${BRANCH} → ${commit.sha.slice(0, 12)}`);
  } else {
    console.log('[done] commit created (no ref update, pass --push to update)');
  }
}

main().catch(err => { console.error('[FATAL]', err); process.exit(1); });