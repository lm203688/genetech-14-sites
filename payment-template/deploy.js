#!/usr/bin/env node

/**
 * 通用支付模板部署脚本
 *
 * 功能：
 *   1. 读取模板目录中的所有文件
 *   2. 将 __PLACEHOLDER__ 占位符替换为实际值
 *   3. 输出到目标部署目录
 *
 * 用法：
 *   node deploy.js --site=agent-ecosystem --domain=https://agent.genetech.io --products=prod_aaa,prod_bbb,prod_ccc
 *
 * 可选参数：
 *   --out=./deployed/agent-ecosystem   输出目录（默认：./deployed/<site>）
 *   --kv-api-keys=xxx                  API_KEYS 命名空间 ID
 *   --kv-credits=xxx                   USER_CREDITS 命名空间 ID
 *   --kv-history=xxx                   USER_CREDIT_HISTORY 命名空间 ID
 *   --deploy                           替换完成后自动运行 wrangler pages deploy
 *
 * 示例（完整）：
 *   node deploy.js \
 *     --site=agent-ecosystem \
 *     --domain=https://agent.genetech.io \
 *     --products=prod_aaa,prod_bbb,prod_ccc \
 *     --kv-api-keys=abc123 \
 *     --kv-credits=def456 \
 *     --kv-history=ghi789 \
 *     --out=./deployed/agent-ecosystem \
 *     --deploy
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// === 参数解析 ===
function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    if (arg.startsWith('--')) {
      const [key, ...valueParts] = arg.slice(2).split('=');
      args[key] = valueParts.join('=') || true;
    }
  });
  return args;
}

// === 递归遍历目录 ===
function walkDir(dir) {
  let results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 跳过 node_modules 和 .git
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      results = results.concat(walkDir(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

// === 替换占位符 ===
function replacePlaceholders(content, replacements) {
  let result = content;
  for (const [placeholder, value] of Object.entries(replacements)) {
    // 全局替换所有出现的占位符
    result = result.split(placeholder).join(value);
  }
  return result;
}

// === 确保目录存在 ===
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// === 主流程 ===
function main() {
  const args = parseArgs();

  // 必需参数校验
  const site = args.site;
  let domain = args.domain || '';
  const products = (args.products || '').split(',').map((p) => p.trim()).filter(Boolean);

  if (!site) {
    console.error('错误：缺少 --site 参数（站点名称）');
    console.error('用法：node deploy.js --site=<name> --domain=<url> --products=<id1>,<id2>,<id3>');
    process.exit(1);
  }

  if (!domain) {
    console.error('错误：缺少 --domain 参数（站点域名）');
    console.error('示例：--domain=https://agent.genetech.io');
    process.exit(1);
  }

  if (products.length < 3) {
    console.error('错误：--products 需要提供 3 个产品 ID（Starter, Pro, Lifetime），用逗号分隔');
    console.error('示例：--products=prod_aaa,prod_bbb,prod_ccc');
    process.exit(1);
  }

  // 规范化域名（确保包含协议）
  if (!domain.startsWith('http://') && !domain.startsWith('https://')) {
    domain = 'https://' + domain;
  }
  // 移除尾部斜杠
  domain = domain.replace(/\/+$/, '');

  // 输出目录
  const outDir = args.out || path.join(__dirname, 'deployed', site);

  // 构建替换映射
  const replacements = {
    __SITE_NAME__: site,
    __SITE_DOMAIN__: domain,
    __PRODUCT_STARTER__: products[0],
    __PRODUCT_PRO__: products[1],
    __PRODUCT_LIFETIME__: products[2],
  };

  // KV 命名空间 ID（可选）
  if (args['kv-api-keys']) replacements.__KV_API_KEYS_ID__ = args['kv-api-keys'];
  if (args['kv-credits']) replacements.__KV_USER_CREDITS_ID__ = args['kv-credits'];
  if (args['kv-history']) replacements.__KV_HISTORY_ID__ = args['kv-history'];

  console.log('========================================');
  console.log('  通用支付模板部署');
  console.log('========================================');
  console.log('  站点名称：' + site);
  console.log('  站点域名：' + domain);
  console.log('  Starter 产品 ID：' + products[0]);
  console.log('  Pro 产品 ID：    ' + products[1]);
  console.log('  Lifetime 产品 ID：' + products[2]);
  console.log('  输出目录：' + outDir);
  console.log('========================================\n');

  // 模板目录（本脚本所在目录）
  const templateDir = __dirname;

  // 遍历模板文件
  const files = walkDir(templateDir);
  const deployFiles = files.filter(
    (f) =>
      !f.includes(path.join('deployed')) && // 排除已部署目录
      !path.basename(f).startsWith('deploy.js') && // 排除自身
      !f.includes('node_modules')
  );

  let processed = 0;
  for (const file of deployFiles) {
    // 计算相对路径
    const relPath = path.relative(templateDir, file);
    const outPath = path.join(outDir, relPath);

    // 确保输出子目录存在
    ensureDir(path.dirname(outPath));

    // 读取文件内容
    const content = fs.readFileSync(file, 'utf-8');

    // 替换占位符
    const processedContent = replacePlaceholders(content, replacements);

    // 写入输出文件
    fs.writeFileSync(outPath, processedContent, 'utf-8');
    processed++;
    console.log('  [OK] ' + relPath);
  }

  console.log('\n========================================');
  console.log('  替换完成！共处理 ' + processed + ' 个文件');
  console.log('  输出目录：' + outDir);
  console.log('========================================\n');

  // 检查是否有未替换的占位符
  const allFiles = walkDir(outDir);
  let unresolved = 0;
  for (const file of allFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const matches = content.match(/__[A-Z_]+__/g);
    if (matches) {
      const unique = [...new Set(matches)];
      for (const m of unique) {
        if (!replacements[m]) {
          console.warn('  [警告] 未替换的占位符：' + m + ' （在 ' + path.relative(outDir, file) + ' 中）');
          unresolved++;
        }
      }
    }
  }

  if (unresolved > 0) {
    console.warn('\n  共 ' + unresolved + ' 个占位符未替换，请手动处理或提供相应参数。');
    console.warn('  提示：KV 命名空间 ID 可通过 --kv-api-keys, --kv-credits, --kv-history 参数提供。');
  } else {
    console.log('  所有占位符均已成功替换。');
  }

  // 自动部署
  if (args.deploy) {
    console.log('\n========================================');
    console.log('  开始部署到 Cloudflare Pages...');
    console.log('========================================\n');

    try {
      const cmd = 'npx wrangler pages deploy "' + outDir + '" --project-name ' + site;
      console.log('  执行命令：' + cmd + '\n');
      execSync(cmd, { stdio: 'inherit', cwd: outDir });
      console.log('\n  部署成功！');
    } catch (e) {
      console.error('\n  部署失败：' + e.message);
      console.error('  请确保已安装 wrangler 并登录（npx wrangler login）');
      process.exit(1);
    }
  } else {
    console.log('\n  下一步操作：');
    console.log('  1. cd ' + outDir);
    console.log('  2. 在 Cloudflare Dashboard 创建 3 个 KV 命名空间');
    console.log('  3. 将 KV ID 填入 wrangler.toml（或重新运行本脚本并传入 --kv-* 参数）');
    console.log('  4. 在 Cloudflare Pages 设置中配置环境变量 CREEM_WEBHOOK_SECRET');
    console.log('  5. npx wrangler pages deploy . --project-name ' + site);
  }

  console.log('');
}

main();
