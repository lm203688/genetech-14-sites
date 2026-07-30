#!/usr/bin/env node
/**
 * 闭环一：数据积累流水线
 * pipeline-data-accumulation.js
 *
 * 功能：
 *   1. 从 PubMed、arXiv、OpenAlex、Crossref、GitHub、HuggingFace 等源定时采集最新数据
 *   2. 自动清洗、去重、结构化
 *   3. 自动更新各站点的实体数据（支持增量更新）
 *   4. 生成 changelog 和采集日志
 *   5. 输出 report-data-*.json 供其他闭环消费
 *
 * 使用方式：
 *   node pipeline-data-accumulation.js [--dry-run]
 */

const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');

// ==================== 配置区 ====================

/** 项目根目录 */
const PROJECT_ROOT = path.resolve(__dirname, '..');

/** 数据输出目录 */
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

/** 状态保存目录 */
const STATE_DIR = path.join(PROJECT_ROOT, 'state');

/** 日志目录 */
const LOG_DIR = path.join(PROJECT_ROOT, 'logs');

/** 报告输出目录 */
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');

/** 各站点实体数据目录 */
const SITES_DIR = path.join(PROJECT_ROOT, 'sites');

/** 数据源配置 */
const DATA_SOURCES = {
  arxiv: {
    enabled: true,
    name: 'arXiv',
    // arXiv 分类，与 14 站主题对应
    categories: ['cs.AI', 'cs.CL', 'cs.CV', 'cs.LG', 'cs.IR', 'cs.RO', 'cs.SE', 'cs.DB', 'cs.CR', 'cs.HC'],
    // 每分类最大采集数
    maxResultsPerCategory: 50,
    // 增量模式：只采集上次执行后的新数据
    incremental: true,
    // API 基础地址
    baseUrl: 'http://export.arxiv.org/api/query',
    // 请求间隔（ms），避免限流
    requestIntervalMs: 3000,
  },
  pubmed: {
    enabled: true,
    name: 'PubMed',
    // NCBI E-utilities 查询词
    query: '("artificial intelligence"[Title/Abstract]) OR ("machine learning"[Title/Abstract]) OR ("large language model"[Title/Abstract])',
    maxResults: 100,
    incremental: true,
    baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/',
    requestIntervalMs: 400,
  },
  openalex: {
    enabled: true,
    name: 'OpenAlex',
    // OpenAlex 概念 ID 或名称
    concepts: ['artificial intelligence', 'natural language processing', 'computer vision', 'machine learning'],
    maxResults: 100,
    incremental: true,
    baseUrl: 'https://api.openalex.org/works',
    requestIntervalMs: 100,
  },
  crossref: {
    enabled: true,
    name: 'Crossref',
    query: 'machine learning OR artificial intelligence OR "large language model"',
    maxResults: 100,
    incremental: true,
    baseUrl: 'https://api.crossref.org/works',
    requestIntervalMs: 1000,
  },
  github: {
    enabled: true,
    name: 'GitHub',
    // 搜索主题词
    topics: ['ai-agent', 'mcp', 'rag', 'llm', 'prompt-engineering', 'fine-tuning', 'multimodal-ai'],
    // 按 stars 排序，取最近更新
    sort: 'stars',
    order: 'desc',
    maxResultsPerTopic: 50,
    incremental: true,
    // GitHub API 需配置 GITHUB_TOKEN 环境变量
    baseUrl: 'https://api.github.com/search/repositories',
    requestIntervalMs: 1000,
  },
  huggingface: {
    enabled: true,
    name: 'HuggingFace',
    // 任务类型
    tasks: ['text-generation', 'text-classification', 'question-answering', 'feature-extraction', 'image-classification'],
    maxResultsPerTask: 50,
    incremental: true,
    baseUrl: 'https://huggingface.co/api/models',
    requestIntervalMs: 500,
  },
};

/** 14 站分类映射规则：根据关键词/标签/分类将数据分配到对应站点 */
const SITE_MAPPING_RULES = [
  { site: 'ai-agents', keywords: ['agent', 'multi-agent', 'autonomous agent', 'agentic'], patterns: [/agent/i, /multi-agent/i] },
  { site: 'mcp', keywords: ['mcp', 'model context protocol', 'context protocol'], patterns: [/\bmcp\b/i, /model context protocol/i] },
  { site: 'agent-ecosystem', keywords: ['orchestration', 'workflow', 'langchain', 'autogen', 'crewai'], patterns: [/orchestration/i, /langchain/i, /autogen/i, /crewai/i] },
  { site: 'llm', keywords: ['llm', 'large language model', 'foundation model', 'transformer'], patterns: [/\bllm\b/i, /large language model/i, /foundation model/i] },
  { site: 'rag', keywords: ['rag', 'retrieval-augmented', 'retrieval augmented', 'vector database'], patterns: [/rag/i, /retrieval.augmented/i, /vector database/i, /vectordb/i] },
  { site: 'prompt-engineering', keywords: ['prompt', 'prompt engineering', 'chain-of-thought', 'few-shot'], patterns: [/prompt engineering/i, /chain.of.thought/i, /few.shot/i] },
  { site: 'fine-tuning', keywords: ['fine-tuning', 'finetuning', 'peft', 'lora', 'qlora', 'instruction tuning'], patterns: [/fine.tun/i, /peft/i, /\blora\b/i, /qlora/i] },
  { site: 'evaluation', keywords: ['benchmark', 'evaluation', 'llm-as-a-judge', 'mt-bench'], patterns: [/benchmark/i, /evaluation/i, /llm.as.a.judge/i] },
  { site: 'safety', keywords: ['safety', 'alignment', 'red teaming', 'rlhf', 'constitutional ai'], patterns: [/alignment/i, /red.team/i, /rlhf/i, /constitutional ai/i] },
  { site: 'multimodal', keywords: ['multimodal', 'vision-language', 'vlm', 'image-text'], patterns: [/multimodal/i, /vision.language/i, /\bvlm\b/i] },
  { site: 'tools', keywords: ['ai tool', 'devtools', 'coding assistant', 'copilot', 'code generation'], patterns: [/coding assistant/i, /copilot/i, /code generation/i] },
  { site: 'datasets', keywords: ['dataset', 'data curation', 'data synthesis', 'synthetic data'], patterns: [/dataset/i, /data curation/i, /synthetic data/i] },
  { site: 'papers', keywords: ['survey', 'review', 'paper digest', 'research trend'], patterns: [/survey/i, /review/i] },
  { site: 'community', keywords: ['community', 'conference', 'workshop', 'meetup'], patterns: [/conference/i, /workshop/i, /meetup/i] },
];

// ==================== 工具函数 ====================

/**
 * 获取当前时间戳字符串（YYYYMMDD-HHMMSS 格式）
 */
function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * 获取当前 ISO 时间字符串
 */
function getISOTime() {
  return new Date().toISOString();
}

/**
 * 确保目录存在
 */
async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    // 目录已存在或其他错误，忽略
  }
}

/**
 * 读取 JSON 文件，若不存在返回 null
 */
async function readJson(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * 写入 JSON 文件（格式化）
 */
async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 追加写入日志文件
 */
async function appendLog(filePath, line) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, line + '\n', 'utf-8');
}

/**
 * 通用 HTTP/HTTPS GET 请求封装
 * @param {string} url - 请求地址
 * @param {object} options - 额外选项（headers、timeout 等）
 * @returns {Promise<{statusCode:number,headers:object,body:string}>}
 */
function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { timeout: 30000, ...options }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

/**
 * 指数退避重试封装
 * @param {Function} fn - 异步函数
 * @param {number} maxRetries - 最大重试次数
 * @param {number} baseDelayMs - 基础延迟（ms）
 */
async function withRetry(fn, maxRetries = 3, baseDelayMs = 1000) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, i);
      console.warn(`[Retry ${i + 1}/${maxRetries}] ${err.message}，等待 ${delay}ms 后重试...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 根据标题/摘要/标签判断所属站点
 * @param {object} item - 数据项
 * @returns {string[]} - 匹配的站点 ID 列表
 */
function classifySite(item) {
  const text = `${item.title || ''} ${item.abstract || ''} ${item.summary || ''} ${(item.tags || []).join(' ')} ${(item.categories || []).join(' ')}`;
  const matched = [];
  for (const rule of SITE_MAPPING_RULES) {
    const hit = rule.keywords.some(kw => text.toLowerCase().includes(kw.toLowerCase())) ||
                rule.patterns.some(p => p.test(text));
    if (hit) matched.push(rule.site);
  }
  // 默认归入 papers 站
  return matched.length > 0 ? matched : ['papers'];
}

/**
 * 数据去重键生成
 */
function getDedupKey(item) {
  if (item.doi) return `doi:${item.doi}`;
  if (item.arxivId) return `arxiv:${item.arxivId}`;
  if (item.githubFullName) return `github:${item.githubFullName}`;
  if (item.huggingfaceId) return `hf:${item.huggingfaceId}`;
  if (item.pmid) return `pmid:${item.pmid}`;
  if (item.openAlexId) return `oa:${item.openAlexId}`;
  // 兜底：基于标题哈希
  const hash = Buffer.from(item.title || '').toString('base64').slice(0, 16);
  return `title-hash:${hash}`;
}

// ==================== 数据采集器 ====================

/**
 * 从 arXiv API 采集论文数据
 * @param {boolean} dryRun - 是否仅模拟
 * @param {object} state - 上次执行状态
 */
async function fetchArxiv(dryRun, state) {
  const cfg = DATA_SOURCES.arxiv;
  const results = [];
  if (!cfg.enabled) return results;

  // 构建上次执行后的时间过滤条件
  const lastRun = state?.lastRunTime || null;
  const timeFilter = lastRun ? `+AND+submittedDate:[${lastRun.replace(/-/g, '')}+TO+99991231]` : '';

  for (const cat of cfg.categories) {
    const url = `${cfg.baseUrl}?search_query=cat:${cat}${timeFilter}&start=0&max_results=${cfg.maxResultsPerCategory}&sortBy=submittedDate&sortOrder=descending`;
    console.log(`[arXiv] 采集分类: ${cat}, URL: ${url}`);

    if (dryRun) {
      console.log(`[DRY-RUN] [arXiv] 将请求: ${url}`);
      results.push({ _dryRun: true, source: 'arxiv', category: cat, simulatedCount: cfg.maxResultsPerCategory });
      await sleep(100); // 模拟网络延迟
      continue;
    }

    try {
      const res = await withRetry(() => httpGet(url), 3, 2000);
      if (res.statusCode !== 200) {
        console.error(`[arXiv] 请求失败: HTTP ${res.statusCode}`);
        continue;
      }
      // 简单解析 XML 中的 entry
      const entries = parseArxivXml(res.body);
      console.log(`[arXiv] 分类 ${cat} 获取 ${entries.length} 条`);
      for (const entry of entries) {
        results.push({
          source: 'arxiv',
          arxivId: entry.id,
          title: entry.title,
          abstract: entry.summary,
          authors: entry.authors,
          published: entry.published,
          categories: entry.categories,
          pdfUrl: entry.pdfUrl,
          doi: entry.doi,
          fetchedAt: getISOTime(),
        });
      }
    } catch (err) {
      console.error(`[arXiv] 采集异常: ${err.message}`);
    }

    await sleep(cfg.requestIntervalMs);
  }

  return results;
}

/**
 * 简易 arXiv XML 解析（不引入外部 xml 库）
 */
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
    const getAttr = (tag, attr) => {
      const r = new RegExp(`<${tag}[^>]*?${attr}="([^"]*)"`);
      const mm = entryXml.match(r);
      return mm ? mm[1] : '';
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
      pdfUrl: getAttr('link', 'href'),
      doi: getTag('doi') || '',
    });
  }
  return entries;
}

/**
 * 从 PubMed/E-utilities 采集
 */
async function fetchPubMed(dryRun, state) {
  const cfg = DATA_SOURCES.pubmed;
  const results = [];
  if (!cfg.enabled) return results;

  // Step 1: esearch 获取 ID 列表
  const searchUrl = `${cfg.baseUrl}esearch.fcgi?db=pubmed&term=${encodeURIComponent(cfg.query)}&retmax=${cfg.maxResults}&retmode=json&sort=date`;
  console.log(`[PubMed] 搜索: ${cfg.query}`);

  if (dryRun) {
    console.log(`[DRY-RUN] [PubMed] 将请求: ${searchUrl}`);
    return [{ _dryRun: true, source: 'pubmed', simulatedCount: cfg.maxResults }];
  }

  try {
    const searchRes = await withRetry(() => httpGet(searchUrl), 3, 2000);
    const searchData = JSON.parse(searchRes.body);
    const idlist = searchData.esearchresult?.idlist || [];
    console.log(`[PubMed] 检索到 ${idlist.length} 条记录`);

    if (idlist.length === 0) return results;

    // Step 2: esummary 获取详情（分批，每批 200）
    const batchSize = 200;
    for (let i = 0; i < idlist.length; i += batchSize) {
      const batch = idlist.slice(i, i + batchSize);
      const summaryUrl = `${cfg.baseUrl}esummary.fcgi?db=pubmed&id=${batch.join(',')}&retmode=json`;
      const summaryRes = await withRetry(() => httpGet(summaryUrl), 3, 2000);
      const summaryData = JSON.parse(summaryRes.body);
      const resultMap = summaryData.result || {};
      for (const pmid of batch) {
        const info = resultMap[pmid];
        if (!info) continue;
        results.push({
          source: 'pubmed',
          pmid,
          title: info.title || '',
          abstract: '', // esummary 不返回 abstract，如需可额外调用 efetch
          authors: (info.authors || []).map(a => a.name),
          pubDate: info.pubdate || '',
          journal: info.fulljournalname || '',
          doi: info.articleids?.find(a => a.idtype === 'doi')?.value || '',
          fetchedAt: getISOTime(),
        });
      }
      await sleep(cfg.requestIntervalMs);
    }
  } catch (err) {
    console.error(`[PubMed] 采集异常: ${err.message}`);
  }

  return results;
}

/**
 * 从 OpenAlex API 采集
 */
async function fetchOpenAlex(dryRun, state) {
  const cfg = DATA_SOURCES.openalex;
  const results = [];
  if (!cfg.enabled) return results;

  for (const concept of cfg.concepts) {
    const url = `${cfg.baseUrl}?filter=concepts.display_name:${encodeURIComponent(concept)}&per-page=${cfg.maxResults}&sort=publication_date:desc`;
    console.log(`[OpenAlex] 采集概念: ${concept}`);

    if (dryRun) {
      console.log(`[DRY-RUN] [OpenAlex] 将请求: ${url}`);
      results.push({ _dryRun: true, source: 'openalex', concept, simulatedCount: cfg.maxResults });
      continue;
    }

    try {
      const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': 'GeneTechBot/1.0 (mailto:ops@genetech.example)' } }), 3, 2000);
      if (res.statusCode !== 200) {
        console.error(`[OpenAlex] 请求失败: HTTP ${res.statusCode}`);
        continue;
      }
      const data = JSON.parse(res.body);
      const works = data.results || [];
      console.log(`[OpenAlex] 概念 ${concept} 获取 ${works.length} 条`);
      for (const w of works) {
        results.push({
          source: 'openalex',
          openAlexId: w.id,
          title: w.display_name || '',
          abstract: w.abstract_inverted_index ? reconstructAbstract(w.abstract_inverted_index) : '',
          authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean),
          pubDate: w.publication_date || '',
          doi: w.doi || '',
          concepts: (w.concepts || []).map(c => c.display_name),
          fetchedAt: getISOTime(),
        });
      }
    } catch (err) {
      console.error(`[OpenAlex] 采集异常: ${err.message}`);
    }

    await sleep(cfg.requestIntervalMs);
  }

  return results;
}

/**
 * 从 OpenAlex 的 inverted_index 重建摘要
 */
function reconstructAbstract(invIndex) {
  if (!invIndex) return '';
  const words = [];
  for (const [word, positions] of Object.entries(invIndex)) {
    for (const pos of positions) {
      words[pos] = word;
    }
  }
  return words.filter(Boolean).join(' ');
}

/**
 * 从 Crossref API 采集
 */
async function fetchCrossref(dryRun, state) {
  const cfg = DATA_SOURCES.crossref;
  const results = [];
  if (!cfg.enabled) return results;

  const url = `${cfg.baseUrl}?query=${encodeURIComponent(cfg.query)}&rows=${cfg.maxResults}&sort=published&order=desc`;
  console.log(`[Crossref] 查询: ${cfg.query}`);

  if (dryRun) {
    console.log(`[DRY-RUN] [Crossref] 将请求: ${url}`);
    return [{ _dryRun: true, source: 'crossref', simulatedCount: cfg.maxResults }];
  }

  try {
    const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': 'GeneTechBot/1.0 (mailto:ops@genetech.example)' } }), 3, 2000);
    if (res.statusCode !== 200) {
      console.error(`[Crossref] 请求失败: HTTP ${res.statusCode}`);
      return results;
    }
    const data = JSON.parse(res.body);
    const items = data.message?.items || [];
    console.log(`[Crossref] 获取 ${items.length} 条`);
    for (const item of items) {
      results.push({
        source: 'crossref',
        doi: item.DOI || '',
        title: (item.title || [])[0] || '',
        abstract: item.abstract || '',
        authors: (item.author || []).map(a => `${a.given || ''} ${a.family || ''}`.trim()),
        pubDate: item.publishedPrint?.dateParts?.[0]?.join('-') || item.created?.['date-time'] || '',
        publisher: item.publisher || '',
        type: item.type || '',
        fetchedAt: getISOTime(),
      });
    }
  } catch (err) {
    console.error(`[Crossref] 采集异常: ${err.message}`);
  }

  return results;
}

/**
 * 从 GitHub API 采集仓库数据
 *
 * 注意：GitHub Search API 不支持在单次查询中组合多个 topic: 限定符，
 * 否则会返回 HTTP 422。因此每个主题必须单独发起一次请求（单 topic 查询）。
 * 同时通过 GITHUB_TOKEN 环境变量支持认证请求以提升速率限制（5000 次/小时）。
 */
async function fetchGitHub(dryRun, state) {
  const cfg = DATA_SOURCES.github;
  const results = [];
  if (!cfg.enabled) return results;

  // 读取 GITHUB_TOKEN 环境变量以提升 API 速率限制
  // 未设置 token 时为匿名请求，速率限制为 60 次/小时
  // 设置 token 后为认证请求，速率限制提升至 5000 次/小时
  const token = process.env.GITHUB_TOKEN || '';
  const headers = {
    'User-Agent': 'GeneTechBot/1.0',
    'Accept': 'application/vnd.github.v3+json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
    console.log('[GitHub] 已检测到 GITHUB_TOKEN 环境变量，使用认证请求（速率限制 5000 次/小时）');
  } else {
    console.warn('[GitHub] 未设置 GITHUB_TOKEN 环境变量，使用匿名请求（速率限制 60 次/小时）');
  }

  // 逐个主题单独查询，每次仅使用一个 topic: 限定符，避免组合多 topic 触发 HTTP 422
  for (const topic of cfg.topics) {
    // 单 topic 查询：q=topic:<topic>
    // 仅对 topic 值进行 URL 编码，保留 "topic:" 前缀不被编码
    const searchQuery = `topic:${encodeURIComponent(topic)}`;
    const url = `${cfg.baseUrl}?q=${searchQuery}&sort=${cfg.sort}&order=${cfg.order}&per_page=${cfg.maxResultsPerTopic}`;
    console.log(`[GitHub] 采集 topic: ${topic}`);

    if (dryRun) {
      console.log(`[DRY-RUN] [GitHub] 将请求: ${url}`);
      results.push({ _dryRun: true, source: 'github', topic, simulatedCount: cfg.maxResultsPerTopic });
      continue;
    }

    try {
      const res = await withRetry(() => httpGet(url, { headers }), 3, 2000);
      if (res.statusCode !== 200) {
        // 针对 422 错误输出更明确的诊断信息
        if (res.statusCode === 422) {
          console.error(`[GitHub] topic "${topic}" 请求失败: HTTP 422（搜索语法需调整为单topic查询）`);
          console.error(`[GitHub] 请求 URL: ${url}`);
          console.error(`[GitHub] 响应内容: ${res.body.slice(0, 300)}`);
        } else {
          console.error(`[GitHub] topic "${topic}" 请求失败: HTTP ${res.statusCode}, body: ${res.body.slice(0, 200)}`);
        }
        continue;
      }
      const data = JSON.parse(res.body);
      const repos = data.items || [];
      console.log(`[GitHub] topic ${topic} 获取 ${repos.length} 条`);
      for (const repo of repos) {
        results.push({
          source: 'github',
          githubFullName: repo.full_name,
          name: repo.name,
          owner: repo.owner?.login || '',
          description: repo.description || '',
          url: repo.html_url,
          stars: repo.stargazers_count || 0,
          forks: repo.forks_count || 0,
          language: repo.language || '',
          topics: repo.topics || [],
          updatedAt: repo.updated_at,
          createdAt: repo.created_at,
          fetchedAt: getISOTime(),
        });
      }
    } catch (err) {
      console.error(`[GitHub] topic "${topic}" 采集异常: ${err.message}`);
    }

    await sleep(cfg.requestIntervalMs);
  }

  return results;
}

/**
 * 从 HuggingFace Hub API 采集模型信息
 *
 * 针对中国大陆网络环境优化：
 *   - 主域名 huggingface.co 经常因网络/DNS 问题出现 ETIMEDOUT/ECONNREFUSED
 *   - 增加 https://hf-mirror.com/api/models 镜像作为兜底，当主域名因网络问题
 *     不可达时自动切换到镜像重试
 *   - HuggingFace 专用超时时间提升至 45s（httpGet 默认为 30s）
 *   - 保留原有 withRetry 指数退避逻辑，包裹在每个 URL 的请求外层
 */
async function fetchHuggingFace(dryRun, state) {
  const cfg = DATA_SOURCES.huggingface;
  const results = [];
  if (!cfg.enabled) return results;

  // HuggingFace 主域名与镜像地址，依次尝试直到成功
  // 镜像 hf-mirror.com 在中国大陆访问更稳定，作为主域名超时/拒连时的兜底
  const HF_URLS = [
    cfg.baseUrl,                        // https://huggingface.co/api/models
    'https://hf-mirror.com/api/models', // 中国大陆镜像
  ];

  // HuggingFace 专用超时时间（45s），比 httpGet 默认的 30s 更长
  const HF_TIMEOUT_MS = 45000;

  // 判断是否为可触发镜像切换的网络类错误
  // 包括 ETIMEDOUT / ECONNREFUSED / ENOTFOUND / EAI_AGAIN / EHOSTUNREACH / ECONNRESET / timeout
  const isNetworkError = (msg) => /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ECONNRESET|timeout/i.test(msg || '');

  for (const task of cfg.tasks) {
    const queryString = `?pipeline_tag=${encodeURIComponent(task)}&limit=${cfg.maxResultsPerTask}&sort=downloads&direction=-1`;
    console.log(`[HuggingFace] 采集 task: ${task}`);

    if (dryRun) {
      console.log(`[DRY-RUN] [HuggingFace] 将请求: ${HF_URLS[0]}${queryString}`);
      results.push({ _dryRun: true, source: 'huggingface', task, simulatedCount: cfg.maxResultsPerTask });
      continue;
    }

    let models = null;
    let lastErr = null;
    let usedBaseUrl = null;

    // 依次尝试主 URL 与镜像 URL，直到有一个成功
    for (let ui = 0; ui < HF_URLS.length; ui++) {
      const baseUrl = HF_URLS[ui];
      const url = `${baseUrl}${queryString}`;
      const urlTag = ui === 0 ? '主域名' : '镜像';

      try {
        // 保留原有 withRetry 重试逻辑，包裹在 URL 循环内
        // 每个单独的 URL 都会先经过 3 次指数退避重试
        const res = await withRetry(() => httpGet(url, { timeout: HF_TIMEOUT_MS }), 3, 2000);
        if (res.statusCode !== 200) {
          console.warn(`[HuggingFace] ${urlTag}请求失败: HTTP ${res.statusCode} (${url})`);
          lastErr = new Error(`HTTP ${res.statusCode}`);
          // 非 200 也尝试下一个 URL（镜像），避免单点故障
          continue;
        }
        models = JSON.parse(res.body);
        usedBaseUrl = baseUrl;
        if (ui > 0) {
          console.log(`[HuggingFace] 已切换至镜像 URL: ${baseUrl}`);
        }
        break;
      } catch (err) {
        console.warn(`[HuggingFace] ${urlTag}请求异常: ${err.message} (${url})`);
        lastErr = err;
        // 仅在 ETIMEDOUT/ECONNREFUSED 等网络类错误时尝试下一个 URL（镜像）
        // 非网络类错误（如 JSON 解析异常）不必再尝试镜像
        if (!isNetworkError(err.message)) {
          break;
        }
      }
    }

    if (models === null) {
      console.error(`[HuggingFace] 采集失败: ${lastErr?.message || '未知错误'}（主域名与镜像均不可用）`);
      continue;
    }

    console.log(`[HuggingFace] task ${task} 获取 ${models.length} 条`);
    for (const m of models) {
      results.push({
        source: 'huggingface',
        huggingfaceId: m.modelId || m.id,
        name: m.modelId || m.id,
        task: m.pipeline_tag || task,
        tags: m.tags || [],
        downloads: m.downloads || 0,
        likes: m.likes || 0,
        description: (m.cardData?.description) || '',
        // 模型页面始终指向官方 huggingface.co，保持链接一致性
        url: `https://huggingface.co/${m.modelId || m.id}`,
        fetchedAt: getISOTime(),
      });
    }

    await sleep(cfg.requestIntervalMs);
  }

  return results;
}

// ==================== 数据清洗与结构化 ====================

/**
 * 全局去重：基于去重键，保留最新的一条
 * @param {object[]} items
 */
function deduplicate(items) {
  const map = new Map();
  for (const item of items) {
    if (item._dryRun) continue;
    const key = getDedupKey(item);
    const existing = map.get(key);
    if (!existing || new Date(item.fetchedAt) > new Date(existing.fetchedAt)) {
      map.set(key, item);
    }
  }
  return Array.from(map.values());
}

/**
 * 数据清洗：去除空白、标准化字段、过滤垃圾数据
 */
function cleanItems(items) {
  return items.map(item => {
    if (item._dryRun) return item;
    const cleaned = { ...item };
    if (cleaned.title) cleaned.title = cleaned.title.trim().replace(/\s+/g, ' ');
    if (cleaned.abstract) cleaned.abstract = cleaned.abstract.trim().replace(/\s+/g, ' ');
    if (cleaned.description) cleaned.description = cleaned.description.trim().replace(/\s+/g, ' ');
    // 过滤无标题的脏数据
    if (!cleaned.title && !cleaned.name) return null;
    return cleaned;
  }).filter(Boolean);
}

/**
 * 将数据项按站点分类
 */
function distributeToSites(items) {
  const distribution = {};
  for (const siteRule of SITE_MAPPING_RULES) {
    distribution[siteRule.site] = [];
  }

  for (const item of items) {
    if (item._dryRun) continue;
    const sites = classifySite(item);
    for (const site of sites) {
      if (!distribution[site]) distribution[site] = [];
      distribution[site].push(item);
    }
  }

  return distribution;
}

// ==================== 数据持久化 ====================

/**
 * 将分类后的数据写入各站点目录
 * @param {object} distribution - 站点 -> 数据项数组
 * @param {boolean} dryRun
 */
async function persistToSites(distribution, dryRun) {
  const persisted = {};
  for (const [site, items] of Object.entries(distribution)) {
    if (items.length === 0) continue;
    const siteDir = path.join(SITES_DIR, site, '_data');
    const filePath = path.join(siteDir, 'entities.json');

    if (dryRun) {
      console.log(`[DRY-RUN] 将写入 ${items.length} 条数据到 ${filePath}`);
      persisted[site] = { filePath, count: items.length, dryRun: true };
      continue;
    }

    // 读取已有数据并增量合并
    let existing = [];
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      existing = JSON.parse(content);
    } catch {
      // 文件不存在则创建
    }

    // 基于去重键合并
    const existingMap = new Map(existing.map(e => [getDedupKey(e), e]));
    let added = 0;
    let updated = 0;
    for (const item of items) {
      const key = getDedupKey(item);
      if (existingMap.has(key)) {
        existingMap.set(key, item); // 覆盖更新
        updated++;
      } else {
        existingMap.set(key, item);
        added++;
      }
    }
    const merged = Array.from(existingMap.values());

    await ensureDir(siteDir);
    await writeJson(filePath, merged);
    console.log(`[Persist] 站点 ${site}: 新增 ${added}, 更新 ${updated}, 总计 ${merged.length}`);
    persisted[site] = { filePath, count: merged.length, added, updated };
  }
  return persisted;
}

/**
 * 生成 changelog
 */
async function generateChangelog(report, dryRun) {
  const ts = getTimestamp();
  const logPath = path.join(LOG_DIR, `changelog-data-${ts}.md`);
  const lines = [
    `# 数据积累流水线 Changelog - ${ts}`,
    '',
    `- 执行时间: ${getISOTime()}`,
    `- Dry-Run: ${dryRun}`,
    '',
    '## 各数据源采集统计',
    '',
  ];

  for (const [source, stat] of Object.entries(report.sourceStats || {})) {
    lines.push(`### ${source}`);
    lines.push(`- 原始采集: ${stat.rawCount} 条`);
    lines.push(`- 去重后: ${stat.dedupedCount} 条`);
    lines.push(`- 清洗后: ${stat.cleanedCount} 条`);
    lines.push('');
  }

  lines.push('## 站点分发统计');
  lines.push('');
  for (const [site, info] of Object.entries(report.sitePersisted || {})) {
    lines.push(`- **${site}**: ${info.count} 条 (新增 ${info.added || 0}, 更新 ${info.updated || 0})`);
  }
  lines.push('');

  const content = lines.join('\n');

  if (dryRun) {
    console.log(`[DRY-RUN] 将生成 changelog: ${logPath}`);
    console.log(content.slice(0, 500) + '...');
    return { logPath, content, dryRun: true };
  }

  await ensureDir(LOG_DIR);
  await fs.writeFile(logPath, content, 'utf-8');
  console.log(`[Changelog] 已生成: ${logPath}`);
  return { logPath, content };
}

// ==================== 主流程 ====================

/**
 * 主入口函数
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const modeLabel = dryRun ? '[DRY-RUN]' : '[PROD]';
  console.log(`${modeLabel} ==========================================`);
  console.log(`${modeLabel} 闭环一：数据积累流水线 启动`);
  console.log(`${modeLabel} 时间: ${getISOTime()}`);
  console.log(`${modeLabel} ==========================================`);

  // 读取上次执行状态
  const statePath = path.join(STATE_DIR, 'pipeline-data-accumulation-state.json');
  const state = await readJson(statePath) || {};

  // 确保目录存在
  await ensureDir(DATA_DIR);
  await ensureDir(STATE_DIR);
  await ensureDir(LOG_DIR);
  await ensureDir(REPORTS_DIR);
  await ensureDir(SITES_DIR);

  const startTime = Date.now();
  const allItems = [];
  const sourceStats = {};

  // ---------- 1. 多源并发采集 ----------
  console.log('\n[Phase 1] 开始多源数据采集...');

  const fetchers = [
    { name: 'arxiv', fn: () => fetchArxiv(dryRun, state) },
    { name: 'pubmed', fn: () => fetchPubMed(dryRun, state) },
    { name: 'openalex', fn: () => fetchOpenAlex(dryRun, state) },
    { name: 'crossref', fn: () => fetchCrossref(dryRun, state) },
    { name: 'github', fn: () => fetchGitHub(dryRun, state) },
    { name: 'huggingface', fn: () => fetchHuggingFace(dryRun, state) },
  ];

  const fetchResults = await Promise.allSettled(fetchers.map(f => f.fn()));

  for (let i = 0; i < fetchers.length; i++) {
    const { name } = fetchers[i];
    const result = fetchResults[i];
    if (result.status === 'fulfilled') {
      const items = result.value;
      const rawCount = items.filter(it => !it._dryRun).length;
      const dryRunItems = items.filter(it => it._dryRun);
      allItems.push(...items);
      sourceStats[name] = { rawCount, dedupedCount: 0, cleanedCount: 0, status: 'success', dryRunCount: dryRunItems.length };
      console.log(`[Fetcher] ${name} 成功，原始数据 ${rawCount} 条` + (dryRunItems.length ? ` (含 ${dryRunItems.length} 条模拟)` : ''));
    } else {
      sourceStats[name] = { rawCount: 0, dedupedCount: 0, cleanedCount: 0, status: 'failed', error: result.reason?.message };
      console.error(`[Fetcher] ${name} 失败: ${result.reason?.message}`);
    }
  }

  // ---------- 2. 全局去重 ----------
  console.log('\n[Phase 2] 全局去重...');
  const dedupedItems = deduplicate(allItems);
  console.log(`[Deduplicate] ${allItems.length} -> ${dedupedItems.length} (去重 ${allItems.length - dedupedItems.length} 条)`);
  for (const name of Object.keys(sourceStats)) {
    // 简单统计：按 source 字段分组
    const count = dedupedItems.filter(it => it.source === name).length;
    sourceStats[name].dedupedCount = count;
  }

  // ---------- 3. 数据清洗 ----------
  console.log('\n[Phase 3] 数据清洗...');
  const cleanedItems = cleanItems(dedupedItems);
  console.log(`[Clean] ${dedupedItems.length} -> ${cleanedItems.length} (过滤 ${dedupedItems.length - cleanedItems.length} 条)`);
  for (const name of Object.keys(sourceStats)) {
    sourceStats[name].cleanedCount = cleanedItems.filter(it => it.source === name).length;
  }

  // ---------- 4. 站点分发与持久化 ----------
  console.log('\n[Phase 4] 站点分发与持久化...');
  const distribution = distributeToSites(cleanedItems);
  const sitePersisted = await persistToSites(distribution, dryRun);

  // ---------- 5. 生成 Changelog ----------
  console.log('\n[Phase 5] 生成 Changelog...');
  const reportBase = { sourceStats, sitePersisted, totalItems: cleanedItems.length };
  const changelogInfo = await generateChangelog(reportBase, dryRun);

  // ---------- 6. 输出 JSON 报告（供其他闭环消费） ----------
  const report = {
    pipeline: 'data-accumulation',
    version: '1.0',
    timestamp: getISOTime(),
    dryRun,
    durationMs: Date.now() - startTime,
    summary: {
      totalRaw: allItems.length,
      totalDeduped: dedupedItems.length,
      totalCleaned: cleanedItems.length,
      sitesAffected: Object.keys(sitePersisted).length,
    },
    sourceStats,
    sitePersisted,
    // 热点标签统计（传递给闭环二、闭环四）
    hotTags: extractHotTags(cleanedItems),
    // 新增实体列表摘要（传递给闭环四作为推广素材）
    newEntitiesSummary: cleanedItems.slice(0, 50).map(it => ({
      source: it.source,
      title: it.title || it.name || '',
      sites: classifySite(it),
      doi: it.doi || '',
      url: it.url || it.pdfUrl || '',
    })),
    changelog: changelogInfo,
  };

  const reportPath = path.join(REPORTS_DIR, `report-data-${getTimestamp()}.json`);
  if (dryRun) {
    console.log(`[DRY-RUN] 将生成报告: ${reportPath}`);
  } else {
    await writeJson(reportPath, report);
    console.log(`[Report] 已生成: ${reportPath}`);
  }

  // ---------- 7. 保存执行状态 ----------
  const newState = {
    lastRunTime: getISOTime(),
    lastReportPath: reportPath,
    totalRuns: (state.totalRuns || 0) + 1,
    cumulativeItems: (state.cumulativeItems || 0) + cleanedItems.length,
  };
  if (!dryRun) {
    await writeJson(statePath, newState);
    console.log(`[State] 状态已更新: ${statePath}`);
  }

  // ---------- 8. 控制台摘要 ----------
  console.log(`\n${modeLabel} ==========================================`);
  console.log(`${modeLabel} 数据积累流水线 执行完毕`);
  console.log(`${modeLabel} 耗时: ${report.durationMs}ms`);
  console.log(`${modeLabel} 清洗后数据: ${report.summary.totalCleaned} 条`);
  console.log(`${modeLabel} 影响站点: ${report.summary.sitesAffected} 个`);
  console.log(`${modeLabel} 报告路径: ${reportPath}`);
  console.log(`${modeLabel} ==========================================`);

  // 非 dry-run 且执行失败的数据源超过一半则退出码非零
  const failedSources = Object.values(sourceStats).filter(s => s.status === 'failed').length;
  const totalEnabled = Object.values(DATA_SOURCES).filter(s => s.enabled).length;
  if (!dryRun && failedSources > totalEnabled / 2) {
    console.error(`[ERROR] 超过半数数据源采集失败 (${failedSources}/${totalEnabled})`);
    process.exit(1);
  }
}

/**
 * 提取热点标签（基于关键词频率）
 */
function extractHotTags(items) {
  const freq = {};
  for (const item of items) {
    if (item._dryRun) continue;
    const text = `${item.title || ''} ${item.abstract || ''} ${item.description || ''}`;
    // 简单基于规则统计关键词出现次数
    for (const rule of SITE_MAPPING_RULES) {
      for (const kw of rule.keywords) {
        if (text.toLowerCase().includes(kw.toLowerCase())) {
          freq[kw] = (freq[kw] || 0) + 1;
        }
      }
    }
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag, count]) => ({ tag, count }));
}

// 执行入口
main().catch(err => {
  console.error('[FATAL] 未捕获的异常:', err);
  process.exit(1);
});
