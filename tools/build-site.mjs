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
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  buildStructure,
  toJSONL,
  toCSV,
  toBibTeX,
  toCSLJSON,
  qualityScore,
} from './lib/structure.mjs';

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
// Bing Webmaster 验证元标签：CI 端配 Secrets: BING_VERIFICATION 后自动注入首页 <head>，
// 用户即可在 Bing Webmaster 用「meta 标签」方式验证所有权（github.io 无法放 BingSiteAuth.xml，
// 故用 meta 标签法替代，避免 XML 文件验证失败）。值为 Bing 给出的 msvalidate.01 的 content 串。
const BING_VERIFICATION = process.env.BING_VERIFICATION || '';

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
  // ---- 2026-08 扩域：对齐国家「十五五」未来产业方向 ----
  'embodied-ai': '具身智能',
  'synbio-manufacturing': '合成生物与生物制造',
  'semiconductor': '半导体与先进封装',
  'ai4science': 'AI 驱动科学发现',
  'low-altitude': '低空经济',
  'sat-6g': '6G 与卫星互联网',
  'spatial-computing': '空间计算',
  'privacy-computing': '隐私计算与数据要素',
  // ---- 2026-08 第三批扩域 ----
  'ai-safety': 'AI 安全与对齐',
  'quantum-materials': '量子材料',
  'carbon-neutral': '碳中和与 CCUS',
  'digital-twin': '数字孪生',
  'biomed-ai': '医疗人工智能',
  'edge-ai': '边缘智能',
  'neuromorphic': '类脑计算',
  'agritech': '智慧农业',
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
.crumb{font-size:13px;color:#6b7280;margin:0 0 4px}
.crumb a{color:#0b62d6;text-decoration:none}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 18px}
.chip{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border:1px solid #dfe3e8;border-radius:999px;background:#fff;font-size:13px;color:#39414d;text-decoration:none}
a.chip:hover{border-color:#0b62d6;color:#0b62d6}
.chip b{color:#0b62d6;font-weight:600}
.up{color:#1a9e57;font-weight:600}
.down{color:#d23b3b;font-weight:600}
.ybars{display:flex;align-items:flex-end;gap:5px;height:70px;margin:10px 0 20px;padding:6px 0;border-bottom:1px solid #e8ebef}
.yb{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px}
.yb i{display:block;width:16px;background:linear-gradient(180deg,#3b8bf0,#0b62d6);border-radius:3px 3px 0 0}
.yb em{font-size:10px;color:#8a93a0;font-style:normal}
ul.elist{list-style:none;padding:0;margin:0}
ul.elist li{padding:11px 0;border-bottom:1px solid #eef1f4}
ul.elist .t{font-size:15px;color:#12212f;text-decoration:none;font-weight:600;line-height:1.5}
ul.elist .t:hover{color:#0b62d6}
ul.elist .m{font-size:12.5px;color:#6b7280;margin-top:4px;line-height:1.6}
ul.elist .m a{color:#0b62d6;text-decoration:none}
.tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;margin:16px 0}
.tcard{display:flex;flex-direction:column;gap:3px;padding:11px 13px;border:1px solid #e3e7ec;border-radius:9px;background:#fff;text-decoration:none}
.tcard:hover{border-color:#0b62d6;box-shadow:0 2px 10px rgba(11,98,214,.09)}
.tcard .n{font-size:14px;color:#12212f;font-weight:600;line-height:1.4}
.tcard .c{font-size:12px;color:#8a93a0}
.tablewrap{overflow-x:auto}
.pagenav{display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;margin:28px 0 8px}
.pagenav .pn{padding:8px 14px;border:1px solid var(--line);border-radius:8px;text-decoration:none}
.pagenav .pn.dim{color:#9aa1ab;border-color:#eceef1}
.pagenums{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pagenums a{padding:6px 10px;border:1px solid var(--line);border-radius:6px;text-decoration:none}
.pagenums .cur{padding:6px 10px;border-radius:6px;background:#0b62d6;color:#fff;font-weight:600}
.pagenums .gap{color:#9aa1ab;padding:0 2px}
article.post table{border-collapse:collapse;width:100%;margin:18px 0;font-size:14px}
article.post th,article.post td{border:1px solid var(--line);padding:9px 11px;text-align:left;vertical-align:top}
article.post th{background:var(--chip);font-weight:600}
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
  const nav = `<nav class="nav"><a href="${BASE}/">首页</a><a href="${BASE}/search.html">全局搜索</a><a href="${BASE}/topic/">主题图谱</a><a href="${BASE}/insights.html">研究洞察</a><a href="${BASE}/data.html">数据下载</a><a href="${BASE}/mcp.html">MCP 接入</a><a href="${BASE}/blog/">博客</a></nav>`;
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
${BING_VERIFICATION ? `<meta name="msvalidate.01" content="${esc(BING_VERIFICATION)}">` : ''}
${ldScripts}
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="${BASE}/">GeneTech 知识引擎<span>${localizeSiteCount('14 个前沿科技垂直领域')}</span></a></div></header>
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
/** 每个归档分页承载的实体条数 */
const ARCHIVE_PAGE_SIZE = 100;
/** 每站导出的引文条数上限（BibTeX / CSL-JSON 按质量分取头部，控制产物体积） */
const CITATION_EXPORT_CAP = 1500;

/** 按加入时间倒序取全量实体（站点页与归档分页共用同一排序，保证翻页不重不漏） */
function sortedEntities(site) {
  return [...site.entities].sort((a, b) =>
    String(b.addedAt || '').localeCompare(String(a.addedAt || '')),
  );
}

/** 实体条目渲染（站点首页与归档分页共用） */
function renderEntityItems(list) {
  return list
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
}

/**
 * 归档分页 —— GEO/SEO 关键表面。
 * 站点首页只渲染最新 300 条，其余实体此前完全没有 HTML 载体，
 * 搜索引擎与 AI 引擎无法抓取（数据全锁在 entities.json 里）。
 * 这里把全量实体按每页 ARCHIVE_PAGE_SIZE 条铺成静态页并进 sitemap，
 * 使全部实体的标题/摘要/来源都可被索引与引用。
 */
function renderArchivePage(site, pageNo, totalPages, list) {
  const label = SITE_LABELS[site.slug] || site.slug;
  const total = site.entities.length;
  const from = (pageNo - 1) * ARCHIVE_PAGE_SIZE + 1;
  const to = from + list.length - 1;
  const canonical = `${ORIGIN}${BASE}/${site.slug}/page/${pageNo}.html`;

  const pageHref = (n) => `${BASE}/${site.slug}/page/${n}.html`;
  // 页码条：首末页 + 当前页附近，避免几百页时导航爆炸
  const nums = new Set([1, totalPages, pageNo, pageNo - 1, pageNo + 1, pageNo - 2, pageNo + 2]);
  const pageNums = [...nums]
    .filter((n) => n >= 1 && n <= totalPages)
    .sort((a, b) => a - b)
    .map((n, i, arr) => {
      const gap = i > 0 && n - arr[i - 1] > 1 ? '<span class="gap">…</span>' : '';
      return `${gap}${
        n === pageNo
          ? `<span class="cur">${n}</span>`
          : `<a href="${pageHref(n)}">${n}</a>`
      }`;
    })
    .join('');

  const body = `
<h1>${esc(label)} · 全部实体（第 ${pageNo} / ${totalPages} 页）</h1>
<p class="sub">本页收录第 ${from}–${to} 条，共 ${total} 条 · <a href="${BASE}/${site.slug}/">返回 ${esc(label)} 首页</a></p>
<div class="api">
机器可读接口：
<a href="${BASE}/${site.slug}/website/api/index.json"><code>index.json</code></a> ·
<a href="${BASE}/${site.slug}/website/api/entities.json"><code>entities.json</code></a>
</div>
<ul class="items">${renderEntityItems(list)}</ul>
<nav class="pagenav">
${pageNo > 1 ? `<a class="pn" href="${pageHref(pageNo - 1)}">← 上一页</a>` : '<span class="pn dim">← 上一页</span>'}
<span class="pagenums">${pageNums}</span>
${pageNo < totalPages ? `<a class="pn" href="${pageHref(pageNo + 1)}">下一页 →</a>` : '<span class="pn dim">下一页 →</span>'}
</nav>
`;

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${label} 实体列表 第 ${pageNo} 页`,
    url: canonical,
    numberOfItems: list.length,
    // 注意：此处刻意不写 abstract。摘要已在可见 HTML 中完整呈现，搜索引擎会直接读取；
    // 在 ItemList 里再存一份会让单页体积翻倍（实测 169KB 页中 JSON-LD 占 94KB），
    // 在 10 万级实体规模下会把站点撑到 GitHub Pages 的 1GB 上限。作者同理裁到 3 位。
    itemListElement: list.slice(0, 100).map((e, i) => ({
      '@type': 'ListItem',
      position: from + i,
      item: {
        '@type': 'ScholarlyArticle',
        name: String(e.name || '').slice(0, 200),
        url: e.url || canonical,
        ...(Array.isArray(e.authors) && e.authors.length
          ? { author: e.authors.slice(0, 3).map((a) => ({ '@type': 'Person', name: String(a) })) }
          : {}),
        ...(e.publishedDate ? { datePublished: e.publishedDate } : {}),
      },
    })),
  };

  return layout({
    title: `${label} 全部实体 第 ${pageNo}/${totalPages} 页 — GeneTech 知识引擎`,
    desc: `${label}领域结构化科研实体第 ${from}–${to} 条（共 ${total} 条），含标题、摘要、作者与原始来源链接，可经 JSON API 与 MCP 供 AI Agent 引用。`,
    body,
    jsonld,
    canonical,
  });
}

function renderSitePage(site, allSites) {
  const label = SITE_LABELS[site.slug] || site.slug;
  const total = site.entities.length;
  const cats = Array.isArray(site.index.categories) ? site.index.categories.slice(0, 12) : [];

  // 首页展示最新 300 条；全量通过归档分页暴露给搜索/AI 引擎
  const list = sortedEntities(site).slice(0, 300);
  const totalPages = Math.max(1, Math.ceil(total / ARCHIVE_PAGE_SIZE));
  const items = renderEntityItems(list);

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
${
    total > list.length
      ? `<p class="pager">页面展示最新 ${list.length} 条；<strong>全部 ${total} 条已按每页 ${ARCHIVE_PAGE_SIZE} 条铺开，可逐页浏览：</strong>
<a href="${BASE}/${site.slug}/page/1.html">浏览全部实体（共 ${totalPages} 页）→</a><br>
也可直接通过 <code>entities.json</code> 一次性获取全量。检索框即时过滤本页最新 ${list.length} 条；全量检索请用顶部「全局搜索」。</p>`
      : ''
  }
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
    slug: 'vs-elicit-consensus-scite',
    title: 'GeneTech 对比 Elicit / Consensus / Scite：面向 AI Agent 的科研知识底座有何不同',
    desc: 'Elicit、Consensus、Scite 都是优秀的「人读」科研工具；GeneTech 走另一条路——把 14 个前沿科技垂直领域的结构化知识，通过 MCP + JSON API 交给 AI Agent 直接调用、可溯源引用。本文给出客观对比与选型建议。',
    date: '2026-08-06',
    keywords: ['GeneTech', 'Elicit', 'Consensus', 'Scite', 'Perplexity', 'Semantic Scholar', '科研工具对比', 'AI Agent 知识库', 'MCP'],
    body: `<p><strong>结论先行：</strong>Elicit、Consensus、Scite、Perplexity 解决的是「人读文献」效率问题；GeneTech 解决的是「让 AI Agent 自动查知识」的可溯源接入问题。两者不互斥——GeneTech 更适合做 RAG 知识底座、自动化综述与竞品监测。</p>

<h2>一、四类主流科研工具在做什么</h2>
<ul>
<li><strong>Elicit</strong>（约 $12/月）：以自然语言提问，自动抽取多篇论文的方法、样本量、结论到结构化表格，强于系统综述的数据提取。</li>
<li><strong>Consensus</strong>（约 $9–12/月）：用「共识仪表盘」回答 yes/no 类循证问题，聚合大量同行评议研究给出倾向。</li>
<li><strong>Scite</strong>（约 $20/月）：Smart Citations 区分引用是「支持 / 对比 / 提及」，用于判断一篇论文在领域里实际被如何对待。</li>
<li><strong>Perplexity / Semantic Scholar</strong>：前者是通用 AI 搜索（学术模式限定同行评议源），后者是免费的大规模论文发现与引用图谱底座。</li>
</ul>

<h2>二、GeneTech 的差异点</h2>
<table class="cmp">
<thead><tr><th>维度</th><th>Elicit / Consensus / Scite</th><th>GeneTech 知识引擎</th></tr></thead>
<tbody>
<tr><td>核心使用者</td><td>人类研究者（UI 驱动）</td><td>AI Agent / 开发者（MCP + JSON API 驱动）</td></tr>
<tr><td>数据形态</td><td>交互式网页 + 导出</td><td>结构化实体（含 URL、作者、置信度、标签）+ 机器可读 API</td></tr>
<tr><td>领域覆盖</td><td>泛全科（生物医学/社科偏重）</td><td>14 个前沿垂直领域策展（量子计算、脑科学、中医药工具、新能源、AI Agent 生态等）</td></tr>
<tr><td>可溯源</td><td>有（引用论文）</td><td>有（每条实体带原始论文 URL + 置信度）</td></tr>
<tr><td>接入方式</td><td>网页 / 插件</td><td>一行命令 <code>npx -y @genetech/data-mcp</code>，5 个 MCP 工具实时检索</td></tr>
<tr><td>付费模式</td><td>按月订阅（国际信用卡）</td><td>一次性买断、国内微信/支付宝（¥9.9 入门 / ¥199 终身）</td></tr>
</tbody>
</table>

<h2>三、什么时候选 GeneTech</h2>
<ul>
<li>你要<strong>把科研知识喂给自己的 Agent</strong>（RAG、自动化报告、竞品监测），而不是自己一篇篇读。</li>
<li>你的场景落在我们策展的<strong>前沿垂直领域</strong>（如中医药工具、聚变能源、地外科学），且需要中文友好的结构化数据。</li>
<li>你想用<strong>国内支付 + 一次性买断</strong>拿到全站通用许可证，避免月费。</li>
</ul>

<h2>四、常见问答</h2>
<p><strong>Q：GeneTech 会取代 Elicit 吗？</strong><br>A：不会。Elicit 擅长「人做系统综述时的数据提取」，GeneTech 擅长「机器可调用、可溯源的知识底座」。两者可配合：用 GeneTech 给 Agent 供数，用 Elicit 做人工深读。</p>
<p><strong>Q：数据从哪来、权威吗？</strong><br>A：聚合 OpenAlex、arXiv、Crossref、PubMed、Semantic Scholar、Europe PMC 等开放学术源，每条实体标注来源与置信度，并附原始论文链接以便核对。</p>
<p><strong>Q：免费能用吗？</strong><br>A：14 站的结构化数据、全局搜索、MCP 基础检索均可直接体验；许可证用于解锁更高配额与引用导出等增强能力。</p>

<p>想立刻体验？前往 <a href="${BASE}/search.html">全局搜索</a> 或 <a href="${BASE}/mcp.html">MCP 接入页</a>。数据规模与更新频率见 <a href="${BASE}/">首页各站实体量</a>。</p>`,
  },
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
<p>${esc(ALL_SITE_LABELS.join('、'))}，共 ${ALL_SITE_LABELS.length} 个垂直领域，实体持续增量更新。</p>
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

/**
 * 站点数量在文案里曾被硬编码为 14，扩域后（22 站及以后）会全站失真。
 * 站点数是运行期才知道的，而 BLOG/常量在模块加载期就已求值，逐处改易漏，
 * 因此统一在输出层做一次收口替换（只针对确定性的量词搭配，避免误伤论文标题）。
 */
let SITE_COUNT = 0;
let ALL_SITE_LABELS = [];

/** 主题聚合页：把「主题」升级为一等公民，承接长尾检索并给 AI 引擎提供可引用的聚合事实 */
function renderTopicPage(t, labels) {
  const canonical = `${ORIGIN}${BASE}/topic/${t.slug}.html`;
  const siteRows = Object.entries(t.siteCounts)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([slug, n]) =>
        `<a class="chip" href="${BASE}/${slug}/">${esc(labels[slug] || slug)} <b>${n}</b></a>`,
    )
    .join('');

  const years = Object.entries(t.years)
    .map(([y, n]) => [parseInt(y, 10), n])
    .filter(([y]) => y >= 2015)
    .sort((a, b) => a[0] - b[0]);
  const maxY = Math.max(1, ...years.map(([, n]) => n));
  const yearBars = years
    .map(
      ([y, n]) =>
        `<span class="yb" title="${y} 年 ${n} 篇"><i style="height:${Math.max(6, Math.round((n / maxY) * 46))}px"></i><em>${String(y).slice(2)}</em></span>`,
    )
    .join('');

  const items = t.entities
    .slice(0, 60)
    .map(
      (e) => `<li>
<a class="t" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a>
<div class="m">${e.year ? `${e.year} · ` : ''}<a href="${BASE}/${e.site}/">${esc(labels[e.site] || e.site)}</a>${e.abstract ? ` · ${esc(e.abstract)}…` : ''}</div>
</li>`,
    )
    .join('\n');

  const rel = (t.related || [])
    .map((r) => `<a class="chip" href="${BASE}/topic/${r.slug}.html">${esc(r.topic)}</a>`)
    .join('');

  const jsonld = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: `${t.topic} — 研究主题聚合`,
      url: canonical,
      description: `GeneTech 知识引擎收录 ${t.docCount} 篇与「${t.topic}」相关的科研实体，横跨 ${t.siteCount} 个前沿科技垂直领域。`,
      about: { '@type': 'DefinedTerm', name: t.topic },
      isPartOf: { '@type': 'WebSite', name: 'GeneTech 知识引擎', url: `${ORIGIN}${BASE}/` },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      numberOfItems: Math.min(60, t.entities.length),
      itemListElement: t.entities.slice(0, 60).map((e, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: {
          '@type': 'ScholarlyArticle',
          name: e.name,
          url: e.url,
          ...(e.year ? { datePublished: String(e.year) } : {}),
        },
      })),
    },
  ];

  const body = `
<p class="crumb"><a href="${BASE}/topic/">主题图谱</a> / ${esc(t.topic)}</p>
<h1>${esc(t.topic)}</h1>
<p class="sub">GeneTech 知识引擎共收录 <b>${t.docCount}</b> 篇相关科研实体，横跨 <b>${t.siteCount}</b> 个垂直领域。数据来自 OpenAlex、arXiv、Crossref、PubMed、Europe PMC 等公开学术源，全部可溯源到原文。</p>
<div class="chips">${siteRows}</div>
${years.length ? `<h2>年度产出趋势</h2><div class="ybars">${yearBars}</div>` : ''}
${rel ? `<h2>相关主题</h2><div class="chips">${rel}</div>` : ''}
<h2>代表性文献（按质量分排序，前 ${Math.min(60, t.entities.length)} 条）</h2>
<ul class="elist">${items}</ul>
<h2>以 API 获取该主题全量数据</h2>
<pre><code># 主题词表（含本主题的站点分布与年度分布）
curl ${ORIGIN}${BASE}/api/topics.json

# 主题共现知识图谱
curl ${ORIGIN}${BASE}/api/graph.json</code></pre>
<p>需要按主题批量拉取、导出 BibTeX 或接入 AI Agent？查看 <a href="${BASE}/data.html">数据下载与格式</a> 或 <a href="${BASE}/mcp.html">MCP 接入</a>。</p>`;

  return layout({
    title: `${t.topic} — ${t.docCount} 篇研究聚合 | GeneTech 知识引擎`,
    desc: `「${t.topic}」主题下的 ${t.docCount} 篇科研实体聚合，横跨 ${t.siteCount} 个前沿科技领域，含年度趋势、相关主题与可溯源原文链接，支持 JSON API 与 MCP 调用。`,
    body,
    jsonld,
    canonical,
  });
}

/** 主题总览页 */
function renderTopicIndex(topics) {
  const canonical = `${ORIGIN}${BASE}/topic/`;
  const items = topics
    .map(
      (t) =>
        `<a class="tcard" href="${BASE}/topic/${t.slug}.html"><span class="n">${esc(t.topic)}</span><span class="c">${t.docCount} 篇 · ${t.siteCount} 站</span></a>`,
    )
    .join('\n');
  const body = `
<h1>主题图谱</h1>
<p class="sub">从 ${SITE_COUNT} 个垂直领域的全部实体中自动抽取、归一化并按共现关系聚合出的 <b>${topics.length}</b> 个研究主题。每个主题页含站点分布、年度趋势、相关主题与代表文献。</p>
<div class="search"><input id="topic-filter" type="search" placeholder="过滤主题…"></div>
<div class="tgrid" id="tgrid">${items}</div>
<script>
(function(){var i=document.getElementById('topic-filter'),g=document.getElementById('tgrid');
if(!i||!g)return;var cards=[].slice.call(g.children);
i.addEventListener('input',function(){var q=i.value.trim().toLowerCase();
cards.forEach(function(c){c.style.display=!q||c.textContent.toLowerCase().indexOf(q)>-1?'':'none';});});})();
</script>
<h2>机器可读版本</h2>
<pre><code>curl ${ORIGIN}${BASE}/api/topics.json   # 主题词表
curl ${ORIGIN}${BASE}/api/graph.json    # 主题共现图谱（节点+边）</code></pre>`;
  return layout({
    title: `主题图谱 — ${topics.length} 个前沿研究主题 | GeneTech 知识引擎`,
    desc: `GeneTech 从 ${SITE_COUNT} 个前沿科技垂直领域自动抽取的 ${topics.length} 个研究主题聚合索引，含共现图谱、年度趋势与可溯源文献。`,
    body,
    jsonld: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: '主题图谱',
      url: canonical,
      description: `${topics.length} 个前沿研究主题的聚合索引`,
    },
    canonical,
  });
}

/** 数据下载页：把「结构化资产」显性化，是 GEO 与商业转化的关键落地页 */
function renderDataPage(sites, stats, labels) {
  const canonical = `${ORIGIN}${BASE}/data.html`;
  const rows = sites
    .map(
      (s) => `<tr>
<td><a href="${BASE}/${s.slug}/">${esc(labels[s.slug] || s.slug)}</a></td>
<td>${s.entities.length}</td>
<td><a href="${BASE}/${s.slug}/website/api/entities.json">JSON</a></td>
<td><a href="${BASE}/${s.slug}/website/api/entities.jsonl.gz">JSONL.gz</a></td>
<td><a href="${BASE}/${s.slug}/website/api/entities.csv">CSV</a></td>
<td><a href="${BASE}/${s.slug}/website/api/citations.bib">BibTeX</a></td>
<td><a href="${BASE}/${s.slug}/website/api/citations.csl.json">CSL-JSON</a></td>
</tr>`,
    )
    .join('\n');

  const body = `
<h1>数据下载与结构化格式</h1>
<p class="sub">GeneTech 的 <b>${stats.totalEntities.toLocaleString('en-US')}</b> 条科研实体以 <b>7 种</b>结构化形态开放：原始 JSON、行式 JSONL、表格 CSV、文献管理 BibTeX / CSL-JSON，以及派生的主题词表、作者索引与知识图谱。全部以 CC-BY 提供。</p>

<h2>全站聚合资产</h2>
<table class="cmp">
<thead><tr><th>资产</th><th>说明</th><th>典型用途</th><th>下载</th></tr></thead>
<tbody>
<tr><td>站点目录</td><td>${SITE_COUNT} 个领域的清单与各自 API 地址</td><td>Agent 一次性发现全部数据源</td><td><a href="${BASE}/api/catalog.json">catalog.json</a></td></tr>
<tr><td>主题词表</td><td>${stats.indexedTopics} 个归一化主题，含站点分布与年度分布</td><td>主题导航、趋势分析、选题</td><td><a href="${BASE}/api/topics.json">topics.json</a></td></tr>
<tr><td>知识图谱</td><td>${stats.graphNodes} 节点 / ${stats.graphEdges} 条共现边</td><td>关联发现、图可视化、推荐</td><td><a href="${BASE}/api/graph.json">graph.json</a></td></tr>
<tr><td>作者索引</td><td>归一化后的高产作者及其领域分布</td><td>专家发现、合作网络</td><td><a href="${BASE}/api/authors.json">authors.json</a></td></tr>
<tr><td>时间线</td><td>逐年产出量（分站点）</td><td>领域热度趋势判断</td><td><a href="${BASE}/api/timeline.json">timeline.json</a></td></tr>
<tr><td>统计快照</td><td>覆盖率、质量分、来源与类型分布</td><td>数据质量评估</td><td><a href="${BASE}/api/stats.json">stats.json</a></td></tr>
</tbody>
</table>

<h2>数据质量快照</h2>
<div class="chips">
<span class="chip">实体总量 <b>${stats.totalEntities.toLocaleString('en-US')}</b></span>
<span class="chip">领域 <b>${stats.totalSites}</b></span>
<span class="chip">摘要覆盖 <b>${stats.coverage.abstract}%</b></span>
<span class="chip">作者覆盖 <b>${stats.coverage.authors}%</b></span>
<span class="chip">DOI 可溯源 <b>${stats.coverage.doi}%</b></span>
<span class="chip">平均质量分 <b>${stats.avgQuality}</b></span>
</div>
<p class="sub">来源分布：${Object.entries(stats.bySource).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</p>

<h2>分领域下载</h2>
<div class="tablewrap">
<table class="cmp">
<thead><tr><th>领域</th><th>实体数</th><th>JSON</th><th>JSONL</th><th>CSV</th><th>BibTeX</th><th>CSL-JSON</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>

<h2>格式怎么选</h2>
<ul>
<li><strong>JSONL</strong> — 每行一条独立 JSON，是 RAG 摄取与模型微调的事实标准，可直接流式读取，无需整文件载入内存。</li>
<li><strong>CSV</strong> — Excel / pandas / BI 工具直接打开，含 <code>year / authors / tags / quality</code> 等已归一化列。</li>
<li><strong>BibTeX / CSL-JSON</strong> — Zotero、EndNote、LaTeX、Pandoc 直接导入，写论文时免去手工录入。</li>
<li><strong>JSON</strong> — 完整原始实体，字段最全，适合二次开发。</li>
<li><strong>MCP</strong> — 不想下载？用 <code>npx -y @genetech/data-mcp</code> 让 AI Agent 实时查询，见 <a href="${BASE}/mcp.html">接入说明</a>。</li>
</ul>

<h2>许可</h2>
<p>数据以 <strong>CC-BY</strong> 提供：可自由用于研究、商业产品与模型训练，请保留来源标注（GeneTech 知识引擎 + 原始文献链接）。需要更高调用配额、私有部署或定制领域，见 <a href="${BASE}/mcp.html">计费说明</a>。</p>`;

  return layout({
    title: `数据下载 — ${stats.totalEntities.toLocaleString('en-US')} 条科研实体 / 7 种结构化格式 | GeneTech`,
    desc: `开放下载 ${stats.totalEntities.toLocaleString('en-US')} 条前沿科技科研实体：JSON / JSONL / CSV / BibTeX / CSL-JSON，以及主题词表、作者索引与知识图谱。CC-BY 许可，支持 RAG 摄取、文献管理与 AI Agent 调用。`,
    body,
    canonical,
    jsonld: {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: 'GeneTech 前沿科技科研实体数据集',
      description: `覆盖 ${stats.totalSites} 个前沿科技垂直领域的 ${stats.totalEntities} 条结构化科研实体，含主题、作者、年份、来源与质量分。`,
      url: canonical,
      license: 'https://creativecommons.org/licenses/by/4.0/',
      creator: { '@type': 'Organization', name: 'GeneTech 知识引擎' },
      distribution: [
        { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: `${ORIGIN}${BASE}/api/catalog.json` },
        { '@type': 'DataDownload', encodingFormat: 'application/x-ndjson', contentUrl: `${ORIGIN}${BASE}/data.html` },
        { '@type': 'DataDownload', encodingFormat: 'text/csv', contentUrl: `${ORIGIN}${BASE}/data.html` },
      ],
      variableMeasured: ['title', 'abstract', 'authors', 'tags', 'year', 'source', 'doi', 'quality'],
    },
  });
}

function localizeSiteCount(s) {
  if (!SITE_COUNT) return s;
  return s
    .replace(/(?<!\d)14(\s?)个(\s?)(前沿|知识领域|垂直领域)/g, `${SITE_COUNT}$1个$2$3`)
    .replace(/(?<!\d)14(\s?)站/g, `${SITE_COUNT}$1站`);
}

// 研究洞察页：把结构化层的高价值派生事实（趋势/研究空白/桥接主题/合著网络）直接呈现为可索引、可引用的页面
function renderInsightsPage(struct, labels) {
  const canonical = `${ORIGIN}${BASE}/insights.html`;
  const { risingTopics, emergingTopics, topBridges } = struct.trends;
  const coAuthors = struct.coAuthors || [];

  const risingRows = risingTopics
    .slice(0, 40)
    .map(
      (t) => `<tr>
<td><a href="${BASE}/topic/${t.slug}.html">${esc(t.topic)}</a></td>
<td>${t.docCount.toLocaleString('en-US')}</td>
<td><span class="up">▲ ${t.trend.pctGrowth >= 999 ? '新起' : '+' + t.trend.pctGrowth + '%'}</span></td>
<td>${t.trend.last3.toLocaleString('en-US')}</td>
<td>${t.siteCount}</td>
</tr>`,
    )
    .join('\n');

  const gapRows = emergingTopics
    .slice(0, 40)
    .map(
      (t) => `<tr>
<td><a href="${BASE}/topic/${t.slug}.html">${esc(t.topic)}</a></td>
<td>${t.docCount.toLocaleString('en-US')}</td>
<td><span class="up">${t.trend.recentShare}%</span></td>
<td>${[...new Set(Object.keys(t.siteCounts || {}))].map((s) => labels[s] || s).slice(0, 4).join('、') || '—'}</td>
</tr>`,
    )
    .join('\n');

  const bridgeRows = topBridges
    .slice(0, 40)
    .map(
      (t) => `<tr>
<td><a href="${BASE}/topic/${t.slug}.html">${esc(t.topic)}</a></td>
<td><span class="up">${t.siteCount} 站</span></td>
<td>${t.docCount.toLocaleString('en-US')}</td>
<td>${[...new Set(Object.keys(t.siteCounts || {}))].map((s) => labels[s] || s).slice(0, 5).join('、') || '—'}</td>
</tr>`,
    )
    .join('\n');

  const coRows = coAuthors
    .slice(0, 40)
    .map(
      (c) => `<tr>
<td>${esc(c.a)}</td>
<td>${esc(c.b)}</td>
<td><span class="chip">${c.weight}</span></td>
<td>${(c.sites || []).map((s) => esc(labels[s] || s)).slice(0, 3).join('、') || '—'}</td>
</tr>`,
    )
    .join('\n');

  const body = `
<h1>研究洞察</h1>
<p class="sub">基于 <b>${struct.stats.totalEntities.toLocaleString('en-US')}</b> 条实体、<b>${struct.stats.indexedTopics.toLocaleString('en-US')}</b> 个主题自动派生。以下四类洞察每天随数据更新——可直接引用，也供 AI Agent 通过 <code>api/insights.json</code> 实时读取。</p>

<h2>① 上升最快的主题（近 3 年增量）</h2>
<p class="sub">按近 3 年相对前 3 年的净增量排序，反映正在升温的研究方向。</p>
<div class="tablewrap"><table class="cmp">
<thead><tr><th>主题</th><th>文献量</th><th>趋势</th><th>近3年</th><th>横跨站点</th></tr></thead>
<tbody>${risingRows}</tbody></table></div>

<h2>② 新兴研究空白（高增长 · 低饱和）</h2>
<p class="sub">近 3 年占比 ≥45% 但总文献量仍偏低（&lt;250），是值得优先选题与扩量的蓝海方向。</p>
<div class="tablewrap"><table class="cmp">
<thead><tr><th>主题</th><th>文献量</th><th>近3年占比</th><th>代表领域</th></tr></thead>
<tbody>${gapRows}</tbody></table></div>

<h2>③ 跨站桥接主题（学科交汇点）</h2>
<p class="sub">同时横跨 ≥3 个垂直领域，是跨学科汇聚、技术迁移的高价值枢纽。</p>
<div class="tablewrap"><table class="cmp">
<thead><tr><th>主题</th><th>横跨站点</th><th>文献量</th><th>涉及领域</th></tr></thead>
<tbody>${bridgeRows}</tbody></table></div>

<h2>④ 核心合著网络（高产合作对）</h2>
<p class="sub">同一篇文献中两两共现 ≥3 次，反映稳定的合作轴心，可用于专家发现与团队组建。</p>
<div class="tablewrap"><table class="cmp">
<thead><tr><th>作者 A</th><th>作者 B</th><th>共现</th><th>领域</th></tr></thead>
<tbody>${coRows}</tbody></table></div>

<h2>机器可读</h2>
<p>全部洞察以 <code>api/insights.json</code> 开放（含上升趋势、研究空白、桥接主题与合著网络），CC-BY 许可。企业批量获取或私有化部署见 <a href="${BASE}/mcp.html">MCP 接入</a>。</p>`;

  const mentions = [...risingTopics.slice(0, 12), ...emergingTopics.slice(0, 8)].map((t) => ({
    '@type': 'DefinedTerm',
    name: t.topic,
    url: `${ORIGIN}${BASE}/topic/${t.slug}.html`,
  }));

  return layout({
    title: `研究洞察 — ${struct.stats.indexedTopics.toLocaleString('en-US')} 主题自动派生趋势 / GeneTech`,
    desc: `从 ${struct.stats.totalEntities.toLocaleString('en-US')} 条科研实体自动派生的研究洞察：上升最快的主题、新兴研究空白、跨站桥接主题与核心合著网络，每日随数据更新。`,
    body,
    canonical,
    jsonld: {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: 'GeneTech 研究洞察数据集',
      description: `基于 ${struct.stats.totalEntities} 条实体自动派生的科研趋势与关系洞察。`,
      url: canonical,
      license: 'https://creativecommons.org/licenses/by/4.0/',
      creator: { '@type': 'Organization', name: 'GeneTech 知识引擎' },
      hasPart: mentions,
    },
  });
}

function writeFile(rel, content) {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const isText = /\.(html|txt|xml)$/i.test(rel);
  fs.writeFileSync(dest, isText && typeof content === 'string' ? localizeSiteCount(content) : content);
}

/**
 * 写 gzip 压缩产物。用于体积大、面向程序消费的批量导出（如 JSONL）。
 * 之所以不靠 HTTP 传输层压缩：GitHub Pages 的 1GB 容量上限按解压后体积计，
 * 且部署时需整体上传为 artifact，明文大文件会直接拖垮部署耗时。
 */
function writeGzip(rel, content) {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, zlib.gzipSync(Buffer.from(content), { level: 9 }));
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

  SITE_COUNT = sites.length;
  ALL_SITE_LABELS = sites.map((s) => SITE_LABELS[s.slug] || s.slug);

  // ===== 结构化层：从扁平实体派生主题/作者/时间线/图谱（构建期计算，不落仓库）=====
  const t0 = Date.now();
  const struct = buildStructure(sites, { labels: SITE_LABELS });
  console.log(
    `[structure] ${struct.stats.totalEntities} 实体 → 主题 ${struct.stats.indexedTopics}/${struct.stats.uniqueTopics}，` +
      `作者 ${struct.stats.uniqueAuthors}，图谱 ${struct.stats.graphNodes} 节点/${struct.stats.graphEdges} 边` +
      `（${((Date.now() - t0) / 1000).toFixed(1)}s）`,
  );

  let totalEntities = 0;
  const archivePaths = []; // 归档分页相对路径，用于写入 sitemap
  for (const s of sites) {
    totalEntities += s.entities.length;
    // 保持原始 API 路径契约
    writeFile(`${s.slug}/website/api/index.json`, JSON.stringify(s.index));
    writeFile(`${s.slug}/website/api/entities.json`, JSON.stringify(s.entities));

    // ---- 多格式导出：同一份数据以不同结构形态开放，覆盖 RAG / 数据分析 / 文献管理三类用途
    // JSONL 与 entities.json 内容高度重复且体积最大（实测占产物 45MB / 20%），
    // 因此只发 gzip 版：pandas / HuggingFace datasets / curl 均原生支持 .gz，
    // 体积约为明文的 1/5，是 10 万级规模下守住 GitHub Pages 1GB 上限的关键。
    writeGzip(`${s.slug}/website/api/entities.jsonl.gz`, toJSONL(s.entities, s.slug));
    writeFile(`${s.slug}/website/api/entities.csv`, toCSV(s.entities, s.slug));
    // 引文格式体积大且低频，只导出质量分最高的部分，避免产物膨胀拖慢部署
    const cites = [...s.entities].sort((a, b) => qualityScore(b) - qualityScore(a)).slice(0, CITATION_EXPORT_CAP);
    writeFile(`${s.slug}/website/api/citations.bib`, toBibTeX(cites));
    writeFile(`${s.slug}/website/api/citations.csl.json`, JSON.stringify(toCSLJSON(cites)));
    // 站点级分面（主题/作者/年份/来源），供站内导航与第三方分析直接消费
    writeFile(`${s.slug}/website/api/facets.json`, JSON.stringify(struct.perSite[s.slug]));

    writeFile(`${s.slug}/index.html`, renderSitePage(s, sites));

    // 归档分页：让全部实体都拥有可被搜索/AI 引擎抓取的 HTML 表面
    const ordered = sortedEntities(s);
    const totalPages = Math.max(1, Math.ceil(ordered.length / ARCHIVE_PAGE_SIZE));
    for (let p = 1; p <= totalPages; p++) {
      const slice = ordered.slice((p - 1) * ARCHIVE_PAGE_SIZE, p * ARCHIVE_PAGE_SIZE);
      writeFile(`${s.slug}/page/${p}.html`, renderArchivePage(s, p, totalPages, slice));
      archivePaths.push(`${s.slug}/page/${p}.html`);
    }
  }
  console.log(`[archive] 生成归档分页 ${archivePaths.length} 页，覆盖 ${totalEntities} 条实体`);

  // ===== 主题聚合页：承接长尾检索，并给 AI 引擎提供可直接引用的聚合事实 =====
  const topicPaths = [];
  for (const t of struct.topics) {
    writeFile(`topic/${t.slug}.html`, renderTopicPage(t, SITE_LABELS));
    topicPaths.push(`topic/${t.slug}.html`);
  }
  writeFile('topic/index.html', renderTopicIndex(struct.topics));
  console.log(`[structure] 生成主题聚合页 ${topicPaths.length} 个`);

  // ===== 派生数据 API =====
  writeFile(
    'api/topics.json',
    JSON.stringify({
      generatedAt: struct.stats.generatedAt,
      total: struct.topics.length,
      topics: struct.topics.map((t) => ({
        topic: t.topic,
        slug: t.slug,
        docCount: t.docCount,
        siteCount: t.siteCount,
        siteCounts: t.siteCounts,
        years: t.years,
        related: (t.related || []).map((r) => r.topic),
        url: `${ORIGIN}${BASE}/topic/${t.slug}.html`,
      })),
    }),
  );
  writeFile('api/graph.json', JSON.stringify(struct.graph));
  writeFile('api/authors.json', JSON.stringify({ generatedAt: struct.stats.generatedAt, total: struct.authors.length, authors: struct.authors }));
  writeFile('api/timeline.json', JSON.stringify({ generatedAt: struct.stats.generatedAt, timeline: struct.timeline }));
  writeFile('api/stats.json', JSON.stringify(struct.stats, null, 2));
  // 洞察层：上升趋势主题、新兴研究空白、跨站桥接主题、合著网络 —— 给 AI 引擎与企业买家可直接引用的高价值聚合事实
  writeFile(
    'api/insights.json',
    JSON.stringify({
      generatedAt: struct.stats.generatedAt,
      trends: struct.trends,
      coAuthors: struct.coAuthors,
    }, null, 2),
  );

  writeFile('index.html', renderHome(sites));
  writeFile('search.html', renderSearchPage(sites));
  writeFile('mcp.html', renderMcpPage());
  writeFile('data.html', renderDataPage(sites, struct.stats, SITE_LABELS));
  writeFile('insights.html', renderInsightsPage(struct, SITE_LABELS));
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
    `- 数据下载与格式说明: ${ORIGIN}${BASE}/data.html`,
    `- RSS: ${ORIGIN}${BASE}/rss.xml`,
    '',
    '## 结构化派生资产（均为机器可读，CC-BY 许可）',
    `- 主题词表（${struct.stats.indexedTopics} 个归一化主题，含站点/年度分布）: ${ORIGIN}${BASE}/api/topics.json`,
    `- 主题共现知识图谱（${struct.stats.graphNodes} 节点 / ${struct.stats.graphEdges} 边）: ${ORIGIN}${BASE}/api/graph.json`,
    `- 作者索引（归一化去重后的高产作者及领域分布）: ${ORIGIN}${BASE}/api/authors.json`,
    `- 年度时间线（逐年产出量，分站点）: ${ORIGIN}${BASE}/api/timeline.json`,
    `- 数据质量统计（覆盖率/来源/类型/质量分）: ${ORIGIN}${BASE}/api/stats.json`,
    `- 研究洞察（上升趋势/研究空白/桥接主题/合著网络）: ${ORIGIN}${BASE}/api/insights.json`,
    `- 研究洞察页（可读）: ${ORIGIN}${BASE}/insights.html`,
    `- 主题聚合页索引: ${ORIGIN}${BASE}/topic/`,
    '',
    '## 每个领域提供的数据格式',
    '- `<site>/website/api/entities.json` 完整实体（JSON）',
    '- `<site>/website/api/entities.jsonl.gz` 行式 JSON（gzip），适合 RAG 摄取与模型训练，pandas/datasets 可直读',
    '- `<site>/website/api/entities.csv` 表格格式，Excel/pandas 直接可用',
    '- `<site>/website/api/citations.bib` BibTeX 引文，Zotero/LaTeX 直接导入',
    '- `<site>/website/api/citations.csl.json` CSL-JSON 引文交换格式',
    '- `<site>/website/api/facets.json` 该领域的主题/作者/年份/来源分面统计',
    '',
    '## 数据规模与质量',
    `- 实体总量 ${struct.stats.totalEntities}，覆盖 ${struct.stats.totalSites} 个前沿科技垂直领域`,
    `- 摘要覆盖率 ${struct.stats.coverage.abstract}%，作者覆盖率 ${struct.stats.coverage.authors}%，DOI 可溯源率 ${struct.stats.coverage.doi}%`,
    `- 数据来源：${Object.keys(struct.stats.bySource).join('、')}（均为公开学术数据源，可溯源到原始文献）`,
    '',
    '## 与其他科研工具对比（Elicit / Consensus / Scite / Perplexity）',
    'GeneTech 与 Elicit、Consensus、Scite 等「人读」科研工具定位不同：它是 Agent 原生的科研知识底座，通过 MCP + JSON API 把 14 个前沿科技垂直领域的结构化实体（含原始论文 URL、作者、置信度、标签）直接交给 AI Agent 调用，支持可溯源引用、RAG 与自动化综述。详见对比文章：',
    `- 对比 Elicit/Consensus/Scite: ${ORIGIN}${BASE}/blog/vs-elicit-consensus-scite.html`,
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
    'insights.html',
    'data.html',
    'topic/',
    'blog/',
    'rss.xml',
    ...BLOG_POSTS.map((b) => `blog/${b.slug}.html`),
  ];
  const urls = ['', ...sites.map((s) => `${s.slug}/`), ...extraPages, ...topicPaths, ...archivePaths]
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
  // IndexNow 验证文件（密钥本就是公开的）。
  // 站点部署在子路径下，主机根目录无法放文件，因此把标准 key 文件写到站点根：
  //   https://<host><BASE>/<key>.txt
  // promotion 管线的 keyLocation 必须指向它，否则 IndexNow 会因 key 不可达而拒收。
  writeFile(`${INDEXNOW_KEY}.txt`, INDEXNOW_KEY);
  writeFile('.well-known/indexnow.txt', INDEXNOW_KEY); // 兼容保留

  console.log(`[ok] 生成 ${sites.length} 个站点 / ${totalEntities} 条实体 → ${OUT}`);
}

main();
