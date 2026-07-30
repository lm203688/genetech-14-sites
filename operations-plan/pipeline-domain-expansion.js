#!/usr/bin/env node
/**
 * 闭环二：领域开拓机制
 * pipeline-domain-expansion.js
 *
 * 功能：
 *   1. 监测新兴技术领域（arXiv 新分类、GitHub trending、Google Trends）
 *   2. 自动评估新领域的价值（搜索量、论文数量、社区热度）
 *   3. 达到阈值后自动生成新站点脚手架
 *   4. 新领域数据自动采集和填充
 *   5. 输出 report-domain-*.json 供其他闭环消费
 *
 * 使用方式：
 *   node pipeline-domain-expansion.js [--dry-run]
 */

const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ==================== 配置区 ====================

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const LOG_DIR = path.join(PROJECT_ROOT, 'logs');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const SITES_DIR = path.join(PROJECT_ROOT, 'sites');
const TEMPLATES_DIR = path.join(__dirname, 'templates');

/** 信号源配置 */
const SIGNAL_SOURCES = {
  arxiv: {
    enabled: true,
    // 监测 arXiv 各分类的论文增长速率
    baseUrl: 'http://export.arxiv.org/api/query',
    categoriesToWatch: ['cs.AI', 'cs.CL', 'cs.CV', 'cs.LG', 'cs.IR', 'cs.RO', 'cs.SE', 'cs.DB', 'cs.CR', 'cs.HC', 'cs.CY', 'cs.NE'],
    // 异常增长阈值：月增长率超过此值则标记为热点
    growthThresholdPercent: 50,
  },
  github: {
    enabled: true,
    // 监测 GitHub 新兴仓库和 trending topics
    baseUrl: 'https://api.github.com',
    // 每日新增 stars 阈值
    starVelocityThreshold: 100,
    // 需要 GitHub Token
    maxReposPerQuery: 100,
  },
  googleTrends: {
    enabled: false, // Google Trends 无官方 API，需要第三方库或 SerpAPI
    note: '如需启用，请配置 SERPAPI_KEY 或 trends-scraper',
  },
  // 从闭环五的报告中读取市场空白信号
  intelligenceReport: {
    enabled: true,
    // 读取最近的 report-intelligence-*.json
    lookbackDays: 7,
  },
};

/** 领域价值评估权重与阈值 */
const EVALUATION_CONFIG = {
  // 各维度权重
  weights: {
    paperVolume: 0.30,        // 论文数量（月新增）
    repoVelocity: 0.25,       // GitHub 仓库增速
    searchTrendGrowth: 0.20,  // 搜索趋势增长
    communityHeat: 0.15,      // 社区讨论热度
    relatednessToExisting: 0.10, // 与现有 14 站关联度
  },
  // 各维度阈值
  thresholds: {
    paperVolume: 50,          // >= 50 篇/月
    repoVelocity: 20,         // >= 20 个新仓库/月
    searchTrendGrowth: 200,   // 搜索量增长 >= 200%
    communityHeat: 1000,      // 讨论帖 >= 1000/月
    relatednessToExisting: 0.30, // 关联度 >= 0.3
  },
  // 综合得分触发阈值
  compositeScoreThreshold: 0.75,
};

/** 现有 14 站的关键词集合（用于计算关联度） */
const EXISTING_SITE_KEYWORDS = [
  'ai agent', 'mcp', 'model context protocol', 'agent framework', 'orchestration',
  'llm', 'large language model', 'rag', 'retrieval augmented', 'prompt engineering',
  'fine tuning', 'peft', 'lora', 'benchmark', 'evaluation', 'safety', 'alignment',
  'multimodal', 'vision language', 'ai tools', 'dataset', 'synthetic data',
  'survey', 'conference', 'workshop'
];

// ==================== 工具函数 ====================

function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function getISOTime() {
  return new Date().toISOString();
}

async function ensureDir(dirPath) {
  try { await fs.mkdir(dirPath, { recursive: true }); } catch {}
}

async function readJson(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch { return null; }
}

async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function readDirFiles(dirPath, pattern = /.*/) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && pattern.test(e.name))
      .map(e => e.name)
      .sort();
  } catch { return []; }
}

function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { timeout: 30000, ...options }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function withRetry(fn, maxRetries = 3, baseDelayMs = 1000) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, i);
      console.warn(`[Retry ${i + 1}/${maxRetries}] ${err.message}，等待 ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== 信号采集 ====================

/**
 * 从 arXiv 各分类采集近期论文数量，计算增长率
 */
async function collectArxivSignals(dryRun) {
  const cfg = SIGNAL_SOURCES.arxiv;
  const signals = [];
  if (!cfg.enabled) return signals;

  // 计算一个月前和现在的论文数量
  const now = new Date();
  const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const formatDate = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

  for (const cat of cfg.categoriesToWatch) {
    // 查询最近 30 天
    const recentUrl = `${cfg.baseUrl}?search_query=cat:${cat}+AND+submittedDate:[${formatDate(oneMonthAgo)}+TO+${formatDate(now)}]&max_results=0`;
    // 查询前 30 天（用于计算增长）
    const twoMonthsAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const prevUrl = `${cfg.baseUrl}?search_query=cat:${cat}+AND+submittedDate:[${formatDate(twoMonthsAgo)}+TO+${formatDate(oneMonthAgo)}]&max_results=0`;

    if (dryRun) {
      console.log(`[DRY-RUN] [arXiv Signal] 分类 ${cat}: 将查询近期/前期论文数量`);
      signals.push({ source: 'arxiv', category: cat, _dryRun: true });
      continue;
    }

    try {
      const [recentRes, prevRes] = await Promise.all([
        withRetry(() => httpGet(recentUrl), 2, 2000),
        withRetry(() => httpGet(prevUrl), 2, 2000),
      ]);

      const recentCount = parseArxivTotalResults(recentRes.body);
      const prevCount = parseArxivTotalResults(prevRes.body);
      const growthRate = prevCount > 0 ? ((recentCount - prevCount) / prevCount) * 100 : 0;

      console.log(`[arXiv Signal] ${cat}: 近期=${recentCount}, 前期=${prevCount}, 增长率=${growthRate.toFixed(1)}%`);

      signals.push({
        source: 'arxiv',
        category: cat,
        recentCount,
        prevCount,
        growthRate,
        isHot: growthRate >= cfg.growthThresholdPercent,
        timestamp: getISOTime(),
      });
    } catch (err) {
      console.error(`[arXiv Signal] ${cat} 采集失败: ${err.message}`);
    }

    await sleep(1000);
  }

  return signals;
}

function parseArxivTotalResults(xml) {
  const m = xml.match(/<opensearch:totalResults>(\d+)<\/opensearch:totalResults>/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * 从 GitHub 采集新兴仓库信号（按 stars 增速）
 */
async function collectGitHubSignals(dryRun) {
  const cfg = SIGNAL_SOURCES.github;
  const signals = [];
  if (!cfg.enabled) return signals;

  const token = process.env.GITHUB_TOKEN || '';
  const headers = {
    'User-Agent': 'GeneTechBot/1.0',
    'Accept': 'application/vnd.github.v3+json',
  };
  if (token) headers['Authorization'] = `token ${token}`;

  // 搜索最近 30 天内创建且 stars 增速快的仓库
  const createdQuery = `created:>${getDateOffset(-30)}`;
  const topics = ['ai', 'agent', 'llm', 'rag', 'multimodal', 'mcp', 'safety'];

  for (const topic of topics) {
    const url = `${cfg.baseUrl}/search/repositories?q=${encodeURIComponent(`${topic} ${createdQuery}`)}&sort=stars&order=desc&per_page=${cfg.maxReposPerQuery}`;
    console.log(`[GitHub Signal] 搜索新兴仓库: topic=${topic}`);

    if (dryRun) {
      console.log(`[DRY-RUN] [GitHub Signal] 将请求: ${url}`);
      signals.push({ source: 'github', topic, _dryRun: true });
      continue;
    }

    try {
      const res = await withRetry(() => httpGet(url, { headers }), 3, 2000);
      if (res.statusCode !== 200) {
        console.error(`[GitHub Signal] HTTP ${res.statusCode}`);
        continue;
      }
      const data = JSON.parse(res.body);
      const repos = data.items || [];
      const highVelocityRepos = repos.filter(r => r.stargazers_count >= cfg.starVelocityThreshold);

      console.log(`[GitHub Signal] topic=${topic}: ${repos.length} 个新仓库，其中 ${highVelocityRepos.length} 个增速快`);

      signals.push({
        source: 'github',
        topic,
        totalNewRepos: repos.length,
        highVelocityRepos: highVelocityRepos.length,
        topRepos: highVelocityRepos.slice(0, 5).map(r => ({
          fullName: r.full_name,
          stars: r.stargazers_count,
          description: r.description,
          topics: r.topics,
        })),
        timestamp: getISOTime(),
      });
    } catch (err) {
      console.error(`[GitHub Signal] ${topic} 失败: ${err.message}`);
    }

    await sleep(1000);
  }

  return signals;
}

function getDateOffset(daysOffset) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return d.toISOString().split('T')[0];
}

/**
 * 从闭环五的报告读取市场空白信号
 */
async function collectIntelligenceSignals(dryRun) {
  const cfg = SIGNAL_SOURCES.intelligenceReport;
  const signals = [];
  if (!cfg.enabled) return signals;

  const files = await readDirFiles(REPORTS_DIR, /^report-intelligence-/);
  if (files.length === 0) {
    console.log('[Intelligence Signal] 暂无竞品情报报告');
    return signals;
  }

  // 取最近的一份报告
  const latestReport = await readJson(path.join(REPORTS_DIR, files[files.length - 1]));
  if (!latestReport || !latestReport.marketGaps) {
    console.log('[Intelligence Signal] 最新报告无市场空白数据');
    return signals;
  }

  for (const gap of latestReport.marketGaps) {
    signals.push({
      source: 'intelligence-report',
      domain: gap.domain,
      description: gap.description,
      confidence: gap.confidence || 0.5,
      suggestedBy: gap.source || 'competitor-analysis',
      timestamp: latestReport.timestamp || getISOTime(),
    });
  }

  console.log(`[Intelligence Signal] 读取到 ${signals.length} 个市场空白信号`);
  return signals;
}

// ==================== 领域评估 ====================

/**
 * 基于采集到的信号，评估潜在新领域
 * @param {object[]} allSignals
 * @returns {object[]} 评估结果列表
 */
function evaluateDomains(allSignals) {
  const domains = [];

  // 从 arXiv 热点分类中提取候选领域
  const arxivSignals = allSignals.filter(s => s.source === 'arxiv' && !s._dryRun);
  for (const sig of arxivSignals) {
    if (!sig.isHot) continue;
    const domainName = `arxiv-${sig.category}`;
    const existing = domains.find(d => d.domainName === domainName);
    if (!existing) {
      domains.push({
        domainName,
        displayName: `领域: ${sig.category}`,
        signals: [sig],
        paperVolume: sig.recentCount || 0,
        repoVelocity: 0,
        searchTrendGrowth: 0,
        communityHeat: 0,
        relatedKeywords: [sig.category],
      });
    } else {
      existing.signals.push(sig);
      existing.paperVolume = Math.max(existing.paperVolume, sig.recentCount);
    }
  }

  // 从 GitHub 新兴仓库中提取候选领域
  const githubSignals = allSignals.filter(s => s.source === 'github' && !s._dryRun);
  for (const sig of githubSignals) {
    if (sig.highVelocityRepos === 0) continue;
    const domainName = `github-topic-${sig.topic}`;
    const existing = domains.find(d => d.domainName === domainName);
    if (!existing) {
      domains.push({
        domainName,
        displayName: `领域: ${sig.topic}`,
        signals: [sig],
        paperVolume: 0,
        repoVelocity: sig.highVelocityRepos,
        searchTrendGrowth: 0,
        communityHeat: sig.highVelocityRepos * 10, // 粗略估算
        relatedKeywords: [sig.topic, ...(sig.topRepos?.[0]?.topics || [])],
      });
    } else {
      existing.signals.push(sig);
      existing.repoVelocity += sig.highVelocityRepos;
      existing.communityHeat += sig.highVelocityRepos * 10;
    }
  }

  // 从竞品情报中提取
  const intelSignals = allSignals.filter(s => s.source === 'intelligence-report');
  for (const sig of intelSignals) {
    const domainName = `market-gap-${slugify(sig.domain)}`;
    const existing = domains.find(d => d.domainName === domainName);
    if (!existing) {
      domains.push({
        domainName,
        displayName: sig.domain,
        signals: [sig],
        paperVolume: 0,
        repoVelocity: 0,
        searchTrendGrowth: 0,
        communityHeat: 0,
        relatedKeywords: [sig.domain],
        fromMarketGap: true,
      });
    }
  }

  // 计算综合得分
  const cfg = EVALUATION_CONFIG;
  for (const domain of domains) {
    const paperScore = Math.min(domain.paperVolume / cfg.thresholds.paperVolume, 3) / 3;
    const repoScore = Math.min(domain.repoVelocity / cfg.thresholds.repoVelocity, 3) / 3;
    const trendScore = Math.min(domain.searchTrendGrowth / cfg.thresholds.searchTrendGrowth, 3) / 3;
    const communityScore = Math.min(domain.communityHeat / cfg.thresholds.communityHeat, 3) / 3;
    const relatedScore = computeRelatedness(domain.relatedKeywords);

    domain.scores = {
      paperVolume: round2(paperScore),
      repoVelocity: round2(repoScore),
      searchTrendGrowth: round2(trendScore),
      communityHeat: round2(communityScore),
      relatednessToExisting: round2(relatedScore),
    };

    domain.compositeScore = round2(
      paperScore * cfg.weights.paperVolume +
      repoScore * cfg.weights.repoVelocity +
      trendScore * cfg.weights.searchTrendGrowth +
      communityScore * cfg.weights.communityHeat +
      relatedScore * cfg.weights.relatednessToExisting
    );

    domain.shouldExpand = domain.compositeScore >= cfg.compositeScoreThreshold;
  }

  // 按综合得分排序
  domains.sort((a, b) => b.compositeScore - a.compositeScore);
  return domains;
}

/**
 * 计算与现有站点的关联度（基于关键词重叠）
 */
function computeRelatedness(keywords) {
  if (!keywords || keywords.length === 0) return 0;
  const normalizedKw = keywords.map(k => k.toLowerCase());
  const matches = EXISTING_SITE_KEYWORDS.filter(ek =>
    normalizedKw.some(k => k.includes(ek) || ek.includes(k))
  ).length;
  return Math.min(matches / 5, 1); // 最多匹配 5 个即满分
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ==================== 脚手架生成 ====================

/**
 * 为新领域生成站点脚手架
 */
async function generateScaffold(domain, dryRun) {
  const siteId = slugify(domain.domainName);
  const siteDir = path.join(SITES_DIR, siteId);

  const scaffold = {
    siteId,
    displayName: domain.displayName,
    createdAt: getISOTime(),
    sourceSignal: domain.signals.map(s => s.source),
    compositeScore: domain.compositeScore,
    files: [],
  };

  const filesToCreate = [
    {
      filePath: path.join(siteDir, 'index.md'),
      content: generateIndexMd(domain),
    },
    {
      filePath: path.join(siteDir, '_data', 'entities.json'),
      content: '[]',
    },
    {
      filePath: path.join(siteDir, '_config.yml'),
      content: generateConfigYml(siteId, domain),
    },
    {
      filePath: path.join(siteDir, 'README.md'),
      content: generateSiteReadme(siteId, domain),
    },
  ];

  for (const file of filesToCreate) {
    if (dryRun) {
      console.log(`[DRY-RUN] 将创建文件: ${file.filePath}`);
      scaffold.files.push({ path: file.filePath, dryRun: true });
      continue;
    }
    await ensureDir(path.dirname(file.filePath));
    await fs.writeFile(file.filePath, file.content, 'utf-8');
    scaffold.files.push({ path: file.filePath, created: true });
    console.log(`[Scaffold] 创建: ${file.filePath}`);
  }

  return scaffold;
}

function generateIndexMd(domain) {
  return `---
title: "${domain.displayName}"
description: "GeneTech 知识引擎 — ${domain.displayName} 专题站点"
createdAt: "${getISOTime()}"
score: ${domain.compositeScore}
---

# ${domain.displayName}

> 本站点由领域开拓机制自动生成，综合得分: **${domain.compositeScore}**

## 概述

该领域被识别为新兴热点，信号来源: ${domain.signals.map(s => s.source).join(', ')}。

## 数据实体

详见 [_data/entities.json](_data/entities.json)。

## 关联关键词

${(domain.relatedKeywords || []).map(k => `- ${k}`).join('\n')}
`;
}

function generateConfigYml(siteId, domain) {
  return `# ${siteId} 站点配置
title: "${domain.displayName}"
site_id: "${siteId}"
description: "${domain.displayName} 知识聚合"
keywords: ${(domain.relatedKeywords || []).join(', ')}
score: ${domain.compositeScore}
created_at: "${getISOTime()}"
`;
}

function generateSiteReadme(siteId, domain) {
  return `# ${siteId}

${domain.displayName} 专题站点

- 自动生成时间: ${getISOTime()}
- 综合得分: ${domain.compositeScore}
- 关联关键词: ${(domain.relatedKeywords || []).join(', ')}
`;
}

// ==================== 新领域数据预填充 ====================

/**
 * 触发闭环一逻辑，为新站点预填充数据
 * 实际场景可调用 pipeline-data-accumulation.js 的导出函数，或写入待处理队列
 */
async function prefillNewDomainData(scaffold, dryRun) {
  const queuePath = path.join(STATE_DIR, 'prefill-queue.json');
  let queue = await readJson(queuePath) || [];

  const task = {
    siteId: scaffold.siteId,
    keywords: scaffold.displayName,
    createdAt: getISOTime(),
    status: 'pending',
  };

  if (dryRun) {
    console.log(`[DRY-RUN] 将加入预填充队列: ${JSON.stringify(task)}`);
    return { queued: true, dryRun: true, task };
  }

  queue.push(task);
  await writeJson(queuePath, queue);
  console.log(`[Prefill] 站点 ${scaffold.siteId} 已加入预填充队列`);
  return { queued: true, task };
}

// ==================== 主流程 ====================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const modeLabel = dryRun ? '[DRY-RUN]' : '[PROD]';

  console.log(`${modeLabel} ==========================================`);
  console.log(`${modeLabel} 闭环二：领域开拓机制 启动`);
  console.log(`${modeLabel} 时间: ${getISOTime()}`);
  console.log(`${modeLabel} ==========================================`);

  const statePath = path.join(STATE_DIR, 'pipeline-domain-expansion-state.json');
  const state = await readJson(statePath) || {};

  await ensureDir(STATE_DIR);
  await ensureDir(LOG_DIR);
  await ensureDir(REPORTS_DIR);
  await ensureDir(SITES_DIR);

  const startTime = Date.now();

  // ---------- Phase 1: 信号采集 ----------
  console.log('\n[Phase 1] 采集领域信号...');
  const allSignals = [];

  const arxivSignals = await collectArxivSignals(dryRun);
  allSignals.push(...arxivSignals);

  const githubSignals = await collectGitHubSignals(dryRun);
  allSignals.push(...githubSignals);

  const intelSignals = await collectIntelligenceSignals(dryRun);
  allSignals.push(...intelSignals);

  console.log(`[Signal] 共采集 ${allSignals.length} 个信号`);

  // ---------- Phase 2: 领域评估 ----------
  console.log('\n[Phase 2] 评估潜在新领域...');
  const domains = evaluateDomains(allSignals);
  console.log(`[Evaluate] 评估了 ${domains.length} 个候选领域`);

  const topDomains = domains.slice(0, 10);
  for (const d of topDomains) {
    console.log(`  - ${d.displayName}: 综合得分=${d.compositeScore}, 是否扩张=${d.shouldExpand}`);
  }

  // ---------- Phase 3: 生成脚手架 ----------
  console.log('\n[Phase 3] 为达标领域生成站点脚手架...');
  const expandedDomains = [];
  for (const domain of domains) {
    if (!domain.shouldExpand) continue;
    // 检查是否已存在同名站点
    const siteId = slugify(domain.domainName);
    const siteDir = path.join(SITES_DIR, siteId);
    try {
      await fs.access(siteDir);
      console.log(`[Skip] 站点 ${siteId} 已存在，跳过`);
      continue;
    } catch {
      // 目录不存在，可以创建
    }

    const scaffold = await generateScaffold(domain, dryRun);
    expandedDomains.push({ domain, scaffold });

    // 预填充数据
    await prefillNewDomainData(scaffold, dryRun);
  }

  console.log(`[Expand] 新扩张领域: ${expandedDomains.length} 个`);

  // ---------- Phase 4: 生成报告 ----------
  const report = {
    pipeline: 'domain-expansion',
    version: '1.0',
    timestamp: getISOTime(),
    dryRun,
    durationMs: Date.now() - startTime,
    summary: {
      signalsCollected: allSignals.length,
      domainsEvaluated: domains.length,
      domainsExpanded: expandedDomains.length,
    },
    signals: allSignals.map(s => ({
      source: s.source,
      category: s.category || s.topic || s.domain,
      isHot: s.isHot || false,
      _dryRun: s._dryRun || false,
    })),
    domains: domains.map(d => ({
      domainName: d.domainName,
      displayName: d.displayName,
      compositeScore: d.compositeScore,
      shouldExpand: d.shouldExpand,
      scores: d.scores,
      relatedKeywords: d.relatedKeywords,
    })),
    expanded: expandedDomains.map(({ domain, scaffold }) => ({
      siteId: scaffold.siteId,
      displayName: domain.displayName,
      compositeScore: domain.compositeScore,
      filesCreated: scaffold.files.length,
    })),
    // 传递给闭环一、闭环三的信息
    techRequirements: expandedDomains.map(({ domain }) => ({
      siteId: slugify(domain.domainName),
      keywords: domain.relatedKeywords,
      neededDataTypes: ['papers', 'repositories', 'datasets'],
    })),
  };

  const reportPath = path.join(REPORTS_DIR, `report-domain-${getTimestamp()}.json`);
  if (dryRun) {
    console.log(`[DRY-RUN] 将生成报告: ${reportPath}`);
  } else {
    await writeJson(reportPath, report);
    console.log(`[Report] 已生成: ${reportPath}`);
  }

  // 保存状态
  const newState = {
    lastRunTime: getISOTime(),
    lastReportPath: reportPath,
    totalRuns: (state.totalRuns || 0) + 1,
    totalDomainsEvaluated: (state.totalDomainsEvaluated || 0) + domains.length,
    totalDomainsExpanded: (state.totalDomainsExpanded || 0) + expandedDomains.length,
  };
  if (!dryRun) {
    await writeJson(statePath, newState);
  }

  console.log(`\n${modeLabel} ==========================================`);
  console.log(`${modeLabel} 领域开拓机制 执行完毕`);
  console.log(`${modeLabel} 耗时: ${report.durationMs}ms`);
  console.log(`${modeLabel} 候选领域: ${domains.length}, 新扩张: ${expandedDomains.length}`);
  console.log(`${modeLabel} ==========================================`);
}

main().catch(err => {
  console.error('[FATAL] 未捕获的异常:', err);
  process.exit(1);
});
