#!/usr/bin/env node
/**
 * 站点感知数据回填 / 扩充流水线（扩量版 v2）
 * pipeline-data-backfill.js
 *
 * 相比 v1 的核心改进（直接解决"数据不增长"根因）：
 *   1. 单页取数 12 → 100（OpenAlex/Crossref/arXiv/S2/EuropePMC 均支持 ≥100/页），
 *      单轮单站可取数从 ~336 条理论值提升到 ~2800 条原始候选。
 *   2. 数据源从 4 个增至 6 个：新增 Semantic Scholar（CS/跨学科）、Europe PMC（生物医学全文索引）。
 *   3. 游标从"站点级"改为"站点×检索词"级：每个检索词独立推进 offset，
 *      避免 7 个词共用一个 offset 导致词间进度不同步、深页大面积重复命中。
 *   4. 修复 PubMed 摘要恒为空：esearch → esummary（标题/DOI/日期）→ efetch（AbstractText）。
 *   5. 清洗 Crossref 的 JATS 标签摘要（<jats:p> 等）。
 *   6. 按 DOI / 标题+首作者 做跨源去重合并：同一篇论文在多个源只计一次，且优先保留带摘要的版本。
 *
 * 用法：
 *   node pipeline-data-backfill.js [--dry-run] [--site=quantum-computing]
 *       [--limit=600] [--max-entities=3000] [--per-page=100]
 *
 * 设计原则：失败即空数组（不抛停整轮），礼貌限速（源内并发受控、站间 sleep），
 * 去重幂等（重跑安全），容量闸门（达标停抓，避免单文件与仓库无限膨胀）。
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
  // ---- 2026-08 扩域：对齐国家「十五五」未来产业六大方向 + 全球 2026 前沿趋势 ----
  'embodied-ai': ['embodied intelligence', 'humanoid robot', 'vision language action model', 'robot learning', 'sim-to-real transfer', 'dexterous manipulation', 'embodied navigation'],
  'synbio-manufacturing': ['synthetic biology', 'biomanufacturing', 'metabolic engineering', 'cell factory', 'bio-based materials', 'enzyme engineering', 'biofoundry'],
  'semiconductor': ['semiconductor device', 'advanced packaging chiplet', 'wide bandgap semiconductor', 'EUV lithography', 'gate-all-around transistor', 'silicon photonics', 'compound semiconductor'],
  'ai4science': ['AI for science', 'machine learning interatomic potential', 'protein structure prediction', 'AI drug discovery', 'materials discovery machine learning', 'scientific foundation model', 'self-driving laboratory'],
  'low-altitude': ['eVTOL aircraft', 'urban air mobility', 'unmanned aerial vehicle', 'UAV swarm', 'drone delivery', 'flight control algorithm', 'low altitude airspace'],
  'sat-6g': ['6G wireless network', 'satellite internet constellation', 'integrated sensing and communication', 'terahertz communication', 'non-terrestrial network', 'LEO satellite communication'],
  'spatial-computing': ['spatial computing', 'augmented reality display', 'mixed reality interaction', 'digital twin', 'neural radiance field', 'visual SLAM'],
  'privacy-computing': ['federated learning', 'secure multiparty computation', 'homomorphic encryption', 'differential privacy', 'trusted execution environment', 'privacy preserving machine learning'],
};

const SOURCE_CONFIDENCE = {
  pubmed: 0.82, arxiv: 0.78, openalex: 0.72, crossref: 0.7,
  semanticscholar: 0.74, europepmc: 0.8, github: 0.6, huggingface: 0.6,
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

const UA = 'GeneTechBot/2.0 (mailto:ops@genetech.example)';

function stripTags(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

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

// ==================== 去重键 ====================

// 跨源去重：优先用 DOI；否则用「标题(归一)+首作者」；再不行用原始 id。
function dedupeKey(e) {
  const doi = String(e.doi || '').toLowerCase().replace(/^doi:/, '').replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();
  if (doi) return 'doi:' + doi;
  const name = String(e.name || '').toLowerCase().replace(/[^a-z0-9一-龥]/g, '');
  const firstAuthor = String((e.authors && e.authors[0]) || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (name) return 'n:' + name.slice(0, 64) + '|' + (firstAuthor.slice(0, 14) || 'x');
  return 'id:' + (e.id || Math.random().toString(36));
}

// ==================== 各数据源抓取（带领域检索词） ====================

async function fetchOpenAlex(query, max, offset = 0) {
  // OpenAlex 用 page 分页（page 从 1 开始）；page*per-page 上限 10000
  const page = Math.floor(offset / max) + 1;
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${max}&page=${page}&sort=relevance_score:desc&mailto=ops@genetech.example`;
  try {
    const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': UA } }), 3, 1500);
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
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=${offset}&max_results=${max}&sortBy=relevance`;
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
  // Crossref offset 深分页上限 10000，超出需 cursor=*（v2 暂不深翻）
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${max}&offset=${offset}&sort=relevance`;
  try {
    const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': UA } }), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.message?.items || []).map(it => {
      const rawAbs = it.abstract || '';
      const abs = rawAbs.startsWith('<') || rawAbs.includes('<jats') ? stripTags(rawAbs) : rawAbs;
      return {
        id: it.DOI ? 'doi:' + it.DOI : 'cr:' + (it.URL || Math.random().toString(36)),
        source: 'crossref', name: (it.title || [''])[0] || '', abstract: abs.slice(0, 4000),
        url: it.URL || '', authors: (it.author || []).map(a => `${a.given || ''} ${a.family || ''}`.trim()).filter(Boolean),
        tags: it.subject || [], publishedDate: (it.publishedPrint?.dateParts?.[0]?.join('-')) || it.created?.['date-time'] || '',
        doi: it.DOI || '',
      };
    });
  } catch { return []; }
}

async function fetchSemanticScholar(query, max, offset = 0) {
  // 免费、无需 key（速率受限，失败即空）。字段含 paperId / DOI / abstract。
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${max}&offset=${offset}&fields=paperId,title,abstract,url,year,venue,publicationDate,authors.name,externalIds`;
  try {
    const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': UA } }), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.data || []).map(p => {
      const doi = p.externalIds?.DOI || '';
      return {
        id: doi ? 'doi:' + doi : 'ss:' + (p.paperId || Math.random().toString(36)),
        source: 'semanticscholar', name: p.title || '', abstract: (p.abstract || '').slice(0, 4000),
        url: p.url || (doi ? `https://doi.org/${doi}` : ''),
        authors: (p.authors || []).map(a => a.name).filter(Boolean),
        tags: p.venue ? [p.venue] : [], publishedDate: p.publicationDate || (p.year ? String(p.year) : ''),
        doi,
      };
    });
  } catch { return []; }
}

async function fetchEuropePMC(query, max, offset = 0) {
  // Europe PMC：免费、无需 key，覆盖 PubMed + PMC + Agricola 等，含摘要。
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&pageSize=${max}&resultStart=${offset}`;
  try {
    const res = await withRetry(() => httpGet(url), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.resultList?.result || []).map(it => {
      const doi = it.doi || '';
      return {
        id: doi ? 'doi:' + doi : `epmc:${it.source || 'x'}${it.id || Math.random().toString(36)}`,
        source: 'europepmc', name: it.title || '', abstract: stripTags(it.abstractText || '').slice(0, 4000),
        url: doi ? `https://doi.org/${doi}` : (it.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${it.pmid}/` : ''),
        authors: (it.authorList?.author || []).map(a => a.fullName || a.collectedFrom || '').filter(Boolean),
        tags: it.keywordList?.keyword || [], publishedDate: it.pubYear || '',
        doi,
      };
    });
  } catch { return []; }
}

async function fetchPubMedAbstracts(idlist) {
  if (!idlist.length) return {};
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${idlist.join(',')}&rettype=abstract&retmode=xml`;
  try {
    const res = await withRetry(() => httpGet(url), 3, 1500);
    const map = {};
    const artRegex = /<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g;
    let m;
    while ((m = artRegex.exec(res.body)) !== null) {
      const a = m[0];
      const pmidMatch = a.match(/<PMID[^>]*>(\d+)<\/PMID>/);
      const pmid = pmidMatch ? pmidMatch[1] : '';
      const absMatch = a.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/);
      if (pmid && absMatch) map[pmid] = stripTags(absMatch[1]).replace(/\s+/g, ' ').trim();
    }
    return map;
  } catch { return {}; }
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
    // 第二跳：efetch 取摘要（修复 v1 摘要恒为空）
    const absMap = await fetchPubMedAbstracts(idlist);
    return idlist.map(pmid => {
      const info = resultMap[pmid]; if (!info) return null;
      const doi = info.articleids?.find(a => a.idtype === 'doi')?.value || '';
      return {
        id: 'pmid:' + pmid, source: 'pubmed', name: info.title || '', abstract: absMap[pmid] || '',
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        authors: (info.authors || []).map(a => a.name),
        tags: [], publishedDate: info.pubdate || '', doi,
      };
    }).filter(Boolean);
  } catch { return []; }
}

// 6 个数据源的统一入口
const SOURCE_FETCHERS = [
  (q, n, o) => fetchOpenAlex(q, n, o),
  (q, n, o) => fetchArxiv(q, n, o),
  (q, n, o) => fetchCrossref(q, n, o),
  (q, n, o) => fetchSemanticScholar(q, n, o),
  (q, n, o) => fetchEuropePMC(q, n, o),
  (q, n, o) => fetchPubMed(q, n, o),
];

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

/**
 * 处理单个（站点, 检索词）：抓 6 源 → 去重合并进 map（map 已含既有实体）。
 * 返回 { fetched, added, nextOffset }。
 */
async function backfillQuery(site, query, offset, perPage, limit, map) {
  // 6 源并发抓取（失败即空数组）；PubMed 内部含 3 次 e-utils 调用，已由 withRetry 保护
  const settled = await Promise.allSettled(SOURCE_FETCHERS.map(f => f(query, perPage, offset)));
  let fetched = 0;
  const collected = [];
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const it of r.value) { collected.push(it); fetched++; }
  }
  let added = 0;
  for (const raw of collected) {
    if (added >= limit) break;
    const n = normalize(raw, site);
    const dk = dedupeKey(n);
    if (map.has(dk)) {
      // 跨源命中：若既有条目缺摘要而新条目有，补全摘要（提升语义检索质量）
      const ex = map.get(dk);
      if ((!ex.abstract || ex.abstract.length < 40) && n.abstract && n.abstract.length > 40) {
        ex.abstract = n.abstract;
        if (n.tags && n.tags.length) ex.tags = Array.from(new Set([...(ex.tags || []), ...n.tags])).slice(0, 8);
      }
      continue;
    }
    map.set(dk, n);
    added++;
  }
  // 游标推进：按 perPage 前进；到达深分页上限则回绕重扫补漏
  const MAX_OFFSET = 9000;
  const nextOffset = (offset + perPage) > MAX_OFFSET ? 0 : (offset + perPage);
  return { fetched, added, nextOffset };
}

// ==================== 主流程 ====================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const siteArg = args.find(a => a.startsWith('--site='));
  const perPageArg = args.find(a => a.startsWith('--per-page='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) || 600 : 600;
  const perPage = Math.min(perPageArg ? parseInt(perPageArg.split('=')[1], 10) || 100 : 100, 200);
  // 每站目标容量：单条约 1.1KB，3000 条 ≈ 3.3MB，远低于 Cloudflare Pages 单文件 25MB 上限
  const maxArg = args.find(a => a.startsWith('--max-entities='));
  const maxEntities = maxArg ? parseInt(maxArg.split('=')[1], 10) || 3000 : 3000;
  // --site 支持逗号分隔多站（如 --site=a,b,c）；缺省则遍历全部站点
  const sites = siteArg
    ? siteArg.split('=').slice(1).join('=').split(',').map(s => s.trim()).filter(Boolean)
    : Object.keys(SITE_QUERIES);

  // ===== 游标：站点×检索词 级 =====
  const cursorPath = path.join(STATE_DIR, 'backfill-cursor.json');
  const rawCursor = (await readJsonSafe(cursorPath)) || {};
  // 兼容 v1 的「站点→数字」旧格式：遇到数字重置为 {}，让各检索词从 0 重新开始
  const cursor = {};
  for (const [s, v] of Object.entries(rawCursor)) {
    cursor[s] = (v && typeof v === 'object') ? v : {};
  }

  console.log(`[Backfill v2] ${dryRun ? '[DRY-RUN] ' : ''}站点 ${sites.length} 个, 单轮每站上限 ${limit}, 单页 ${perPage}, 每站目标容量 ${maxEntities}, 数据源 ${SOURCE_FETCHERS.length} 个`);
  const results = [];
  const QUERY_CONCURRENCY = 3; // 检索词并发；站间另有 sleep，整体礼貌限速

  for (const site of sites) {
    const queries = SITE_QUERIES[site];
    if (!queries) { console.warn(`[Backfill] 未知站点 ${site}, 跳过`); continue; }
    if (!cursor[site]) cursor[site] = {};

    const siteDir = path.join(PROJECT_ROOT, site, 'website', 'api');
    const livePath = path.join(siteDir, 'entities.json');
    const indexPath = path.join(siteDir, 'index.json');
    const existing = (await readJsonSafe(livePath)) || [];

    if (existing.length >= maxEntities) {
      console.log(`[Backfill] ${site}: 已达目标容量 ${existing.length}/${maxEntities}，跳过抓取`);
      results.push({ site, fetched: 0, added: 0, total: existing.length, capped: true, dryRun });
      await sleep(150);
      continue;
    }

    // 既有实体预装入 map（键=去重键），保证幂等 + 跨源去重
    const map = new Map();
    for (const e of existing) map.set(dedupeKey(e), e);

    let siteFetched = 0;
    let siteAdded = 0;
    for (let i = 0; i < queries.length; i += QUERY_CONCURRENCY) {
      if (map.size >= maxEntities) break;
      const chunk = queries.slice(i, i + QUERY_CONCURRENCY);
      const chunkRes = await Promise.all(chunk.map(q => {
        const off = Number(cursor[site][q]) || 0;
        return backfillQuery(site, q, off, perPage, limit, map).then(r => ({ q, ...r }));
      }));
      for (const r of chunkRes) {
        cursor[site][r.q] = r.nextOffset;
        siteFetched += r.fetched;
        siteAdded += r.added;
      }
      await sleep(300); // 检索词批次间礼貌限速
    }

    const all = Array.from(map.values());
    const cats = [...new Set(all.flatMap(x => x.tags || []))].slice(0, 20).filter(Boolean);

    if (dryRun) {
      console.log(`[DRY-RUN] ${site}: 抓取 ${siteFetched} 条, 可新增 ${siteAdded}, 现有 ${existing.length}, 合计将达 ${all.length}`);
      results.push({ site, fetched: siteFetched, added: siteAdded, total: all.length, dryRun: true });
      await sleep(150);
      continue;
    }

    await ensureDir(siteDir);
    await fs.writeFile(livePath, JSON.stringify(all, null, 2), 'utf-8');
    await fs.writeFile(indexPath, JSON.stringify({ site, totalEntities: all.length, lastUpdated: getISOTime(), categories: cats }, null, 2), 'utf-8');
    console.log(`[Backfill] ${site}: 抓取 ${siteFetched}, 新增 ${siteAdded}, 现有合计 ${all.length}`);
    results.push({ site, fetched: siteFetched, added: siteAdded, total: all.length, dryRun: false });
    await sleep(200);
  }

  const report = { pipeline: 'data-backfill-v2', timestamp: getISOTime(), dryRun, limit, perPage, results };
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
