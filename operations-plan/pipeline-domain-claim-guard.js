#!/usr/bin/env node
/**
 * operations-plan/pipeline-domain-claim-guard.js
 *
 * G0 的护栏形态：扫出公开面上任何「<站>.swarmlabs.tools」形式的站点域宣称，
 * 并让 CI 变红。
 *
 * 为什么要这个护栏（不是"改一次文案"就能结束的事）
 *   30 个站点子域（quantum-computing.swarmlabs.tools 等）从未配置 DNS，
 *   `getent hosts` / `nslookup` 立刻返回无记录。这是**10 秒可证伪**的对外宣称。
 *   而同一二级域下的 api. / data. / license. 三个子域是能解析的——
 *   这恰恰是危险所在：它会让后续写文档的人误以为"这个域名没问题"，于是又写回去。
 *   所以必须把"别再写"变成机器判据，而不是靠人记得。
 *
 * 用法
 *   node operations-plan/pipeline-domain-claim-guard.js                # 检查
 *   node operations-plan/pipeline-domain-claim-guard.js --allow-dns    # 联网 DNS 复核（慢，CI 不用）
 *
 * 退出码
 *   0  无违规
 *   1  发现违规宣称（CI 应阻断）
 *   2  配置错误
 */
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';

const ROOT = process.cwd();
const ALLOW_DNS = process.argv.includes('--allow-dns');

// 平台域：这三个子域确实存在（2026-10-08 实测 200），是合法对外地址。
const ALLOWED_SUBDOMAINS = new Set(['api', 'data', 'license']);

// 公开面扫描清单。原则：**对外可见的都扫，内部文档也要扫**（因为内部文档
// 常被复制进对外材料，且 docs/ 整体在公开仓里）。
const SCAN_GLOBS = [
  'README.md',
  'openapi.yaml',
  'glama.json',
  'mcp-server/README.md',
  'mcp-server/package.json',
];
const SCAN_DIRS = ['docs', 'mcp-server', 'api-guard'];

// 明确排除：历史报告与归档保留违规实例作为证据（改了就把取证链抹掉了）。
const EXCLUDE_DIRS = new Set(['_site', '_site_test', '_site_geo', 'node_modules', '.workbuddy', '.git', '.backups', 'archive']);
const EXCLUDE_GLOBS = /reports\/|\/archive\/|node_modules\//;

function listFiles() {
  const out = new Set();
  for (const g of SCAN_GLOBS) if (fs.existsSync(path.join(ROOT, g))) out.add(g);
  for (const d of SCAN_DIRS) {
    const base = path.join(ROOT, d);
    if (!fs.existsSync(base)) continue;
    (function walk(p, rel) {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (EXCLUDE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(p, e.name), r);
        else if (/\.(md|mdx|json|ya?ml|html|js|mjs|txt)$/.test(e.name)) out.add(r);
      }
    })(base, d);
  }
  return Array.from(out).filter((f) => !EXCLUDE_GLOBS.test(f));
}

// 找站点 slug：任何有 website/api/index.json 的顶层目录。
function stationSlugs() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, e.name, 'website', 'api', 'index.json')))
    .map((e) => e.name);
}

/** 匹配 `<站>.swarmlabs.tools` 或 `<站>.genetech.tools`（站点子域宣称）。 */
function buildPattern(slugs) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const slugAlt = slugs.map(esc).join('|');
  // 允许前面是裸域前缀（*.swarmlabs.tools 形式的通配宣称）
  return new RegExp(
    `(^|[^a-zA-Z0-9-])((?:${slugAlt})|\\*)\\.(?:swarmlabs\\.tools|genetech\\.tools)(?:[:/\"'\\s<),\\]|]|$)`,
    'g'
  );
}

async function checkDns(host) {
  try {
    const r = await dns.lookup(host, { all: true, ttl: false });
    return r.length > 0;
  } catch {
    return false;
  }
}

async function main() {
  const slugs = stationSlugs();
  if (!slugs.length) {
    console.error('[domain-guard][FAIL] 找不到任何站点目录（缺 website/api/index.json），配置错误');
    process.exit(2);
  }
  const pat = buildPattern(slugs);
  const files = listFiles();

  console.log(`[domain-guard] 站点 ${slugs.length} 个 | 公开面文件 ${files.length} 个`);
  console.log(`[domain-guard] 平台域白名单: ${[...ALLOWED_SUBDOMAINS].join(', ')}`);

  const violations = [];
  for (const f of files) {
    const p = path.join(ROOT, f);
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (text.length > 2_000_000) continue; // 跳过超大产物
    let m;
    pat.lastIndex = 0;
    while ((m = pat.exec(text))) {
      const host = m[2] + '.' + m[3];
      const line = text.slice(0, m.index).split('\n').length;
      violations.push({ file: f, line, host, snippet: m[0].trim().slice(0, 120) });
    }
  }

  let dnsChecked = 0;
  const dnsResults = {};
  if (ALLOW_DNS) {
    for (const v of violations) {
      if (v.host === '*.swarmlabs.tools' || dnsResults[v.host] !== undefined) continue;
      dnsResults[v.host] = await checkDns(v.host);
      dnsChecked++;
      console.log(`[domain-guard] DNS ${v.host} → ${dnsResults[v.host] ? '有记录' : '无记录'}`);
    }
  }

  console.log('');
  if (!violations.length) {
    console.log('[domain-guard] 公开面 0 处站点子域宣称。OK');
    process.exit(0);
  }

  console.log(`[domain-guard][FAIL] 发现 ${violations.length} 处站点子域宣称：`);
  for (const v of violations.slice(0, 40)) {
    const dnsTag = dnsResults[v.host] === undefined ? '' : ` | DNS=${dnsResults[v.host] ? '有记录' : '无记录'}`;
    console.log(`  ${v.file}:${v.line}  ${v.host}${dnsTag}`);
    console.log(`    ${v.snippet}`);
  }
  if (violations.length > 40) console.log(`  ……另有 ${violations.length - 40} 处`);
  console.log('');
  console.log('[domain-guard][FAIL] 处理办法：改用真实可达地址 api.swarmlabs.tools / data.swarmlabs.tools，');
  console.log('[domain-guard][FAIL] 或 GitHub Pages 相对路径（见 README「可达性事实」一节）。');
  process.exit(1);
}

main();
