#!/usr/bin/env node
/**
 * deploy-pagefind-search.mjs — 批量替换 30 站搜索页为 Pagefind 模板
 *
 * 用法：
 *   node tools/deploy-pagefind-search.mjs              # 部署到所有 30 站
 *   node tools/deploy-pagefind-search.mjs --dry-run    # 仅预览，不写入
 *   node tools/deploy-pagefind-search.mjs ai-safety    # 仅部署到指定站点
 *
 * 前置条件：
 *   1. 已运行 tools/build-pagefind.mjs 生成各站 pagefind/ 索引
 *   2. 确认 tools/templates/pagefind-search.html 模板内容正确
 *
 * 输出：
 *   <site>/website/search.html（覆盖原 fetch-based 搜索页）
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEMPLATES_DIR = path.join(ROOT, 'tools', 'templates');
const TEMPLATE_PATH = path.join(TEMPLATES_DIR, 'pagefind-search.html');
const DATA_FILE = path.join(ROOT, 'data', 'sites.json');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const TARGET_SITES = argv.filter(a => !a.startsWith('--'));

// 加载站点配置
let sites = [];
if (fs.existsSync(DATA_FILE)) {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  sites = data.sites || data || [];
} else {
  // 从目录结构推断
  const dirs = fs.readdirSync(ROOT).filter(d => {
    const p = path.join(ROOT, d);
    return fs.statSync(p).isDirectory() && 
           fs.existsSync(path.join(p, 'website', 'api', 'entities.json'));
  });
  sites = dirs.map(d => ({ site: d, slug: d }));
}

if (TARGET_SITES.length) {
  sites = sites.filter(s => TARGET_SITES.includes(s.site) || TARGET_SITES.includes(s.slug));
}

if (sites.length === 0) {
  console.error('❌ 未找到任何站点');
  process.exit(1);
}

// 加载模板
if (!fs.existsSync(TEMPLATE_PATH)) {
  console.error(`❌ 模板文件不存在: ${TEMPLATE_PATH}`);
  process.exit(2);
}
const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

let deployed = 0;
let skipped = 0;
let errors = 0;

for (const site of sites) {
  const siteDir = path.join(ROOT, site.site);
  const entitiesPath = path.join(siteDir, 'website', 'api', 'entities.json');
  const pagefindDir = path.join(siteDir, 'website', 'pagefind');
  const searchPath = path.join(siteDir, 'website', 'search.html');

  // 检查前置条件
  if (!fs.existsSync(entitiesPath)) {
    console.log(`⏭️  跳过 ${site.site}: 无 entities.json`);
    skipped++;
    continue;
  }
  if (!fs.existsSync(pagefindDir)) {
    console.log(`⏭️  跳过 ${site.site}: 无 pagefind/ 索引（先运行 build-pagefind.mjs）`);
    skipped++;
    continue;
  }

  // 读取 entities 数量
  let entityCount = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(entitiesPath, 'utf-8'));
    entityCount = Array.isArray(raw) ? raw.length : (raw.entities?.length || raw.data?.length || 0);
  } catch {}

  // 替换模板变量
  const siteUrl = `https://${process.env.CANONICAL_HOST || 'lm203688.github.io'}/${site.site}/`;
  const siteName = site.site.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const buildDate = new Date().toISOString().slice(0, 10);

  const content = template
    .replace(/\{\{SITE_NAME\}\}/g, siteName)
    .replace(/\{\{TOTAL_ENTITIES\}\}/g, entityCount.toLocaleString())
    .replace(/\{\{SITE_URL\}\}/g, siteUrl)
    .replace(/\{\{BUILD_DATE\}\}/g, buildDate);

  // 写入
  if (DRY_RUN) {
    console.log(`📄 [dry-run] ${site.site}: ${entityCount} entities → ${searchPath}`);
  } else {
    try {
      fs.writeFileSync(searchPath, content, 'utf-8');
      console.log(`✅ ${site.site}: ${entityCount} entities → ${searchPath}`);
      deployed++;
    } catch (e) {
      console.error(`❌ ${site.site}: ${e.message}`);
      errors++;
    }
  }
}

console.log(`\n=== 完成 ===`);
console.log(`  部署: ${deployed}`);
console.log(`  跳过: ${skipped}`);
console.log(`  错误: ${errors}`);
console.log(`  总计: ${sites.length} 站`);
if (DRY_RUN) console.log(`\n⚠️  dry-run 模式，未写入文件。去掉 --dry-run 执行部署。`);
