#!/usr/bin/env node
/**
 * 能力域④-学术实体扩库（第二源）：pipeline-pubmed-expand.js
 *
 * 从 PubMed (NCBI E-utilities，免费、无 key 也可，全球最大生物医学文献库) 批量拉取与
 * 站点主题相关的科研文献，结构化、去重、归类后写入 data/pubmed-entities.json。
 *
 * 与 OpenAlex 互补：PubMed 偏生物医学/生命科学与临床，且走 NCBI 独立出口，不受 OpenAlex
 * 共享出口 IP 的 429 限流影响，可并行扩大实体池。
 *
 * 设计约束（对齐 pipeline-openalex-expand.js，2026-09-23）：
 *   - 落点仅在 data/，不写入 <site>/website/api/entities.json，避免撑爆 CF Pages（已 ~955MB/1GB）。
 *   - 30 站 per-site 实体库已 ALL-AT-CAP（各 10,000），扩库只能落 data/ 独立数据集。
 *   - 体积受控：单实体精简字段 + 紧凑 JSON，总量封顶 MAX_TOTAL。
 *   - 幂等：按 pmid / doi 去重；重跑只 upsert 不重复计数。
 *   - 健壮性：每词墙钟预算（超时跳过，绝不卡死）+ 增量落盘（中断不丢已拉数据）+ 429/5xx 退避。
 *
 * 用法：
 *   node operations-plan/pipeline-pubmed-expand.js [--dry-run] [--max-total=10000]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const OUT_PATH = path.join(DATA_DIR, 'pubmed-entities.json');
const REPORT_PATH = path.join(PROJECT_ROOT, 'reports', `report-pubmed-expand-${Date.now()}.json`);

const DRY = process.argv.includes('--dry-run');
const getArg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const MAX_TOTAL = parseInt(getArg('max-total', '10000'), 10);
const RETMAX = 90;             // 每次 esearch 取回的 PMID 数（efetch 批量上限）
const DELAY_MS = 380;          // NCBI 无 key ~3 req/s
const TIMEOUT_MS = 15000;      // 单请求墙钟硬超时
const QUERY_BUDGET_MS = 150000; // 单个检索词整体预算，超时即跳过继续下一个
const SAVE_EVERY = 3;          // 每 N 个词增量落盘一次
const TOOL = 'Genetech14Infra';
const EMAIL = 'ops@swarmlabs.tools';

// 站点主题 → PubMed 检索词（[site, query]），覆盖更多站点
const QUERIES = [
  ['biomed-ai', 'biomedical artificial intelligence'],
  ['biomed-ai', 'precision medicine machine learning'],
  ['brain-science', 'neuroscience'],
  ['brain-science', 'cognitive brain imaging'],
  ['synthetic-biology', 'synthetic biology'],
  ['crispr', 'CRISPR gene editing'],
  ['crispr', 'base editing prime editing genome'],
  ['protein-design', 'protein structure design'],
  ['biocomputing', 'DNA computing molecular'],
  ['bionic-ai', 'prosthesis neural interface'],
  ['nanomedicine', 'nanomedicine nanoparticle delivery'],
  ['ai-drug', 'artificial intelligence drug discovery'],
  ['autonomous-lab', 'laboratory automation robotics'],
  ['life-science', 'single cell genomics'],
  ['life-science', 'microbiome metagenomics'],
  ['agritech', 'crop phenotyping artificial intelligence'],
  ['carbon-neutral', 'carbon capture biotechnology'],
  ['deep-sea-tech', 'deep sea marine biology'],
  ['neuromorphic', 'neuromorphic spiking computing'],
  ['exo-science', 'astrobiology exobiology'],
  ['ai-safety', 'AI safety alignment robustness'],
  ['ai4science', 'scientific machine learning'],
  ['privacy-computing', 'federated learning differential privacy'],
  ['edge-ai', 'tiny machine learning on-device'],
  ['embodied-ai', 'robot learning manipulation'],
  ['digital-twin', 'digital twin simulation'],
  ['spatial-computing', 'augmented reality spatial computing'],
  ['low-altitude', 'unmanned aerial vehicle autonomous'],
  ['new-energy', 'lithium battery hydrogen energy'],
  ['nuclear-energy', 'nuclear reactor fusion'],
  ['quantum-computing', 'quantum computing qubit'],
  ['quantum-materials', 'quantum materials superconductor'],
  ['semiconductor', 'semiconductor device fabrication'],
  ['sat-6g', 'satellite communication 6G'],
  ['robot-parts', 'robot actuator soft robotics'],
  ['alien-minerals', 'meteorite mineralogy'],
  ['synbio-manufacturing', 'metabolic engineering biomanufacturing'],
  ['tcm-tools', 'traditional chinese medicine herbal'],
  ['genetech-tools', 'bioinformatics sequencing pipeline'],
  ['mcp-server', 'clinical decision support interoperability'],
];

// 站点关键词归类表（多标签；命中即打标，无命中落 'papers'）
const SITE_KEYWORDS = {
  'biomed-ai': ['biomedical', 'clinical', 'diagnos', 'medical imaging', 'precision medicine', 'health informatics', 'electronic health'],
  'brain-science': ['neuroscience', 'neuron', 'cortical', 'brain', 'cognitive', 'eeg', 'fmri', 'synap', 'hippocamp'],
  'synthetic-biology': ['synthetic biology', 'genetic circuit', 'chassis organism', 'genome engineering'],
  'crispr': ['crispr', 'cas9', 'gene editing', 'base editing', 'prime editing', 'guide rna'],
  'protein-design': ['protein design', 'protein structure', 'protein folding', 'alphafold', 'enzyme engineering', 'de novo protein'],
  'biocomputing': ['dna computing', 'molecular computing', 'biocomput', 'dna storage'],
  'bionic-ai': ['prosthe', 'bionic', 'exoskeleton', 'neural interface', 'brain-computer interface', 'brain machine interface'],
  'nanomedicine': ['nanomedicine', 'nanoparticle', 'nanocarrier', 'liposome', 'nanotheranostic'],
  'ai-drug': ['drug discovery', 'drug design', 'virtual screening', 'admet', 'molecular generation', 'drug repurposing'],
  'autonomous-lab': ['laboratory automation', 'self-driving lab', 'robotic platform', 'high-throughput screening', 'automated experiment'],
  'life-science': ['genomic', 'transcriptom', 'proteom', 'single-cell', 'single cell', 'microbiome', 'metagenom', 'epigenet'],
  'agritech': ['agricultur', 'crop', 'phenotyping', 'plant breeding', 'precision farming', 'soil'],
  'carbon-neutral': ['carbon capture', 'climate change', 'decarboni', 'greenhouse gas', 'emission reduction'],
  'deep-sea-tech': ['deep sea', 'deep-sea', 'hydrothermal', 'marine biolog', 'submersible'],
  'neuromorphic': ['neuromorphic', 'spiking neural', 'memristor', 'in-memory computing'],
  'exo-science': ['astrobiolog', 'exobiolog', 'extraterrestrial', 'biosignature', 'mars mission'],
  'ai-safety': ['ai safety', 'alignment', 'adversarial', 'interpretab', 'robustness of neural'],
  'ai4science': ['ai for science', 'scientific machine learning', 'foundation model', 'surrogate model', 'neural operator'],
  'privacy-computing': ['federated learning', 'differential privacy', 'homomorphic', 'secure multiparty', 'privacy-preserving'],
  'edge-ai': ['edge computing', 'tinyml', 'tiny machine learning', 'on-device', 'quantization', 'embedded inference'],
  'embodied-ai': ['embodied', 'robot learning', 'manipulation polic', 'locomotion', 'sim-to-real', 'sim2real'],
  'digital-twin': ['digital twin', 'model predictive control', 'virtual replica'],
  'spatial-computing': ['augmented reality', 'virtual reality', 'spatial computing', 'slam', 'mixed reality'],
  'low-altitude': ['unmanned aerial', 'uav', 'drone', 'urban air mobility'],
  'new-energy': ['solar cell', 'photovoltaic', 'lithium', 'battery', 'hydrogen energy', 'energy storage'],
  'nuclear-energy': ['nuclear', 'fission', 'fusion', 'reactor'],
  'quantum-computing': ['quantum comput', 'qubit', 'quantum algorithm', 'quantum error correction'],
  'quantum-materials': ['quantum material', 'superconductor', 'topological material', 'two-dimensional material', '2d material'],
  'semiconductor': ['semiconductor', 'transistor', 'lithograph', 'gallium nitride', 'wafer', 'chip design'],
  'sat-6g': ['satellite', '6g', 'leo constellation', 'non-terrestrial network'],
  'robot-parts': ['actuator', 'gripper', 'servo', 'soft robot'],
  'alien-minerals': ['meteorite', 'mineralog', 'geolog'],
  'synbio-manufacturing': ['biomanufactur', 'fermentation', 'metabolic engineering', 'bio-based production'],
  'tcm-tools': ['traditional chinese medicine', 'herbal', 'acupuncture', 'chinese materia medica'],
  'genetech-tools': ['bioinformatic', 'sequencing pipeline', 'sequence alignment', 'variant calling'],
  'mcp-server': ['decision support system', 'interoperability', 'fhir', 'health data exchange'],
};

function classifySite(text) {
  const t = (text || '').toLowerCase();
  const hits = [];
  for (const [site, kws] of Object.entries(SITE_KEYWORDS)) {
    if (kws.some((k) => t.includes(k))) hits.push(site);
  }
  if (hits.length === 0) hits.push('papers');
  return hits.slice(0, 4);
}

function httpGet(url, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const hard = setTimeout(() => ac.abort(), timeoutMs); // 独立墙钟：无论如何必触发，不依赖 socket 事件
    let settled = false;
    const done = (fn) => (v) => { if (settled) return; settled = true; clearTimeout(hard); fn(v); };
    const ok = done(resolve);
    const fail = done(reject);
    const req = https.get(url, { headers: { 'User-Agent': `${TOOL}/1.0 (${EMAIL})` }, signal: ac.signal }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) ok(body);
        else fail(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('error', (e) => fail(e));
    ac.signal.addEventListener('abort', () => { try { req.destroy(); } catch {} fail(new Error('hard-timeout')); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWithRetry(url, maxRetry = 4) {
  let wait = 1500;
  for (let i = 0; i <= maxRetry; i++) {
    try {
      return await httpGet(url);
    } catch (e) {
      const m = String(e.message);
      const isRateLimit = m.includes('429');
      const isServer = /\b5\d{2}\b/.test(m) || m.includes('HTTP 5');
      const transient = m.includes('timeout') || m.includes('ECONN') || m.includes('ETIMEDOUT') || m.includes('aborted');
      if ((isRateLimit || isServer || transient) && i < maxRetry) {
        const back = isRateLimit || isServer ? wait : 700;
        console.warn(`  [retry ${m.slice(0, 40)}] 退避 ${back}ms (${i + 1}/${maxRetry})`);
        await sleep(back);
        wait = Math.min(wait * 2, 15000);
        continue;
      }
      throw e;
    }
  }
  throw new Error('retry exhausted');
}

// 给单个检索词整体加墙钟预算，超时即抛错（由外层 catch 跳过该词，继续下一个）
async function withBudget(promise, ms, label) {
  let t;
  const guard = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`budget-exceeded:${label}`)), ms); });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(t);
  }
}

function unescapeXml(s) {
  return (s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\s+/g, ' ').trim();
}

// 从 PubMed HTML/XML abstract 文本抓 DOI
function extractDoi(text) {
  const m = text && text.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/);
  return m ? m[0] : '';
}

// 解析 efetch 返回的一批 Article（XML）
function parseArticles(xml) {
  const out = [];
  const articles = xml.split('<PubmedArticle>').slice(1);
  for (const a of articles) {
    const pmidM = a.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    const pmid = pmidM ? pmidM[1] : '';
    if (!pmid) continue;
    const titleM = a.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
    const title = unescapeXml(titleM ? titleM[1] : '');
    if (!title) continue;
    const absM = a.match(/<Abstract>([\s\S]*?)<\/Abstract>/);
    const abstract = unescapeXml(absM ? absM[1].replace(/<[^>]+>/g, ' ') : '').slice(0, 1200);
    const yearM = a.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/);
    const year = yearM ? parseInt(yearM[1], 10) : null;
    const authorM = a.match(/<Author[^>]*>[\s\S]*?<LastName>([\s\S]*?)<\/LastName>/g) || [];
    const authors = authorM.map((x) => unescapeXml(x.replace(/<[^>]+>/g, ''))).slice(0, 10);
    const fullText = `${title} ${abstract}`;
    const doi = extractDoi(fullText);
    const tags = classifySite(fullText);
    out.push({
      id: `pm:${pmid}`,
      source: 'pubmed',
      pmid,
      doi,
      title,
      abstract,
      url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      authors,
      year,
      concepts: [],
      tags,
      sites: tags,
      referencedBy: 0,
      confidence: 0.72,
      fetchedAt: new Date().toISOString(),
    });
  }
  return out;
}

function saveAll(all, report) {
  if (DRY) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(all), 'utf-8'); // 紧凑 JSON，省 Pages 体积
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
}

(async () => {
  const existing = (() => { try { return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch { return []; } })();
  const byKey = new Map();
  for (const e of existing) byKey.set(e.doi || e.pmid || e.id, e);
  const startCount = byKey.size;
  let added = 0, updated = 0, qi = 0;

  const mkReport = () => ({
    pipeline: 'pubmed-expand',
    timestamp: new Date().toISOString(),
    dryRun: DRY,
    added, updated, total: byKey.size,
    bySite: Array.from(byKey.values()).reduce((m, e) => { for (const s of (e.sites || [])) m[s] = (m[s] || 0) + 1; return m; }, {}),
    maxTotal: MAX_TOTAL,
  });

  for (const [site, q] of QUERIES) {
    if (byKey.size >= MAX_TOTAL) { console.log(`[cap] 已达 MAX_TOTAL=${MAX_TOTAL}，停止`); break; }
    qi++;
    console.log(`[PubMed ${qi}/${QUERIES.length}] "${q}" (站=${site}) ...`);
    try {
      await withBudget((async () => {
        const esUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(q)}&retmode=json&retmax=${RETMAX}&sort=date&tool=${TOOL}&email=${encodeURIComponent(EMAIL)}`;
        const esJson = JSON.parse(await getWithRetry(esUrl));
        const ids = (esJson?.esearchresult?.idlist || []).filter((x) => !byKey.has(`pm:${x}`));
        if (ids.length === 0) { console.log('  → 无新 PMID'); return; }
        const efUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(',')}&rettype=abstract&retmode=xml&tool=${TOOL}&email=${encodeURIComponent(EMAIL)}`;
        const xml = await getWithRetry(efUrl);
        const items = parseArticles(xml);
        for (const it of items) {
          const k = it.doi || `pm:${it.pmid}` || it.id;
          if (byKey.has(k)) { updated++; continue; }
          byKey.set(k, it); added++;
        }
        console.log(`  → 累计 ${byKey.size} 条 (本轮 +${items.length})`);
      })(), QUERY_BUDGET_MS, q);
    } catch (e) {
      console.error(`[PubMed][${site}] 跳过: ${e.message}`);
    }
    if (qi % SAVE_EVERY === 0) { saveAll(Array.from(byKey.values()), mkReport()); console.log(`  [save] 增量落盘 total=${byKey.size}`); }
    await sleep(DELAY_MS);
  }

  const all = Array.from(byKey.values());
  saveAll(all, mkReport());
  console.log(`[pubmed-expand] total=${all.length} (start=${startCount}) added=${added} updated=${updated}` + (DRY ? ' (dry-run)' : ''));
})().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
