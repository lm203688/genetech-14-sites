#!/usr/bin/env node
/**
 * 站点感知数据回填 / 扩充流水线
 * pipeline-data-backfill.js
 *
 * 背景（修复报告"5 个科学站点为空壳"的根因）：
 *   原 data-accumulation 的 SITE_MAPPING_RULES 全是 AI 主题词（ai-agents/mcp/llm…），
 *   与 14 个科学领域站点完全不匹配；且写入路径 sites/<site>/_data/ 不存在于线上结构。
 *   导致 alien-minerals/biocomputing/bionic-ai/deep-sea-tech/quantum-computing 等站永不被灌数据。
 *
 * 本管线做法：
 *   1. 为每个站点定义"领域检索词" SITE_QUERIES（科学领域语义，而非 AI 关键词）
 *   2. 用 OpenAlex（主通道，稳定免 key）+ arXiv + Crossref + PubMed 真实抓取
 *   3. 归一化为线上 schema：{id,name,source,abstract,url,authors,tags,confidence,sites,publishedDate,addedAt}
 *   4. 合并写入 <site>/website/api/entities.json（按 id 去重，绝不覆盖既有数据）
 *   5. 刷新 index.json（totalEntities / lastUpdated / categories）
 *
 * 用法：
 *   node pipeline-data-backfill.js [--dry-run] [--site=quantum-computing] [--limit=400] [--max-entities=3000]
 *
 * 游标分页：四个数据源此前均硬编码第 1 页，导致每轮抓回完全相同的条目、去重后新增恒为 0。
 * 现按站点维护 offset 游标（state/backfill-cursor.json），每轮推进一页，持续抓到新数据。
 */

const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');

// 每个站点抓取的领域检索词（科学语义）
const SITE_QUERIES = {
  'quantum-computing': ['quantum computing', 'quantum error correction', 'superconducting qubit', 'quantum algorithm', 'quantum supremacy', 'topological qubit', 'quantum key distribution'],
  'alien-minerals': ['extraterrestrial minerals', 'meteorite mineralogy', 'lunar regolith', 'asteroid mining', 'space resources', 'lunar ice', 'astrobiology minerals'],
  'biocomputing': ['biological computing', 'DNA computing', 'molecular computing', 'synthetic biology circuits', 'living computers', 'microbial computing'],
  'bionic-ai': ['brain-computer interface', 'neurorobotics', 'bionic prosthesis', 'neural engineering', 'neuroprosthetics', 'bionic vision'],
  'deep-sea-tech': ['deep sea technology', 'underwater robotics', 'marine robotics', 'ocean observation', 'autonomous underwater vehicle', 'subsea engineering'],
  'brain-science': ['neuroscience', 'brain imaging', 'neural plasticity', 'connectome', 'neurogenesis', 'cognitive neuroscience'],
  'life-science': ['life sciences', 'systems biology', 'cell biology', 'genomics', 'proteomics', 'molecular biology'],
  'new-energy': ['renewable energy', 'solid-state battery', 'hydrogen energy', 'perovskite solar cell', 'lithium battery', 'grid energy storage'],
  'nuclear-energy': ['nuclear fusion', 'tokamak', 'small modular reactor', 'nuclear fission', 'fusion energy', 'plasma confinement'],
  'robot-parts': ['robot actuator', 'robotic gripper', 'servo motor', 'tactile sensor', 'soft robotics', 'robotics components'],
  'tcm-tools': ['traditional Chinese medicine', 'herbal medicine', 'acupuncture', 'medicinal plant', 'TCM formula', 'pharmacology of herbs'],
  'genetech-tools': ['genomics', 'CRISPR gene editing', 'gene therapy', 'DNA sequencing', 'genome engineering', 'gene regulation'],
  'exo-science': ['exoplanet', 'astrobiology', 'biosignature', 'extraterrestrial life', 'SETI', 'planetary habitability'],
  'agent-ecosystem': ['AI agent', 'multi-agent system', 'agent orchestration', 'LLM agent framework', 'autonomous agent', 'agentic workflow'],
};

const SOURCE_CONFIDENCE = {
  pubmed: 0.82, arxiv: 0.78, openalex: 0.72, crossref: 0.7, github: 0.6, huggingface: 0.6,
};

// ==================== 工具函数 ====================

function getISOTime() { return new Date().toISOString(); }

function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { timeout: 30000, ...options }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function withRetry(fn, maxRetries = 3, baseDelayMs = 1000) {
  for (let i = 0; i <= maxRetries; i++) {
    try { return await fn(); } catch (err) {
      if (i === maxRetries) throw err;
      await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, i)));
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function readJsonSafe(p) { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } }
async function ensureDir(d) { try { await fs.mkdir(d, { recursive: true }); } catch {} }

// OpenAlex inverted_index -> 文本摘要
function reconstructAbstract(invIndex) {
  if (!invIndex) return '';
  const words = [];
  for (const [word, positions] of Object.entries(invIndex)) {
    for (const pos of positions) words[pos] = word;
  }
  return words.filter(Boolean).join(' ');
}

// 简化 arXiv XML 解析
function parseArxivXml(xml) {
  const entries = [];
  const entryRegex = /<entry>[\s\S]*?<\/entry>/g;
  let m;
  while ((m = entryRegex.exec(xml)) !== null) {
    const ex = m[0];
    const getTag = (t) => { const r = new RegExp(`<${t}[\\s\\S]*?>([\\s\\S]*?)<\\/${t}>`); const mm = ex.match(r); return mm ? mm[1].trim() : ''; };
    const getAttr = (t, a) => { const r = new RegExp(`<${t}[^>]*?${a}="([^"]*)"`); const mm = ex.match(r); return mm ? mm[1] : ''; };
    const authors = []; const ar = /<name>(.*?)<\/name>/g; let am; while ((am = ar.exec(ex)) !== null) authors.push(am[1]);
    const cats = []; const cr = /<category term="([^"]*)"/g; let cm; while ((cm = cr.exec(ex)) !== null) cats.push(cm[1]);
    entries.push({
      id: getTag('id').split('/').pop().replace('abs/', ''),
      title: getTag('title').replace(/\s+/g, ' '),
      summary: getTag('summary').replace(/\s+/g, ' '),
      authors, published: getTag('published'), categories: cats,
      pdfUrl: getAttr('link', 'href'), doi: getTag('doi') || '',
    });
  }
  return entries;
}

// ==================== 各数据源抓取（带领域检索词） ====================

async function fetchOpenAlex(query, max, offset = 0) {
  // OpenAlex 用 page 分页（page 从 1 开始）；page*per-page 上限 10000，超出需 cursor
  const page = Math.floor(offset / max) + 1;
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${max}&page=${page}&sort=relevance_score:desc`;
  try {
    const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': 'GeneTechBot/1.0 (mailto:ops@genetech.example)' } }), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.results || []).map(w => ({
      id: 'oa:' + String(w.id || '').split('/').pop(),
      source: 'openalex',
      name: w.display_name || '',
      abstract: reconstructAbstract(w.abstract_inverted_index),
      url: w.doi || w.id || '',
      authors: (w.authorships || []).map(a => a.author?.display_name).filter(Boolean),
      tags: (w.concepts || []).slice(0, 5).map(c => c.display_name),
      publishedDate: w.publication_date || '',
      doi: w.doi || '',
    }));
  } catch { return []; }
}

async function fetchArxiv(query, max, offset = 0) {
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=${offset}&max_results=${max}&sortBy=relevance`;
  try {
    const res = await withRetry(() => httpGet(url), 3, 1500);
    if (res.statusCode !== 200) return [];
    return parseArxivXml(res.body).map(e => ({
      id: 'arxiv:' + e.id, source: 'arxiv', name: e.title, abstract: e.summary,
      url: e.pdfUrl || '', authors: e.authors, tags: e.categories,
      publishedDate: e.published, doi: e.doi,
    }));
  } catch { return []; }
}

async function fetchCrossref(query, max, offset = 0) {
  // Crossref offset 深分页上限 10000，超出需 cursor=*
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${max}&offset=${offset}&sort=relevance`;
  try {
    const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': 'GeneTechBot/1.0 (mailto:ops@genetech.example)' } }), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.message?.items || []).map(it => ({
      id: it.DOI ? 'doi:' + it.DOI : 'cr:' + (it.URL || Math.random().toString(36)),
      source: 'crossref', name: (it.title || [''])[0] || '', abstract: it.abstract || '',
      url: it.URL || '', authors: (it.author || []).map(a => `${a.given || ''} ${a.family || ''}`.trim()).filter(Boolean),
      tags: it.subject || [], publishedDate: (it.publishedPrint?.dateParts?.[0]?.join('-')) || it.created?.['date-time'] || '',
      doi: it.DOI || '',
    }));
  } catch { return []; }
}

async function fetchPubMed(query, max, offset = 0) {
  // PubMed esearch retstart 上限约 9998
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${max}&retstart=${offset}&retmode=json&sort=date`;
  try {
    const sres = await withRetry(() => httpGet(searchUrl), 3, 1500);
    const idlist = JSON.parse(sres.body).esearchresult?.idlist || [];
    if (!idlist.length) return [];
    const sumUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${idlist.join(',')}&retmode=json`;
    const res = await withRetry(() => httpGet(sumUrl), 3, 1500);
    const resultMap = JSON.parse(res.body).result || {};
    return idlist.map(pmid => {
      const info = resultMap[pmid]; if (!info) return null;
      return {
        id: 'pmid:' + pmid, source: 'pubmed', name: info.title || '', abstract: '',
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        authors: (info.authors || []).map(a => a.name),
        tags: [], publishedDate: info.pubdate || '',
        doi: info.articleids?.find(a => a.idtype === 'doi')?.value || '',
      };
    }).filter(Boolean);
  } catch { return []; }
}

// ==================== 归一化 + 合并 ====================

function normalize(raw, site) {
  const id = raw.id || ('t:' + Buffer.from(String(raw.name || '')).toString('base64').slice(0, 12));
  return {
    id,
    name: raw.name || '',
    source: raw.source || '',
    abstract: (raw.abstract || '').slice(0, 4000),
    url: raw.url || '',
    authors: raw.authors || [],
    tags: raw.tags || [],
    confidence: typeof raw.confidence === 'number' ? raw.confidence : (SOURCE_CONFIDENCE[raw.source] || 0.6),
    sites: [site],
    publishedDate: raw.publishedDate || '',
    addedAt: getISOTime(),
  };
}

async function backfillSite(site, queries, limit, dryRun, offset = 0, maxEntities = Infinity) {
  const siteDirPre = path.join(PROJECT_ROOT, site, 'website', 'api');
  const livePathPre = path.join(siteDirPre, 'entities.json');
  const existingPre = (await readJsonSafe(livePathPre)) || [];
  // 容量闸门：达标即不再抓取（省 API 配额，也避免 entities.json 超出
  // Cloudflare Pages 单文件 25MB 上限、以及 git 仓库无限膨胀）
  if (existingPre.length >= maxEntities) {
    console.log(`[Backfill] ${site}: 已达目标容量 ${existingPre.length}/${maxEntities}，跳过抓取`);
    return { site, fetched: 0, added: 0, total: existingPre.length, offset, capped: true, dryRun };
  }

  const collected = [];
  const seen = new Set();
  // 检索词按小并发分批：串行时单站约 110s，14 站会逼近 job 的 timeout-minutes 而整轮丢数据；
  // 并发 3 可降到约 40s/站，同时对单个数据源的并发请求数仍在其限流要求之内
  const QUERY_CONCURRENCY = 3;
  for (let i = 0; i < queries.length; i += QUERY_CONCURRENCY) {
    if (collected.length >= limit) break;
    const chunk = queries.slice(i, i + QUERY_CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map(q => Promise.allSettled([
      // 四源单页取数统一为 12，与游标步长 PAGE_STEP 对齐：
      // 若各源取数不一致（如 8 < 步长 12），窗口之间会留下永远抓不到的空档
      fetchOpenAlex(q, 12, offset), fetchArxiv(q, 12, offset), fetchCrossref(q, 12, offset), fetchPubMed(q, 12, offset),
    ])));
    for (const batch of chunkResults) {
      for (const r of batch) {
        if (r.status !== 'fulfilled') continue;
        for (const it of r.value) {
          if (collected.length >= limit) break;
          if (seen.has(it.id)) continue;
          seen.add(it.id); collected.push(it);
        }
      }
    }
    await sleep(300); // 礼貌限速（并发后适当加长）
  }

  const siteDir = path.join(PROJECT_ROOT, site, 'website', 'api');
  const livePath = path.join(siteDir, 'entities.json');
  const indexPath = path.join(siteDir, 'index.json');

  const existing = (await readJsonSafe(livePath)) || [];
  const map = new Map(existing.map(e => [e.id || e.name, e]));
  let added = 0;
  for (const raw of collected) {
    const n = normalize(raw, site);
    if (!map.has(n.id)) { map.set(n.id, n); added++; }
  }
  const all = Array.from(map.values());
  const cats = [...new Set(all.flatMap(x => x.tags || []))].slice(0, 20).filter(Boolean);

  if (dryRun) {
    console.log(`[DRY-RUN] ${site}: 抓取 ${collected.length} 条, 可新增 ${added}, 现有 ${existing.length}, 合计将达 ${all.length}`);
    return { site, fetched: collected.length, added, total: all.length, dryRun: true };
  }

  await ensureDir(siteDir);
  await fs.writeFile(livePath, JSON.stringify(all, null, 2), 'utf-8');
  await fs.writeFile(indexPath, JSON.stringify({ site, totalEntities: all.length, lastUpdated: getISOTime(), categories: cats }, null, 2), 'utf-8');
  console.log(`[Backfill] ${site}: offset=${offset} 抓取 ${collected.length}, 新增 ${added}, 现有合计 ${all.length}`);
  return { site, fetched: collected.length, added, total: all.length, offset, dryRun: false };
}

// ==================== 主流程 ====================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const siteArg = args.find(a => a.startsWith('--site='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) || 30 : 30;
  // 每站目标容量：单条约 1.1KB，3000 条 ≈ 3.3MB，远低于 Cloudflare Pages 单文件 25MB 上限
  const maxArg = args.find(a => a.startsWith('--max-entities='));
  const maxEntities = maxArg ? parseInt(maxArg.split('=')[1], 10) || 3000 : 3000;
  const sites = siteArg ? [siteArg.split('=')[1]] : Object.keys(SITE_QUERIES);

  // ===== 游标分页状态 =====
  // 四个数据源此前均硬编码第 1 页，导致每轮抓回完全相同的条目、去重后新增恒为 0。
  // 这里为每个站点维护一个 offset 游标，每轮推进一页，确保持续抓到新数据。
  const cursorPath = path.join(STATE_DIR, 'backfill-cursor.json');
  const cursor = (await readJsonSafe(cursorPath)) || {};
  const PAGE_STEP = 12;      // 与 OpenAlex per-page 对齐（各源单页最大取数）
  const MAX_OFFSET = 9000;   // Crossref/PubMed 深分页上限约 1 万，到顶则回绕重扫补漏

  console.log(`[Backfill] ${dryRun ? '[DRY-RUN] ' : ''}目标站点 ${sites.length} 个, 单轮每站上限 ${limit}, 每站目标容量 ${maxEntities}`);
  const results = [];
  for (const site of sites) {
    const queries = SITE_QUERIES[site];
    if (!queries) { console.warn(`[Backfill] 未知站点 ${site}, 跳过`); continue; }
    const offset = Number(cursor[site]) || 0;
    try {
      const r = await backfillSite(site, queries, limit, dryRun, offset, maxEntities);
      results.push(r);
      if (!dryRun && !r.capped) {
        // 抓到东西才推进游标；本页为空说明该检索词已见底，回绕重扫
        const next = r.fetched > 0 ? offset + PAGE_STEP : 0;
        cursor[site] = next > MAX_OFFSET ? 0 : next;
      }
    } catch (err) {
      console.error(`[Backfill] ${site} 失败: ${err.message}`);
      results.push({ site, error: err.message });
    }
    await sleep(200);
  }

  const report = { pipeline: 'data-backfill', timestamp: getISOTime(), dryRun, limit, results };
  if (!dryRun) {
    await ensureDir(STATE_DIR);
    await fs.writeFile(cursorPath, JSON.stringify(cursor, null, 2), 'utf-8');
    console.log(`[Backfill] 游标已保存 ${cursorPath}`);
    await ensureDir(REPORTS_DIR);
    const rp = path.join(REPORTS_DIR, `report-data-backfill-${getISOTime().slice(0, 10)}.json`);
    await fs.writeFile(rp, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`[Backfill] 报告已写入 ${rp}`);
  }
  const totalAdded = results.reduce((s, r) => s + (r.added || 0), 0);
  const totalNow = results.reduce((s, r) => s + (r.total || 0), 0);
  const cappedN = results.filter(r => r.capped).length;
  console.log(`[Backfill] 完成. 新增实体合计 ${totalAdded}, 现有合计 ${totalNow}, 涉及站点 ${results.length}, 已达容量站点 ${cappedN}/${results.length}`);
}

main().catch(err => { console.error('[FATAL]', err); process.exit(1); });
