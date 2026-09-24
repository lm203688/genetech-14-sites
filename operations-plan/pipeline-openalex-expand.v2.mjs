#!/usr/bin/env node
/**
 * pipeline-openalex-expand.v2.mjs — DataFlow-Agent 风格重构版
 *
 * 与 v1 (pipeline-openalex-expand.js) 保持 API/输出兼容（同 OUT_PATH、同字段），
 * 但内部改用 flow.mjs 的 Operator + Dag + Ledger，获得：
 *   - 每一步执行都有 ledger 追溯（state/flow/ledger.jsonl）
 *   - 统一的重试/退避/原子写（不用每个脚本各写一遍）
 *   - Checkpoint 支持（长任务中断可从 state/flow/checkpoint-*.json 恢复）
 *   - 报告结构统一（steps[] + elapsedMs + error）
 *
 * 设计约束（沿用 v1，对齐 UPDATE_DISCIPLINE.md）：
 *   - 落点仅在 data/，不写 sites/<site>/_data/entities.json（30 站已 ALL-AT-CAP）。
 *   - 幂等：按 doi/openalexId 去重；重跑只 upsert。
 *   - 429 退避：fetchWithRetry 指数退避，最高 20s。
 *   - 限流：per-page=200，请求间隔 120ms。
 *
 * 用法（与 v1 兼容）：
 *   node operations-plan/pipeline-openalex-expand.v2.mjs [--dry-run] [--max-total=5000] [--pages=3]
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
const OUT_PATH = path.join(DATA_DIR, 'academic-entities.json');
const REPORT_DIR = path.join(PROJECT_ROOT, 'reports');

const PER_PAGE = 200;
const DELAY_MS = 120;

// 14 站主题 → OpenAlex 检索词（title_and_abstract.search 高召回）
// 与 v1 完全一致（含 25 个前沿检索词）
const TERMS = [
  ['ai-agents', 'autonomous AI agent'],
  ['mcp', 'model context protocol'],
  ['quantum-computing', 'quantum computing'],
  ['brain-science', 'neuroscience brain'],
  ['biomed-ai', 'biomedical artificial intelligence'],
  ['biocomputing', 'biocomputing'],
  ['bionic-ai', 'bionic prosthesis AI'],
  ['embodied-ai', 'embodied AI robotics'],
  ['edge-ai', 'edge AI inference'],
  ['ai4science', 'AI for science'],
  ['digital-twin', 'digital twin'],
  ['carbon-neutral', 'carbon neutral climate'],
  ['agritech', 'agriculture AI'],
  ['deep-sea-tech', 'deep sea technology'],
  ['exo-science', 'exobiology'],
  ['alien-minerals', 'astrobiology mineral'],
  ['synthetic-biology', 'synthetic biology'],
  ['crispr', 'CRISPR gene editing'],
  ['protein-design', 'protein design'],
  ['materials-genome', 'materials genome'],
  ['autonomous-lab', 'autonomous laboratory'],
  ['foundation-models', 'foundation model'],
  ['graph-neural-networks', 'graph neural network'],
  ['climate-modeling', 'climate modeling'],
  ['ocean-observatory', 'ocean observation'],
  ['space-biology', 'space biology'],
  ['neuromorphic', 'neuromorphic computing'],
  ['nanomedicine', 'nanomedicine'],
  ['ai-drug', 'AI drug discovery'],
  ['robotics-control', 'robot learning control'],
  ['protein-design', 'AlphaFold structure prediction'],
  ['crispr', 'base editing prime editing'],
  ['biomed-ai', 'precision medicine genomics'],
  ['brain-science', 'cognitive neuroscience memory'],
  ['synthetic-biology', 'metabolic engineering biomanufacturing'],
  ['ai-safety', 'AI alignment safety robustness'],
  ['privacy-computing', 'federated learning differential privacy'],
  ['life-science', 'single cell transcriptomics'],
  ['life-science', 'microbiome metagenomics'],
  ['new-energy', 'lithium battery hydrogen energy'],
  ['new-energy', 'perovskite solar cell'],
  ['nuclear-energy', 'nuclear fusion reactor plasma'],
  ['quantum-materials', 'quantum materials superconductor'],
  ['semiconductor', 'semiconductor transistor lithography'],
  ['sat-6g', 'satellite communication 6G'],
  ['robot-parts', 'soft robotics actuator'],
  ['synbio-manufacturing', 'fermentation bioprocess'],
  ['tcm-tools', 'traditional chinese medicine pharmacology'],
  ['genetech-tools', 'bioinformatics sequencing pipeline'],
  ['mcp-server', 'clinical decision support interoperability'],
  ['spatial-computing', 'augmented reality spatial interface'],
  ['low-altitude', 'unmanned aerial vehicle autonomous'],
  ['embodied-ai', 'robot manipulation policy'],
  ['agent-ecosystem', 'multi-agent large language model'],
];

// ============================================================================
// 分类 + 摘要重建（复用 v1 逻辑）
// ============================================================================

function classifySite(text) {
  const t = (text || '').toLowerCase();
  const hits = [];
  for (const [site, kw] of TERMS) {
    if (t.includes(kw.split(' ')[0]) || t.includes(kw)) hits.push(site);
  }
  if (hits.length === 0) hits.push('papers');
  return [...new Set(hits)];
}

function rebuildAbstract(inv) {
  if (!inv || typeof inv !== 'object') return '';
  const pos = [];
  for (const [w, idxs] of Object.entries(inv)) for (const i of idxs) pos[i] = w;
  return Object.keys(pos).sort((a, b) => a - b).map((i) => pos[i]).join(' ').trim();
}

function buildEntity(w) {
  const doi = w.doi || '';
  const oaId = (w.id || '').replace('https://openalex.org/', '');
  const title = (w.title || w.display_name || '').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const abstract = rebuildAbstract(w.abstract_inverted_index);
  const concepts = (w.concepts || []).map((c) => c.display_name).filter(Boolean).slice(0, 8);
  const authors = (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean).slice(0, 10);
  const text = `${title} ${abstract} ${concepts.join(' ')}`;
  const sites = classifySite(text);
  return {
    id: `oa:${oaId}`,
    source: 'openalex',
    openAlexId: oaId,
    doi,
    title,
    abstract: abstract.slice(0, 1200),
    url: doi ? `https://doi.org/${doi.replace('https://doi.org/', '')}` : (w.landing_page_url || w.id || ''),
    authors,
    year: w.publication_year || null,
    concepts,
    tags: sites,
    sites,
    referencedBy: w.cited_by_count || 0,
    confidence: 0.7,
    fetchedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Operators
// ============================================================================

/**
 * 遍历 TERMS，逐条拉取并返回结构化实体数组。
 * 单个 term 失败不影响其他 term（fail-open，与 v1 一致）。
 */
async function fetchAllTerms(items, ctx) {
  const { MAX_TOTAL, PAGES_PER_TERM } = ctx.args;
  const out = [];
  const total = items.length;
  for (let i = 0; i < total; i++) {
    const [site, term] = items[i];
    ctx.step(`[${i + 1}/${total}] term="${term}" (站=${site}) ...`);
    try {
      const fetched = await fetchTerm(term, {
        pagesPerTerm: PAGES_PER_TERM,
        ctx,
      });
      out.push(...fetched);
      ctx.ledger.record({
        event: 'term-ok', runId: ctx.runId, term, site,
        fetched: fetched.length, total,
      });
    } catch (e) {
      ctx.warn(`[term="${term}"] 失败: ${e.message}`);
      ctx.ledger.record({
        event: 'term-error', runId: ctx.runId, term, site, error: e.message,
      });
    }
    if (out.length >= MAX_TOTAL) {
      ctx.step(`[cap] 已达 MAX_TOTAL=${MAX_TOTAL}，停止拉取`);
      break;
    }
  }
  return out;
}

/**
 * 单个 term 的分页拉取。每页 200 条，含 429/5xx 指数退避。
 */
async function fetchTerm(term, { pagesPerTerm, ctx }) {
  const out = [];
  let cursor = '*';
  for (let p = 0; p < pagesPerTerm; p++) {
    const url = `https://api.openalex.org/works?filter=title_and_abstract.search:${encodeURIComponent(term)}&per-page=${PER_PAGE}&cursor=${encodeURIComponent(cursor)}&sort=publication_date:desc`;
    try {
      const json = await withRetry(
        () => httpGetJson(url, { timeoutMs: 25000 }),
        {
          maxRetry: 6,
          initialDelay: 1500,
          onRetry: (e, i, max, wait) => ctx.step(`  [429/5xx] 退避 ${wait}ms (${i}/${max}): ${String(e.message).slice(0, 40)}`),
        }
      );
      for (const w of json.results || []) {
        const e = buildEntity(w);
        if (e) out.push(e);
      }
      cursor = json.meta?.next_cursor || '';
      if (!cursor) break;
    } catch (e) {
      ctx.warn(`[OpenAlex][${term}] page ${p} 失败: ${e.message}`);
      break;
    }
    await sleep(DELAY_MS);
  }
  return out;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { dryRun, flags } = parseArgs(process.argv.slice(2));
  const MAX_TOTAL = parseInt(getFlag(flags, 'max-total', '5000'), 10);
  const PAGES_PER_TERM = parseInt(getFlag(flags, 'pages', '3'), 10);

  const args = { MAX_TOTAL, PAGES_PER_TERM, PER_PAGE, DELAY_MS };
  const outPathForUpsert = OUT_PATH;
  const outPathForPersist = OUT_PATH;

  const dag = new Dag()
    // 1) 遍历 TERMS 拉取原始实体
    .add(new Operator({
      name: 'fetch-openalex',
      run: fetchAllTerms,
      describe: '遍历 TERMS 分页拉取 OpenAlex works，含 429 退避',
    }))
    // 2) 截断到 MAX_TOTAL
    .add(makeCapOperator(MAX_TOTAL))
    // 3) 与已有 academic-entities.json 合并去重
    .add(makeUpsertOperator(outPathForUpsert, (x) => x.doi || x.openAlexId || x.id))
    // 4) 落盘
    .add(makePersistOperator(outPathForPersist));

  let report;
  try {
    report = await dag.run(TERMS, {
      pipelineName: 'openalex-expand',
      dryRun,
      args,
    });
  } catch (e) {
    console.error('[FATAL]', e);
    process.exit(1);
  }

  // 生成 bySite 统计（v1 report 兼容）
  const final = dag.result || [];
  const bySite = {};
  for (const e of final) for (const s of (e.sites || [])) bySite[s] = (bySite[s] || 0) + 1;

  const startExisting = (() => { try { return readEntitiesOrEmpty(OUT_PATH); } catch { return []; } })();

  const enrichedReport = {
    ...report,
    dryRun,
    maxTotal: MAX_TOTAL,
    pagesPerTerm: PAGES_PER_TERM,
    bySite,
    total: final.length,
    addedThisRun: final.length - startExisting.length,
  };

  if (!dryRun) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = path.join(REPORT_DIR, `report-openalex-expand-${Date.now()}.json`);
    writeJsonAtomic(reportPath, enrichedReport);
    console.log(`[report] ${reportPath}`);
  }

  console.log(`[openalex-expand v2] total=${final.length} added=${enrichedReport.addedThisRun} elapsed=${report.elapsedMs}ms` + (dryRun ? ' (dry-run)' : ''));
  console.log(`[ledger] ${report.ledgerPath}`);
}

main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
