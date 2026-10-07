#!/usr/bin/env node
/**
 * GeneTech 14站知识引擎 — 修复主脚本
 *
 * 一键执行所有修复操作，按依赖顺序运行各修复模块。
 *
 * 用法：
 *   node apply-all.js [--dry-run] [--only=security|api|data|ux|automation|monitoring]
 *   node apply-all.js                # 执行全部修复
 *   node apply-all.js --dry-run      # 仅预览，不实际修改
 *   node apply-all.js --only=data    # 只执行数据一致性修复
 *
 * 环境变量：
 *   PROJECT_ROOT  项目根目录（默认自动推断）
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// ============================================================
// 配置
// ============================================================

const FIXES_DIR = __dirname;
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(FIXES_DIR, '..');

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

// 修复模块定义（按依赖顺序）
const MODULES = [
  {
    id: 'security',
    name: '安全修复',
    description: '凭证轮换、环境变量模板、gitignore 配置',
    files: ['security/.env.example', 'security/.gitignore', 'security/rotate-credentials.md', 'security/CREDENTIALS.md.template'],
    apply: applySecurityFixes,
  },
  {
    id: 'api',
    name: 'API 网关',
    description: 'Cloudflare Worker 认证与限流',
    files: ['api-gateway/worker.js', 'api-gateway/wrangler.toml', 'api-gateway/README.md'],
    apply: applyApiGateway,
  },
  {
    id: 'data',
    name: '数据一致性',
    description: '实体计数修复、置信度、溯源追踪',
    files: ['data-integrity/fix-data-consistency.js'],
    apply: applyDataIntegrity,
  },
  {
    id: 'ux',
    name: 'UX 修复',
    description: '反爬虫优化、定价 URL 修复、时间戳',
    files: ['ux-fixes/anti-scrape.js', 'ux-fixes/fix-ux.js'],
    apply: applyUxFixes,
  },
  {
    id: 'automation',
    name: '自动化',
    description: '路径可移植性、CI/CD 流水线',
    files: ['automation/fix-portability.js', 'automation/ci-cd.yml', 'automation/security-scan.yml'],
    apply: applyAutomation,
  },
  {
    id: 'monitoring',
    name: '监控',
    description: '健康检查、告警系统',
    files: ['monitoring/health-check.js'],
    apply: applyMonitoring,
  },
];

// ============================================================
// 工具函数
// ============================================================

function log(msg, color = 'reset') {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${COLORS.gray}[${ts}]${COLORS.reset} ${COLORS[color]}${msg}${COLORS.reset}`);
}

function logStep(msg) {
  log(`▶ ${msg}`, 'cyan');
}

function logOk(msg) {
  log(`✓ ${msg}`, 'green');
}

function logWarn(msg) {
  log(`⚠ ${msg}`, 'yellow');
}

function logError(msg) {
  log(`✗ ${msg}`, 'red');
}

function fileExists(p) {
  return fs.existsSync(p);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyTemplate(src, dest, replacements = {}) {
  if (!fileExists(src)) {
    logWarn(`模板不存在: ${src}`);
    return false;
  }
  let content = fs.readFileSync(src, 'utf8');
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replace(new RegExp(key, 'g'), value);
  }
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, content);
  return true;
}

function runScript(scriptPath, args = []) {
  const cmd = `node "${scriptPath}" ${args.join(' ')}`;
  try {
    const result = spawnSync('node', [scriptPath, ...args], {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, PROJECT_ROOT },
    });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    return result.status === 0;
  } catch (err) {
    logError(`脚本执行失败: ${err.message}`);
    return false;
  }
}

// ============================================================
// 各模块应用函数
// ============================================================

function applySecurityFixes(dryRun) {
  logStep('应用安全修复');
  if (dryRun) {
    log('  [DRY-RUN] 将创建 .env.example、.gitignore、rotate-credentials.md', 'gray');
    return true;
  }

  // 1. 复制 .env.example 到项目根
  const envExample = path.join(FIXES_DIR, 'security', '.env.example');
  const targetEnv = path.join(PROJECT_ROOT, '.env.example');
  if (copyTemplate(envExample, targetEnv)) {
    logOk(`创建 ${path.relative(PROJECT_ROOT, targetEnv)}`);
  }

  // 2. 合并 .gitignore
  const gitignoreSrc = path.join(FIXES_DIR, 'security', '.gitignore');
  const gitignoreDest = path.join(PROJECT_ROOT, '.gitignore');
  if (fileExists(gitignoreDest)) {
    const existing = fs.readFileSync(gitignoreDest, 'utf8');
    const additions = fs.readFileSync(gitignoreSrc, 'utf8');
    const lines = additions.split('\n').filter((l) => l.trim() && !existing.includes(l));
    if (lines.length > 0) {
      fs.appendFileSync(gitignoreDest, '\n# 安全修复追加\n' + lines.join('\n') + '\n');
      logOk(`追加 ${lines.length} 行到 .gitignore`);
    } else {
      log('  .gitignore 已包含所有规则', 'gray');
    }
  } else {
    copyTemplate(gitignoreSrc, gitignoreDest);
    logOk('创建 .gitignore');
  }

  // 3. 复制凭证轮换指南
  const rotateGuide = path.join(FIXES_DIR, 'security', 'rotate-credentials.md');
  const targetGuide = path.join(PROJECT_ROOT, 'docs', 'rotate-credentials.md');
  if (copyTemplate(rotateGuide, targetGuide)) {
    logOk(`创建 ${path.relative(PROJECT_ROOT, targetGuide)}`);
  }

  // 4. 检查 CREDENTIALS.md 是否仍存在
  const credFile = path.join(PROJECT_ROOT, 'CREDENTIALS.md');
  if (fileExists(credFile)) {
    logWarn('CREDENTIALS.md 仍存在！请按 rotate-credentials.md 指南处理');
  }

  return true;
}

function applyApiGateway(dryRun) {
  logStep('应用 API 网关');
  if (dryRun) {
    log('  [DRY-RUN] 将部署 Cloudflare Worker API 网关', 'gray');
    return true;
  }

  const workerSrc = path.join(FIXES_DIR, 'api-gateway', 'worker.js');
  const targetDir = path.join(PROJECT_ROOT, 'api-gateway');
  ensureDir(targetDir);

  if (copyTemplate(workerSrc, path.join(targetDir, 'worker.js'))) {
    logOk('部署 worker.js');
  }
  if (copyTemplate(path.join(FIXES_DIR, 'api-gateway', 'wrangler.toml'), path.join(targetDir, 'wrangler.toml'))) {
    logOk('部署 wrangler.toml');
  }
  if (copyTemplate(path.join(FIXES_DIR, 'api-gateway', 'README.md'), path.join(targetDir, 'README.md'))) {
    logOk('部署 README.md');
  }

  log('  提示: 运行 `npx wrangler deploy` 部署到 Cloudflare', 'gray');
  return true;
}

function applyDataIntegrity(dryRun) {
  logStep('修复数据一致性');
  const script = path.join(FIXES_DIR, 'data-integrity', 'fix-data-consistency.js');
  if (!fileExists(script)) {
    logError(`脚本不存在: ${script}`);
    return false;
  }
  if (dryRun) {
    log('  [DRY-RUN] 将运行数据一致性修复脚本', 'gray');
    return true;
  }
  return runScript(script, ['--all', '--project-root', PROJECT_ROOT]);
}

function applyUxFixes(dryRun) {
  logStep('应用 UX 修复');

  // 1. 反爬虫脚本部署到 static/js
  const antiScrapeSrc = path.join(FIXES_DIR, 'ux-fixes', 'anti-scrape.js');
  const staticJsDir = path.join(PROJECT_ROOT, 'static', 'js');
  if (fileExists(antiScrapeSrc)) {
    if (dryRun) {
      log('  [DRY-RUN] 将部署 anti-scrape.js', 'gray');
    } else {
      ensureDir(staticJsDir);
      copyTemplate(antiScrapeSrc, path.join(staticJsDir, 'anti-scrape.js'));
      logOk('部署 anti-scrape.js');
    }
  }

  // 2. 运行 UX 修复脚本
  const fixUxScript = path.join(FIXES_DIR, 'ux-fixes', 'fix-ux.js');
  if (fileExists(fixUxScript)) {
    if (dryRun) {
      log('  [DRY-RUN] 将运行 UX 修复脚本', 'gray');
    } else {
      runScript(fixUxScript, ['--project-root', PROJECT_ROOT]);
    }
  }

  return true;
}

function applyAutomation(dryRun) {
  logStep('应用自动化修复');

  // 1. 运行可移植性修复
  const portScript = path.join(FIXES_DIR, 'automation', 'fix-portability.js');
  if (fileExists(portScript)) {
    if (dryRun) {
      log('  [DRY-RUN] 将运行路径可移植性修复', 'gray');
    } else {
      runScript(portScript, ['--project-root', PROJECT_ROOT]);
    }
  }

  // 2. 部署 CI/CD 工作流
  const ciSrc = path.join(FIXES_DIR, 'automation', 'ci-cd.yml');
  const secScanSrc = path.join(FIXES_DIR, 'automation', 'security-scan.yml');
  const ghDir = path.join(PROJECT_ROOT, '.github', 'workflows');
  if (dryRun) {
    log('  [DRY-RUN] 将部署 CI/CD 工作流', 'gray');
  } else {
    ensureDir(ghDir);
    if (fileExists(ciSrc)) {
      copyTemplate(ciSrc, path.join(ghDir, 'ci-cd.yml'));
      logOk('部署 .github/workflows/ci-cd.yml');
    }
    if (fileExists(secScanSrc)) {
      copyTemplate(secScanSrc, path.join(ghDir, 'security-scan.yml'));
      logOk('部署 .github/workflows/security-scan.yml');
    }
  }

  return true;
}

function applyMonitoring(dryRun) {
  logStep('部署监控系统');
  const script = path.join(FIXES_DIR, 'monitoring', 'health-check.js');
  if (!fileExists(script)) {
    logError(`脚本不存在: ${script}`);
    return false;
  }
  if (dryRun) {
    log('  [DRY-RUN] 将部署健康检查脚本', 'gray');
    return true;
  }

  const monDir = path.join(PROJECT_ROOT, 'scripts', 'monitoring');
  ensureDir(monDir);
  if (copyTemplate(script, path.join(monDir, 'health-check.js'))) {
    logOk('部署 health-check.js');
  }
  log('  提示: 配置定时任务运行 `node scripts/monitoring/health-check.js --all`', 'gray');
  return true;
}

// ============================================================
// 主流程
// ============================================================

function printBanner() {
  console.log(`
${COLORS.bold}${COLORS.cyan}╔═══════════════════════════════════════════════════════════╗
║   GeneTech 14站知识引擎 — 修复工具 v1.0                       ║
║   一键执行安全、API、数据、UX、自动化、监控修复              ║
╚═══════════════════════════════════════════════════════════╝${COLORS.reset}
  `);
}

function printSummary(results) {
  console.log('\n' + '─'.repeat(60));
  log('修复执行摘要', 'bold');
  console.log('─'.repeat(60));
  for (const r of results) {
    const status = r.success ? `${COLORS.green}✓ 成功${COLORS.reset}` : `${COLORS.red}✗ 失败${COLORS.reset}`;
    console.log(`  ${status}  ${r.id.padEnd(12)} ${r.name}`);
  }
  const successCount = results.filter((r) => r.success).length;
  const totalCount = results.length;
  console.log('─'.repeat(60));
  const summaryColor = successCount === totalCount ? 'green' : 'yellow';
  log(`总计: ${successCount}/${totalCount} 模块成功`, summaryColor);
  console.log();
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const onlyModule = onlyArg ? onlyArg.split('=')[1] : null;

  printBanner();

  if (dryRun) log('运行模式: DRY-RUN（仅预览）', 'yellow');
  log(`项目根目录: ${PROJECT_ROOT}`, 'gray');
  console.log();

  // 验证项目根目录
  if (!fileExists(PROJECT_ROOT)) {
    logError(`项目根目录不存在: ${PROJECT_ROOT}`);
    process.exit(1);
  }

  // 选择要执行的模块
  const modulesToRun = onlyModule
    ? MODULES.filter((m) => m.id === onlyModule)
    : MODULES;

  if (modulesToRun.length === 0) {
    logError(`未找到模块: ${onlyModule}`);
    log(`可用模块: ${MODULES.map((m) => m.id).join(', ')}`, 'gray');
    process.exit(1);
  }

  log(`将执行 ${modulesToRun.length} 个模块:`, 'cyan');
  for (const m of modulesToRun) {
    console.log(`  • ${COLORS.bold}${m.name}${COLORS.reset} — ${m.description}`);
  }
  console.log();

  // 执行各模块
  const results = [];
  for (const mod of modulesToRun) {
    console.log(`\n${COLORS.bold}━━━ ${mod.name} ━━━${COLORS.reset}`);
    try {
      const success = mod.apply(dryRun);
      results.push({ id: mod.id, name: mod.name, success });
      if (!success) {
        logWarn(`${mod.name} 执行失败，继续下一个模块`);
      }
    } catch (err) {
      logError(`${mod.name} 异常: ${err.message}`);
      results.push({ id: mod.id, name: mod.name, success: false });
    }
  }

  printSummary(results);

  const allSuccess = results.every((r) => r.success);
  process.exit(allSuccess ? 0 : 1);
}

main();
