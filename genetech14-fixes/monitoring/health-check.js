#!/usr/bin/env node
/**
 * GeneTech 14站知识引擎 — 健康检查与监控系统
 *
 * 功能：
 *   1. 检查 14 个站点的可用性（HTTP 状态码 + 响应时间）
 *   2. 检查 API 端点的健康状态
 *   3. 检查数据完整性（实体计数一致性）
 *   4. 检查安全状态（CREDENTIALS.md 是否存在、.env 是否泄漏）
 *   5. 生成健康报告（JSON + HTML）
 *   6. 支持告警 webhook（飞书/钉钉/Slack）
 *
 * 用法：
 *   node health-check.js [--sites] [--api] [--data] [--security] [--all]
 *   node health-check.js --all --alert
 *
 * 环境变量：
 *   SITES_BASE_URL    站点根 URL（默认 https://genetech14.pages.dev）
 *   API_BASE_URL      API 根 URL（默认同 SITES_BASE_URL）
 *   ALERT_WEBHOOK     告警 webhook 地址（可选）
 *   PROJECT_ROOT      项目根目录（默认自动推断）
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ============================================================
// 配置
// ============================================================

const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '..', '..');
const SITES_BASE_URL = process.env.SITES_BASE_URL || 'https://genetech14.pages.dev';
const API_BASE_URL = process.env.API_BASE_URL || SITES_BASE_URL;
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK || '';

// 14 个站点清单
const SITES = [
  { id: 'ai-agents', name: 'AI Agents 站', path: '/ai-agents/' },
  { id: 'mcp', name: 'MCP 站', path: '/mcp/' },
  { id: 'agent-ecosystem', name: 'Agent 生态站', path: '/agent-ecosystem/' },
  { id: 'llm', name: 'LLM 站', path: '/llm/' },
  { id: 'rag', name: 'RAG 站', path: '/rag/' },
  { id: 'prompt', name: 'Prompt 工程站', path: '/prompt/' },
  { id: 'fine-tuning', name: '微调站', path: '/fine-tuning/' },
  { id: 'evaluation', name: '评测站', path: '/evaluation/' },
  { id: 'safety', name: '安全站', path: '/safety/' },
  { id: 'multimodal', name: '多模态站', path: '/multimodal/' },
  { id: 'tools', name: '工具站', path: '/tools/' },
  { id: 'datasets', name: '数据集站', path: '/datasets/' },
  { id: 'papers', name: '论文站', path: '/papers/' },
  { id: 'community', name: '社区站', path: '/community/' },
];

// API 端点清单
const API_ENDPOINTS = [
  { path: '/api/health', expected: 200, name: '健康检查' },
  { path: '/api/entities', expected: 200, name: '实体列表', requiresAuth: true },
  { path: '/api/search', expected: 200, name: '搜索', requiresAuth: true },
];

// 告警阈值
const THRESHOLDS = {
  responseTimeMs: 3000,     // 响应时间告警阈值
  uptimePercent: 99.0,      // 可用率告警阈值
  maxDataInconsistency: 0,  // 数据不一致最大允许数
};

// ============================================================
// 工具函数
// ============================================================

function fetch(url, options = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, options, (res) => {
      const startTime = Date.now();
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
          responseTime: Date.now() - startTime,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`请求超时: ${url}`));
    });
  });
}

function log(level, msg) {
  const ts = new Date().toISOString();
  const prefix = { info: 'ℹ', ok: '✓', warn: '⚠', error: '✗' }[level] || ' ';
  console.log(`[${ts}] ${prefix} ${msg}`);
}

function severity(status) {
  return status === 'ok' ? 'success' : status === 'warn' ? 'warning' : 'danger';
}

// ============================================================
// 检查器
// ============================================================

async function checkSites() {
  log('info', `开始检查 ${SITES.length} 个站点...`);
  const results = [];
  for (const site of SITES) {
    const url = SITES_BASE_URL + site.path;
    try {
      const res = await fetch(url);
      const ok = res.status === 200;
      const slow = res.responseTime > THRESHOLDS.responseTimeMs;
      const status = ok ? (slow ? 'warn' : 'ok') : 'error';
      log(status === 'ok' ? 'ok' : status, `${site.name}: ${res.status} (${res.responseTime}ms)`);
      results.push({
        id: site.id,
        name: site.name,
        url,
        status,
        httpStatus: res.status,
        responseTime: res.responseTime,
        message: ok
          ? (slow ? `响应缓慢 ${res.responseTime}ms` : '正常')
          : `HTTP ${res.status}`,
      });
    } catch (err) {
      log('error', `${site.name}: ${err.message}`);
      results.push({
        id: site.id,
        name: site.name,
        url,
        status: 'error',
        httpStatus: 0,
        responseTime: 0,
        message: err.message,
      });
    }
  }
  return results;
}

async function checkApiEndpoints() {
  log('info', `开始检查 ${API_ENDPOINTS.length} 个 API 端点...`);
  const results = [];
  for (const ep of API_ENDPOINTS) {
    const url = API_BASE_URL + ep.path;
    try {
      const headers = {};
      if (ep.requiresAuth) {
        headers.Authorization = `Bearer ${process.env.API_KEY || 'test'}`;
      }
      const res = await fetch(url, { headers });
      // 认证端点返回 401 视为"服务在线但需认证"
      const serviceOk = res.status === ep.expected || (ep.requiresAuth && res.status === 401);
      const status = serviceOk ? 'ok' : 'error';
      log(status === 'ok' ? 'ok' : 'error', `${ep.name}: ${res.status}`);
      results.push({
        path: ep.path,
        name: ep.name,
        url,
        status,
        httpStatus: res.status,
        expected: ep.expected,
        message: serviceOk ? '正常' : `期望 ${ep.expected}，实际 ${res.status}`,
      });
    } catch (err) {
      log('error', `${ep.name}: ${err.message}`);
      results.push({
        path: ep.path,
        name: ep.name,
        url,
        status: 'error',
        httpStatus: 0,
        message: err.message,
      });
    }
  }
  return results;
}

function checkDataIntegrity() {
  log('info', '检查数据完整性...');
  const issues = [];
  const entitiesDir = path.join(PROJECT_ROOT, 'entities');
  if (!fs.existsSync(entitiesDir)) {
    log('warn', 'entities 目录不存在，跳过数据完整性检查');
    return [{ check: 'entities-dir', status: 'warn', message: 'entities 目录不存在' }];
  }

  // 检查每个领域的实体计数一致性
  const domains = fs.readdirSync(entitiesDir).filter((d) =>
    fs.statSync(path.join(entitiesDir, d)).isDirectory()
  );
  for (const domain of domains) {
    const domainDir = path.join(entitiesDir, domain);
    const indexFile = path.join(domainDir, 'index.json');
    if (!fs.existsSync(indexFile)) {
      issues.push({
        check: 'index-exists',
        domain,
        status: 'warn',
        message: `${domain}/index.json 不存在`,
      });
      continue;
    }
    try {
      const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      const entityFiles = fs.readdirSync(domainDir).filter((f) => f.endsWith('.json') && f !== 'index.json');
      const declared = index.totalEntities || index.count || (index.entities ? index.entities.length : 0);
      const actual = entityFiles.length;
      if (declared !== actual) {
        issues.push({
          check: 'entity-count',
          domain,
          status: 'error',
          declared,
          actual,
          message: `${domain}: 声明 ${declared} 实体，实际 ${actual} 文件`,
        });
        log('error', `${domain}: 计数不一致 (声明 ${declared} / 实际 ${actual})`);
      }
    } catch (err) {
      issues.push({
        check: 'index-parse',
        domain,
        status: 'error',
        message: `解析 ${domain}/index.json 失败: ${err.message}`,
      });
    }
  }
  if (issues.length === 0) log('ok', '数据完整性检查通过');
  return issues;
}

function checkSecurity() {
  log('info', '检查安全状态...');
  const issues = [];

  // 1. CREDENTIALS.md 应不存在
  const credFile = path.join(PROJECT_ROOT, 'CREDENTIALS.md');
  if (fs.existsSync(credFile)) {
    issues.push({
      check: 'credentials-file',
      status: 'danger',
      message: 'CREDENTIALS.md 仍存在于项目根目录',
    });
    log('error', 'CREDENTIALS.md 仍存在！');
  }

  // 2. .env 应不被 git 追踪
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const gitignore = path.join(PROJECT_ROOT, '.gitignore');
    if (fs.existsSync(gitignore)) {
      const content = fs.readFileSync(gitignore, 'utf8');
      if (!content.includes('.env')) {
        issues.push({
          check: 'env-gitignored',
          status: 'danger',
          message: '.env 存在但未在 .gitignore 中',
        });
        log('error', '.env 未被 gitignore');
      }
    }
  }

  // 3. 扫描硬编码路径
  const srcDir = path.join(PROJECT_ROOT, 'src');
  if (fs.existsSync(srcDir)) {
    const scanDir = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (/\.(js|ts|json)$/.test(entry.name)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          if (content.includes('/home/z/my-project') || content.includes('/home/z/')) {
            issues.push({
              check: 'hardcoded-path',
              status: 'warn',
              file: path.relative(PROJECT_ROOT, fullPath),
              message: '检测到硬编码路径 /home/z/',
            });
          }
        }
      }
    };
    scanDir(srcDir);
  }

  if (issues.length === 0) log('ok', '安全检查通过');
  return issues;
}

// ============================================================
// 报告生成
// ============================================================

function generateReport(siteResults, apiResults, dataIssues, securityIssues) {
  const timestamp = new Date().toISOString();
  const totalChecks =
    siteResults.length + apiResults.length + dataIssues.length + securityIssues.length;
  const failedChecks =
    siteResults.filter((r) => r.status === 'error').length +
    apiResults.filter((r) => r.status === 'error').length +
    dataIssues.filter((r) => r.status === 'error').length +
    securityIssues.filter((r) => r.status === 'danger').length;
  const warnChecks =
    siteResults.filter((r) => r.status === 'warn').length +
    dataIssues.filter((r) => r.status === 'warn').length +
    securityIssues.filter((r) => r.status === 'warn').length;
  const overallStatus = failedChecks > 0 ? 'error' : warnChecks > 0 ? 'warn' : 'ok';

  const report = {
    timestamp,
    overallStatus,
    summary: {
      total: totalChecks,
      passed: totalChecks - failedChecks - warnChecks,
      warnings: warnChecks,
      failures: failedChecks,
      uptime: siteResults.length
        ? ((siteResults.filter((s) => s.status !== 'error').length / siteResults.length) * 100).toFixed(2) + '%'
        : 'N/A',
    },
    sites: siteResults,
    api: apiResults,
    dataIntegrity: dataIssues,
    security: securityIssues,
  };

  // 写 JSON 报告
  const reportDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(reportDir, `health-${dateStr}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  log('ok', `JSON 报告: ${jsonPath}`);

  // 生成 HTML 报告
  const htmlPath = path.join(reportDir, `health-${dateStr}.html`);
  fs.writeFileSync(htmlPath, generateHtmlReport(report));
  log('ok', `HTML 报告: ${htmlPath}`);

  return report;
}

function generateHtmlReport(report) {
  const statusColor = { ok: '#3fb950', warn: '#d29922', error: '#f85149', danger: '#f85149' };
  const statusText = { ok: '正常', warn: '警告', error: '错误', danger: '严重' };
  const overallColor = statusColor[report.overallStatus];

  const siteRows = report.sites
    .map(
      (s) => `<tr>
      <td>${s.name}</td>
      <td><span style="color:${statusColor[s.status]};font-weight:600">${statusText[s.status] || s.status}</span></td>
      <td>${s.httpStatus || '-'}</td>
      <td>${s.responseTime || 0}ms</td>
      <td>${s.message}</td>
      <td><a href="${s.url}" target="_blank">访问</a></td>
    </tr>`
    )
    .join('\n');

  const apiRows = report.api
    .map(
      (a) => `<tr>
      <td>${a.name}</td>
      <td><span style="color:${statusColor[a.status]};font-weight:600">${statusText[a.status] || a.status}</span></td>
      <td>${a.httpStatus || '-'}</td>
      <td>${a.message}</td>
    </tr>`
    )
    .join('\n');

  const dataRows = report.dataIntegrity.length
    ? report.dataIntegrity
        .map(
          (d) => `<tr>
        <td>${d.check}</td>
        <td>${d.domain || '-'}</td>
        <td><span style="color:${statusColor[d.status] || statusColor.danger};font-weight:600">${statusText[d.status] || d.status}</span></td>
        <td>${d.message}</td>
      </tr>`
        )
        .join('\n')
    : '<tr><td colspan="4" style="text-align:center;color:#8b949e">无问题</td></tr>';

  const securityRows = report.security.length
    ? report.security
        .map(
          (s) => `<tr>
        <td>${s.check}</td>
        <td><span style="color:${statusColor[s.status] || statusColor.danger};font-weight:600">${statusText[s.status] || s.status}</span></td>
        <td>${s.file || '-'}</td>
        <td>${s.message}</td>
      </tr>`
        )
        .join('\n')
    : '<tr><td colspan="4" style="text-align:center;color:#8b949e">无问题</td></tr>';

  return `<!-- Generated by Trae Work -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>健康检查报告 — ${report.timestamp}</title>
  <style>
    :root {
      --bg: #0f1117; --bg2: #161b22; --bg3: #1c2128;
      --ink: #e6edf3; --muted: #8b949e; --rule: #30363d;
      --accent: #58a6ff; --font: -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); background: var(--bg); color: var(--ink); line-height: 1.6; padding: 2rem; }
    .container { max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 1.8rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.3rem; margin: 2rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid var(--accent); }
    .subtitle { color: var(--muted); margin-bottom: 2rem; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .stat { background: var(--bg2); border: 1px solid var(--rule); border-radius: 8px; padding: 1rem; text-align: center; }
    .stat .num { font-size: 1.8rem; font-weight: 800; color: var(--accent); }
    .stat .label { font-size: 0.8rem; color: var(--muted); margin-top: 0.3rem; }
    .badge { display: inline-block; padding: 0.2rem 0.8rem; border-radius: 4px; font-size: 0.85rem; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; background: var(--bg2); border-radius: 8px; overflow: hidden; margin-bottom: 1rem; }
    th, td { padding: 0.7rem 1rem; text-align: left; border-bottom: 1px solid var(--rule); font-size: 0.9rem; }
    th { background: var(--bg3); color: var(--muted); font-weight: 600; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--rule); color: var(--muted); font-size: 0.85rem; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <h1>GeneTech 14站知识引擎 — 健康检查报告</h1>
    <p class="subtitle">生成时间: ${report.timestamp}</p>

    <div class="stats">
      <div class="stat"><div class="num" style="color:${overallColor}">${statusText[report.overallStatus]}</div><div class="label">总体状态</div></div>
      <div class="stat"><div class="num">${report.summary.uptime}</div><div class="label">站点可用率</div></div>
      <div class="stat"><div class="num">${report.summary.passed}</div><div class="label">通过检查</div></div>
      <div class="stat"><div class="num" style="color:#d29922">${report.summary.warnings}</div><div class="label">警告</div></div>
      <div class="stat"><div class="num" style="color:#f85149">${report.summary.failures}</div><div class="label">失败</div></div>
    </div>

    <h2>站点可用性</h2>
    <table>
      <thead><tr><th>站点</th><th>状态</th><th>HTTP</th><th>响应时间</th><th>详情</th><th>链接</th></tr></thead>
      <tbody>${siteRows}</tbody>
    </table>

    <h2>API 端点</h2>
    <table>
      <thead><tr><th>端点</th><th>状态</th><th>HTTP</th><th>详情</th></tr></thead>
      <tbody>${apiRows}</tbody>
    </table>

    <h2>数据完整性</h2>
    <table>
      <thead><tr><th>检查项</th><th>领域</th><th>状态</th><th>详情</th></tr></thead>
      <tbody>${dataRows}</tbody>
    </table>

    <h2>安全状态</h2>
    <table>
      <thead><tr><th>检查项</th><th>状态</th><th>文件</th><th>详情</th></tr></thead>
      <tbody>${securityRows}</tbody>
    </table>

    <footer>GeneTech 14站知识引擎监控 | 自动生成于 ${report.timestamp}</footer>
  </div>
</body>
</html>`;
}

// ============================================================
// 告警
// ============================================================

async function sendAlert(report) {
  if (!ALERT_WEBHOOK) return;
  if (report.overallStatus === 'ok') return;

  const severity = report.overallStatus === 'error' ? '严重' : '警告';
  const text = `【GeneTech 监控告警】\n状态: ${severity}\n失败: ${report.summary.failures}\n警告: ${report.summary.warnings}\n可用率: ${report.summary.uptime}\n时间: ${report.timestamp}`;

  try {
    await fetch(ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg_type: 'text',
        content: { text },
      }),
    });
    log('ok', '告警已发送');
  } catch (err) {
    log('error', `告警发送失败: ${err.message}`);
  }
}

// ============================================================
// 主入口
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const runAll = args.includes('--all');
  const doSites = runAll || args.includes('--sites');
  const doApi = runAll || args.includes('--api');
  const doData = runAll || args.includes('--data');
  const doSecurity = runAll || args.includes('--security');
  const doAlert = args.includes('--alert');

  if (!doSites && !doApi && !doData && !doSecurity) {
    console.log('用法: node health-check.js [--sites] [--api] [--data] [--security] [--all] [--alert]');
    process.exit(1);
  }

  log('info', `=== 健康检查开始 ${new Date().toISOString()} ===`);

  let siteResults = [];
  let apiResults = [];
  let dataIssues = [];
  let securityIssues = [];

  if (doSites) siteResults = await checkSites();
  if (doApi) apiResults = await checkApiEndpoints();
  if (doData) dataIssues = checkDataIntegrity();
  if (doSecurity) securityIssues = checkSecurity();

  const report = generateReport(siteResults, apiResults, dataIssues, securityIssues);

  log('info', `=== 检查完成 ===`);
  log(
    report.overallStatus === 'ok' ? 'ok' : report.overallStatus === 'warn' ? 'warn' : 'error',
    `总体状态: ${report.overallStatus.toUpperCase()} | 通过 ${report.summary.passed} / 警告 ${report.summary.warnings} / 失败 ${report.summary.failures}`
  );

  if (doAlert) await sendAlert(report);

  process.exit(report.overallStatus === 'error' ? 1 : 0);
}

main().catch((err) => {
  log('error', `未捕获错误: ${err.message}`);
  process.exit(2);
});
