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
// v3（2026-08-06）：每站从 6-7 个扩到 13-15 个细分子领域词。
// 关键：游标是「站点 × 检索词」级，因此检索词数量 ≈ 可抓取容量上限的线性倍数。
// 139 → 300+ 意味着每站理论可抓容量翻一倍以上，且覆盖更细的长尾主题（利于主题聚合页 SEO）。
const SITE_QUERIES = {
  'quantum-computing': ['quantum computing', 'quantum error correction', 'superconducting qubit', 'quantum algorithm', 'quantum supremacy', 'topological qubit', 'quantum key distribution', 'trapped ion quantum computer', 'quantum machine learning', 'variational quantum eigensolver', 'quantum annealing', 'photonic quantum computing', 'quantum compiler', 'silicon spin qubit'],
  'alien-minerals': ['extraterrestrial minerals', 'meteorite mineralogy', 'lunar regolith', 'asteroid mining', 'space resources', 'lunar ice', 'astrobiology minerals', 'in-situ resource utilization', 'Martian soil composition', 'chondrite petrology', 'cosmochemistry isotopes', 'space weathering', 'planetary geology remote sensing', 'sample return mission'],
  'biocomputing': ['biological computing', 'DNA computing', 'molecular computing', 'synthetic biology circuits', 'living computers', 'microbial computing', 'DNA data storage', 'genetic logic gate', 'biosensor computation', 'neuromorphic biological system', 'protein based computing', 'wetware computing', 'cell-free biocomputing', 'organoid intelligence'],
  'bionic-ai': ['brain-computer interface', 'neurorobotics', 'bionic prosthesis', 'neural engineering', 'neuroprosthetics', 'bionic vision', 'neural decoding motor', 'EEG signal classification', 'cochlear implant', 'spinal cord stimulation', 'biohybrid robot', 'artificial muscle actuator', 'closed-loop neuromodulation', 'implantable neural electrode'],
  'deep-sea-tech': ['deep sea technology', 'underwater robotics', 'marine robotics', 'ocean observation', 'autonomous underwater vehicle', 'subsea engineering', 'deep sea mining', 'hydrothermal vent exploration', 'underwater acoustic communication', 'remotely operated vehicle', 'ocean sensor network', 'bathymetry mapping', 'deep sea biodiversity', 'marine geotechnics'],
  'brain-science': ['neuroscience', 'brain imaging', 'neural plasticity', 'connectome', 'neurogenesis', 'cognitive neuroscience', 'functional MRI analysis', 'neurodegenerative disease mechanism', 'single-cell brain atlas', 'synaptic transmission', 'neural circuit optogenetics', 'sleep and memory consolidation', 'computational neuroscience model', 'neuroinflammation'],
  'life-science': ['life sciences', 'systems biology', 'cell biology', 'genomics', 'proteomics', 'molecular biology', 'single cell RNA sequencing', 'metabolomics', 'immunology mechanism', 'stem cell differentiation', 'microbiome analysis', 'structural biology cryo-EM', 'epigenetics regulation', 'developmental biology'],
  'new-energy': ['renewable energy', 'solid-state battery', 'hydrogen energy', 'perovskite solar cell', 'lithium battery', 'grid energy storage', 'sodium ion battery', 'green hydrogen electrolysis', 'fuel cell catalyst', 'offshore wind power', 'carbon capture utilization', 'battery recycling', 'vehicle to grid', 'thermoelectric materials'],
  'nuclear-energy': ['nuclear fusion', 'tokamak', 'small modular reactor', 'nuclear fission', 'fusion energy', 'plasma confinement', 'inertial confinement fusion', 'stellarator', 'molten salt reactor', 'nuclear fuel cycle', 'tritium breeding blanket', 'radiation shielding materials', 'nuclear waste disposal', 'high temperature gas reactor'],
  'robot-parts': ['robot actuator', 'robotic gripper', 'servo motor', 'tactile sensor', 'soft robotics', 'robotics components', 'harmonic drive reducer', 'series elastic actuator', 'force torque sensor', 'robot joint design', 'cable driven mechanism', 'lidar for robotics', 'robot end effector', 'exoskeleton mechanism'],
  'tcm-tools': ['traditional Chinese medicine', 'herbal medicine', 'acupuncture', 'medicinal plant', 'TCM formula', 'pharmacology of herbs', 'network pharmacology', 'Chinese herbal compound mechanism', 'moxibustion therapy', 'TCM syndrome differentiation', 'herbal quality control chromatography', 'natural product isolation', 'ethnopharmacology', 'acupoint stimulation mechanism'],
  'genetech-tools': ['genomics', 'CRISPR gene editing', 'gene therapy', 'DNA sequencing', 'genome engineering', 'gene regulation', 'base editing', 'prime editing', 'AAV vector delivery', 'CAR-T cell engineering', 'long read sequencing', 'gene knockout screening', 'mRNA therapeutics', 'genome wide association study'],
  'exo-science': ['exoplanet', 'astrobiology', 'biosignature', 'extraterrestrial life', 'SETI', 'planetary habitability', 'transit photometry detection', 'exoplanet atmosphere spectroscopy', 'habitable zone modeling', 'JWST exoplanet observation', 'planetary formation simulation', 'technosignature search', 'extremophile organism', 'ocean world Europa Enceladus'],
  'agent-ecosystem': ['AI agent', 'multi-agent system', 'agent orchestration', 'LLM agent framework', 'autonomous agent', 'agentic workflow', 'tool use language model', 'retrieval augmented generation', 'agent memory architecture', 'agent benchmark evaluation', 'model context protocol', 'agent planning reasoning', 'human agent collaboration', 'agent safety alignment'],
  // ---- 2026-08 扩域：对齐国家「十五五」未来产业六大方向 + 全球 2026 前沿趋势 ----
  'embodied-ai': ['embodied intelligence', 'humanoid robot', 'vision language action model', 'robot learning', 'sim-to-real transfer', 'dexterous manipulation', 'embodied navigation', 'imitation learning robot', 'reinforcement learning locomotion', 'robot foundation model', 'tactile manipulation learning', 'whole body control humanoid', 'embodied question answering', 'robot teleoperation data collection'],
  'synbio-manufacturing': ['synthetic biology', 'biomanufacturing', 'metabolic engineering', 'cell factory', 'bio-based materials', 'enzyme engineering', 'biofoundry', 'directed evolution protein', 'precision fermentation', 'CO2 to chemicals biological', 'genetic circuit design', 'microbial chassis strain', 'bioprocess scale-up', 'de novo protein design'],
  'semiconductor': ['semiconductor device', 'advanced packaging chiplet', 'wide bandgap semiconductor', 'EUV lithography', 'gate-all-around transistor', 'silicon photonics', 'compound semiconductor', 'gallium nitride power device', 'silicon carbide MOSFET', 'high bandwidth memory', 'ferroelectric memory device', '2D material transistor', 'in-memory computing chip', 'semiconductor thermal management'],
  'ai4science': ['AI for science', 'machine learning interatomic potential', 'protein structure prediction', 'AI drug discovery', 'materials discovery machine learning', 'scientific foundation model', 'self-driving laboratory', 'neural network quantum chemistry', 'weather forecasting deep learning', 'symbolic regression physics', 'graph neural network molecules', 'automated experiment optimization', 'physics informed neural network', 'AI mathematical reasoning proof'],
  'low-altitude': ['eVTOL aircraft', 'urban air mobility', 'unmanned aerial vehicle', 'UAV swarm', 'drone delivery', 'flight control algorithm', 'low altitude airspace', 'UAV traffic management', 'distributed electric propulsion', 'drone obstacle avoidance', 'aerial manipulation', 'BVLOS operation safety', 'tiltrotor aerodynamics', 'drone battery endurance'],
  'sat-6g': ['6G wireless network', 'satellite internet constellation', 'integrated sensing and communication', 'terahertz communication', 'non-terrestrial network', 'LEO satellite communication', 'reconfigurable intelligent surface', 'massive MIMO beamforming', 'inter-satellite laser link', 'network slicing orchestration', 'semantic communication', 'satellite IoT connectivity', 'millimeter wave propagation', 'AI native air interface'],
  'spatial-computing': ['spatial computing', 'augmented reality display', 'mixed reality interaction', 'digital twin', 'neural radiance field', 'visual SLAM', '3D Gaussian splatting', 'waveguide optical display', 'eye tracking foveated rendering', 'hand gesture recognition XR', 'scene understanding 3D reconstruction', 'haptic feedback interface', 'volumetric video capture', 'spatial audio rendering'],
  'privacy-computing': ['federated learning', 'secure multiparty computation', 'homomorphic encryption', 'differential privacy', 'trusted execution environment', 'privacy preserving machine learning', 'zero knowledge proof', 'post quantum cryptography', 'secure aggregation protocol', 'data anonymization technique', 'confidential computing enclave', 'split learning', 'privacy preserving record linkage', 'blockchain data sharing'],
  // ---- 2026-08 第三批扩域：对齐国家「十五五」未来产业 + 全球 2026 科研热点 ----
  'ai-safety': ['ai alignment', 'interpretability neural network', 'mechanistic interpretability', 'rlhf', 'constitutional ai', 'ai safety', 'red teaming language model', 'scalable oversight', 'ai risk assessment', 'value learning', 'deceptive alignment', 'ai governance policy', 'model evaluation safety', 'ai control problem'],
  'quantum-materials': ['quantum material', 'topological insulator', 'topological superconductor', 'quantum spin liquid', 'majorana fermion', 'twisted bilayer graphene', 'magnetic topological material', 'quantum anomalous hall effect', 'correlated electron system', 'kagome superconductor', 'nonlinear optical crystal', '2d quantum material', 'moire material', 'quantum criticality'],
  'carbon-neutral': ['carbon capture utilization storage', 'ccus', 'direct air capture', 'carbon mineralization', 'green ammonia', 'power to gas', 'negative emission technology', 'carbon utilization co2', 'co2 electroreduction', 'biochar carbon sequestration', 'industrial decarbonization', 'climatetech carbon', 'methane pyrolysis', 'co2 to methanol'],
  'digital-twin': ['digital twin', 'digital twin manufacturing', 'city digital twin', 'digital twin engineering', 'twin model predictive control', 'physics based digital twin', 'digital twin industrial iot', 'twin driven simulation', 'digital thread', 'twin synchronization', 'digital twin maintenance', 'virtual commissioning', 'twin enabled optimization', 'digital twin energy'],
  'biomed-ai': ['medical artificial intelligence', 'clinical machine learning', 'healthcare large language model', 'medical image segmentation', 'clinical decision support ai', 'radiology ai', 'electronic health record ml', 'drug target discovery ai', 'pathology deep learning', 'medical foundation model', 'clinical nlp', 'ai diagnostics', 'biomarker discovery machine learning', 'precision medicine ai'],
  'edge-ai': ['edge artificial intelligence', 'tiny machine learning', 'tinyml', 'edge inference', 'on device ai', 'edge computing neural network', 'model quantization', 'neural network pruning', 'edge deployment deep learning', 'federated edge learning', 'low power ai chip', 'edge vision', 'sparse model', 'knowledge distillation edge'],
  'neuromorphic': ['neuromorphic computing', 'spiking neural network', 'neuro-inspired computing', 'memristor neural network', 'brain inspired chip', 'event driven computing', 'neuromorphic hardware', 'synaptic device', 'resistive random access memory computing', 'silicon neuron', 'neuromorphic vision sensor', 'analog in memory computing', 'physical reservoir computing', 'spiking neural network training'],
  'agritech': ['precision agriculture', 'smart farming', 'agricultural robotics', 'crop phenotyping', 'plant phenotyping', 'agricultural ai', 'vertical farming', 'controlled environment agriculture', 'crop disease detection', 'soil sensor network', 'livestock monitoring', 'agricultural drone', 'gene editing crop', 'synthetic fertilizer alternative'],
};

const SOURCE_CONFIDENCE = {
  pubmed: 0.82, arxiv: 0.78, openalex: 0.72, crossref: 0.7,
  semanticscholar: 0.74, europepmc: 0.8, github: 0.6, huggingface: 0.6,
  // v3 新增：DOAJ 为同行评审开放获取期刊，质量较高；DataCite/Zenodo 含大量自主提交的数据集与软件
  doaj: 0.76, datacite: 0.66, zenodo: 0.64,
  // v4 新增：CORE 聚合全球开放获取全文（含预印本/期刊），质量较高
  core: 0.72,
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

async function fetchDOAJ(query, max, offset = 0) {
  // DOAJ：开放获取期刊论文，免费无 key。page 从 1 开始，pageSize 上限 100。
  const page = Math.floor(offset / max) + 1;
  const url = `https://doaj.org/api/search/articles/${encodeURIComponent(query)}?pageSize=${Math.min(max, 100)}&page=${page}`;
  try {
    const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': UA } }), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.results || []).map(r => {
      const b = r.bibjson || {};
      const doi = (b.identifier || []).find(i => i.type === 'doi')?.id || '';
      const link = (b.link || []).find(l => l.type === 'fulltext')?.url || '';
      const ym = b.year ? `${b.year}${b.month ? '-' + String(b.month).padStart(2, '0') : ''}` : '';
      return {
        id: doi ? 'doi:' + doi : 'doaj:' + (r.id || Math.random().toString(36)),
        source: 'doaj',
        name: b.title || '',
        abstract: stripTags(b.abstract || '').slice(0, 4000),
        url: doi ? `https://doi.org/${doi}` : link,
        authors: (b.author || []).map(a => a.name).filter(Boolean),
        tags: (b.keywords || []).slice(0, 8),
        publishedDate: ym,
        doi,
      };
    });
  } catch { return []; }
}

async function fetchDataCite(query, max, offset = 0) {
  // DataCite：数据集 / 预印本 / 软件的 DOI 注册库，免费无 key。补齐 dataset 类型实体。
  const page = Math.floor(offset / max) + 1;
  const url = `https://api.datacite.org/dois?query=${encodeURIComponent(query)}&page[size]=${Math.min(max, 100)}&page[number]=${page}`;
  try {
    const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': UA } }), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.data || []).map(d => {
      const a = d.attributes || {};
      const doi = a.doi || '';
      const abs = (a.descriptions || []).find(x => x.descriptionType === 'Abstract')?.description
        || (a.descriptions || [])[0]?.description || '';
      return {
        id: doi ? 'doi:' + doi : 'datacite:' + (d.id || Math.random().toString(36)),
        source: 'datacite',
        name: (a.titles || [])[0]?.title || '',
        abstract: stripTags(String(abs)).slice(0, 4000),
        url: doi ? `https://doi.org/${doi}` : (a.url || ''),
        authors: (a.creators || []).map(c => c.name || `${c.givenName || ''} ${c.familyName || ''}`.trim()).filter(Boolean),
        tags: (a.subjects || []).map(s => s.subject).filter(Boolean).slice(0, 8),
        publishedDate: a.publicationYear ? String(a.publicationYear) : '',
        doi,
        resourceType: a.types?.resourceTypeGeneral || '',
      };
    });
  } catch { return []; }
}

async function fetchZenodo(query, max, offset = 0) {
  // Zenodo：科研软件 / 数据集 / 报告，免费无 key。对"工具类"站点价值高。
  const page = Math.floor(offset / max) + 1;
  // Zenodo 限制 size*page <= 10000
  if (page * max > 10000) return [];
  const url = `https://zenodo.org/api/records?q=${encodeURIComponent(query)}&size=${Math.min(max, 100)}&page=${page}`;
  try {
    const res = await withRetry(() => httpGet(url, { headers: { 'User-Agent': UA } }), 3, 1500);
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.hits?.hits || []).map(h => {
      const md = h.metadata || {};
      const doi = h.doi || md.doi || '';
      return {
        id: doi ? 'doi:' + doi : 'zenodo:' + (h.id || Math.random().toString(36)),
        source: 'zenodo',
        name: md.title || '',
        abstract: stripTags(md.description || '').slice(0, 4000),
        url: h.links?.self_html || (doi ? `https://doi.org/${doi}` : ''),
        authors: (md.creators || []).map(c => c.name).filter(Boolean),
        tags: (md.keywords || []).slice(0, 8),
        publishedDate: md.publication_date || '',
        doi,
        resourceType: md.resource_type?.type || '',
      };
    });
  } catch { return []; }
}

async function fetchCORE(query, max, offset = 0) {
  // CORE：全球开放获取聚合（预印本+期刊全文），免费 demo key 可用；失败即空。
  const key = (process.env.CORE_API_KEY || 'e6d5c495-5365-4616-be4c-f5203f0e3a98');
  const url = `https://api.core.ac.uk/v3/search/works?q=${encodeURIComponent(query)}&limit=${Math.min(max, 100)}&offset=${offset}`;
  try {
    const res = await withRetry(
      () => httpGet(url, { headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA } }),
      2, 1500,
    );
    if (res.statusCode !== 200) return [];
    const data = JSON.parse(res.body);
    return (data.results || []).map((r) => {
      const doi = r.doi || '';
      return {
        id: doi ? 'doi:' + doi : 'core:' + (r.id || Math.random().toString(36)),
        source: 'core',
        name: r.title || '',
        abstract: stripTags(r.abstract || '').slice(0, 4000),
        url: r.downloadUrl || (doi ? `https://doi.org/${doi}` : (r.url || '')),
        authors: (r.authors || []).map((a) => a.name).filter(Boolean),
        tags: (r.subjects || []).map((s) => (typeof s === 'string' ? s : s.name)).filter(Boolean).slice(0, 8),
        publishedDate: r.year ? String(r.year) : '',
        doi,
      };
    });
  } catch { return []; }
}

// 10 个数据源的统一入口（DOAJ/DataCite/Zenodo 于 v3、CORE 于 v4 加入）
const SOURCE_FETCHERS = [
  (q, n, o) => fetchOpenAlex(q, n, o),
  (q, n, o) => fetchArxiv(q, n, o),
  (q, n, o) => fetchCrossref(q, n, o),
  (q, n, o) => fetchSemanticScholar(q, n, o),
  (q, n, o) => fetchEuropePMC(q, n, o),
  (q, n, o) => fetchPubMed(q, n, o),
  (q, n, o) => fetchDOAJ(q, n, o),
  (q, n, o) => fetchDataCite(q, n, o),
  (q, n, o) => fetchZenodo(q, n, o),
  (q, n, o) => fetchCORE(q, n, o),
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
  // 每站目标容量：单条约 1.1KB，4000 条 ≈ 4.4MB；30 站全满 ≈ 132MB（entities.json 合计），
  // 加结构化索引后总产物仍安全低于 GitHub Pages 1GB 上限（实测 22 站/3k 时为 184MB）
  const maxArg = args.find(a => a.startsWith('--max-entities='));
  const maxEntities = maxArg ? parseInt(maxArg.split('=')[1], 10) || 4000 : 4000;
  // 时间预算：CI 的 job timeout-minutes 是硬杀，一旦触发，末尾的「提交数据」步骤不会执行，
  // 整轮抓取全部作废。这里主动在预算内收尾，保证已抓数据必被提交。默认 35 分钟（CI 上限 50）。
  const minutesArg = args.find(a => a.startsWith('--max-minutes='));
  const parsedMinutes = minutesArg ? parseInt(minutesArg.split('=')[1], 10) : NaN;
  const maxMinutes = Number.isFinite(parsedMinutes) && parsedMinutes >= 0 ? parsedMinutes : 35;
  const deadline = Date.now() + maxMinutes * 60 * 1000;
  // --site 支持逗号分隔多站（如 --site=a,b,c）；缺省则遍历全部站点
  const explicitSites = siteArg
    ? siteArg.split('=').slice(1).join('=').split(',').map(s => s.trim()).filter(Boolean)
    : null;

  // ===== 游标：站点×检索词 级 =====
  const cursorPath = path.join(STATE_DIR, 'backfill-cursor.json');
  const rawCursor = (await readJsonSafe(cursorPath)) || {};
  // 兼容 v1 的「站点→数字」旧格式：遇到数字重置为 {}，让各检索词从 0 重新开始
  const cursor = {};
  let rotate = 0;
  for (const [s, v] of Object.entries(rawCursor)) {
    if (s === '__rotate') { rotate = Number(v) || 0; continue; }
    cursor[s] = (v && typeof v === 'object') ? v : {};
  }

  // ===== 站点轮转 =====
  // 站点数增长后（22 站）单轮跑不完全部，若每次都从第一个站开始，
  // 排在后面的站将永远抓不到数据。用持久化的 rotate 偏移轮流做起点，保证公平覆盖。
  const allSites = Object.keys(SITE_QUERIES);
  const sites = explicitSites
    ? explicitSites
    : [...allSites.slice(rotate % allSites.length), ...allSites.slice(0, rotate % allSites.length)];

  console.log(`[Backfill v2] ${dryRun ? '[DRY-RUN] ' : ''}站点 ${sites.length} 个, 单轮每站上限 ${limit}, 单页 ${perPage}, 每站目标容量 ${maxEntities}, 数据源 ${SOURCE_FETCHERS.length} 个`);
  const results = [];
  const QUERY_CONCURRENCY = 3; // 检索词并发；站间另有 sleep，整体礼貌限速

  let processedSites = 0;
  for (const site of sites) {
    if (Date.now() > deadline) {
      console.log(`[Backfill] 已达时间预算 ${maxMinutes} 分钟，本轮在第 ${processedSites} 站收尾（剩余站点下轮由轮转起点优先处理）`);
      break;
    }
    const queries = SITE_QUERIES[site];
    if (!queries) { console.warn(`[Backfill] 未知站点 ${site}, 跳过`); continue; }
    processedSites++;
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
    // 仅全站遍历时推进轮转起点；显式 --site 是定点补数，不应打乱全局轮转节奏
    if (!explicitSites) cursor.__rotate = (rotate + processedSites) % allSites.length;
    await fs.writeFile(cursorPath, JSON.stringify(cursor, null, 2), 'utf-8');
    console.log(`[Backfill] 游标已保存 ${cursorPath}（下轮起点偏移 ${cursor.__rotate ?? rotate}）`);
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
