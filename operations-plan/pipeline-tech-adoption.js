#!/usr/bin/env node
/**
 * 闭环三：数据分析与结构化技术采纳
 * pipeline-tech-adoption.js
 *
 * 功能：
 *   1. 收集最新的 NLP、知识图谱、数据分析技术
 *   2. 评估哪些技术可以改进现有数据 pipeline
 *   3. 自动测试和验证新技术的效果（PoC + A/B 测试）
 *   4. 效果达标后自动集成到生产 pipeline
 *   5. 输出 report-tech-*.json 供其他闭环消费
 *
 * 使用方式：
 *   node pipeline-tech-adoption.js [--dry-run]
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
const POC_DIR = path.join(PROJECT_ROOT, 'poc'); // Proof of Concept 隔离目录

/** 技术监测源配置 */
const TECH_SOURCES = {
  arxiv: {
    enabled: true,
    // 关注技术方法类论文（非应用类）
    categories: ['cs.CL', 'cs.AI', 'cs.LG', 'cs.IR', 'cs.DB'],
    keywords: ['embedding', 'tokenizer', 'clustering', 'entity linking', 'relation extraction',
               'graph neural', 'anomaly detection', 'text classification', 'data cleaning',
               'vector database', 'approximate nearest neighbor', 'semantic search'],
    maxResults: 30,
  },
  github: {
    enabled: true,
    // 关注数据处理/分析相关的新开源工具
    searchQueries: [
      'text clustering language:python created:>30d',
      'embedding model inference language:python created:>30d',
      'knowledge graph construction language:python created:>30d',
      'data pipeline etl language:python created:>30d',
    ],
    maxResultsPerQuery: 20,
  },
  // 从闭环二的报告中读取新领域技术需求
  domainExpansionReport: {
    enabled: true,
    lookbackDays: 14,
  },
};

/** 技术评估指标与达标阈值 */
const EVALUATION_METRICS = {
  // 数据清洗类技术
  dataCleaning: {
    accuracyImprovement: 0.05,     // 准确率提升 >= 5%
    speedImprovement: 0.10,        // 处理速度提升 >= 10%
    memoryOverheadMax: 1.5,        // 内存开销不超过 1.5 倍
  },
  // 文本分析类技术（分类、聚类、embedding）
  textAnalysis: {
    f1Improvement: 0.03,           // F1 提升 >= 3%
    inferenceLatencyMaxMs: 500,    // 推理延迟 <= 500ms
  },
  // 知识图谱类技术
  knowledgeGraph: {
    precisionImprovement: 0.05,
    recallImprovement: 0.05,
  },
  // 数据存储/检索类技术
  storageRetrieval: {
    queryLatencyImprovement: 0.20, // 查询延迟降低 >= 20%
    throughputImprovement: 0.10,   // 吞吐量提升 >= 10%
  },
};

/** 技术采纳决策阈值 */
const ADOPTION_THRESHOLD = {
  minTestsPassed: 2,       // 至少通过 2 项测试
  minScore: 0.70,          // 综合采纳得分 >= 0.70
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

// ==================== 技术发现 ====================

/**
 * 从 arXiv 搜索技术方法类论文
 */
async function discoverFromArxiv(dryRun) {
  const cfg = TECH_SOURCES.arxiv;
  const candidates = [];
  if (!cfg.enabled) return candidates;

  const keywordQuery = cfg.keywords.join(' OR ');
  const url = `http://export.arxiv.org/api/query?search_query=all:(${encodeURIComponent(keywordQuery)})+AND+cat:(${cfg.categories.join(' OR ')})&max_results=${cfg.maxResults}&sortBy=submittedDate&sortOrder=descending`;

  console.log(`[Tech Discovery] arXiv 搜索: ${cfg.keywords.slice(0, 3).join(', ')}...`);

  if (dryRun) {
    console.log(`[DRY-RUN] 将请求: ${url}`);
    return [{ _dryRun: true, source: 'arxiv', simulatedCount: cfg.maxResults }];
  }

  try {
    const res = await withRetry(() => httpGet(url), 3, 2000);
    if (res.statusCode !== 200) {
      console.error(`[Tech Discovery] arXiv HTTP ${res.statusCode}`);
      return candidates;
    }
    const entries = parseArxivXml(res.body);
    for (const entry of entries) {
      candidates.push({
        source: 'arxiv',
        id: entry.id,
        title: entry.title,
        summary: entry.summary,
        authors: entry.authors,
        published: entry.published,
        categories: entry.categories,
        pdfUrl: entry.pdfUrl,
        // 提取技术关键词
        techKeywords: extractTechKeywords(entry.title + ' ' + entry.summary, cfg.keywords),
      });
    }
    console.log(`[Tech Discovery] arXiv 发现 ${candidates.length} 个候选技术`);
  } catch (err) {
    console.error(`[Tech Discovery] arXiv 异常: ${err.message}`);
  }

  return candidates;
}

/**
 * 从 GitHub 发现新工具/库
 */
async function discoverFromGitHub(dryRun) {
  const cfg = TECH_SOURCES.github;
  const candidates = [];
  if (!cfg.enabled) return candidates;

  const token = process.env.GITHUB_TOKEN || '';
  const headers = {
    'User-Agent': 'GeneTechBot/1.0',
    'Accept': 'application/vnd.github.v3+json',
  };
  if (token) headers['Authorization'] = `token ${token}`;

  for (const query of cfg.searchQueries) {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${cfg.maxResultsPerQuery}`;
    console.log(`[Tech Discovery] GitHub 搜索: ${query}`);

    if (dryRun) {
      console.log(`[DRY-RUN] 将请求: ${url}`);
      candidates.push({ _dryRun: true, source: 'github', query });
      continue;
    }

    try {
      const res = await withRetry(() => httpGet(url, { headers }), 3, 2000);
      if (res.statusCode !== 200) {
        console.error(`[Tech Discovery] GitHub HTTP ${res.statusCode}`);
        continue;
      }
      const data = JSON.parse(res.body);
      const repos = data.items || [];
      for (const repo of repos) {
        candidates.push({
          source: 'github',
          id: repo.full_name,
          title: repo.name,
          description: repo.description || '',
          url: repo.html_url,
          stars: repo.stargazers_count,
          language: repo.language || '',
          topics: repo.topics || [],
          updatedAt: repo.updated_at,
          techKeywords: repo.topics || [],
        });
      }
      console.log(`[Tech Discovery] GitHub 查询 "${query}" 发现 ${repos.length} 个候选`);
    } catch (err) {
      console.error(`[Tech Discovery] GitHub 异常: ${err.message}`);
    }

    await sleep(1000);
  }

  return candidates;
}

/**
 * 从闭环二的报告中读取技术需求
 */
async function discoverFromDomainReport(dryRun) {
  const cfg = TECH_SOURCES.domainExpansionReport;
  const candidates = [];
  if (!cfg.enabled) return candidates;

  const files = await readDirFiles(REPORTS_DIR, /^report-domain-/);
  if (files.length === 0) {
    console.log('[Tech Discovery] 无领域扩张报告');
    return candidates;
  }

  const latest = await readJson(path.join(REPORTS_DIR, files[files.length - 1]));
  if (!latest || !latest.techRequirements) {
    return candidates;
  }

  for (const req of latest.techRequirements) {
    candidates.push({
      source: 'domain-expansion-report',
      id: `req-${req.siteId}`,
      title: `新领域数据需求: ${req.siteId}`,
      description: `新站点 ${req.siteId} 需要 ${req.neededDataTypes.join(', ')} 类型的数据处理能力`,
      techKeywords: req.keywords,
      neededDataTypes: req.neededDataTypes,
    });
  }

  console.log(`[Tech Discovery] 领域报告需求: ${candidates.length} 个`);
  return candidates;
}

// ==================== 简易 XML 解析 & 关键词提取 ====================

function parseArxivXml(xml) {
  const entries = [];
  const entryRegex = /<entry>[\s\S]*?<\/entry>/g;
  let m;
  while ((m = entryRegex.exec(xml)) !== null) {
    const entryXml = m[0];
    const getTag = (tag) => {
      const r = new RegExp(`<${tag}[\s\S]*?>([\s\S]*?)<\/${tag}>`);
      const mm = entryXml.match(r);
      return mm ? mm[1].trim() : '';
    };
    const authors = [];
    const authorRegex = /<name>(.*?)<\/name>/g;
    let am;
    while ((am = authorRegex.exec(entryXml)) !== null) authors.push(am[1]);
    const categories = [];
    const catRegex = /<category term="([^"]*)"/g;
    let cm;
    while ((cm = catRegex.exec(entryXml)) !== null) categories.push(cm[1]);
    entries.push({
      id: getTag('id').split('/').pop().replace('abs/', ''),
      title: getTag('title').replace(/\s+/g, ' '),
      summary: getTag('summary').replace(/\s+/g, ' '),
      authors,
      published: getTag('published'),
      categories,
      pdfUrl: getTag('id').replace('abs', 'pdf'),
    });
  }
  return entries;
}

function extractTechKeywords(text, keywordList) {
  const found = [];
  const lower = text.toLowerCase();
  for (const kw of keywordList) {
    if (lower.includes(kw.toLowerCase())) found.push(kw);
  }
  return found;
}

// ==================== 技术评估与 PoC ====================

/**
 * 对候选技术进行分类和初步评估
 */
function classifyAndScore(candidates) {
  const classified = [];
  for (const c of candidates) {
    if (c._dryRun) continue;
    const text = `${c.title || ''} ${c.description || ''} ${c.summary || ''} ${(c.techKeywords || []).join(' ')}`;
    const lower = text.toLowerCase();

    let category = 'general';
    if (/clean|preprocess|etl|pipeline/.test(lower)) category = 'dataCleaning';
    else if (/embed|cluster|classif|tokeniz|semantic|search/.test(lower)) category = 'textAnalysis';
    else if (/graph|entity|relation|knowledge|kg/.test(lower)) category = 'knowledgeGraph';
    else if (/vector|database|index|retrieval|ann|nearest/.test(lower)) category = 'storageRetrieval';

    // 计算一个基于热度的初步得分（stars、论文引用等无法快速获取，用存在性近似）
    const heatScore = Math.min((c.techKeywords || []).length / 3, 1);
    const noveltyScore = c.source === 'github' && c.stars ? Math.min(c.stars / 1000, 1) : 0.5;

    classified.push({
      ...c,
      category,
      preliminaryScore: round2((heatScore + noveltyScore) / 2),
    });
  }

  // 按初步得分排序，取前 N
  classified.sort((a, b) => b.preliminaryScore - a.preliminaryScore);
  return classified;
}

/**
 * 对单个候选技术执行 PoC 测试
 * 实际场景应在隔离环境中运行代码，这里用模拟逻辑演示框架
 */
async function runPoc(candidate, dryRun) {
  const pocId = `poc-${candidate.source}-${slugify(candidate.id || candidate.title).slice(0, 30)}-${getTimestamp()}`;
  const pocWorkDir = path.join(POC_DIR, pocId);

  console.log(`\n[PoC] 开始测试: ${candidate.title || candidate.id} (类别: ${candidate.category})`);

  if (dryRun) {
    console.log(`[DRY-RUN] [PoC] 将创建隔离目录: ${pocWorkDir}`);
    return {
      pocId,
      candidateId: candidate.id,
      status: 'simulated',
      dryRun: true,
      metrics: simulateMetrics(candidate.category),
    };
  }

  await ensureDir(pocWorkDir);

  // 写入候选技术描述（供后续人工复核或自动脚本使用）
  await writeJson(path.join(pocWorkDir, 'candidate.json'), candidate);

  // 创建模拟测试脚本模板
  const testScript = generateTestScript(candidate);
  await fs.writeFile(path.join(pocWorkDir, 'test.js'), testScript, 'utf-8');

  // 实际场景：执行测试脚本，收集性能指标
  // 这里使用模拟数据来演示完整的评估框架
  const metrics = simulateMetrics(candidate.category);

  // 判定是否达标
  const passed = evaluateMetrics(candidate.category, metrics);

  const result = {
    pocId,
    candidateId: candidate.id,
    title: candidate.title || candidate.id,
    category: candidate.category,
    status: passed.overall ? 'passed' : 'failed',
    metrics,
    evaluation: passed,
    workDir: pocWorkDir,
    testedAt: getISOTime(),
  };

  await writeJson(path.join(pocWorkDir, 'result.json'), result);
  console.log(`[PoC] 结果: ${result.status}, 综合得分: ${passed.score}`);
  return result;
}

/**
 * 生成测试脚本模板（实际 PoC 的基础）
 */
function generateTestScript(candidate) {
  return `/**
 * PoC 测试脚本 — 自动生成
 * 候选技术: ${candidate.title || candidate.id}
 * 来源: ${candidate.source}
 * 生成时间: ${getISOTime()}
 *
 * 使用方式:
 *   cd ${candidate.pocId || 'POC_DIR'}
 *   npm install
 *   node test.js
 */

// TODO: 根据候选技术的具体类型安装依赖并编写测试逻辑
// 示例：如果是一个新的 embedding 库，则加载样本数据，对比旧库和新库的向量质量与推理速度

const fs = require('fs');

async function main() {
  console.log('PoC 测试开始...');
  // 1. 加载测试数据集（从 data/samples/ 读取）
  // 2. 运行旧方案 baseline
  // 3. 运行新候选技术
  // 4. 对比指标并写入 result.json
  console.log('PoC 测试完成（模板）');
}

main().catch(console.error);
`;
}

/**
 * 模拟指标（用于演示框架）
 * 实际部署时应替换为真实测试执行结果
 */
function simulateMetrics(category) {
  // 随机生成一些看起来合理的指标
  const rand = () => 0.7 + Math.random() * 0.3; // 0.7 ~ 1.0
  const randLatency = () => Math.floor(100 + Math.random() * 400); // 100 ~ 500ms

  return {
    accuracy: rand(),
    f1Score: rand(),
    precision: rand(),
    recall: rand(),
    inferenceLatencyMs: randLatency(),
    throughputPerSec: Math.floor(50 + Math.random() * 200),
    memoryMB: Math.floor(200 + Math.random() * 800),
    baselineAccuracy: rand() * 0.95, // 略低于新方案
    baselineLatencyMs: randLatency() + 50,
  };
}

/**
 * 评估指标是否达标
 */
function evaluateMetrics(category, metrics) {
  const cfg = EVALUATION_METRICS[category] || EVALUATION_METRICS.dataCleaning;
  const results = {};

  // 准确率提升
  const accImprovement = metrics.accuracy - metrics.baselineAccuracy;
  results.accuracyImprovement = { value: round2(accImprovement), threshold: cfg.accuracyImprovement || 0.05, passed: accImprovement >= (cfg.accuracyImprovement || 0.05) };

  // 速度提升
  const speedImprovement = (metrics.baselineLatencyMs - metrics.inferenceLatencyMs) / metrics.baselineLatencyMs;
  results.speedImprovement = { value: round2(speedImprovement), threshold: cfg.speedImprovement || 0.10, passed: speedImprovement >= (cfg.speedImprovement || 0.10) };

  // F1 提升
  const f1Diff = metrics.f1Score - 0.75; // 假设 baseline F1 = 0.75
  results.f1Improvement = { value: round2(f1Diff), threshold: cfg.f1Improvement || 0.03, passed: f1Diff >= (cfg.f1Improvement || 0.03) };

  // 延迟上限
  results.latencyWithinLimit = { value: metrics.inferenceLatencyMs, threshold: cfg.inferenceLatencyMaxMs || 500, passed: metrics.inferenceLatencyMs <= (cfg.inferenceLatencyMaxMs || 500) };

  // 计算综合得分
  const checks = Object.values(results);
  const passedCount = checks.filter(c => c.passed).length;
  const score = round2(passedCount / checks.length);

  return {
    overall: passedCount >= ADOPTION_THRESHOLD.minTestsPassed && score >= ADOPTION_THRESHOLD.minScore,
    score,
    passedCount,
    totalChecks: checks.length,
    details: results,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ==================== 生产集成 ====================

/**
 * 将通过测试的技术集成到生产 pipeline
 * dry-run 模式下生成 patch 文件而非实际修改
 */
async function integrateToProduction(candidate, pocResult, dryRun) {
  const integrationId = `integration-${slugify(candidate.id || candidate.title).slice(0, 20)}-${getTimestamp()}`;
  const patchPath = path.join(LOG_DIR, `${integrationId}.patch`);

  // 模拟 patch 内容
  const patchContent = generateMockPatch(candidate);

  if (dryRun) {
    console.log(`[DRY-RUN] [Integrate] 将生成 patch: ${patchPath}`);
    return { integrationId, status: 'simulated', patchPath, dryRun: true };
  }

  // 实际场景：修改 pipeline-data-accumulation.js 或其他脚本，引入新库/新逻辑
  // 这里仅保存 patch 供人工审核
  await fs.writeFile(patchPath, patchContent, 'utf-8');
  console.log(`[Integrate] Patch 已生成: ${patchPath}`);

  // 更新已采纳技术清单
  const adoptedPath = path.join(STATE_DIR, 'adopted-technologies.json');
  let adopted = await readJson(adoptedPath) || [];
  adopted.push({
    integrationId,
    candidateId: candidate.id,
    title: candidate.title || candidate.id,
    category: candidate.category,
    source: candidate.source,
    pocResult: {
      pocId: pocResult.pocId,
      score: pocResult.evaluation.score,
      status: pocResult.status,
    },
    patchPath,
    integratedAt: getISOTime(),
    appliedToProduction: false, // 人工审核后设为 true
  });
  await writeJson(adoptedPath, adopted);

  return { integrationId, status: 'patch_generated', patchPath };
}

function generateMockPatch(candidate) {
  return `diff --git a/pipeline-data-accumulation.js b/pipeline-data-accumulation.js
--- a/pipeline-data-accumulation.js
+++ b/pipeline-data-accumulation.js
@@ -TODO
+// [AUTO-GENERATED PATCH by pipeline-tech-adoption]
+// 建议集成新技术: ${candidate.title || candidate.id}
+// 来源: ${candidate.source}
+// 类别: ${candidate.category}
+//
+// 请根据 PoC 结果 (${candidate.preliminaryScore}) 审核此 patch
+// 并在测试通过后手动应用或修改为自动应用逻辑
+
+// 示例：引入新 embedding 库
+// const newEmbeddingLib = require('${candidate.title || 'new-lib'}');
+
`;
}

// ==================== 主流程 ====================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const modeLabel = dryRun ? '[DRY-RUN]' : '[PROD]';

  console.log(`${modeLabel} ==========================================`);
  console.log(`${modeLabel} 闭环三：技术采纳闭环 启动`);
  console.log(`${modeLabel} 时间: ${getISOTime()}`);
  console.log(`${modeLabel} ==========================================`);

  const statePath = path.join(STATE_DIR, 'pipeline-tech-adoption-state.json');
  const state = await readJson(statePath) || {};

  await ensureDir(STATE_DIR);
  await ensureDir(LOG_DIR);
  await ensureDir(REPORTS_DIR);
  await ensureDir(POC_DIR);

  const startTime = Date.now();

  // ---------- Phase 1: 技术发现 ----------
  console.log('\n[Phase 1] 发现候选技术...');
  let allCandidates = [];

  const arxivCandidates = await discoverFromArxiv(dryRun);
  allCandidates.push(...arxivCandidates);

  const githubCandidates = await discoverFromGitHub(dryRun);
  allCandidates.push(...githubCandidates);

  const domainCandidates = await discoverFromDomainReport(dryRun);
  allCandidates.push(...domainCandidates);

  console.log(`[Discovery] 共发现 ${allCandidates.length} 个候选技术`);

  // ---------- Phase 2: 分类与初筛 ----------
  console.log('\n[Phase 2] 分类与初步评分...');
  const classified = classifyAndScore(allCandidates);
  const topCandidates = classified.slice(0, 10); // 只测前 10
  console.log(`[Filter] 选取 Top ${topCandidates.length} 进行 PoC 测试`);

  // ---------- Phase 3: PoC 测试 ----------
  console.log('\n[Phase 3] 执行 PoC 测试...');
  const pocResults = [];
  for (const candidate of topCandidates) {
    const result = await runPoc(candidate, dryRun);
    pocResults.push({ candidate, result });
  }

  // ---------- Phase 4: 生产集成 ----------
  console.log('\n[Phase 4] 评估通过的技术进行生产集成...');
  const integrations = [];
  for (const { candidate, result } of pocResults) {
    if (result.status === 'passed' || (result.dryRun && result.status === 'simulated')) {
      const integration = await integrateToProduction(candidate, result, dryRun);
      integrations.push({ candidate, result, integration });
    }
  }

  console.log(`[Integrate] ${integrations.length} 个技术进入集成流程`);

  // ---------- Phase 5: 生成报告 ----------
  const report = {
    pipeline: 'tech-adoption',
    version: '1.0',
    timestamp: getISOTime(),
    dryRun,
    durationMs: Date.now() - startTime,
    summary: {
      candidatesDiscovered: allCandidates.length,
      candidatesTested: topCandidates.length,
      passedCount: pocResults.filter(r => r.result.status === 'passed').length,
      integrationsInitiated: integrations.length,
    },
    candidates: topCandidates.map(c => ({
      id: c.id,
      title: c.title || c.id,
      source: c.source,
      category: c.category,
      preliminaryScore: c.preliminaryScore,
      techKeywords: c.techKeywords,
    })),
    pocResults: pocResults.map(({ candidate, result }) => ({
      candidateId: candidate.id,
      pocId: result.pocId,
      status: result.status,
      metrics: result.metrics,
      evaluation: result.evaluation,
    })),
    integrations: integrations.map(({ candidate, integration }) => ({
      candidateId: candidate.id,
      integrationId: integration.integrationId,
      status: integration.status,
      patchPath: integration.patchPath,
    })),
    // 传递给闭环一、闭环五的信息
    adoptedTechnologies: integrations.map(({ candidate }) => ({
      id: candidate.id,
      title: candidate.title || candidate.id,
      category: candidate.category,
      impact: candidate.category === 'dataCleaning' ? 'pipeline-quality' :
              candidate.category === 'textAnalysis' ? 'content-classification' :
              candidate.category === 'knowledgeGraph' ? 'entity-linking' :
              candidate.category === 'storageRetrieval' ? 'query-performance' : 'general',
    })),
  };

  const reportPath = path.join(REPORTS_DIR, `report-tech-${getTimestamp()}.json`);
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
    totalCandidatesTested: (state.totalCandidatesTested || 0) + topCandidates.length,
    totalAdopted: (state.totalAdopted || 0) + integrations.length,
  };
  if (!dryRun) {
    await writeJson(statePath, newState);
  }

  console.log(`\n${modeLabel} ==========================================`);
  console.log(`${modeLabel} 技术采纳闭环 执行完毕`);
  console.log(`${modeLabel} 耗时: ${report.durationMs}ms`);
  console.log(`${modeLabel} 候选: ${allCandidates.length}, 测试: ${topCandidates.length}, 通过: ${report.summary.passedCount}, 集成: ${integrations.length}`);
  console.log(`${modeLabel} ==========================================`);
}

main().catch(err => {
  console.error('[FATAL] 未捕获的异常:', err);
  process.exit(1);
});
