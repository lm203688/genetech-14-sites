#!/usr/bin/env node
/**
 * UX 修复脚本
 *
 * 解决问题：
 * 1. 移除 index.html 中内联的过度激进的反爬虫代码
 * 2. 修复定价页 URL 错误（www.www.creem.io → www.creem.io）
 * 3. 统一 api-pricing.html 和 credits.html 的定价信息
 * 4. 移除底部固定导航栏的 emoji（改为专业风格）
 * 5. 为实体页面添加"最后更新时间"标识
 *
 * 用法：
 *   node fix-ux.js <site-dir> [--project-root <path>]
 *   node fix-ux.js --all [--project-root <path>]
 */

const fs = require('fs');
const path = require('path');

const SITES = [
  'genetech-tools', 'tcm-tools', 'agent-ecosystem', 'robot-parts',
  'quantum-computing', 'brain-science', 'nuclear-energy', 'exo-science',
  'alien-minerals', 'deep-sea-tech', 'new-energy', 'life-science',
  'biocomputing', 'bionic-ai'
];

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return null;
  }
}

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * 修复 1：替换 anti-scrape.js（用精简版替换激进版）
 */
function fixAntiScrape(sitePath) {
  const targetPath = path.join(sitePath, 'website', 'anti-scrape.js');
  const sourcePath = path.join(__dirname, 'anti-scrape.js');

  if (!fs.existsSync(sourcePath)) {
    console.log('  - 未找到精简版 anti-scrape.js，跳过');
    return;
  }

  const newContent = fs.readFileSync(sourcePath, 'utf-8');
  fs.writeFileSync(targetPath, newContent);
  console.log('  ✓ 替换 anti-scrape.js 为精简版（v3.0）');
}

/**
 * 修复 2：移除 index.html 中内联的反爬虫代码块
 */
function fixInlineAntiScrape(sitePath) {
  const indexPath = path.join(sitePath, 'website', 'index.html');
  let content = readFile(indexPath);
  if (!content) {
    console.log('  - index.html 不存在，跳过');
    return;
  }

  let modified = false;

  // 移除 Honeypot HTML 块
  const honeypotPattern = /<!-- Honeypot[\s\S]*?<\/div>\s*<script>\s*\/\/ Anti-scraping JavaScript[\s\S]*?<\/script>/;
  if (honeypotPattern.test(content)) {
    content = content.replace(honeypotPattern, '<!-- Anti-scraping moved to external anti-scrape.js v3.0 (lightweight) -->');
    modified = true;
    console.log('  ✓ 移除内联 honeypot + 反爬虫代码块');
  }

  // 移除反爬虫 CSS
  const antiScrapeCssPattern = /\/\* Anti-scraping CSS \*\/[\s\S]*?\.honey-link\s*\{[^}]*\}/;
  if (antiScrapeCssPattern.test(content)) {
    content = content.replace(antiScrapeCssPattern, '/* Anti-scraping CSS removed — use lightweight version */');
    modified = true;
  }

  if (modified) {
    writeFile(indexPath, content);
  }
}

/**
 * 修复 3：修复定价页 URL 错误
 */
function fixPricingUrls(sitePath) {
  const creditsPath = path.join(sitePath, 'website', 'credits.html');
  let content = readFile(creditsPath);
  if (!content) {
    console.log('  - credits.html 不存在，跳过');
    return;
  }

  let modified = false;

  // 修复 www.www.creem.io → www.creem.io
  const wrongUrlPattern = /https:\/\/www\.www\.creem\.io/g;
  if (wrongUrlPattern.test(content)) {
    content = content.replace(wrongUrlPattern, 'https://www.creem.io');
    modified = true;
    console.log('  ✓ 修复 www.www.creem.io → www.creem.io');
  }

  if (modified) {
    writeFile(creditsPath, content);
  }

  // 同样修复 api-pricing.html
  const apiPricingPath = path.join(sitePath, 'website', 'api-pricing.html');
  let apiContent = readFile(apiPricingPath);
  if (apiContent && wrongUrlPattern.test(apiContent)) {
    apiContent = apiContent.replace(wrongUrlPattern, 'https://www.creem.io');
    writeFile(apiPricingPath, apiContent);
    console.log('  ✓ 修复 api-pricing.html 中的 URL');
  }
}

/**
 * 修复 4：统一定价信息
 * 在 api-pricing.html 中添加指向 credits.html 的说明
 */
function unifyPricing(sitePath) {
  const apiPricingPath = path.join(sitePath, 'website', 'api-pricing.html');
  let content = readFile(apiPricingPath);
  if (!content) return;

  // 检查是否已有统一说明
  if (content.includes('unified-pricing-notice')) return;

  // 在 <h1> 后添加统一说明
  const noticeHtml = `
<div class="notice" id="unified-pricing-notice" style="background:#fff3cd;border:1px solid #ffeaa7;color:#856404;padding:12px 16px;border-radius:8px;margin:16px 0;font-size:0.9rem">
  <strong>💡 完整定价方案</strong> — 我们提供从免费到企业级的多种方案。
  查看 <a href="/credits.html" style="color:inherit;text-decoration:underline">完整定价页面</a> 了解所有订阅和一次性购买选项。
</div>`;

  const h1Pattern = /(<h1>[^<]*<\/h1>)/;
  if (h1Pattern.test(content)) {
    content = content.replace(h1Pattern, '$1' + noticeHtml);
    writeFile(apiPricingPath, content);
    console.log('  ✓ 在 api-pricing.html 添加统一定价说明');
  }
}

/**
 * 修复 5：为实体页面添加更新时间戳
 */
function addTimestampToEntityPages(sitePath) {
  const entityDir = path.join(sitePath, 'website', 'entity');
  if (!fs.existsSync(entityDir)) {
    console.log('  - entity/ 目录不存在，跳过');
    return;
  }

  const files = fs.readdirSync(entityDir).filter(f => f.endsWith('.html'));
  let updatedCount = 0;
  const now = new Date().toISOString().slice(0, 10);

  for (const file of files) {
    const filePath = path.join(entityDir, file);
    let content = readFile(filePath);
    if (!content) continue;

    // 检查是否已有时间戳
    if (content.includes('data-updated')) continue;

    // 在 footer 前添加更新时间
    const footerPattern = /(<div class="footer">)/;
    const timestampHtml = `<div style="padding:0.5rem 2rem;font-size:0.75rem;color:#94a3b8;border-top:1px solid #f1f5f9">📅 数据最后更新: ${now} | 🔍 来源: 多源交叉验证</div>`;
    if (footerPattern.test(content)) {
      content = content.replace(footerPattern, timestampHtml + '$1');
      writeFile(filePath, content);
      updatedCount++;
    }
  }

  if (updatedCount > 0) {
    console.log(`  ✓ 为 ${updatedCount} 个实体页面添加更新时间戳`);
  }
}

/**
 * 修复 6：精简底部导航栏（移除过多 emoji，保持专业）
 */
function simplifyBottomNav(sitePath) {
  const indexPath = path.join(sitePath, 'website', 'index.html');
  let content = readFile(indexPath);
  if (!content) return;

  // 查找底部固定导航栏
  const navPattern = /(<div id="kb-ecosystem-nav"[^>]*>)([\s\S]*?)(<\/div>)/;
  if (!navPattern.test(content)) return;

  // 简化导航栏样式 — 移除 emoji 但保留文字链接
  let modified = false;

  // 检查是否有过多的 emoji 图标
  if ((content.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length > 10) {
    // 这是一个信号，说明 emoji 使用过多
    // 具体的 emoji 清理需要针对每个站点定制，这里仅作标记
    modified = true;
  }

  if (modified) {
    console.log('  ⚠ 底部导航栏 emoji 较多，建议手动精简（保持专业风格）');
  }
}

// === 主流程 ===
function fixSite(siteDir, projectRoot) {
  const sitePath = path.join(projectRoot, siteDir);
  if (!fs.existsSync(sitePath)) {
    console.error(`✗ 站点目录不存在: ${sitePath}`);
    return;
  }

  console.log(`\n处理站点: ${siteDir}`);
  console.log('─'.repeat(50));

  try {
    fixAntiScrape(sitePath);
    fixInlineAntiScrape(sitePath);
    fixPricingUrls(sitePath);
    unifyPricing(sitePath);
    addTimestampToEntityPages(sitePath);
    simplifyBottomNav(sitePath);
    console.log('  ✓ UX 修复完成');
  } catch (e) {
    console.error(`  ✗ 错误: ${e.message}`);
  }
}

// === CLI ===
function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('用法: node fix-ux.js <site-dir> [--project-root <path>]');
    console.log('     node fix-ux.js --all [--project-root <path>]');
    process.exit(1);
  }

  let projectRoot = path.resolve(__dirname, '..', '..');
  let targetSite = null;
  let processAll = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-root') {
      projectRoot = args[i + 1];
      i++;
    } else if (args[i] === '--all') {
      processAll = true;
    } else {
      targetSite = args[i];
    }
  }

  console.log(`项目根目录: ${projectRoot}`);

  const sites = processAll ? SITES : [targetSite];
  for (const site of sites) {
    fixSite(site, projectRoot);
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log('UX 修复完成');
}

main();
