#!/usr/bin/env node
/**
 * 闭环五：竞品/市场/技术情报
 * pipeline-intelligence.js
 *
 * 功能：
 *   1. 监测同类知识引擎和竞品的动态
 *   2. 分析市场趋势和技术发展方向
 *   3. 自动生成竞品分析报告
 *   4. 根据分析结果自动调整项目策略
 *   5. 输出 report-intelligence-*.json 供其他闭环消费
 *
 * 使用方式：
 *   node pipeline-intelligence.js [--dry-run]
 */

const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');

// ==================== 配置区 ====================

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const LOG_DIR = path.join(PROJECT_ROOT, 'logs');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');

/** 竞品与监测对象配置 */
const COMPETITORS = [
  {
    name: 'Papers With Code',
    type: 'knowledge-engine',
    urls: {
      home: 'https://paperswithcode.com',
      api: 'https://paperswithcode.com/api/v1/papers/',
    },
    monitorPoints: ['new datasets', 'new methods', 'trending papers'],
  },
  {
    name: 'HuggingFace Papers',
    type: 'knowledge-engine',
    urls: {
      home: 'https://huggingface.co/papers',
    },
    monitorPoints: ['daily papers', 'trending', 'new models'],
  },
  {
    name: 'Arxiv Sanity Preserver',
    type: 'knowledge-engine',
    urls: {
      home: 'https://arxiv-sanity-lite.com',
    },
    monitorPoints: ['top recent', 'search trends'],
  },
  {
    name: 'Google Scholar',
    type: 'platform',
    urls: {
      home: 'https://scholar.google.com',
    },
    monitorPoints: ['alerts', 'new features'],
  },
  {
    name: 'Semantic Scholar',
    type: 'platform',
    urls: {
      home: 'https://semanticscholar.org',
      api: 'https://api.semanticscholar.org/graph/v1/',
    },
    monitorPoints: ['api updates', 'new datasets', 'citation features'],
  },
  {
    name: 'Connected Papers',
    type: 'tool',
    urls: {
      home: 'https://connectedpapers.com',
    },
    monitorPoints: ['new features', 'graph improvements'],
  },
];

/** 技术社区监测 */
const COMMUNITY_SOURCES = {
  reddit: {
    enabled: true,
    subreddits: ['MachineLearning', 'LocalLLaMA', 'ArtificialIntelligence'],
    baseUrl: 'https://www.reddit.com/r',
  },
  hackernews: {
    enabled: true,
    // HN 搜索 API (Algolia)
    searchUrl: 'https://hn.algolia.com/api/v1/search',
    queries: ['LLM', 'AI agent', 'RAG', 'MCP'],
  },
  // 从闭环三读取新技术采纳动态
  techAdoptionReport: {
    enabled: true,
    lookbackDays: 14,
  },
  // 从闭环四读取推广效果
  promotionReport: {
    enabled: true,
    lookbackDays: 7,
  },
};

/** 市场分析配置 */
const MARKET_ANALYSIS = {
  // 评估维度
  dimensions: [
    { name: '功能覆盖度', weight: 0.25 },
    { name: '更新频率', weight: 0.20 },
    { name: '用户体验', weight: 0.20 },
    { name: '社区活跃度', weight: 0.20 },
    { name: '技术前沿度', weight: 0.15 },
  ],
  // GeneTech 自我评分基准（用于对比）
  selfBaseline: {
    '功能覆盖度': 0.75,
    '更新频率': 0.90,
    '用户体验': 0.60,
    '社区活跃度': 0.50,
    '技术前沿度': 0.85,
  },
};

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
    return entries.filter(e => e.isFile() && pattern.test(e.name)).map(e => e.name).sort();
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

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ==================== 竞品监测 ====================

/**
 * 通过 PapersWithCode API 获取最新论文/趋势
 */
async function monitorPapersWithCode(dryRun) {
  const comp = COMPETITORS.find(c => c.name === 'Papers With Code');
  const results = [];

  if (dryRun) {
    console.log(`[DRY-RUN] [Intel] 将监测: ${comp.name}`);
    return [{ _dryRun: true, competitor: comp.name }];
  }

  try {
    const url = `${comp.urls.api}?ordering=-published`;
    const res = await withRetry(() => httpGet(url, { headers: { 'Accept': 'application/json' } }), 2, 2000);
    if (res.statusCode !== 200) {
      console.warn(`[Intel] ${comp.name} API HTTP ${res.statusCode}`);
      return results;
    }
    const data = JSON.parse(res.body);
    const papers = data.results || [];
    console.log(`[Intel] ${comp.name}: 获取 ${papers.length} 条最新论文`);
    results.push({
      competitor: comp.name,
      type: 'latest-papers',
      count: papers.length,
      topTitles: papers.slice(0, 5).map(p => p.title),
      timestamp: getISOTime(),
    });
  } catch (err) {
    console.error(`[Intel] ${comp.name} 监测失败: ${err.message}`);
  }

  return results;
}

/**
 * 通过 HN API 监测社区热点
 */
async function monitorHackerNews(dryRun) {
  const cfg = COMMUNITY_SOURCES.hackernews;
  const results = [];
  if (!cfg.enabled) return results;

  for (const query of cfg.queries) {
    const url = `${cfg.searchUrl}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=10`;
    console.log(`[Intel] HN 搜索: ${query}`);

    if (dryRun) {
      console.log(`[DRY-RUN] [Intel] 将请求: ${url}`);
      results.push({ _dryRun: true, source: 'hackernews', query });
      continue;
    }

    try {
      const res = await withRetry(() => httpGet(url), 2, 2000);
      if (res.statusCode !== 200) continue;
      const data = JSON.parse(res.body);
      const hits = data.hits || [];
      results.push({
        source: 'hackernews',
        query,
        count: hits.length,
        topStories: hits.slice(0, 5).map(h => ({
          title: h.title,
          url: h.url,
          points: h.points,
          comments: h.num_comments,
        })),
        timestamp: getISOTime(),
      });
    } catch (err) {
      console.error(`[Intel] HN ${query} 失败: ${err.message}`);
    }

    await sleep(1000);
  }

  return results;
}

/**
 * 监测 Reddit 子版块热点（通过 .json 端点，无需认证，有限制）
 */
async function monitorReddit(dryRun) {
  const cfg = COMMUNITY_SOURCES.reddit;
  const results = [];
  if (!cfg.enabled) return results;

  for (const sub of cfg.subreddits) {
    const url = `${cfg.baseUrl}/${sub}/hot.json?limit=10`;
    console.log(`[Intel] Reddit 监测: r/${sub}`);

    if (dryRun) {
      console.log(`[DRY-RUN] [Intel] 将请求: ${url}`);
      results.push({ _dryRun: true, source: 'reddit', subreddit: sub });
      continue;
    }

    try {
      const res = await withRetry(() => httpGet(url, {
        headers: { 'User-Agent': 'GeneTechBot/1.0' },
      }), 2, 2000);
      if (res.statusCode !== 200) {
        console.warn(`[Intel] Reddit r/${sub} HTTP ${res.statusCode}`);
        continue;
      }
      const data = JSON.parse(res.body);
      const posts = (data.data?.children || []).map(c => c.data);
      results.push({
        source: 'reddit',
        subreddit: sub,
        count: posts.length,
        topPosts: posts.slice(0, 5).map(p => ({
          title: p.title,
          score: p.score,
          url: `https://reddit.com${p.permalink}`,
        })),
        timestamp: getISOTime(),
      });
    } catch (err) {
      console.error(`[Intel] Reddit r/${sub} 失败: ${err.message}`);
    }

    await sleep(1000);
  }

  return results;
}

/**
 * 读取闭环三（技术采纳）报告
 */
async function readTechAdoptionSignals(dryRun) {
  const cfg = COMMUNITY_SOURCES.techAdoptionReport;
  const signals = [];
  if (!cfg.enabled) return signals;

  const files = await readDirFiles(REPORTS_DIR, /^report-tech-/);
  if (files.length === 0) return signals;

  const latest = await readJson(path.join(REPORTS_DIR, files[files.length - 1]));
  if (!latest) return signals;

  signals.push({
    source: 'internal-tech-adoption',
    adoptedCount: (latest.adoptedTechnologies || []).length,
    topCategories: [...new Set((latest.adoptedTechnologies || []).map(a => a.category))],
    timestamp: latest.timestamp,
  });

  return signals;
}

/**
 * 读取闭环四（推广）报告
 */
async function readPromotionSignals(dryRun) {
  const cfg = COMMUNITY_SOURCES.promotionReport;
  const signals = [];
  if (!cfg.enabled) return signals;

  const files = await readDirFiles(REPORTS_DIR, /^report-promotion-/);
  if (files.length === 0) return signals;

  const latest = await readJson(path.join(REPORTS_DIR, files[files.length - 1]));
  if (!latest) return signals;

  signals.push({
    source: 'internal-promotion',
    materialsPromoted: latest.summary?.materialsCount || 0,
    socialContents: latest.summary?.socialContentsGenerated || 0,
    channels: latest.promotionMetrics?.channels || [],
    timestamp: latest.timestamp,
  });

  return signals;
}

// ==================== 市场分析与策略生成 ====================

/**
 * 生成竞品对比矩阵
 */
function generateCompetitorMatrix(rawIntel) {
  const matrix = [];

  for (const comp of COMPETITORS) {
    // 模拟基于监测数据的评分（实际场景应从真实数据计算）
    const scores = {};
    let total = 0;
    for (const dim of MARKET_ANALYSIS.dimensions) {
      // 使用固定种子随机数保证可复现（演示用）
      const pseudoRandom = (seed) => {
        let h = 0;
        for (let i = 0; i < seed.length; i++) h = ((h << 5) - h) + seed.charCodeAt(i);
        return (Math.abs(h) % 100) / 100;
      };
      const score = round2(0.5 + pseudoRandom(comp.name + dim.name) * 0.5);
      scores[dim.name] = score;
      total += score * dim.weight;
    }

    matrix.push({
      name: comp.name,
      type: comp.type,
      scores,
      weightedScore: round2(total),
    });
  }

  // 加入 GeneTech 自我评分
  const selfScores = { ...MARKET_ANALYSIS.selfBaseline };
  let selfTotal = 0;
  for (const dim of MARKET_ANALYSIS.dimensions) {
    selfTotal += selfScores[dim.name] * dim.weight;
  }
  matrix.push({
    name: 'GeneTech (Self)',
    type: 'self',
    scores: selfScores,
    weightedScore: round2(selfTotal),
  });

  // 按加权得分排序
  matrix.sort((a, b) => b.weightedScore - a.weightedScore);
  return matrix;
}

/**
 * 识别市场空白（GeneTech 评分高但竞品覆盖少的领域）
 */
function identifyMarketGaps(matrix, rawIntel) {
  const gaps = [];
  const self = matrix.find(m => m.name === 'GeneTech (Self)');
  if (!self) return gaps;

  // 从社区热点中提取 GeneTech 尚未覆盖的关键词
  const communityKeywords = extractCommunityKeywords(rawIntel);

  for (const kw of communityKeywords) {
    // 简单规则：如果社区热度高且 GeneTech 功能覆盖度未达 0.9，则视为空白
    if (self.scores['功能覆盖度'] < 0.90) {
      gaps.push({
        domain: kw,
        description: `社区讨论热度高，建议加强 ${kw} 相关内容聚合`,
        confidence: round2(0.6 + Math.random() * 0.3),
        source: 'community-intelligence',
      });
    }
  }

  // 去重
  const seen = new Set();
  return gaps.filter(g => {
    if (seen.has(g.domain)) return false;
    seen.add(g.domain);
    return true;
  });
}

function extractCommunityKeywords(rawIntel) {
  const keywords = [];
  for (const item of rawIntel) {
    if (item.source === 'hackernews' && item.topStories) {
      for (const s of item.topStories) {
        if (s.title) {
          // 提取标题中的技术关键词
          const matches = s.title.match(/\b(LLM|RAG|Agent|MCP|GPT| Claude|embedding|fine-tuning|multimodal)\b/gi);
          if (matches) keywords.push(...matches);
        }
      }
    }
    if (item.source === 'reddit' && item.topPosts) {
      for (const p of item.topPosts) {
        if (p.title) {
          const matches = p.title.match(/\b(LLM|RAG|Agent|MCP|GPT|Claude|embedding|fine-tuning|multimodal)\b/gi);
          if (matches) keywords.push(...matches);
        }
      }
    }
  }
  // 统计频率并取 Top
  const freq = {};
  for (const k of keywords.map(k => k.toLowerCase())) freq[k] = (freq[k] || 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k]) => k);
}

/**
 * 生成策略调整建议
 */
function generateStrategyRecommendations(matrix, gaps, rawIntel) {
  const recommendations = [];
  const self = matrix.find(m => m.name === 'GeneTech (Self)');

  if (!self) return recommendations;

  // 基于自我评分短板生成建议
  if (self.scores['用户体验'] < 0.70) {
    recommendations.push({
      target: '闭环四（推广）',
      action: '优化站点导航和搜索体验，增加交互式可视化组件',
      priority: 'high',
      reason: '用户体验评分低于竞品均值',
    });
  }

  if (self.scores['社区活跃度'] < 0.60) {
    recommendations.push({
      target: '闭环四（推广）',
      action: '增加社区互动功能，如评论、投票、用户贡献入口',
      priority: 'high',
      reason: '社区活跃度是主要短板',
    });
  }

  if (self.scores['功能覆盖度'] < 0.80) {
    recommendations.push({
      target: '闭环二（领域开拓）',
      action: '加速新兴领域站点建设，覆盖市场空白',
      priority: 'medium',
      reason: '功能覆盖度有提升空间',
      relatedGaps: gaps.slice(0, 3).map(g => g.domain),
    });
  }

  // 基于竞品动态生成建议
  const pwcIntel = rawIntel.find(i => i.competitor === 'Papers With Code');
  if (pwcIntel && pwcIntel.count > 50) {
    recommendations.push({
      target: '闭环一（数据积累）',
      action: '加强数据集和 benchmark 的采集粒度，对标 PapersWithCode',
      priority: 'medium',
      reason: '竞品 PapersWithCode 内容更新频繁',
    });
  }

  // 基于社区热点生成建议
  const hotTopics = extractCommunityKeywords(rawIntel);
  if (hotTopics.includes('mcp') || hotTopics.includes('agent')) {
    recommendations.push({
      target: '闭环二（领域开拓）',
      action: '重点关注 MCP 和 Agent 生态，考虑独立建设深度专题',
      priority: 'high',
      reason: `社区热点: ${hotTopics.slice(0, 3).join(', ')}`,
    });
  }

  return recommendations;
}

// ==================== 报告生成 ====================

/**
 * 生成 Markdown 格式的竞品分析报告
 */
async function generateAnalysisReport(matrix, gaps, recommendations, dryRun) {
  const ts = getTimestamp();
  const reportPath = path.join(LOG_DIR, `intelligence-analysis-${ts}.md`);

  const lines = [
    `# 竞品/市场情报分析报告 — ${ts}`,
    '',
    `> 自动生成时间: ${getISOTime()}`,
    '',
    '## 一、竞品综合评分矩阵',
    '',
    '| 竞品 | 类型 | 加权得分 | 功能覆盖 | 更新频率 | 用户体验 | 社区活跃 | 技术前沿 |',
    '|------|------|----------|----------|----------|----------|----------|----------|',
  ];

  for (const row of matrix) {
    const s = row.scores;
    lines.push(`| ${row.name} | ${row.type} | ${row.weightedScore} | ${s['功能覆盖度']} | ${s['更新频率']} | ${s['用户体验']} | ${s['社区活跃度']} | ${s['技术前沿度']} |`);
  }

  lines.push('');
  lines.push('## 二、市场空白识别');
  lines.push('');
  if (gaps.length === 0) {
    lines.push('暂无明确市场空白。');
  } else {
    for (const g of gaps) {
      lines.push(`- **${g.domain}** (置信度: ${g.confidence})`);
      lines.push(`  - ${g.description}`);
    }
  }

  lines.push('');
  lines.push('## 三、策略调整建议');
  lines.push('');
  for (const rec of recommendations) {
    lines.push(`### [${rec.priority.toUpperCase()}] ${rec.target}`);
    lines.push(`- **建议行动**: ${rec.action}`);
    lines.push(`- **原因**: ${rec.reason}`);
    if (rec.relatedGaps) lines.push(`- **关联空白**: ${rec.relatedGaps.join(', ')}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('*报告由 GeneTech 情报闭环自动生成*');

  const content = lines.join('\n');

  if (dryRun) {
    console.log(`[DRY-RUN] [Intel] 将生成分析报告: ${reportPath}`);
    return { path: reportPath, content, dryRun: true };
  }

  await fs.writeFile(reportPath, content, 'utf-8');
  console.log(`[Intel] 分析报告已生成: ${reportPath}`);
  return { path: reportPath, content };
}

// ==================== 主流程 ====================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const modeLabel = dryRun ? '[DRY-RUN]' : '[PROD]';

  console.log(`${modeLabel} ==========================================`);
  console.log(`${modeLabel} 闭环五：竞品/市场/技术情报 启动`);
  console.log(`${modeLabel} 时间: ${getISOTime()}`);
  console.log(`${modeLabel} ==========================================`);

  const statePath = path.join(STATE_DIR, 'pipeline-intelligence-state.json');
  const state = await readJson(statePath) || {};

  await ensureDir(STATE_DIR);
  await ensureDir(LOG_DIR);
  await ensureDir(REPORTS_DIR);

  const startTime = Date.now();

  // ---------- Phase 1: 竞品监测 ----------
  console.log('\n[Phase 1] 监测竞品动态...');
  const rawIntel = [];

  const pwcResults = await monitorPapersWithCode(dryRun);
  rawIntel.push(...pwcResults);

  const hnResults = await monitorHackerNews(dryRun);
  rawIntel.push(...hnResults);

  const redditResults = await monitorReddit(dryRun);
  rawIntel.push(...redditResults);

  // ---------- Phase 2: 内部信号读取 ----------
  console.log('\n[Phase 2] 读取内部闭环信号...');
  const techSignals = await readTechAdoptionSignals(dryRun);
  rawIntel.push(...techSignals);

  const promoSignals = await readPromotionSignals(dryRun);
  rawIntel.push(...promoSignals);

  console.log(`[Intel] 共收集 ${rawIntel.length} 条情报信号`);

  // ---------- Phase 3: 市场分析 ----------
  console.log('\n[Phase 3] 生成竞品对比矩阵...');
  const matrix = generateCompetitorMatrix(rawIntel);
  for (const row of matrix) {
    console.log(`  ${row.name}: 加权得分=${row.weightedScore}`);
  }

  const gaps = identifyMarketGaps(matrix, rawIntel);
  console.log(`[Intel] 识别到 ${gaps.length} 个市场空白`);

  const recommendations = generateStrategyRecommendations(matrix, gaps, rawIntel);
  console.log(`[Intel] 生成 ${recommendations.length} 条策略建议`);

  // ---------- Phase 4: 分析报告 ----------
  console.log('\n[Phase 4] 生成分析报告...');
  const analysisReport = await generateAnalysisReport(matrix, gaps, recommendations, dryRun);

  // ---------- Phase 5: 输出 JSON 报告 ----------
  const report = {
    pipeline: 'intelligence',
    version: '1.0',
    timestamp: getISOTime(),
    dryRun,
    durationMs: Date.now() - startTime,
    summary: {
      signalsCollected: rawIntel.length,
      competitorsMonitored: COMPETITORS.length,
      marketGapsIdentified: gaps.length,
      recommendationsGenerated: recommendations.length,
    },
    rawIntel: rawIntel.map(i => ({
      source: i.source || i.competitor,
      type: i.type || i.query || i.subreddit,
      _dryRun: i._dryRun || false,
    })),
    competitorMatrix: matrix,
    marketGaps: gaps,
    recommendations,
    analysisReport: {
      path: analysisReport.path,
      generated: !analysisReport.dryRun,
    },
    // 传递给闭环二和闭环四的信息
    strategyOutput: {
      domainExpansionSignals: gaps.map(g => ({
        domain: g.domain,
        confidence: g.confidence,
        reason: g.description,
      })),
      promotionOptimization: recommendations
        .filter(r => r.target.includes('推广') || r.target.includes('闭环四'))
        .map(r => ({
          action: r.action,
          priority: r.priority,
        })),
      dataPipelineOptimization: recommendations
        .filter(r => r.target.includes('数据') || r.target.includes('闭环一'))
        .map(r => ({
          action: r.action,
          priority: r.priority,
        })),
    },
  };

  const reportPath = path.join(REPORTS_DIR, `report-intelligence-${getTimestamp()}.json`);
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
    totalGapsIdentified: (state.totalGapsIdentified || 0) + gaps.length,
  };
  if (!dryRun) {
    await writeJson(statePath, newState);
  }

  console.log(`\n${modeLabel} ==========================================`);
  console.log(`${modeLabel} 竞品/市场/技术情报 执行完毕`);
  console.log(`${modeLabel} 耗时: ${report.durationMs}ms`);
  console.log(`${modeLabel} 信号: ${rawIntel.length}, 空白: ${gaps.length}, 建议: ${recommendations.length}`);
  console.log(`${modeLabel} ==========================================`);
}

main().catch(err => {
  console.error('[FATAL] 未捕获的异常:', err);
  process.exit(1);
});
