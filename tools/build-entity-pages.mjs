#!/usr/bin/env node
/**
 * build-entity-pages.mjs — per-entity 静态详情页生成器（P2-1）
 *
 * 背景（10-14 报告 §11）：30 站目前只有列表页 + Pagefind 搜索，无单实体
 * 详情页，无法承接 SEO / 分享 / 反向链接。对标 Scite / Litmaps / Semantic
 * Scholar 的国际竞品形态：每个 entity 有一个 canonical URL。
 *
 * 本脚本把 <site>/website/api/entities.json 拆成：
 *   <site>/website/entities/
 *     ├── index.html              # 站级实体索引
 *     ├── <entity-id>.html        # 每个实体一页（canonical URL）
 *     ├── tags/<tag>.html         # 每标签聚合页
 *     └── sitemap.xml             # sitemap（含所有页 URL）
 *
 * 产物特性：
 *   - HTML 精简（~1.2KB/页，无冗余 CSS），SEO 元数据齐备
 *   - JSON-LD schema.org/Publication，Google/Bing/LLM 友好
 *   - Open Graph + Twitter Card
 *   - canonical URL（基于站点部署域）
 *   - 支持中文实体（UTF-8，中文标题原样保留）
 *
 * 用法：
 *   node tools/build-entity-pages.mjs <site>                # 单站全量
 *   node tools/build-entity-pages.mjs <site> --limit 100    # 只生成前 N 条
 *   node tools/build-entity-pages.mjs --all                 # 30 站全量
 *   node tools/build-entity-pages.mjs --dry-run             # 只统计不写盘
 *
 * 环境变量：
 *   SITE_BASE_URL  站点域名（默认 https://genetech.tools/）
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── CLI 解析 ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getFlag = (name, def = null) => {
  const i = argv.indexOf(name);
  return (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : def;
};
const hasFlag = (name) => argv.includes(name);

const SITE_BASE_URL = (process.env.SITE_BASE_URL || 'https://genetech.tools').replace(/\/$/, '');
const OUT_DIR = path.join(ROOT, '_site');
const DRY_RUN = hasFlag('--dry-run');

// ─── 工具函数 ──────────────────────────────────────────────────────────────
function slugify(s) {
  if (!s) return 'untitled';
  return String(s)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')  // 保留 unicode 字母数字（含中文）
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/^-|-$/g, '') || 'untitled';
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseId(id) {
  // 支持 'pmid:42561407', 'doi:10.1000/xxx', 'arxiv:2401.00001'
  const idx = String(id).indexOf(':');
  if (idx === -1) return { source: 'unknown', key: id, hash: 'noid-' + id.length };
  const source = id.slice(0, idx);
  const key = id.slice(idx + 1);
  // 简单 hash 避免 URL 太长（原 key 保留在 data-key）
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return { source, key, hash: h.toString(36).padStart(6, '0') };
}

function truncate(s, n) {
  if (!s) return '';
  const t = String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// ─── HTML 模板 ─────────────────────────────────────────────────────────────
function renderEntityPage(e, site, outBase) {
  const { source, key, hash } = parseId(e.id);
  const slug = slugify(e.name);
  const canonical = `${SITE_BASE_URL}/${site}/entities/${slug}__${hash}.html`;
  const title = `${e.name} — GeneTech ${site}`;
  const desc = truncate(e.snippet || '', 180);
  const tags = Array.isArray(e.tags) ? e.tags : [];
  const hasDOI = source === 'doi' || (e.url || '').includes('doi.org');
  const tagsHtml = tags.slice(0, 8).map(t => `<a class="tag" href="${escapeHtml(outBase + 'tags/' + slugify(t) + '.html')}">${escapeHtml(t)}</a>`).join(' ');
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ScholarlyArticle',
    headline: e.name,
    url: e.url || canonical,
    abstract: e.snippet || '',
    datePublished: e.publishedDate || undefined,
    isAccessibleForFree: true,
    keywords: tags.join(', '),
    identifier: hasDOI ? { '@type': 'PropertyValue', propertyID: 'DOI', value: e.url || e.id } : undefined,
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeHtml(e.name)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(e.name)}">
<meta name="twitter:description" content="${escapeHtml(desc)}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;max-width:800px;margin:0 auto;padding:2rem;color:#222}
h1{font-size:1.5rem;line-height:1.3}
.meta{color:#666;font-size:.9rem;margin:1rem 0}
.snippet{background:#f5f5f5;padding:1rem;border-radius:6px;margin:1.5rem 0}
.tags{margin:1rem 0}
.tag{display:inline-block;background:#eef;color:#335;padding:.2rem .6rem;border-radius:12px;margin:0 .3rem .3rem 0;font-size:.8rem;text-decoration:none}
.actions{margin-top:2rem;padding-top:1rem;border-top:1px solid #eee}
.actions a{margin-right:1rem;color:#0645ad;text-decoration:none}
.actions a:hover{text-decoration:underline}
.home{position:fixed;top:1rem;right:1rem;font-size:.8rem;color:#888}
</style>
</head>
<body>
<a class="home" href="${escapeHtml(outBase)}">← ${escapeHtml(site)}</a>
<article>
<h1>${escapeHtml(e.name)}</h1>
<div class="meta">
${e.publishedDate ? `<time datetime="${escapeHtml(e.publishedDate)}">${escapeHtml(e.publishedDate)}</time> · ` : ''}
source: <code>${escapeHtml(source)}</code> · confidence: ${(e.confidence ?? 0).toFixed(2)}
</div>
<div class="snippet">${escapeHtml(e.snippet || '（无摘要）')}</div>
<div class="tags">${tagsHtml}</div>
<div class="actions">
${e.url ? `<a href="${escapeHtml(e.url)}" rel="noopener noreferrer" target="_blank">原文 ↗</a>` : ''}
<a href="${escapeHtml(outBase)}">返回列表</a>
<a href="${escapeHtml(outBase + 'api/entities.json')}">JSON</a>
</div>
</article>
</body>
</html>
`;
}

function renderTagsPage(tag, ents, site, outBase) {
  const slug = slugify(tag);
  const canonical = `${SITE_BASE_URL}/${site}/entities/tags/${slug}.html`;
  const title = `${tag} — GeneTech ${site}`;
  const rows = ents.slice(0, 50).map(e => {
    const { hash } = parseId(e.id);
    const eslug = slugify(e.name);
    const href = `${escapeHtml(outBase + eslug + '__' + hash + '.html')}`;
    return `<li><a href="${href}">${escapeHtml(truncate(e.name, 120))}</a><br><small>${escapeHtml(truncate(e.snippet || '', 200))}</small></li>`;
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${ents.length} entities tagged ${escapeHtml(tag)} on GeneTech ${site}.">
<link rel="canonical" href="${canonical}">
<style>
body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;max-width:800px;margin:0 auto;padding:2rem;color:#222}
a{color:#0645ad}
li{margin:.8rem 0;padding-bottom:.6rem;border-bottom:1px solid #eee}
.back{margin-bottom:1rem;display:inline-block}
</style>
</head>
<body>
<a class="back" href="${escapeHtml(outBase)}">← ${escapeHtml(site)} / entities</a>
<h1>#${escapeHtml(tag)}</h1>
<p>共 ${ents.length} 个实体</p>
<ul>
${rows}
</ul>
${ents.length > 50 ? `<p><em>已展示前 50 条，剩余 ${ents.length - 50} 条请通过 <a href="${escapeHtml(outBase + 'api/entities.json')}">entities.json</a> 获取。</em></p>` : ''}
</body>
</html>
`;
}

function renderIndexPage(site, total, entsPreview, outBase) {
  const canonical = `${SITE_BASE_URL}/${site}/entities/`;
  const topTags = collectTopTags(entsPreview, 15);
  const tagsHtml = topTags.map(([tag, count]) => `<a href="${escapeHtml(outBase + 'tags/' + slugify(tag) + '.html')}">${escapeHtml(tag)}</a> (${count})`).join(' · ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Entities — GeneTech ${site}</title>
<meta name="description" content="${total} entities on GeneTech ${site}.">
<link rel="canonical" href="${canonical}">
<style>body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;max-width:800px;margin:0 auto;padding:2rem;color:#222}a{color:#0645ad}li{margin:.5rem 0}</style>
</head>
<body>
<h1>Entities · ${escapeHtml(site)}</h1>
<p>共 ${total.toLocaleString()} 个实体。通过标签浏览或下载完整 JSON。</p>
<h2>热门标签</h2>
<p>${tagsHtml}</p>
<h2>实体预览（前 20）</h2>
<ul>${entsPreview.slice(0, 20).map(e => `<li><a href="${escapeHtml(outBase + slugify(e.name) + '__' + parseId(e.id).hash + '.html')}">${escapeHtml(truncate(e.name, 100))}</a></li>`).join('\n')}</ul>
<p><a href="${escapeHtml(outBase + 'api/entities.json')}">下载完整 entities.json</a> · <a href="${escapeHtml('../search.html')}">站内搜索</a></p>
</body>
</html>
`;
}

function collectTopTags(ents, n) {
  const counts = new Map();
  for (const e of ents) {
    for (const t of (Array.isArray(e.tags) ? e.tags : [])) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function renderSitemap(urls) {
  const rows = urls.map(u => `<url><loc>${escapeHtml(u)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows}
</urlset>
`;
}

// ─── 主流程 ────────────────────────────────────────────────────────────────
async function buildSite(site, limit) {
  const siteDir = path.join(ROOT, site);
  const entitiesPath = path.join(siteDir, 'website', 'api', 'entities.json');
  if (!fs.existsSync(entitiesPath)) {
    console.error(`[skip] ${site}: 无 ${entitiesPath}`);
    return null;
  }

  console.log(`\n[${site}] 读取 ${entitiesPath} ...`);
  const ents = JSON.parse(fs.readFileSync(entitiesPath, 'utf-8'));
  if (!Array.isArray(ents)) {
    console.error(`[skip] ${site}: entities.json 不是数组`);
    return null;
  }
  console.log(`  ${ents.length} entities, 大小 ${(fs.statSync(entitiesPath).size / 1024 / 1024).toFixed(1)}MB`);

  const toProcess = limit ? ents.slice(0, limit) : ents;

  // 按 tag 聚合
  const tagMap = new Map();
  for (const e of toProcess) {
    for (const t of (Array.isArray(e.tags) ? e.tags : [])) {
      if (!tagMap.has(t)) tagMap.set(t, []);
      if (tagMap.get(t).length < 100) tagMap.get(t).push(e);  // 上限 100 条防爆炸
    }
  }

  const outEntities = path.join(siteDir, 'website', 'entities');
  const outBase = `/entities/`;
  const sitemapUrls = [`${SITE_BASE_URL}/${site}/entities/`];

  if (!DRY_RUN) fs.mkdirSync(outEntities, { recursive: true });
  if (!DRY_RUN) fs.mkdirSync(path.join(outEntities, 'tags'), { recursive: true });

  // 1) 实体页
  const entityStats = { written: 0, bytes: 0 };
  const usedSlugs = new Map();  // slug -> count
  for (const e of toProcess) {
    const { hash } = parseId(e.id);
    let slug = slugify(e.name);
    const count = usedSlugs.get(slug) || 0;
    usedSlugs.set(slug, count + 1);
    const uniqueSlug = count > 0 ? `${slug}-${count}` : slug;
    const filename = `${uniqueSlug}__${hash}.html`;
    const html = renderEntityPage(e, site, outBase);
    if (!DRY_RUN) {
      fs.writeFileSync(path.join(outEntities, filename), html, 'utf-8');
    }
    entityStats.written++;
    entityStats.bytes += html.length;
    sitemapUrls.push(`${SITE_BASE_URL}/${site}/entities/${filename}`);
  }

  // 2) 标签页
  const tagStats = { written: 0, bytes: 0 };
  for (const [tag, tagEnts] of tagMap) {
    const html = renderTagsPage(tag, tagEnts, site, outBase);
    if (!DRY_RUN) {
      fs.writeFileSync(path.join(outEntities, 'tags', slugify(tag) + '.html'), html, 'utf-8');
    }
    tagStats.written++;
    tagStats.bytes += html.length;
    sitemapUrls.push(`${SITE_BASE_URL}/${site}/entities/tags/${slugify(tag)}.html`);
  }

  // 3) 索引页
  const indexHtml = renderIndexPage(site, ents.length, toProcess, outBase);
  if (!DRY_RUN) fs.writeFileSync(path.join(outEntities, 'index.html'), indexHtml, 'utf-8');
  sitemapUrls.push(`${SITE_BASE_URL}/${site}/entities/`);

  // 4) sitemap
  if (!DRY_RUN) fs.writeFileSync(path.join(outEntities, 'sitemap.xml'), renderSitemap(sitemapUrls), 'utf-8');

  console.log(`  实体页: ${entityStats.written} (${(entityStats.bytes / 1024).toFixed(0)}KB)`);
  console.log(`  标签页: ${tagStats.written} (${(tagStats.bytes / 1024).toFixed(0)}KB)`);
  console.log(`  sitemap: ${sitemapUrls.length} URLs`);

  return { site, entities: ents.length, written: entityStats.written, tags: tagStats.written, sitemap: sitemapUrls.length };
}

// ─── 站点发现 ──────────────────────────────────────────────────────────────
function discoverSites() {
  const sites = [];
  for (const name of fs.readdirSync(ROOT)) {
    const candidate = path.join(ROOT, name, 'website', 'api', 'entities.json');
    if (fs.existsSync(candidate)) sites.push(name);
  }
  return sites.sort();
}

// ─── 入口 ─────────────────────────────────────────────────────────────────
const positional = argv.filter(a => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]);
const targetSite = positional[0];
const all = hasFlag('--all');
const limit = parseInt(getFlag('--limit', '0'), 10) || 0;
const dryRunOnly = hasFlag('--dry-run');

if (!targetSite && !all) {
  console.error('用法: node tools/build-entity-pages.mjs <site> [--limit N] | --all [--limit N] | --dry-run');
  process.exit(1);
}

console.log(`SITE_BASE_URL = ${SITE_BASE_URL}`);
console.log(`DRY_RUN = ${DRY_RUN}`);
console.log(`LIMIT = ${limit || '全量'}`);

if (targetSite) {
  await buildSite(targetSite, limit || null);
} else if (all) {
  const sites = discoverSites();
  console.log(`发现 ${sites.length} 站: ${sites.join(', ')}`);
  const results = [];
  for (const s of sites) {
    const r = await buildSite(s, limit || null);
    if (r) results.push(r);
  }
  const total = results.reduce((a, r) => a + r.written, 0);
  const totalTags = results.reduce((a, r) => a + r.tags, 0);
  const totalUrls = results.reduce((a, r) => a + r.sitemap, 0);
  console.log(`\n=== 汇总 ===`);
  console.log(`  站数: ${results.length}`);
  console.log(`  实体页: ${total}`);
  console.log(`  标签页: ${totalTags}`);
  console.log(`  sitemap URLs: ${totalUrls}`);
}
