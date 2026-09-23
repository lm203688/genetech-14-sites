#!/usr/bin/env node
/**
 * 能力域④-学术实体扩库（第四源）：pipeline-s2-expand.js
 *
 * 从 Semantic Scholar Graph API（免费、API key 可选但无 key 也可用）
 * 批量拉取与站点主题相关的科研著作元数据，结构化、去重、归类后写入 data/s2-entities.json。
 *
 * 定位：与 OpenAlex/PubMed/Crossref 互补——Semantic Scholar 提供 AI 模型计算的影响力指标
 * （influentialCitationCount / tldr 摘要 / openAccessPdf），是"实体影响力"维度的关键补充。
 *
 * 设计约束（对齐 pipeline-openalex-expand.js / pipeline-pubmed-expand.js，2026-09-23）：
 *   - 落点仅在 data/，不写 <site>/website/api/entities.json（30 站已 ALL-AT-CAP，各 10,000）。
 *   - 体积受控：精简字段 + 紧凑 JSON，总量封顶 MAX_TOTAL。
 *   - 幂等：按 paperId / doi 去重；重跑只 upsert。
 *   - 健壮性：每词墙钟预算 + 增量落盘 + 429/5xx 退避。
 *
 * 用法：
 *   node operations-plan/pipeline-s2-expand.js [--dry-run] [--max-total=8000]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const OUT_PATH = path.join(DATA_DIR, 's2-entities.json');
const REPORT_PATH = path.join(PROJECT_ROOT, 'reports', `report-s2-expand-${Date.now()}.json`);

const DRY = process.argv.includes('--dry-run');
const getArg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const MAX_TOTAL = parseInt(getArg('max-total', '8000'), 10);
const LIMIT = 100;
const DELAY_MS = 1200;          // Semantic Scholar 无 key 限速 1 req/1.2s
const TIMEOUT_MS = 25000;
const QUERY_BUDGET_MS = 150000;
const SAVE_EVERY = 3;

// 站点主题 → S2 检索词（[site, query]），覆盖更多站点
const QUERIES = [
  ['biomed-ai', 'biomedical artificial intelligence clinical'],
  ['brain-science', 'neuroscience brain imaging cognition'],
  ['synthetic-biology', 'synthetic biology genetic circuit'],
  ['crispr', 'CRISPR gene editing genome'],
  ['protein-design', 'protein structure prediction design'],
  ['biocomputing', 'DNA computing molecular storage'],
  ['bionic-ai', 'neural interface prosthesis bionic'],
  ['nanomedicine', 'nanomedicine drug delivery nanoparticle'],
  ['ai-drug', 'machine learning drug discovery'],
  ['autonomous-lab', 'automated laboratory self-driving lab'],
  ['life-science', 'single cell transcriptomics genomics'],
  ['agritech', 'crop phenotyping agricultural AI'],
  ['carbon-neutral', 'carbon capture climate biotechnology'],
  ['deep-sea-tech', 'deep sea marine biology'],
  ['neuromorphic', 'neuromorphic computing spiking neural'],
  ['exo-science', 'astrobiology exoplanet habitability'],
  ['ai-safety', 'AI alignment safety robustness'],
  ['ai4science', 'scientific machine learning discovery'],
  ['privacy-computing', 'federated learning differential privacy'],
  ['edge-ai', 'edge computing on-device machine learning'],
  ['embodied-ai', 'robot manipulation learning policy'],
  ['digital-twin', 'digital twin simulation industry'],
  ['spatial-computing', 'augmented reality spatial interface'],
  ['low-altitude', 'unmanned aerial vehicle autonomous navigation'],
  ['new-energy', 'lithium battery solar cell perovskite'],
  ['nuclear-energy', 'nuclear fusion reactor plasma'],
  ['quantum-computing', 'quantum computing qubit algorithm'],
  ['quantum-materials', 'quantum material superconductor topological'],
  ['semiconductor', 'semiconductor transistor lithography'],
  ['sat-6g', 'satellite communication 6G network'],
  ['robot-parts', 'soft robotics actuator gripper'],
  ['alien-minerals', 'meteorite mineralogy geology'],
  ['synbio-manufacturing', 'metabolic engineering biomanufacturing'],
  ['tcm-tools', 'traditional chinese medicine herbal pharmacology'],
  ['agent-ecosystem', 'multi-agent large language model autonomous'],
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
    const req = https.get(url, { headers: { 'User-Agent': 'Genetech14Infra/1.0 (mailto:ops@swarmlabs.tools)' }, signal: ac.signal }, (res) => {
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
        const back = isRateLimit || isServer ? wait : 800;
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

function parseItems(json) {
  const items = json?.data || [];
  const out = [];
  for (const it of items) {
    const pid = it.paperId || '';
    if (!pid) continue;
    const title = it.title || '';
    if (!title) continue;
    const abstract = (it.abstract || (it.tldr?.text) || '').slice(0, 1200);
    const year = it.year || null;
    const authors = (it.authors || []).map((a) => a.name).slice(0, 10);
    const doi = it.externalIds?.DOI || '';
    const fullText = `${title} ${abstract} ${(it.fieldsOfStudy || []).join(' ')}`;
    const tags = classifySite(fullText);
    out.push({
      id: `s2:${pid}`,
      source: 'semantic-scholar',
      paperId: pid,
      doi,
      title,
      abstract,
      url: it.openAccessPdf?.url || (doi ? `https://doi.org/${doi}` : `https://www.semanticscholar.org/paper/${pid}`),
      authors,
      year,
      venue: it.venue || '',
      fieldsOfStudy: (it.fieldsOfStudy || []).slice(0, 6),
      influentialCitationCount: it.influentialCitationCount || 0,
      citationCount: it.citationCount || 0,
      openAccessPdf: it.openAccessPdf?.url || '',
      concepts: [],
      tags,
      sites: tags,
      referencedBy: it.influentialCitationCount || 0,
      confidence: 0.75,
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
  for (const e of existing) byKey.set(e.doi || e.paperId || e.id, e);
  const startCount = byKey.size;
  let added = 0, updated = 0, qi = 0;

  const mkReport = () => ({
    pipeline: 's2-expand',
    timestamp: new Date().toISOString(),
    dryRun: DRY,
    added, updated, total: byKey.size,
    bySite: Array.from(byKey.values()).reduce((m, e) => { for (const s of (e.sites || [])) m[s] = (m[s] || 0) + 1; return m; }, {}),
    maxTotal: MAX_TOTAL,
  });

  for (const [site, q] of QUERIES) {
    if (byKey.size >= MAX_TOTAL) { console.log(`[cap] 已达 MAX_TOTAL=${MAX_TOTAL}，停止`); break; }
    qi++;
    console.log(`[S2 ${qi}/${QUERIES.length}] "${q}" (站=${site}) ...`);
    try {
      await withBudget((async () => {
        const fields = 'paperId,title,abstract,tldr,year,authors,venue,fieldsOfStudy,influentialCitationCount,citationCount,openAccessPdf,externalIds';
        const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${LIMIT}&fields=${fields}`;
        const json = JSON.parse(await getWithRetry(url));
        const items = parseItems(json);
        let n = 0;
        for (const it of items) {
          const k = it.doi || it.paperId || it.id;
          if (byKey.has(k)) { updated++; continue; }
          byKey.set(k, it); added++; n++;
        }
        console.log(`  → 累计 ${byKey.size} 条 (本轮 +${n}/${items.length})`);
      })(), QUERY_BUDGET_MS, q);
    } catch (e) {
      console.error(`[S2][${site}] 跳过: ${e.message}`);
    }
    if (qi % SAVE_EVERY === 0) { saveAll(Array.from(byKey.values()), mkReport()); console.log(`  [save] 增量落盘 total=${byKey.size}`); }
    await sleep(DELAY_MS);
  }

  const all = Array.from(byKey.values());
  saveAll(all, mkReport());
  console.log(`[s2-expand] total=${all.length} (start=${startCount}) added=${added} updated=${updated}` + (DRY ? ' (dry-run)' : ''));
})().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
