#!/usr/bin/env node
/**
 * build-pagefind.mjs — 独立 Pagefind 搜索索引构建器
 *
 * 背景（10-14 报告 §11）：站点内搜索 lazy fetch 整站 entities.json（9-14MB）做
 * indexOf 子串匹配，无分词；全局 search.html 跨 30 站等于拉数百 MB。
 *
 * 本脚本把每站的 entities.json 转成静态 HTML 页（每页 50 条 entity），
 * 再用 Pagefind（Rust 静态索引器）产出 pagefind/ 目录。
 * 客户端改用 pagefind.js 后，搜索 payload = ~20KB 索引 + 每结果 ~1KB。
 *
 * 用法：
 *   node tools/build-pagefind.mjs <site-dir> [--entities entities.json] [--out <site>/website] [--chunk 50]
 *
 * 依赖：
 *   - pagefind（npm 包名就是 `pagefind`，不是 @pagefind/cli）
 *   - 本地安装：npm i --save-dev pagefind
 *   - 或 npx -y -p pagefind pagefind（本脚本会 fallback 到 npx）
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const args = process.argv.slice(2);
const siteDir = args[0];
if (!siteDir) {
  console.error('用法: node tools/build-pagefind.mjs <site-dir> [--entities entities.json] [--out <site>/website] [--chunk 50]');
  process.exit(1);
}

const opts = { entitiesFile: 'website/api/entities.json', outDir: 'website', chunk: 50 };
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--entities') opts.entitiesFile = args[++i];
  else if (args[i] === '--out') opts.outDir = args[++i];
  else if (args[i] === '--chunk') opts.chunk = parseInt(args[++i], 10) || 50;
}

const root = path.resolve(siteDir);
const entitiesPath = path.join(root, opts.entitiesFile);
if (!fs.existsSync(entitiesPath)) {
  console.error(`❌ 找不到 entities 文件: ${entitiesPath}`);
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(entitiesPath, 'utf-8'));
const entities = Array.isArray(raw) ? raw : (raw.entities || raw.data || []);
console.log(`📖 读取 ${entities.length} 条 entity`);

// ---- 1. 生成中间 HTML（每 chunk 条一页） ----
const workDir = path.join(root, '.pagefind-src');
if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });

const siteName = path.basename(root);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const chunks = [];
for (let i = 0; i < entities.length; i += opts.chunk) {
  const batch = entities.slice(i, i + opts.chunk);
  const items = batch.map((e, k) => {
    const idx = i + k;
    const name = esc(e.name || e.title || `entity-${idx}`);
    const doi = esc(e.doi || e.id || '');
    const authors = e.authors && e.authors.length ? esc(e.authors.join(', ')) : '';
    const year = e.year || e.publishedYear || (e.publishedDate ? String(e.publishedDate).slice(0, 4) : '');
    const abstract = esc((e.abstract || e.description || e.summary || '').slice(0, 400));
    const tags = (e.tags || e.subjects || []).slice(0, 8).map(esc).join(', ');
    const url = e.url || e.doi ? `https://doi.org/${doi}` : '';
    return `<article>
      <h2>${name}</h2>
      ${doi ? `<p class="doi">DOI: ${doi}</p>` : ''}
      ${authors ? `<p class="authors">作者: ${authors}</p>` : ''}
      ${year ? `<p class="year">${year}</p>` : ''}
      ${tags ? `<p class="tags">标签: ${tags}</p>` : ''}
      ${abstract ? `<p class="abstract">${abstract}</p>` : ''}
      ${url ? `<p><a href="${esc(url)}">DOI 链接</a></p>` : ''}
    </article>`;
  }).join('\n');
  const file = path.join(workDir, `chunk-${String(Math.floor(i / opts.chunk)).padStart(4, '0')}.html`);
  fs.writeFileSync(file, `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${siteName} — Pagefind ${Math.floor(i/opts.chunk)+1}</title></head>
<body>
<h1>${esc(siteName)} 搜索结果</h1>
${items}
</body></html>`);
  chunks.push(file);
}
console.log(`📝 生成 ${chunks.length} 个中间 HTML 页`);

// ---- 2. 调用 Pagefind CLI 构建索引 ----
const outDir = path.join(root, opts.outDir, 'pagefind');
if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });

let pfOut, pfStatus;
// 优先本地 pagefind（npm 包名就是 `pagefind`，不是 @pagefind/cli）
const localPkg = path.join(root, 'node_modules', 'pagefind', 'pagefind');
// --force-language 只接受单一 ISO 639-1 code；Pagefind 按 <html lang> 自动多语言分词
const pfArgs = ['--site', workDir, '--output-path', outDir];
if (fs.existsSync(localPkg)) {
  pfStatus = spawnSync('npx', ['--no-install', 'pagefind', ...pfArgs], { encoding: 'utf-8', shell: process.platform === 'win32' });
} else {
  pfStatus = spawnSync('npx', ['-y', '-p', 'pagefind', 'pagefind', ...pfArgs], { encoding: 'utf-8', shell: process.platform === 'win32' });
}

if (pfStatus.status !== 0) {
  console.error('❌ Pagefind 构建失败:');
  console.error(pfStatus.stderr || pfStatus.stdout || '');
  fs.rmSync(workDir, { recursive: true, force: true });
  process.exit(3);
}

// 打印关键 stdout 行
if (pfStatus.stdout) {
  pfStatus.stdout.split('\n').filter(l => l.trim()).slice(-8).forEach(l => console.log('  ' + l));
}

// ---- 3. 清理中间产物 ----
fs.rmSync(workDir, { recursive: true, force: true });

const indexHtml = path.join(outDir, 'pagefind.js');
const indexMeta = path.join(outDir, 'pagefind-ui.js');
console.log(`✅ Pagefind 索引生成于 ${outDir}`);
if (fs.existsSync(outDir)) {
  const files = fs.readdirSync(outDir);
  console.log(`   文件: ${files.join(', ')}`);
}
console.log(`\n📌 后续动作：修改 ${siteName}/website/search.html 引入 pagefind-ui.css 和 pagefind-ui.js 替换原 fetch 逻辑。见 docs/PAGEFIND-INTEGRATION.md`);
