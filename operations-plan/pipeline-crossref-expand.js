#!/usr/bin/env node
/**
 * 能力域④-学术实体扩库（第三源）：pipeline-crossref-expand.js
 *
 * 从 Crossref REST API（免费、无 key、全球最大 DOI 元数据库，2 亿+ 条记录）批量拉取与
 * 站点主题相关的科研著作元数据，结构化、去重、归类后写入 data/crossref-entities.json。
 *
 * 定位：与 OpenAlex（学术图谱广度）/ PubMed（生物医学深度）互补，Crossref 提供 DOI 可溯源的
 * 出版级元数据（期刊、被引数、主题分类），是摘要回填链路的关键配套源。
 *
 * 设计约束（对齐 pipeline-openalex-expand.js / pipeline-pubmed-expand.js，2026-09-23）：
 *   - 落点仅在 data/，不写 <site>/website/api/entities.json（30 站已 ALL-AT-CAP，各 10,000）。
 *   - 体积受控：精简字段 + 紧凑 JSON，总量封顶 MAX_TOTAL，确保 _site（~955MB/1GB）不超限。
 *   - 幂等：按 doi 去重；重跑只 upsert。
 *   - 健壮性：每词墙钟预算 + 增量落盘 + 429/5xx 退避。
 *
 * 用法：
 *   node operations-plan/pipeline-crossref-expand.js [--dry-run] [--max-total=10000]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const OUT_PATH = path.join(DATA_DIR, 'crossref-entities.json');
const REPORT_PATH = path.join(PROJECT_ROOT, 'reports', `report-crossref-expand-${Date.now()}.json`);

const DRY = process.argv.includes('--dry-run');
const getArg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const MAX_TOTAL = parseInt(getArg('max-total', '10000'), 10);
const ROWS = 100;
const DELAY_MS = 500;
const TIMEOUT_MS = 20000;
const QUERY_BUDGET_MS = 150000;
const SAVE_EVERY = 3;
const MAILTO = 'ops@swarmlabs.tools';

// 站点主题 → Crossref 检索词（[site, query]）
const QUERIES = [
  ['biomed-ai', 'artificial intelligence clinical diagnosis'],
  ['biomed-ai', 'precision medicine genomics'],
  ['brain-science', 'neuroscience brain imaging'],
  ['brain-science', 'cognitive neuroscience memory'],
  ['synthetic-biology', 'synthetic biology genetic circuit'],
  ['crispr', 'CRISPR genome editing'],
  ['protein-design', 'protein structure prediction design'],
  ['biocomputing', 'DNA computing molecular information'],
  ['bionic-ai', 'neural interface prosthesis'],
  ['nanomedicine', 'nanomedicine drug delivery'],
  ['ai-drug', 'machine learning drug discovery'],
  ['autonomous-lab', 'automated laboratory robotics'],
  ['life-science', 'single cell transcriptomics'],
  ['life-science', 'microbiome metagenomics'],
  ['agritech', 'agriculture artificial intelligence crop'],
  ['carbon-neutral', 'carbon capture climate'],
  ['deep-sea-tech', 'deep sea marine ecology'],
  ['neuromorphic', 'neuromorphic computing spiking neural network'],
  ['exo-science', 'astrobiology exoplanet habitability'],
  ['ai-safety', 'AI alignment safety robustness'],
  ['ai4science', 'scientific machine learning discovery'],
  ['privacy-computing', 'federated learning privacy'],
  ['edge-ai', 'edge computing embedded machine learning'],
  ['embodied-ai', 'embodied intelligence robot manipulation'],
  ['digital-twin', 'digital twin simulation industry'],
  ['spatial-computing', 'augmented reality spatial interface'],
  ['low-altitude', 'UAV autonomous navigation'],
  ['new-energy', 'perovskite solar cell battery'],
  ['new-energy', 'hydrogen energy storage'],
  ['nuclear-energy', 'nuclear fusion reactor'],
  ['quantum-computing', 'quantum computing algorithm'],
  ['quantum-materials', 'quantum materials superconductor'],
  ['semiconductor', 'semiconductor transistor fabrication'],
  ['sat-6g', 'satellite network 6G communication'],
  ['robot-parts', 'soft robotics actuator'],
  ['alien-minerals', 'meteorite mineralogy geology'],
  ['synbio-manufacturing', 'metabolic engineering biomanufacturing'],
  ['tcm-tools', 'traditional chinese medicine pharmacology'],
  ['mcp-server', 'clinical decision support system'],
  ['agent-ecosystem', 'multi-agent system large language model'],
];

const SITE_KEYWORDS = {
  'biomed-ai': ['biomedical', 'clinical', 'diagnos', 'medical imaging', 'precision medicine', 'health informatics', 'electronic health'],
  'brain-science': ['neuroscience', 'neuron', 'cortical', 'brain', 'cognitive', 'eeg', 'fmri', 'synap', 'hippocamp'],
  'synthetic-biology': ['synthetic biology', 'genetic circuit', 'chassis organism', 'genome engineering'],
  'crispr': ['crispr', 'cas9', 'gene editing', 'base editing', 'prime editing', 'guide rna'],
  'protein-design': ['protein design', 'protein structure', 'protein folding', 'alphafold', 'enzyme engineering', 'de novo protein'],
  'biocomputing': ['dna computing', 'molecular computing', 'biocomput', 'dna storage'],
  'bionic-ai': ['prosthe', 'bionic', 'exoskeleton', 'neural interface', 'brain-computer interface', 'brain machine interface'],
  'nanomedicine': ['nanomedicine', 'nanoparticle', 'nanocarrier', 'liposome'],
  'ai-drug': ['drug discovery', 'drug design', 'virtual screening', 'admet', 'molecular generation', 'drug repurposing'],
  'autonomous-lab': ['laboratory automation', 'self-driving lab', 'robotic platform', 'high-throughput screening', 'automated experiment'],
  'life-science': ['genomic', 'transcriptom', 'proteom', 'single-cell', 'single cell', 'microbiome', 'metagenom', 'epigenet'],
  'agritech': ['agricultur', 'crop', 'phenotyping', 'plant breeding', 'precision farming', 'soil'],
  'carbon-neutral': ['carbon capture', 'climate change', 'decarboni', 'greenhouse gas', 'emission reduction'],
  'deep-sea-tech': ['deep sea', 'deep-sea', 'hydrothermal', 'marine biolog', 'submersible'],
  'neuromorphic': ['neuromorphic', 'spiking neural', 'memristor', 'in-memory computing'],
  'exo-science': ['astrobiolog', 'exobiolog', 'extraterrestrial', 'biosignature', 'exoplanet'],
  'ai-safety': ['ai safety', 'alignment', 'adversarial', 'interpretab'],
  'ai4science': ['ai for science', 'scientific machine learning', 'foundation model', 'surrogate model', 'neural operator'],
  'privacy-computing': ['federated learning', 'differential privacy', 'homomorphic', 'secure multiparty', 'privacy-preserving'],
  'edge-ai': ['edge computing', 'tinyml', 'tiny machine learning', 'on-device', 'embedded machine learning'],
  'embodied-ai': ['embodied', 'robot learning', 'manipulation polic', 'locomotion', 'sim-to-real'],
  'digital-twin': ['digital twin', 'model predictive control', 'virtual replica'],
  'spatial-computing': ['augmented reality', 'virtual reality', 'spatial computing', 'slam', 'mixed reality'],
  'low-altitude': ['unmanned aerial', 'uav', 'drone', 'urban air mobility'],
  'new-energy': ['solar cell', 'photovoltaic', 'lithium', 'battery', 'hydrogen energy', 'energy storage', 'perovskite'],
  'nuclear-energy': ['nuclear', 'fission', 'fusion', 'reactor'],
  'quantum-computing': ['quantum comput', 'qubit', 'quantum algorithm', 'quantum error correction'],
  'quantum-materials': ['quantum material', 'superconductor', 'topological material', 'two-dimensional material'],
  'semiconductor': ['semiconductor', 'transistor', 'lithograph', 'gallium nitride', 'wafer', 'chip design'],
  'sat-6g': ['satellite', '6g', 'leo constellation', 'non-terrestrial network'],
  'robot-parts': ['actuator', 'gripper', 'servo', 'soft robot'],
  'alien-minerals': ['meteorite', 'mineralog', 'geolog'],
  'synbio-manufacturing': ['biomanufactur', 'fermentation', 'metabolic engineering', 'bio-based production'],
  'tcm-tools': ['traditional chinese medicine', 'herbal', 'acupuncture', 'chinese materia medica'],
  'genetech-tools': ['bioinformatic', 'sequencing pipeline', 'sequence alignment', 'variant calling'],
  'mcp-server': ['decision support system', 'interoperability', 'fhir', 'health data exchange'],
  'agent-ecosystem': ['multi-agent', 'large language model', 'autonomous agent'],
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
    const hard = setTimeout(() => ac.abort(), timeoutMs);
    let settled = false;
    const done = (fn) => (v) => { if (settled) return; settled = true; clearTimeout(hard); fn(v); };
    const ok = done(resolve);
    const fail = done(reject);
    const req = https.get(url, { headers: { 'User-Agent': `Genetech14Infra/1.0 (mailto:${MAILTO})`, Accept: 'application/json' }, signal: ac.signal }, (res) => {
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

async function withBudget(promise, ms, label) {
  let t;
  const guard = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`budget-exceeded:${label}`)), ms); });
  try { return await Promise.race([promise, guard]); } finally { clearTimeout(t); }
}

function stripJats(s) {
  return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseItems(json) {
  const items = json?.message?.items || [];
  const out = [];
  for (const it of items) {
    const doi = it.DOI || '';
    if (!doi) continue;
    const title = Array.isArray(it.title) ? it.title.join(' ') : (it.title || '');
    if (!title) continue;
    const year = it.issued?.['date-parts']?.[0]?.[0] || null;
    const authors = (it.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).slice(0, 10);
    const subject = Array.isArray(it.subject) ? it.subject.slice(0, 6) : [];
    const container = Array.isArray(it['container-title']) ? it['container-title'][0] : (it['container-title'] || '');
    const abstract = stripJats(it.abstract).slice(0, 1200);
    const fullText = `${title} ${abstract} ${subject.join(' ')}`;
    const tags = classifySite(fullText);
    out.push({
      id: `cr:${doi}`,
      source: 'crossref',
      doi,
      title: stripJats(title).slice(0, 400),
      abstract,
      url: it.URL || `https://doi.org/${doi}`,
      authors,
      year,
      container,
      subject,
      citedBy: it['is-referenced-by-count'] || 0,
      type: it.type || '',
      concepts: [],
      tags,
      sites: tags,
      referencedBy: it['is-referenced-by-count'] || 0,
      confidence: abstract ? 0.78 : 0.6,
      fetchedAt: new Date().toISOString(),
    });
  }
  return out;
}

function saveAll(all, report) {
  if (DRY) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(all), 'utf-8');
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
}

(async () => {
  const existing = (() => { try { return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch { return []; } })();
  const byKey = new Map();
  for (const e of existing) byKey.set(e.doi || e.id, e);
  const startCount = byKey.size;
  let added = 0, updated = 0, qi = 0;

  const mkReport = () => ({
    pipeline: 'crossref-expand',
    timestamp: new Date().toISOString(),
    dryRun: DRY,
    added, updated, total: byKey.size,
    bySite: Array.from(byKey.values()).reduce((m, e) => { for (const s of (e.sites || [])) m[s] = (m[s] || 0) + 1; return m; }, {}),
    maxTotal: MAX_TOTAL,
  });

  for (const [site, q] of QUERIES) {
    if (byKey.size >= MAX_TOTAL) { console.log(`[cap] 已达 MAX_TOTAL=${MAX_TOTAL}，停止`); break; }
    qi++;
    console.log(`[Crossref ${qi}/${QUERIES.length}] "${q}" (站=${site}) ...`);
    try {
      await withBudget((async () => {
        const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=${ROWS}&select=DOI,title,abstract,author,issued,subject,type,URL,is-referenced-by-count,container-title&mailto=${MAILTO}`;
        const json = JSON.parse(await getWithRetry(url));
        const items = parseItems(json);
        let n = 0;
        for (const it of items) {
          const k = it.doi || it.id;
          if (byKey.has(k)) { updated++; continue; }
          byKey.set(k, it); added++; n++;
        }
        console.log(`  → 累计 ${byKey.size} 条 (本轮 +${n}/${items.length})`);
      })(), QUERY_BUDGET_MS, q);
    } catch (e) {
      console.error(`[Crossref][${site}] 跳过: ${e.message}`);
    }
    if (qi % SAVE_EVERY === 0) { saveAll(Array.from(byKey.values()), mkReport()); console.log(`  [save] 增量落盘 total=${byKey.size}`); }
    await sleep(DELAY_MS);
  }

  const all = Array.from(byKey.values());
  saveAll(all, mkReport());
  console.log(`[crossref-expand] total=${all.length} (start=${startCount}) added=${added} updated=${updated}` + (DRY ? ' (dry-run)' : ''));
})().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
