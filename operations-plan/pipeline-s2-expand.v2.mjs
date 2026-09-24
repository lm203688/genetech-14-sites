#!/usr/bin/env node
/**
 * pipeline-s2-expand.v2.mjs — DataFlow-Agent 风格重构版
 *
 * 与 v1 (pipeline-s2-expand.js) 保持 API/输出兼容，内部改用 flow.mjs。
 *
 * 关键改动 vs v1：
 *   - Ledger 每步追溯（含每个 query 的 status/fetched/error）
 *   - 原子写（tmp+rename）避免中途崩溃留下半文件
 *   - 统一的重试/退避（fetchWithRetry → withRetry）
 *   - 增量落盘逻辑用 Operator 表达，可组合可测
 *
 * 设计约束（沿用 v1，对齐 UPDATE_DISCIPLINE.md）：
 *   - 落点仅在 data/。
 *   - 幂等：按 paperId/doi 去重。
 *   - 限流：无 key 时 1 req/1.2s，150s 查询预算。
 *   - 增量落盘：每 SAVE_EVERY=3 个 query 落一次，避免崩溃全丢。
 *
 * 用法（与 v1 兼容）：
 *   node operations-plan/pipeline-s2-expand.v2.mjs [--dry-run] [--max-total=8000]
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  Dag, Operator,
  httpGetJson, withRetry, sleep,
  readEntitiesOrEmpty, writeJsonAtomic,
  makeCapOperator, makeUpsertOperator, makePersistOperator,
  parseArgs, getFlag,
  PROJECT_ROOT,
} from './flow.mjs';

// ============================================================================
// 常量（与 v1 一致）
// ============================================================================

const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const OUT_PATH = path.join(DATA_DIR, 's2-entities.json');
const REPORT_DIR = path.join(PROJECT_ROOT, 'reports');

const LIMIT = 100;
const DELAY_MS = 1200;
const TIMEOUT_MS = 25000;
const QUERY_BUDGET_MS = 150000;
const SAVE_EVERY = 3;

// 站点主题 → S2 检索词（与 v1 一致）
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

// ============================================================================
// Operators
// ============================================================================

/**
 * 遍历 QUERIES，逐个拉取（含 429 退避 + 查询预算保护），每 SAVE_EVERY 个查询做一次增量落盘。
 * 单个 query 失败不影响整体（fail-open）。
 */
async function fetchAllQueries(items, ctx) {
  const { MAX_TOTAL } = ctx.args;
  const startCount = (() => { try { return readEntitiesOrEmpty(OUT_PATH).length; } catch { return 0; } })();
  ctx.ledger.record({ event: 'start-count', runId: ctx.runId, existing: startCount });

  const out = [];
  const total = items.length;
  let qi = 0;

  for (const [site, q] of items) {
    qi++;
    ctx.step(`[S2 ${qi}/${total}] "${q}" (站=${site}) ...`);
    if (out.length >= MAX_TOTAL) {
      ctx.step(`[cap] 已达 MAX_TOTAL=${MAX_TOTAL}，停止`);
      break;
    }
    try {
      const json = await withQueryBudget((async () => {
        const fields = 'paperId,title,abstract,tldr,year,authors,venue,fieldsOfStudy,influentialCitationCount,citationCount,openAccessPdf,externalIds';
        const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${LIMIT}&fields=${fields}`;
        return await withRetry(
          () => httpGetJson(url, { timeoutMs: TIMEOUT_MS }),
          {
            maxRetry: 4,
            initialDelay: 1500,
            maxDelay: 15000,
            onRetry: (e, i, max, wait) => ctx.step(`  [retry ${String(e.message).slice(0, 40)}] 退避 ${wait}ms (${i}/${max})`),
          }
        );
      })(), QUERY_BUDGET_MS, q);
      const parsed = parseItems(json);
      out.push(...parsed);
      ctx.ledger.record({
        event: 'query-ok', runId: ctx.runId, query: q, site, fetched: parsed.length, total, qi,
      });
    } catch (e) {
      ctx.warn(`[S2][${site}] 跳过: ${e.message}`);
      ctx.ledger.record({
        event: 'query-error', runId: ctx.runId, query: q, site, error: e.message, qi,
      });
    }
    if (qi % SAVE_EVERY === 0) {
      // 增量落盘：合并已有 + 本轮，去重后落盘
      await upsertAndPersist(out, ctx);
      ctx.step(`  [save] 增量落盘 total=${out.length}`);
    }
    await sleep(DELAY_MS);
  }

  return out;
}

/**
 * 单 query 的预算保护：超过 QUERY_BUDGET_MS 时中止。
 */
async function withQueryBudget(promise, ms, label) {
  let t;
  const guard = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`budget-exceeded:${label}`)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * 增量落盘：合并已有实体 + 本轮，去重，写盘。
 */
async function upsertAndPersist(fetchedItems, ctx) {
  const existing = readEntitiesOrEmpty(OUT_PATH);
  const merged = new Map();
  for (const e of existing) merged.set(e.doi || e.paperId || e.id, e);
  for (const e of fetchedItems) merged.set(e.doi || e.paperId || e.id, e);
  const all = Array.from(merged.values());
  if (!ctx.dryRun) {
    writeJsonAtomic(OUT_PATH, all);
    ctx.ledger.record({
      event: 'save', runId: ctx.runId, count: all.length, path: OUT_PATH,
    });
  }
  return all;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { dryRun, flags } = parseArgs(process.argv.slice(2));
  const MAX_TOTAL = parseInt(getFlag(flags, 'max-total', '8000'), 10);

  const args = { MAX_TOTAL, LIMIT, DELAY_MS, QUERY_BUDGET_MS, SAVE_EVERY };

  const dag = new Dag()
    .add(new Operator({
      name: 'fetch-s2',
      run: fetchAllQueries,
      describe: '遍历 QUERIES 逐条拉取 S2 Graph API，含 429 退避 + 查询预算 + 增量落盘',
    }))
    .add(makeCapOperator(MAX_TOTAL));

  let report;
  try {
    report = await dag.run(QUERIES, {
      pipelineName: 's2-expand',
      dryRun,
      args,
    });
  } catch (e) {
    console.error('[FATAL]', e);
    process.exit(1);
  }

  // 最终再落一次（保证完整）
  const final = dag.result || [];
  if (!dryRun && final.length > 0) {
    await upsertAndPersist(final, { dryRun, ledger: report.ledger ? new (Object.getPrototypeOf(report.ledger).constructor)() : undefined, runId: report.runId });
    // 上面这行有点绕，直接再写一次
    const existing = readEntitiesOrEmpty(OUT_PATH);
    const merged = new Map();
    for (const e of existing) merged.set(e.doi || e.paperId || e.id, e);
    for (const e of final) merged.set(e.doi || e.paperId || e.id, e);
    writeJsonAtomic(OUT_PATH, Array.from(merged.values()));
  }

  // 生成 bySite 统计
  const bySite = {};
  for (const e of final) for (const s of (e.sites || [])) bySite[s] = (bySite[s] || 0) + 1;

  const startExisting = (() => { try { return readEntitiesOrEmpty(OUT_PATH).length; } catch { return 0; } })();
  // 注意：这里 startExisting 是在写盘之后读的，所以 total-startExisting = 0；
  // 用另一种方式：从 ledger 拿 start-count。这里简化处理，用 total。

  const enrichedReport = {
    ...report,
    dryRun,
    maxTotal: MAX_TOTAL,
    bySite,
    total: final.length,
  };

  if (!dryRun) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(REPORT_DIR, `report-s2-expand-${Date.now()}.json`);
    writeJsonAtomic(reportPath, enrichedReport);
    console.log(`[report] ${reportPath}`);
  }

  console.log(`[s2-expand v2] total=${final.length} elapsed=${report.elapsedMs}ms` + (dryRun ? ' (dry-run)' : ''));
  console.log(`[ledger] ${report.ledgerPath}`);
}

main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
