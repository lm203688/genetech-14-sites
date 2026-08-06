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
// 生产环境绝对地址（用于 canonical / og:url / JSON-LD；CI 会通过 SITE_ORIGIN 覆盖）
const PROD_ORIGIN = 'https://lm203688.github.io';
const ORIGIN = SITE_ORIGIN || PROD_ORIGIN;
// IndexNow 密钥：公开托管于 .well-known/indexnow.txt；CI 端需在仓库 Secrets 配置同名 INDEXNOW_KEY 才能向 Bing/Yandex 提交
// 优先用 CI 注入的真实密钥（仓库 Secrets: INDEXNOW_KEY），缺省回退占位值（需替换）
// IndexNow 密钥：默认用仓库内置稳定 key（state/indexnow-key.txt，已随仓库提交，零外部账号），
// 若 CI 注入 INDEXNOW_KEY 则优先用其覆盖；最后回退占位值（仅本地调试）。
// 该 key 发布到 .well-known/indexnow.txt 即与提交请求自洽，无需任何 Bing 账号。
const INDEXNOW_KEY = (() => {
  if (process.env.INDEXNOW_KEY) return process.env.INDEXNOW_KEY;
  try {
    const kp = path.join(ROOT, 'state', 'indexnow-key.txt');
    const k = fs.readFileSync(kp, 'utf8').trim();
    if (k) return k;
  } catch {}
  return 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
})();
// Google Search Console 验证元标签：CI 端配 Secrets: GSC_VERIFICATION 后自动注入首页 <head>，
// 用户即可在 GSC 用「HTML 标记」方式零服务器验证所有权
const GSC_VERIFICATION = process.env.GSC_VERIFICATION || '';

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

// ---------------------------------------------------------------------------
// 轻量 Markdown -> HTML（无依赖，零成本；用于自动生成的 GEO 博客文章）
// 支持：标题 #~######、段落、无序/有序列表、引用、分隔线、行内 **粗体** *斜体* `代码` [链接](url)、围栏代码块
// ---------------------------------------------------------------------------
function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let i = 0;
  let inCode = false;
  let codeBuf = [];
  let inList = false;
  let listType = '';
  const closeList = () => {
    if (inList) {
      html += `</${listType}>`;
      inList = false;
      listType = '';
    }
  };
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener nofollow" target="_blank">$1</a>');
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeBuf = [];
        closeList();
        i++;
        continue;
      }
      inCode = false;
      html += `<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`;
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }
    let m;
    if ((m = line.match(/^\s*(#{1,6})\s+(.*)$/))) {
      closeList();
      const lvl = m[1].length;
      html += `<h${lvl}>${inline(m[2])}</h${lvl}>`;
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      closeList();
      html += `<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`;
      i++;
      continue;
    }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (!inList || listType !== 'ul') {
        closeList();
        html += '<ul>';
        inList = true;
        listType = 'ul';
      }
      html += `<li>${inline(m[1])}</li>`;
      i++;
      continue;
    }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (!inList || listType !== 'ol') {
        closeList();
        html += '<ol>';
        inList = true;
        listType = 'ol';
      }
      html += `<li>${inline(m[1])}</li>`;
      i++;
      continue;
    }
    if (/^\s*---\s*$/.test(line)) {
      closeList();
      html += '<hr>';
      i++;
      continue;
    }
    if (line.trim() === '') {
      closeList();
      i++;
      continue;
    }
    closeList();
    html += `<p>${inline(line)}</p>`;
    i++;
  }
  closeList();
  return html;
}

/** 解析 Markdown 前置元数据（--- title: ... ---） */
function parseFrontMatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const ln of m[1].split('\n')) {
    const mm = ln.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (mm) meta[mm[1].toLowerCase()] = mm[2].trim();
  }
  return { meta, body: m[3] };
}

/** 读取 content/blog/*.md（由 pipeline-geo-promotion.js 自动生成） */
function loadGeneratedPosts() {
  const dir = path.join(ROOT, 'content', 'blog');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const { meta, body } = parseFrontMatter(raw);
    if (!meta.title) continue;
    out.push({
      slug: f.replace(/\.md$/, ''),
      title: meta.title,
      desc: meta.desc || meta.description || '',
      date: meta.date || '2026-01-01',
      keywords: (meta.keywords || '').split(',').map((s) => s.trim()).filter(Boolean),
      body: renderMarkdown(body),
      generated: true,
    });
  }
  return out;
}

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
.search{display:flex;gap:8px;margin:0 0 18px}
.search input{flex:1;padding:9px 12px;border:1px solid var(--line);border-radius:8px;font-size:14px;outline:none}
.search input:focus{border-color:var(--accent)}
.search button{padding:9px 14px;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:8px;cursor:pointer;font-size:14px}
.search-status{color:var(--muted);font-size:12.5px;margin:0 0 12px;min-height:1em}
ul.items li.m{color:var(--muted);font-style:italic}
.glb{margin:18px 0}
.nav{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 18px}
.nav a{padding:5px 12px;border:1px solid var(--line);border-radius:999px;color:var(--fg);font-size:13px}
.nav a:hover{text-decoration:none;background:var(--chip)}
.hero{border:1px solid var(--line);border-radius:12px;padding:22px 24px;background:linear-gradient(180deg,#f5f9ff,#fff);margin:0 0 22px}
.hero h1{margin:0 0 8px;font-size:28px}
.hero p{color:#3d434d;font-size:14.5px;margin:8px 0}
.cta{display:inline-block;margin:10px 10px 0 0;background:var(--accent);color:#fff;padding:9px 16px;border-radius:8px;font-weight:600;font-size:14px}
.cta:hover{text-decoration:none;opacity:.92}
.cta.ghost{background:#fff;color:var(--accent);border:1px solid var(--accent)}
.faq{border:1px solid var(--line);border-radius:12px;padding:4px 20px;margin:28px 0}
.faq h2{font-size:19px;margin:16px 0 4px}
.faq details{border-top:1px solid var(--line);padding:12px 0}
.faq summary{cursor:pointer;font-weight:600;font-size:15px}
.faq p{color:#3d434d;font-size:14px;margin:8px 0 0;line-height:1.7}
article.post{max-width:780px}
article.post h1{font-size:27px;margin:0 0 4px}
article.post .byline{color:var(--muted);font-size:13px;margin-bottom:16px}
article.post h2{font-size:20px;margin:26px 0 8px}
article.post p{color:#2b2f36;font-size:15.5px;line-height:1.85}
article.post pre{background:#0f172a;color:#e2e8f0;padding:14px 16px;border-radius:8px;overflow:auto;font-size:13px}
article.post code{color:#0b62d6}
article.post ul,article.post ol{line-height:1.9;color:#2b2f36}
.cards2{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;margin:14px 0}
.card .k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
`;

// 客户端搜索脚本（站点内 / 首页卡片过滤 / 全局 14 站），纯原生 JS，无依赖
const SEARCH_JS = `
(function(){
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function norm(s){return String(s==null?'':s).toLowerCase();}
  function makeItem(e){
    var authors = Array.isArray(e.authors)? e.authors.slice(0,4).join(', '):'';
    var more = (Array.isArray(e.authors)&&e.authors.length>4)?' 等':'';
    var tags = Array.isArray(e.tags)? e.tags.slice(0,5):[];
    var abs = e.abstract? String(e.abstract).slice(0,260):'';
    return '<li><div class="t">'+(e.url?'<a href="'+esc(e.url)+'" rel="noopener nofollow" target="_blank">'+esc(e.name)+'</a>':esc(e.name))+'</div>'
      + (abs?'<div class="abs">'+esc(abs)+(String(e.abstract).length>260?'…':'')+'</div>':'')
      + '<div class="meta">'
      + (e.source?'<span class="chip">'+esc(e.source)+'</span>':'')
      + (authors?'<span>'+esc(authors)+more+'</span>':'')
      + (e.publishedDate?'<span>'+esc(e.publishedDate)+'</span>':'')
      + (typeof e.confidence==='number'?'<span>置信度 '+e.confidence.toFixed(2)+'</span>':'')
      + tags.map(function(t){return '<span class="chip">'+esc(t)+'</span>';}).join('')
      + '</div></li>';
  }
  function matches(e,q){
    q = norm(q); if(!q) return true;
    return [e.name,e.abstract,e.source,(e.authors||[]).join(' '),(e.tags||[]).join(' ')].some(function(f){return norm(f).indexOf(q)>=0;});
  }
  // 站点内检索
  var siteInput = document.getElementById('site-search');
  if(siteInput){
    var cache=null, list=document.getElementById('entity-list'), status=document.getElementById('search-status');
    if(list) list.dataset.original = list.innerHTML;
    siteInput.addEventListener('input', function(){
      var q = siteInput.value.trim();
      if(cache===null){
        status.textContent='加载中…';
        fetch('website/api/entities.json').then(function(r){return r.json();}).then(function(j){
          cache = Array.isArray(j)? j : (j.entities||[]);
          run();
        }).catch(function(){status.textContent='加载失败';});
        return;
      }
      run();
      function run(){
        if(!q){ if(list) list.innerHTML = (list.dataset.original||''); if(status) status.textContent=''; return; }
        var res = cache.filter(function(e){return matches(e,q);}).slice(0,100);
        if(list) list.innerHTML = res.length? res.map(makeItem).join('') : '<li class="m">无匹配结果</li>';
        if(status) status.textContent = res.length+' 条匹配';
      }
    });
  }
  // 首页卡片过滤
  var homeInput = document.getElementById('home-search');
  if(homeInput){
    homeInput.addEventListener('input', function(){
      var q = norm(homeInput.value);
      document.querySelectorAll('.card').forEach(function(c){
        c.style.display = (!q || norm(c.textContent).indexOf(q)>=0)?'':'none';
      });
    });
  }
  // 全局 14 站检索
  var globalInput = document.getElementById('global-search');
  if(globalInput){
    var glist=document.getElementById('global-list'), gstatus=document.getElementById('search-status'), sites=[];
    globalInput.addEventListener('input', function(){
      var q = globalInput.value.trim();
      if(!q){ if(glist) glist.innerHTML=''; if(gstatus) gstatus.textContent=''; return; }
      if(!sites.length){
        fetch('api/catalog.json').then(function(r){return r.json();}).then(function(c){sites=c.sites||[]; run();}).catch(function(){gstatus.textContent='目录加载失败';});
        return;
      }
      run();
      function run(){
        gstatus.textContent='检索中…';
        var out=[];
        (function next(i){
          if(i>=sites.length || out.length>250){ finish(); return; }
          fetch(sites[i].site+'/website/api/entities.json').then(function(r){return r.json();}).then(function(j){
            var ents = Array.isArray(j)? j : (j.entities||[]);
            for(var k=0;k<ents.length;k++){ if(matches(ents[k],q)) out.push(Object.assign({},ents[k],{_site:sites[i].site})); }
            next(i+1);
          }).catch(function(){ next(i+1); });
        })(0);
        function finish(){
          out.sort(function(a,b){return String(b.addedAt||'').localeCompare(String(a.addedAt||''));});
          var top = out.slice(0,100);
          glist.innerHTML = top.length? top.map(function(e){
            return '<li>'+(e.url?'<a href="'+esc(e.url)+'" target="_blank" rel="noopener">'+esc(e.name)+'</a>':esc(e.name))+' <span class="chip">'+esc(e._site)+'</span></li>';
          }).join('') : '<li class="m">无匹配</li>';
          gstatus.textContent = top.length+' 条（扫描 '+out.length+'）';
        }
      }
    });
  }
})();
`;

function layout({ title, desc, body, jsonld, canonical, type }) {
  const searchTarget = `${ORIGIN}${BASE}/search.html?q={query}`;
  const webSite = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'GeneTech 知识引擎',
    url: `${ORIGIN}${BASE}/`,
    description: '覆盖基因、量子计算、脑科学、AI Agent 等 14 个前沿科技领域的 Agent 原生知识引擎，提供 JSON API 与 MCP 接口。',
    potentialAction: { '@type': 'SearchAction', target: searchTarget, 'query-input': 'required name=query' },
  };
  const pageLd = jsonld ? (Array.isArray(jsonld) ? jsonld : [jsonld]) : [];
  const ldScripts = [webSite, ...pageLd]
    .map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`)
    .join('\n');
  const nav = `<nav class="nav"><a href="${BASE}/">首页</a><a href="${BASE}/search.html">全局搜索</a><a href="${BASE}/mcp.html">MCP 接入</a><a href="${BASE}/blog/">博客</a></nav>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:type" content="${type || 'website'}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical || `${ORIGIN}${BASE}/`)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="theme-color" content="#0b62d6">
<meta name="application-name" content="GeneTech 知识引擎">
<link rel="alternate" type="application/rss+xml" title="GeneTech 博客" href="${ORIGIN}${BASE}/rss.xml">
${GSC_VERIFICATION ? `<meta name="google-site-verification" content="${esc(GSC_VERIFICATION)}">` : ''}
${ldScripts}
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="${BASE}/">GeneTech 知识引擎<span>14 个前沿科技垂直领域</span></a></div></header>
<div class="wrap">
${nav}
${body}
<footer>
数据以 CC-BY 提供 · 通过 <code>@genetech/data-mcp</code> 可由 AI Agent 直接查询检索 ·
生成于 ${new Date().toISOString()}
</footer>
</div>
</body>
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

  const canonical = `${ORIGIN}${BASE}/${site.slug}/`;
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
<div class="search"><input id="site-search" type="search" placeholder="在本站内检索（标题/摘要/标签/作者，支持中英文）" autofocus><button onclick="document.getElementById('site-search').dispatchEvent(new Event('input'))">搜索</button></div>
<div id="search-status" class="search-status"></div>
<ul class="items" id="entity-list">${items}</ul>
${total > list.length ? `<p class="pager">页面展示最新 ${list.length} 条，全部 ${total} 条请通过上方 <code>entities.json</code> 获取。检索框会即时过滤最新 ${list.length} 条；全量检索请用顶部「全局搜索」。</p>` : ''}
<script>${SEARCH_JS}</script>
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

  const hero = `<section class="hero">
<h1>GeneTech 知识引擎</h1>
<p class="sub">${sites.length} 个前沿科技垂直领域 · ${total} 条结构化科研实体 · 面向 AI Agent 的实时知识接口</p>
<p>把 14 个前沿科技垂直领域的结构化知识（基因、量子计算、脑科学、AI Agent、生命科学…）通过一行命令接入你的 AI Agent——实时检索、带引用、可溯源。</p>
<a class="cta" href="${BASE}/mcp.html">用 MCP 接入 →</a>
<a class="cta ghost" href="${BASE}/search.html">全局搜索 14 站 →</a>
</section>`;

  const faqItems = [
    ['GeneTech 知识引擎是什么？', '一个覆盖 14 个前沿科技垂直领域的结构化知识库，提供机器可读的 JSON API 与 MCP 接口，让 AI Agent 能实时检索、引用前沿科研实体。'],
    ['如何把知识库接入我的 AI Agent？', '安装 MCP Server：<code>npx -y @genetech/data-mcp</code>，在支持 MCP 的客户端（Claude Desktop、Cursor、任意 Function-Calling 框架）中配置即可调用 5 个工具。'],
    ['数据来源与更新频率？', '数据来自 OpenAlex、arXiv、Crossref、PubMed 等开放学术源，经混合检索建库，每 30 分钟增量更新，覆盖论文、工具、数据集与专利。'],
    ['检索是真正的语义检索吗？', '是的。我们采用 BM25 + 字段加权 + RRF 融合的混合检索（src/search.mjs），并预留向量嵌入接口，兼顾召回率与精度。'],
    ['商业使用如何计费？', '基础接口免费（Free 层）；Pro 层提供高并发与 HMAC 鉴权；团队/企业可定制领域与 SLA。详见 MCP 接入页。'],
  ];
  const faq = `<section class="faq">
<h2>常见问题</h2>
${faqItems.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${a}</p></details>`).join('\n')}
</section>`;

  const body = `
${hero}
<div class="api">
每个站点均提供机器可读接口 <code>/&lt;site&gt;/website/api/entities.json</code>；
也可通过 MCP 直接接入：<code>npx -y @genetech/data-mcp</code> ·
<a href="${BASE}/search.html">全局搜索 14 站 →</a>
</div>
<div class="search"><input id="home-search" type="search" placeholder="过滤下方领域卡片（输入关键词）"></div>
<div class="grid">${cards}</div>
${faq}
<script>${SEARCH_JS}</script>
`;

  const dataCatalog = {
    '@context': 'https://schema.org',
    '@type': 'DataCatalog',
    name: 'GeneTech 知识引擎',
    description: `覆盖 ${sites.length} 个前沿科技领域、共 ${total} 条结构化科研实体的知识目录。`,
    dataset: sites.map((s) => ({
      '@type': 'Dataset',
      name: SITE_LABELS[s.slug] || s.slug,
      url: `${ORIGIN}${BASE}/${s.slug}/`,
    })),
  };
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqItems.map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a.replace(/<[^>]+>/g, '') },
    })),
  };

  return layout({
    title: 'GeneTech 知识引擎 — 14 个前沿科技领域的 Agent 原生知识库',
    desc: `覆盖基因、量子计算、脑科学、AI Agent 等 ${sites.length} 个前沿科技领域，共 ${total} 条结构化实体，提供 JSON API 与 MCP 接口。`,
    body,
    jsonld: [dataCatalog, faqLd],
    canonical: `${ORIGIN}${BASE}/`,
  });
}

/** 全局搜索页（跨 14 站） */
function renderSearchPage(sites) {
  const total = sites.reduce((s, x) => s + x.entities.length, 0);
  const body = `
<h1>全局搜索</h1>
<p class="sub">跨全部 ${sites.length} 个领域、${total} 条实体即时检索（客户端加载各站 <code>entities.json</code>，无需后端）</p>
<div class="search glb"><input id="global-search" type="search" placeholder="输入关键词，跨 14 站检索论文/工具/数据集（中英文）" autofocus><button onclick="document.getElementById('global-search').dispatchEvent(new Event('input'))">搜索</button></div>
<div id="search-status" class="search-status"></div>
<ul class="items" id="global-list"></ul>
<script>${SEARCH_JS}</script>
`;
  return layout({
    title: '全局搜索 — GeneTech 知识引擎',
    desc: `跨 ${sites.length} 个前沿科技领域、${total} 条结构化实体的即时检索。`,
    body,
    canonical: `${ORIGIN}${BASE}/search.html`,
  });
}

// ============================================================================
// GEO / SEO 内容层：博客文章 + MCP 接入页
// ============================================================================

const BLOG = [
  {
    slug: 'mcp-for-agents',
    title: '用 MCP 把 14 个前沿科技知识库接入你的 AI Agent（一行命令）',
    desc: 'GeneTech 知识引擎通过 MCP（Model Context Protocol）把 14 个前沿科技垂直领域的结构化知识直接喂给 AI Agent：实时检索、带引用、可溯源。',
    date: '2026-08-05',
    keywords: ['MCP', 'AI Agent', '知识库', '科研知识接口', 'Function Calling'],
    body: `<p>AI Agent 最大的短板之一，是<strong>缺乏可靠、可溯源的科研知识</strong>。大模型靠参数记忆事实，容易过时、易产生幻觉。GeneTech 知识引擎用 MCP（Model Context Protocol）把 14 个前沿科技垂直领域的结构化知识直接喂给 Agent。</p>
<h2>一行命令接入</h2>
<pre><code>npx -y @genetech/data-mcp</code></pre>
<p>在 Claude Desktop、Cursor 或任意支持 Function-Calling 的框架里配置这条命令，Agent 即可调用以下 5 个工具：</p>
<ul>
<li><code>list_sites</code> — 列出 14 个知识领域及其实体量</li>
<li><code>get_entities</code> — 按站点 / 分类获取结构化实体</li>
<li><code>semantic_search</code> — 混合检索（BM25 + 字段加权 + RRF），返回最相关实体</li>
<li><code>get_entity</code> — 获取单条实体详情与引用来源</li>
<li><code>export_bibtex</code> — 导出 BibTeX，方便论文引用</li>
</ul>
<h2>为什么是 Agent 原生</h2>
<p>传统科研工具（Elicit、Consensus）面向「人读」界面；GeneTech 面向「机器调用」：返回的是带 URL、作者、置信度、标签的结构化 JSON，Agent 可直接消费、可溯源到原始论文。这让它天然适合做 RAG 的知识底座、自动化综述与竞品监测。</p>
<p>想立刻试试？前往 <a href="${BASE}/search.html">全局搜索</a> 体验检索，或浏览 <a href="${BASE}/">14 个知识领域</a>。</p>`,
  },
  {
    slug: 'hybrid-search',
    title: '生物医学 AI 文献检索：从关键词到混合检索（BM25 + 向量 + RRF）',
    desc: '关键词检索召回高但精度差，纯向量语义好但易漏术语。GeneTech 在 src/search.mjs 用 BM25 + 字段加权 + RRF 融合实现兼顾召回与精度的混合检索。',
    date: '2026-08-05',
    keywords: ['混合检索', 'BM25', 'RRF', '语义搜索', '生物医学文献'],
    body: `<p>关键词检索（如简单包含匹配）召回率高但精度差；纯向量检索语义好但容易漏掉精确术语。我们在 <code>src/search.mjs</code> 里实现了<strong>混合检索</strong>。</p>
<h2>三路召回 + 融合</h2>
<ul>
<li><strong>BM25</strong>：经典词频逆文档频率，保证精确术语（如 "CRISPR-Cas9"）高排。</li>
<li><strong>字段加权</strong>：标题 6 分、标签 3 分、作者 2 分、摘要 1 分，让核心字段主导排序。</li>
<li><strong>RRF 融合</strong>：Reciprocal Rank Fusion 把多路排序归一后加权合并，兼顾召回与精度。</li>
</ul>
<pre><code>const fused = rrf([bm25Rank, fieldRank], { k: 60 });</code></pre>
<h2>为什么对科研重要</h2>
<p>科研检索里，术语精确性（"single-cell RNA-seq"）和语义相关性（"单细胞测序"）同样关键。混合检索让两者兼得，且无需 embedding 服务即可运行（向量接口预留，可按需开启）。</p>
<p>这套检索已作为 MCP 的 <code>semantic_search</code> 工具对外开放，详见 <a href="${BASE}/mcp.html">MCP 接入页</a>。</p>`,
  },
  {
    slug: 'geo-advantage',
    title: 'Elicit / Consensus / Scite 之后：Agent 原生知识底座的 GEO 机会',
    desc: '当科研工具还在做「人读文献」，让 AI Agent 自己查知识的入口正在打开——这就是 Generative Engine Optimization（GEO）的机会。GeneTech 用 MCP + 结构化数据抢占这一红利。',
    date: '2026-08-05',
    keywords: ['GEO', 'Generative Engine Optimization', '知识引擎', 'Agent 原生', '科研工具对比'],
    body: `<p>当所有人还在用 Elicit、Consensus、SciSpace 做「人读文献」时，一个新的入口正在打开：<strong>让 AI Agent 自己去查知识</strong>。这就是 Generative Engine Optimization（GEO）的机会。</p>
<h2>从「人读」到「机器读」</h2>
<p>大模型在生成答案时会检索外部知识。如果你的内容：① 结构化（JSON-LD / Dataset）、② 事实可溯源、③ 机器可读，就更容易被 Agent 引用——这正是 GEO 的核心。</p>
<h2>GeneTech 的差异化</h2>
<ul>
<li><strong>Agent 原生</strong>：知识以 MCP + JSON API 暴露，Agent 直接调用，而非爬网页。</li>
<li><strong>垂直策展</strong>：14 个前沿科技领域，而非泛全科。</li>
<li><strong>可溯源</strong>：每条实体带原始论文 URL 与置信度。</li>
</ul>
<h2>给研究者的建议</h2>
<p>如果你的工具 / 数据集想被 AI 引用，尽快补齐结构化数据（schema.org Dataset / SoftwareApplication）、开放 API、以及清晰的引用链。这正是 GeneTech 已经做完的事——欢迎通过 <a href="${BASE}/mcp.html">MCP</a> 接入或 <a href="${BASE}/search.html">全局搜索</a> 体验。</p>`,
  },
];

// 合并硬编码文章 + 自动生成的 GEO 文章，按日期倒序（最新在前）
const BLOG_POSTS = [...BLOG, ...loadGeneratedPosts()].sort((a, b) =>
  String(b.date).localeCompare(String(a.date)),
);

/** 单篇博客文章页 */
function renderArticle(a) {
  const url = `${ORIGIN}${BASE}/blog/${a.slug}.html`;
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    description: a.desc,
    datePublished: a.date,
    author: { '@type': 'Organization', name: 'GeneTech' },
    publisher: { '@type': 'Organization', name: 'GeneTech', url: `${ORIGIN}${BASE}/` },
    mainEntityOfPage: url,
    keywords: (a.keywords || []).join(', '),
  };
  const body = `<article class="post">
<h1>${esc(a.title)}</h1>
<p class="byline">GeneTech · ${esc(a.date)} · 关键词：${esc((a.keywords || []).join('、'))}</p>
${a.body}
<p style="margin-top:24px"><a href="${BASE}/blog/">← 返回博客</a> · <a href="${BASE}/mcp.html">MCP 接入</a> · <a href="${BASE}/search.html">全局搜索</a></p>
</article>`;
  return layout({
    title: `${a.title} — GeneTech 博客`,
    desc: a.desc,
    body,
    jsonld,
    canonical: url,
    type: 'article',
  });
}

/** 博客首页 */
function renderBlogIndex() {
  const cards = BLOG_POSTS.map(
    (a) => `<a class="card" href="${BASE}/blog/${a.slug}.html">
<div class="k">${esc(a.date)}</div>
<div class="n">${esc(a.title)}</div>
<div class="m">${esc((a.keywords || []).slice(0, 3).join(' · '))}</div>
</a>`,
  ).join('\n');
  const body = `<h1>GeneTech 博客</h1>
<p class="sub">关于 Agent 原生知识引擎、混合检索与 GEO 的技术笔记</p>
<div class="grid">${cards}</div>`;
  return layout({
    title: 'GeneTech 博客 — Agent 原生知识引擎技术笔记',
    desc: 'GeneTech 博客：MCP 接入、混合检索（BM25+RRF）、GEO 与科研知识底座的技术文章。',
    body,
    canonical: `${ORIGIN}${BASE}/blog/`,
  });
}

/** MCP 接入页（SoftwareApplication 结构化数据 + 转化入口） */
function renderMcpPage() {
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'GeneTech Data MCP',
    operatingSystem: 'Any',
    applicationCategory: 'DeveloperApplication',
    description: '面向 AI Agent 的科研知识引擎 MCP Server：实时检索、引用 14 个前沿科技垂直领域的结构化实体。',
    url: 'https://www.npmjs.com/package/@genetech/data-mcp',
    sameAs: ['https://www.npmjs.com/package/@genetech/data-mcp'],
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    author: { '@type': 'Organization', name: 'GeneTech' },
  };
  const tools = [
    ['list_sites', '列出 14 个知识领域及其实体量'],
    ['get_entities', '按站点 / 分类获取结构化实体'],
    ['semantic_search', '混合检索（BM25 + 字段加权 + RRF），返回最相关实体'],
    ['get_entity', '获取单条实体详情与引用来源'],
    ['export_bibtex', '导出 BibTeX，方便论文引用'],
  ];
  const body = `<h1>GeneTech Data MCP</h1>
<p class="sub">面向 AI Agent 的科研知识引擎接口 · 一行命令接入 14 个前沿科技垂直领域</p>
<section class="hero">
<h1 style="font-size:20px">快速开始</h1>
<pre><code>npx -y @genetech/data-mcp</code></pre>
<p>在 Claude Desktop、Cursor 或任意支持 MCP / Function-Calling 的框架中配置上述命令即可。</p>
<a class="cta" href="https://www.npmjs.com/package/@genetech/data-mcp">在 npm 查看 →</a>
<a class="cta ghost" href="${BASE}/search.html">全局搜索体验 →</a>
</section>
<h2>提供的工具</h2>
<div class="cards2">
${tools.map(([n, d]) => `<div class="card"><div class="n"><code>${esc(n)}</code></div><div class="m">${esc(d)}</div></div>`).join('\n')}
</div>
<h2>数据覆盖</h2>
<p>基因技术、量子计算、脑科学、AI Agent 生态、生命科学、新能源、核能、深海科技、地外科学、中医药、机器人零部件、仿生智能、生物计算、地外矿物，共 14 个垂直领域，实体持续增量更新。</p>
<h2>计费</h2>
<ul>
<li><strong>Free</strong>：基础接口免费调用。</li>
<li><strong>Pro</strong>：高并发 + HMAC 鉴权（通过 Cloudflare Worker 付费墙）。</li>
<li><strong>Team / Enterprise</strong>：定制领域、SLA 与企业内网部署。</li>
</ul>
<p>想直接检索？前往 <a href="${BASE}/search.html">全局搜索</a> 或浏览 <a href="${BASE}/">14 个知识领域</a>。</p>`;
  return layout({
    title: 'GeneTech Data MCP — 面向 AI Agent 的科研知识接口',
    desc: 'GeneTech Data MCP：一行命令把 14 个前沿科技垂直领域的结构化知识接入 AI Agent，提供混合检索与引用。',
    body,
    jsonld,
    canonical: `${ORIGIN}${BASE}/mcp.html`,
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

  // 清理旧产物；沙箱 safe-delete 可能拦截删除，失败不致命——后续 writeFile 会覆盖，CI(Linux)下可正常删除
  try {
    fs.rmSync(OUT, { recursive: true, force: true });
  } catch (e) {
    console.warn('[warn] 清理 _site 失败（沙箱删除拦截），继续覆盖写入：', e.message);
  }
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
  writeFile('search.html', renderSearchPage(sites));
  writeFile('mcp.html', renderMcpPage());
  writeFile('blog/index.html', renderBlogIndex());
  for (const a of BLOG_POSTS) writeFile(`blog/${a.slug}.html`, renderArticle(a));

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

  // llms.txt —— GEO 核心：给 LLM/AI Agent 一份机器友好的站点索引（llmstxt.org 标准）
  const llmsTxt = [
    '# GeneTech 知识引擎',
    '',
    'GeneTech 是一个覆盖 14 个前沿科技垂直领域的 Agent 原生知识引擎，提供机器可读的 JSON API 与 MCP 接口，供 AI Agent 实时检索、引用结构化科研实体。',
    '',
    '## 站点与 API',
    ...sites.map(
      (s) =>
        `- ${SITE_LABELS[s.slug] || s.slug}: ${ORIGIN}${BASE}/${s.slug}/ (实体 API: ${ORIGIN}${BASE}/${s.slug}/website/api/entities.json)`,
    ),
    '',
    '## 聚合入口',
    `- 全站目录: ${ORIGIN}${BASE}/api/catalog.json`,
    `- MCP 接入: npx -y @genetech/data-mcp`,
    `- 全局搜索: ${ORIGIN}${BASE}/search.html`,
    `- RSS: ${ORIGIN}${BASE}/rss.xml`,
    '',
    '## 博客',
    ...BLOG_POSTS.map((a) => `- ${a.title}: ${ORIGIN}${BASE}/blog/${a.slug}.html`),
    '',
  ].join('\n');
  writeFile('llms.txt', llmsTxt);

  // rss.xml —— 供聚合器与 AI 引擎订阅最新内容
  const rssItems = BLOG_POSTS.map((a) => {
    const d = new Date(`${a.date}T00:00:00Z`);
    return `  <item>
    <title>${esc(a.title)}</title>
    <link>${ORIGIN}${BASE}/blog/${a.slug}.html</link>
    <guid>${ORIGIN}${BASE}/blog/${a.slug}.html</guid>
    <description>${esc(a.desc)}</description>
    <pubDate>${d.toUTCString()}</pubDate>
  </item>`;
  }).join('\n');
  writeFile(
    'rss.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>GeneTech 知识引擎</title>
  <link>${ORIGIN}${BASE}/</link>
  <description>GeneTech 博客：Agent 原生知识引擎、混合检索与 GEO 技术笔记</description>
${rssItems}
</channel>
</rss>
`,
  );

  // sitemap + robots
  const origin = ORIGIN;
  const extraPages = [
    'search.html',
    'mcp.html',
    'blog/',
    'rss.xml',
    ...BLOG_POSTS.map((b) => `blog/${b.slug}.html`),
  ];
  const urls = ['', ...sites.map((s) => `${s.slug}/`), ...extraPages]
    .map((u) => `  <url><loc>${origin}${BASE}/${u}</loc></url>`)
    .join('\n');
  writeFile(
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  );
  writeFile(
    'robots.txt',
    `User-agent: *\nAllow: /\n${origin ? `Sitemap: ${origin}${BASE}/sitemap.xml\nLLMs.txt: ${origin}${BASE}/llms.txt\n` : ''}`,
  );
  // 禁止 GitHub Pages 的 Jekyll 处理，确保下划线等路径原样发布
  writeFile('.nojekyll', '');
  // IndexNow 验证文件（密钥公开；CI 端配置 INDEXNOW_KEY 后由 promotion 管线提交 Bing/Yandex）
  writeFile('.well-known/indexnow.txt', INDEXNOW_KEY);

  console.log(`[ok] 生成 ${sites.length} 个站点 / ${totalEntities} 条实体 → ${OUT}`);
}

main();
