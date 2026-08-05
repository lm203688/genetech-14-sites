#!/usr/bin/env node
/**
 * GeneTech 14站 静态站点生成器
 *
 * 输入：仓库根目录下各站点的 <site>/website/api/{index,entities}.json
 * 输出：_site/ 目录，可直接由 GitHub Pages / Cloudflare Pages 托管
 *
 * 关键约定（不可破坏）：
 *   生成结果保持 <site>/website/api/index.json 与 entities.json 的原始路径，
 *   以保证 MCP Server 的 GENETECH_API_BASE 远程读取契约继续成立。
 *
 * 用法：node tools/build-site.mjs [--out _site] [--base ""]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};

const OUT = path.resolve(ROOT, getArg('--out', '_site'));
// BASE 用于 GitHub Pages 的子路径部署，例如 /genetech-14-sites
const BASE = (process.env.SITE_BASE ?? getArg('--base', '')).replace(/\/$/, '');
const SITE_ORIGIN = process.env.SITE_ORIGIN || '';

/** 站点中文名映射（用于标题与导航） */
const SITE_LABELS = {
  'agent-ecosystem': 'AI Agent 生态',
  'alien-minerals': '地外矿物',
  'biocomputing': '生物计算',
  'bionic-ai': '仿生智能',
  'brain-science': '脑科学',
  'deep-sea-tech': '深海科技',
  'exo-science': '地外科学',
  'genetech-tools': '基因技术工具',
  'life-science': '生命科学',
  'new-energy': '新能源',
  'nuclear-energy': '核能',
  'quantum-computing': '量子计算',
  'robot-parts': '机器人零部件',
  'tcm-tools': '中医药工具',
};

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** 发现所有含标准数据契约的站点目录 */
function discoverSites() {
  const out = [];
  for (const name of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!name.isDirectory() || name.name.startsWith('.')) continue;
    const idxPath = path.join(ROOT, name.name, 'website/api/index.json');
    const entPath = path.join(ROOT, name.name, 'website/api/entities.json');
    if (!fs.existsSync(idxPath) || !fs.existsSync(entPath)) continue;
    try {
      const index = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
      const entities = JSON.parse(fs.readFileSync(entPath, 'utf8'));
      if (!Array.isArray(entities)) continue;
      out.push({ slug: name.name, index, entities, idxPath, entPath });
    } catch (e) {
      console.warn(`[warn] 跳过 ${name.name}: ${e.message}`);
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

const CSS = `
:root{--bg:#ffffff;--fg:#16181d;--muted:#5c6370;--line:#e3e6ea;--accent:#0b62d6;--chip:#f2f5f9;--card:#fbfcfd}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:32px 20px 64px}
header.top{border-bottom:1px solid var(--line);background:var(--card)}
header.top .wrap{padding:18px 20px}
.brand{font-weight:700;font-size:16px;color:var(--fg)}
.brand span{color:var(--muted);font-weight:400;margin-left:8px;font-size:13px}
h1{font-size:26px;margin:0 0 6px;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:14px;margin:0 0 26px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.card{border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:var(--card)}
.card .n{font-weight:600;font-size:15px;margin-bottom:4px}
.card .m{color:var(--muted);font-size:12.5px}
ul.items{list-style:none;padding:0;margin:0}
ul.items li{padding:14px 0;border-bottom:1px solid var(--line)}
.t{font-weight:600;font-size:15px;margin-bottom:5px}
.meta{color:var(--muted);font-size:12.5px;display:flex;flex-wrap:wrap;gap:6px 12px}
.chip{background:var(--chip);border-radius:4px;padding:1px 7px;font-size:11.5px;color:var(--muted)}
.abs{color:#3d434d;font-size:13.5px;margin-top:6px}
footer{margin-top:40px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}
.api{background:var(--chip);border-radius:8px;padding:12px 14px;font-size:13px;margin:0 0 24px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.pager{margin-top:22px;color:var(--muted);font-size:13px}
`;

function layout({ title, desc, body, jsonld, canonical }) {
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<style>${CSS}</style>
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
<header class="top"><div class="wrap"><a class="brand" href="${BASE}/">GeneTech 知识引擎<span>14 个前沿科技垂直领域</span></a></div></header>
<div class="wrap">
${body}
<footer>
数据以 CC-BY 提供 · 通过 <code>@genetech/data-mcp</code> 可由 AI Agent 直接查询检索 ·
生成于 ${new Date().toISOString()}
</footer>
</div>
</html>`;
}

/** 单站页面 */
function renderSitePage(site, allSites) {
  const label = SITE_LABELS[site.slug] || site.slug;
  const total = site.entities.length;
  const cats = Array.isArray(site.index.categories) ? site.index.categories.slice(0, 12) : [];

  // 按加入时间倒序，最多展示 300 条，避免单页过大
  const list = [...site.entities]
    .sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')))
    .slice(0, 300);

  const items = list
    .map((e) => {
      const authors = Array.isArray(e.authors) ? e.authors.slice(0, 4).join(', ') : '';
      const more = Array.isArray(e.authors) && e.authors.length > 4 ? ' 等' : '';
      const tags = Array.isArray(e.tags) ? e.tags.slice(0, 5) : [];
      return `<li>
<div class="t">${e.url ? `<a href="${esc(e.url)}" rel="noopener nofollow" target="_blank">${esc(e.name)}</a>` : esc(e.name)}</div>
${e.abstract ? `<div class="abs">${esc(String(e.abstract).slice(0, 260))}${String(e.abstract).length > 260 ? '…' : ''}</div>` : ''}
<div class="meta">
${e.source ? `<span class="chip">${esc(e.source)}</span>` : ''}
${authors ? `<span>${esc(authors)}${more}</span>` : ''}
${e.publishedDate ? `<span>${esc(e.publishedDate)}</span>` : ''}
${typeof e.confidence === 'number' ? `<span>置信度 ${e.confidence.toFixed(2)}</span>` : ''}
${tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
</div>
</li>`;
    })
    .join('\n');

  const canonical = SITE_ORIGIN ? `${SITE_ORIGIN}${BASE}/${site.slug}/` : '';
  const body = `
<h1>${esc(label)}</h1>
<p class="sub">${total} 条实体 · 最后更新 ${esc(site.index.lastUpdated || '未知')}${
    cats.length ? ` · ${cats.map((c) => esc(c)).join(' / ')}` : ''
  }</p>
<div class="api">
机器可读接口：
<a href="${BASE}/${site.slug}/website/api/index.json"><code>index.json</code></a> ·
<a href="${BASE}/${site.slug}/website/api/entities.json"><code>entities.json</code></a>
</div>
<ul class="items">${items}</ul>
${total > list.length ? `<p class="pager">页面展示最新 ${list.length} 条，全部 ${total} 条请通过上方 <code>entities.json</code> 获取。</p>` : ''}
`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: `GeneTech ${label} 知识库`,
    description: `${label}领域的结构化科研实体数据集，共 ${total} 条。`,
    dateModified: site.index.lastUpdated,
    license: 'https://creativecommons.org/licenses/by/4.0/',
    distribution: [
      {
        '@type': 'DataDownload',
        encodingFormat: 'application/json',
        contentUrl: `${SITE_ORIGIN}${BASE}/${site.slug}/website/api/entities.json`,
      },
    ],
  };

  return layout({
    title: `${label} — GeneTech 知识引擎`,
    desc: `${label}领域 ${total} 条结构化科研实体，提供 JSON API 供 AI Agent 实时检索引用。`,
    body,
    jsonld,
    canonical,
  });
}

/** 首页 */
function renderHome(sites) {
  const total = sites.reduce((s, x) => s + x.entities.length, 0);
  const cards = sites
    .map((s) => {
      const label = SITE_LABELS[s.slug] || s.slug;
      return `<a class="card" href="${BASE}/${s.slug}/">
<div class="n">${esc(label)}</div>
<div class="m">${s.entities.length} 条 · ${esc(String(s.index.lastUpdated || '').slice(0, 10))}</div>
</a>`;
    })
    .join('\n');

  const body = `
<h1>GeneTech 知识引擎</h1>
<p class="sub">${sites.length} 个前沿科技垂直领域 · ${total} 条结构化科研实体 · 面向 AI Agent 的实时知识接口</p>
<div class="api">
每个站点均提供机器可读接口 <code>/&lt;site&gt;/website/api/entities.json</code>；
也可通过 MCP 直接接入：<code>npx -y @genetech/data-mcp</code>
</div>
<div class="grid">${cards}</div>
`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'DataCatalog',
    name: 'GeneTech 知识引擎',
    description: `覆盖 ${sites.length} 个前沿科技领域、共 ${total} 条结构化科研实体的知识目录。`,
    dataset: sites.map((s) => ({
      '@type': 'Dataset',
      name: SITE_LABELS[s.slug] || s.slug,
      url: `${SITE_ORIGIN}${BASE}/${s.slug}/`,
    })),
  };

  return layout({
    title: 'GeneTech 知识引擎 — 14 个前沿科技领域的 Agent 原生知识库',
    desc: `覆盖基因、量子计算、脑科学、AI Agent 等 ${sites.length} 个前沿科技领域，共 ${total} 条结构化实体，提供 JSON API 与 MCP 接口。`,
    body,
    jsonld,
    canonical: SITE_ORIGIN ? `${SITE_ORIGIN}${BASE}/` : '',
  });
}

function writeFile(rel, content) {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
}

function main() {
  const sites = discoverSites();
  if (!sites.length) {
    console.error('[fatal] 未发现任何符合数据契约的站点目录');
    process.exit(1);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  let totalEntities = 0;
  for (const s of sites) {
    totalEntities += s.entities.length;
    // 保持原始 API 路径契约
    writeFile(`${s.slug}/website/api/index.json`, JSON.stringify(s.index));
    writeFile(`${s.slug}/website/api/entities.json`, JSON.stringify(s.entities));
    writeFile(`${s.slug}/index.html`, renderSitePage(s, sites));
  }

  writeFile('index.html', renderHome(sites));

  // 聚合目录，方便 Agent 一次拿到全量站点清单
  writeFile(
    'api/catalog.json',
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totalSites: sites.length,
        totalEntities,
        sites: sites.map((s) => ({
          site: s.slug,
          label: SITE_LABELS[s.slug] || s.slug,
          totalEntities: s.entities.length,
          lastUpdated: s.index.lastUpdated,
          index: `${BASE}/${s.slug}/website/api/index.json`,
          entities: `${BASE}/${s.slug}/website/api/entities.json`,
        })),
      },
      null,
      2,
    ),
  );

  // sitemap + robots
  const origin = SITE_ORIGIN || '';
  const urls = ['', ...sites.map((s) => `${s.slug}/`)]
    .map((u) => `  <url><loc>${origin}${BASE}/${u}</loc></url>`)
    .join('\n');
  writeFile(
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  );
  writeFile(
    'robots.txt',
    `User-agent: *\nAllow: /\n${origin ? `Sitemap: ${origin}${BASE}/sitemap.xml\n` : ''}`,
  );
  // 禁止 GitHub Pages 的 Jekyll 处理，确保下划线等路径原样发布
  writeFile('.nojekyll', '');

  console.log(`[ok] 生成 ${sites.length} 个站点 / ${totalEntities} 条实体 → ${OUT}`);
}

main();
