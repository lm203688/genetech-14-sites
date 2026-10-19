#!/usr/bin/env node
/**
 * 可移植性修复脚本
 *
 * 解决问题：
 * 1. rebuild.js 和 build-entity-pages.js 中硬编码的路径 /home/z/my-project
 * 2. 添加环境变量支持，使脚本可在任何机器上运行
 * 3. 添加路径自动检测逻辑
 *
 * 用法：
 *   node fix-portability.js --project-root <path>
 */

const fs = require('fs');
const path = require('path');

// 需要修复的硬编码路径
const HARDCODED_PATTERNS = [
  {
    pattern: /\/home\/z\/my-project/g,
    replacement: 'process.env.PROJECT_ROOT || path.resolve(__dirname, "..", "..")'
  },
  {
    pattern: /const BASE = '\/home\/z\/my-project'/g,
    replacement: "const BASE = process.env.PROJECT_ROOT || path.resolve(__dirname, '..', '..');"
  },
  {
    pattern: /const PROJECT_ROOT = '\/home\/z\/my-project'/g,
    replacement: "const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '..', '..');"
  }
];

// 需要处理的脚本文件列表
const SCRIPT_FILES = [
  'kb-workflow/scripts/build-entity-pages.js',
  'kb-workflow/deep-mine/rebuild.js',
  'kb-workflow/deep-mine/mine.js',
  'kb-workflow/deep-mine/mine-one.js',
  'kb-workflow/deep-mine/mine-robust.js',
  'kb-workflow/deep-mine/mine-saturday.js',
  'kb-workflow/deep-mine/mine-tuesday-v2.js',
  'kb-workflow/deep-mine/mine-tuesday-v3.js',
  'kb-workflow/deep-mine/process-one.js',
  'kb-workflow/deep-mine/process-saturday.js',
  'kb-workflow/deep-mine/llm-extract.js',
  'kb-workflow/scripts/add-agent-api.js',
  'kb-workflow/scripts/add-anti-scraping.js',
  'kb-workflow/scripts/add-geo.js',
  'kb-workflow/scripts/add-monetization.js',
  'kb-workflow/scripts/batch-add-entities.js',
  'kb-workflow/scripts/build-llms-txt.js',
  'kb-workflow/scripts/generate-atlas.js',
  'kb-workflow/scripts/generate-compass.js',
  'kb-workflow/scripts/generate-usage.js',
  'kb-workflow/scripts/generate-workflows.js',
  'kb-workflow/scripts/launch-kb.js',
  'kb-workflow/scripts/monetize-optimize.js',
  'kb-workflow/scripts/niche-scout.js',
  'kb-workflow/scripts/search-breakthroughs.js',
  'kb-workflow/scripts/single-search.js',
  'kb-workflow/scripts/tcm-create-base-entities.js',
  'kb-workflow/agent-layer/upgrade-agent-discovery.js',
];

function fixFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  let content = fs.readFileSync(filePath, 'utf-8');
  let modified = false;

  for (const { pattern, replacement } of HARDCODED_PATTERNS) {
    if (pattern.test(content)) {
      // 对于直接赋值的模式，直接替换
      content = content.replace(pattern, replacement);
      modified = true;
    }
  }

  // 检查是否需要添加 path require
  if (modified && !content.includes("require('path')") && !content.includes('require("path")')) {
    // 在第一个 require 后添加 path
    const requireMatch = content.match(/const\s+(\w+)\s*=\s*require\(['"][^'"]+['"]\)/);
    if (requireMatch) {
      content = content.replace(
        requireMatch[0],
        requireMatch[0] + "\nconst path = require('path');"
      );
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  return modified;
}

function main() {
  const args = process.argv.slice(2);
  let projectRoot = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-root') {
      projectRoot = args[i + 1];
      i++;
    }
  }

  if (!projectRoot) {
    console.log('用法: node fix-portability.js --project-root <path>');
    console.log('');
    console.log('示例:');
    console.log('  node fix-portability.js --project-root /c/Users/xing/Desktop/genetech14_package');
    console.log('  node fix-portability.js --project-root C:\\Users\\xing\\genetech14_package');
    process.exit(1);
  }

  projectRoot = path.resolve(projectRoot);
  console.log(`项目根目录: ${projectRoot}`);
  console.log('');

  let fixedCount = 0;
  let skippedCount = 0;
  let notFoundCount = 0;

  for (const relPath of SCRIPT_FILES) {
    const fullPath = path.join(projectRoot, relPath);

    if (!fs.existsSync(fullPath)) {
      notFoundCount++;
      continue;
    }

    const modified = fixFile(fullPath);
    if (modified) {
      console.log(`  ✓ 修复: ${relPath}`);
      fixedCount++;
    } else {
      console.log(`  - 跳过（无硬编码）: ${relPath}`);
      skippedCount++;
    }
  }

  console.log('');
  console.log('═'.repeat(50));
  console.log(`修复完成: ${fixedCount} 个文件已修复, ${skippedCount} 个跳过, ${notFoundCount} 个未找到`);
  console.log('');
  console.log('下一步:');
  console.log('  1. 设置环境变量: $env:PROJECT_ROOT = "' + projectRoot + '"');
  console.log('  2. 测试脚本: node ' + path.join(projectRoot, 'kb-workflow/deep-mine/rebuild.js'));
}

main();
