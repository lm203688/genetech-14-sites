#!/usr/bin/env node
/**
 * pipeline-quality-gate.js — 数据质量红线门禁 + confidence 真实化重构
 *
 * 为什么需要它（2026-10-08 全面扫描结论）
 * ----------------------------------------
 * 此前的护栏矩阵只覆盖 publish / ingest / evolve 三类「流程」策略，没有任何一条能拦住
 * 「质量」。实测后果（10 站 × 10,000 = 100,000 实体抽样）：
 *   - 摘要完整度 74.0%（最差站 neuromorphic 42.4%）
 *   - 标签率 68.4%（最差站 neuromorphic 25.9%）
 *   - DOI 覆盖 91.4%（最差站 75.5%）—— 而"每条带 DOI"是对外核心卖点
 *   - confidence 完全退化为 f(source) 的确定性映射（crossref=0.70 / openalex=0.72 /
 *     europepmc=0.80 / pubmed=0.82 ...），信息量为零，是伪装成质量分的来源 one-hot 编码
 *
 * 本脚本两件事：
 *   1. 扫描全站计算 8 项质量指标 → 过 guards/quality.policy.json（同引擎、同语义、默认拒绝）
 *   2. 用多因子模型把 confidence 重算为真实质量分（摘要长度 × DOI × 标签数 × 领域相关性 × 新鲜度 × 被引强度）
 *
 * 用法
 * ----
 *   node operations-plan/pipeline-quality-gate.js                      # 扫描 + 报告（不写盘、不改退出码）
 *   node operations-plan/pipeline-quality-gate.js --ci                 # CI 模式：有站点被 deny 则 exit 1
 *   node operations-plan/pipeline-quality-gate.js --self-test          # 双向回归：注入故障必须被拦、达标必须放行
 *   node operations-plan/pipeline-quality-gate.js --rebuild-confidence --dry-run   # 只统计重算结果
 *   node operations-plan/pipeline-quality-gate.js --rebuild-confidence           # 重算并写回 entities.json
 *   node operations-plan/pipeline-quality-gate.js --rebuild-confidence --site=neuromorphic,nuclear-energy
 *
 * 退出码：0=全绿 / 1=有站点被门禁拒绝（仅 --ci）/ 2=self-test 失败
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadPolicy, evalGuard } from '../tools/guard-eval.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPORTS = path.join(ROOT, 'reports');
const BACKFILL = path.join(ROOT, 'operations-plan', 'pipeline-data-backfill.js');

// ==================== 阈值（与 guards/quality.policy.json 保持同步） ====================
const THRESH = {
  summary_min: 0.60, tag_min: 0.50, doi_min: 0.85, url_min: 0.99,
  dup_max: 0.05, offdomain_max: 0.10,
};

// ==================== 领域词表（单一真源：从 pipeline-data-backfill.js 提取 SITE_QUERIES） ====================
// 不复制一份硬编码，避免与采集引擎的检索词漂移。提取失败则降级为空词表（off_domain 记 0，不误伤）。
export function loadDomainQueries() {
  try {
    const src = fs.readFileSync(BACKFILL, 'utf-8');
    const start = src.indexOf('const SITE_QUERIES');
    if (start === -1) return {};
    const brace = src.indexOf('{', start);
    if (brace === -1) return {};
    let depth = 0, end = -1;
    for (let i = brace; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end === -1) return {};
    return new Function(`'use strict'; return ${src.slice(brace, end)};`)();
  } catch (e) {
    console.warn(`[QualityGate] 领域词表提取失败，off_domain 判定降级为 0：${e.message.slice(0, 100)}`);
    return {};
  }
}

// 把「检索词串」展开成去重小写词元；单字母/极短词过滤，避免噪声命中
export function expandQueryTerms(site, queries) {
  const raw = queries[site];
  if (!raw) return new Set();
  const list = Array.isArray(raw) ? raw.join(' ') : String(raw);
  const terms = new Set();
  for (const tok of list.toLowerCase().split(/[^a-z0-9+#]+/)) {
    if (tok.length >= 3 && !STOPWORDS.has(tok)) terms.add(tok);
  }
  return terms;
}

const STOPWORDS = new Set(['and', 'the', 'for', 'with', 'from', 'new', 'deep', 'large', 'based', 'using', 'model', 'models', 'data', 'analysis']);

// ==================== confidence 真实化：多因子模型 ====================
// 设计原则：任何一条实体都能在 confidence_breakdown 里看到分值是怎么来的（可解释、可反驳）。
// 因子全部是无量纲乘子，落在 [0.92, 1.06] 窄区间，保证
//   (a) 不会掩盖来源权威性这一主信号；
//   (b) 同一来源的不同实体会因摘要/标签/领域命中/年份真实产生差异（验收判据）。
export const SOURCE_BASE = {
  pubmed: 0.82, europepmc: 0.80, cnki: 0.80, arxiv: 0.78,
  doaj: 0.76, semanticscholar: 0.74, preprints: 0.74,
  openalex: 0.72, core: 0.72, crossref: 0.70,
  datacite: 0.66, zenodo: 0.64,
  github: 0.60, huggingface: 0.60,
};
const DEFAULT_BASE = 0.60;

export function summaryText(e) {
  const s = e.summary ?? e.abstract ?? e.description ?? e.snippet ?? '';
  return typeof s === 'string' ? s.trim() : '';
}

export function tagList(e) {
  const t = e.tags ?? e.keywords ?? e.subjects ?? [];
  if (typeof t === 'string') return t.split(/[;,]/).map(x => x.trim()).filter(Boolean);
  return Array.isArray(t) ? t.map(x => String(x).trim()).filter(Boolean) : [];
}

/**
 * 计算实体真实质量分。
 * @returns {{confidence: number, quality_tier: 'A'|'B'|'C'|'D'|'E', confidence_breakdown: object}}
 */
export function computeConfidence(e, site = null, domainTerms = null) {
  const breakdown = {};

  // 因子 0：来源权威度（主信号，基准值）
  const base = SOURCE_BASE[e.source] ?? DEFAULT_BASE;
  breakdown.source_base = base;

  // 因子 1：摘要完整度 —— 摘要长度是 RAG 可用性的直接决定因素
  const slen = summaryText(e).length;
  breakdown.summary_len = slen;
  const f_summary = slen >= 400 ? 1.06 : slen >= 120 ? 1.03 : slen >= 30 ? 1.00 : 0.92;
  breakdown.f_summary = f_summary;

  // 因子 2：DOI 可复核性 —— 本项目核心卖点，无 DOI 直接降档
  const hasDoi = typeof e.doi === 'string' && e.doi.trim().length > 0;
  breakdown.has_doi = hasDoi;
  const f_doi = hasDoi ? 1.03 : 0.96;
  breakdown.f_doi = f_doi;

  // 因子 3：标签密度 —— 决定图谱边密度与跨域桥接能力
  const nTags = tagList(e).length;
  breakdown.tag_count = nTags;
  const f_tags = nTags >= 6 ? 1.04 : nTags >= 3 ? 1.02 : nTags >= 1 ? 1.00 : 0.95;
  breakdown.f_tags = f_tags;

  // 因子 4：领域相关性 —— 「垂直做深」的唯一可计算代理
  let domainHits = null, f_domain = 1.0;
  if (site && domainTerms && domainTerms.size) {
    const hay = `${(e.title ?? e.name) ?? ''} ${summaryText(e)}`.toLowerCase();
    domainHits = 0;
    for (const t of domainTerms) if (hay.includes(t)) domainHits++;
    f_domain = domainHits >= 2 ? 1.05 : domainHits >= 1 ? 1.00 : 0.94;
  }
  breakdown.domain_hits = domainHits;
  breakdown.f_domain = f_domain;

  // 因子 5：新鲜度 —— 科研数据有半衰期，过旧的条目权重递减
  let yearsOld = null, f_fresh = 1.0;
  const dt = e.publishedDate ?? e.issued ?? e.date ?? null;
  if (dt) {
    const yr = new Date(dt).getUTCFullYear();
    if (!Number.isNaN(yr)) {
      yearsOld = (new Date().getUTCFullYear() - yr);
      f_fresh = yearsOld <= 2 ? 1.03 : yearsOld <= 7 ? 1.00 : yearsOld <= 15 ? 0.98 : 0.95;
    }
  }
  breakdown.years_old = yearsOld;
  breakdown.f_fresh = f_fresh;

  // 因子 6：被引强度 / 多源确认
  const cited = Number(e.citations ?? e.citation_count ?? e.referencedByCount ?? 0) || 0;
  const crossConfirmed = Number(e.sources_count ?? 0) || 0;
  breakdown.citation_count = cited;
  const f_cited = cited >= 50 ? 1.05 : cited >= 10 ? 1.02 : cited >= 1 ? 1.00 : (crossConfirmed >= 2 ? 1.02 : 0.97);
  breakdown.f_cited = f_cited;

  let score = base * f_summary * f_doi * f_tags * f_domain * f_fresh * f_cited;
  score = Math.max(0.50, Math.min(0.98, score));
  const confidence = Math.round(score * 1000) / 1000;

  breakdown.confidence = confidence;
  return {
    confidence,
    quality_tier: tierOf(confidence),
    confidence_breakdown: breakdown,
  };
}

export function tierOf(c) {
  if (c >= 0.85) return 'A';
  if (c >= 0.78) return 'B';
  if (c >= 0.72) return 'C';
  if (c >= 0.65) return 'D';
  return 'E';
}

// ==================== 指标计算 ====================
// 标题归一化：小写、压缩空白、去首尾。刻意不剔除标点——「Subscribers' Page」与
// 「Subscribers Page」在源数据里确实不同，强行归一反而制造假碰撞。
export function normTitle(e) {
  return String(e.title ?? e.name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// 真重复判定键。有 DOI 时 DOI 是文献的唯一标识（跨源通用）；无 DOI 时退回
// 「标题+作者」组合——同一文献即便缺 DOI，标题与作者仍必然一致。
// 注意：这**不是**用来合并同名不同文献的键，那是检索侧的问题。
export function dedupeKey(e) {
  const doi = typeof e.doi === 'string' ? e.doi.trim().toLowerCase() : '';
  if (doi) return 'doi:' + doi;
  const authors = (e.authors ?? [])
    .map(a => String(a).trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean)
    .sort()
    .join('|');
  return 't:' + normTitle(e) + '#' + authors;
}

// 前置页噪声判定。判据是**三重与**：标题命中泛化词表 AND 无摘要 AND 无标签。
// 后两个条件是安全护栏，缺一即保留：「vantage6」×140、「mh370: mathematical proof...」×95
// 这类标题虽短但全部带摘要，是真实出版物，绝不能删；反之「Editorial Board」×394
// 全部零摘要零标签，是 Crossref 返回的期刊前置元数据，对检索与统计只有噪声。
export const BOILERPLATE_TITLES = new Set([
  'editorial board', 'editorial board page', 'editorial board pages', 'editorial', 'c2/ ed. board',
  'preface', 'prologue', 'epilogue', 'index', 'author index', 'subject index', 'subject indexes',
  'index of contents', 'index of tables', 'index of figures', 'index of contributors',
  'list of figures', 'list of tables', 'list of abbreviations', 'list of symbols', 'list of acronyms',
  'glossary', 'front matter', 'frontmatter', 'front matter page', 'contents', 'table of contents',
  'table of contents page', 'contents list', 'issue contents', 'issue contents list',
  'issue information', 'issue information page', 'issue information pages', 'in this issue',
  'forthcoming papers', 'new books', 'new books received', 'newly received publications',
  'books received', 'books in review', 'newly published publications', 'catalogue', 'catalog',
  'book catalogue', 'copyright', 'license', 'terms of use', 'terms and conditions', 'privacy policy',
  'colophon', 'dedication', 'title page', 'title pages', 'cover', 'cover page',
  'subscribers page', "subscribers' page", 'preliminary pages', 'preliminaries', 'plates',
  'appendix', 'appendices', 'bibliography', 'references', 'reference', 'acknowledgement',
  'acknowledgments', 'acknowledgements', 'acknowledgments page', 'list of contributors',
  'contributors', 'author biographies', 'author information', 'author contributions', 'general',
  'erratum', 'errata', 'erratum page', 'errata page', 'corrigendum', 'corrigenda',
  'retraction notice', 'notices', 'announcements', 'society announcements', 'news',
  'book review', 'book reviews', 'books received', 'new books', 'reviews', 'review', 'reviews of books',
  'abstracts', 'abstracts of m.sc. theses', 'abstracts of d.sc. theses', 'abstracts of theses',
  'abstracts of doctorate theses', 'abstracts of master theses', 'abstract of thesis',
  'data availability', 'conflict of interest', 'conflicts of interest', 'declaration',
  'declarations', 'ethical approval', 'financial disclosure', 'funding',
  'supplement', 'supplementary', 'supplementaries', 'supplemental', 'web supplement', 'online supplement',
]);

// 仅用于判定，不用于删除——返回 true 表示该条目是前置页噪声（贡献 boilerplate_rate）
export function isBoilerplate(e) {
  const t = normTitle(e);
  if (!t || !BOILERPLATE_TITLES.has(t)) return false;
  if (summaryText(e).trim()) return false;   // 护栏1：有摘要 → 真实内容
  if (tagList(e).length > 0) return false;    // 护栏2：有标签 → 已被判定为图谱节点
  return true;
}

export function computeSiteMetrics(entities, site = null, domainTerms = null) {
  const n = entities.length;
  if (!n) return { n: 0 };

  let sumOk = 0, tagOk = 0, doiOk = 0, urlOk = 0, offDom = 0, offDomJ = 0, boilerplate = 0;
  const titles = new Map();          // 归一化标题 -> 计数（仅诊断用）
  const dedupeKeys = new Map();      // 真重复判定键 -> 计数
  const confBySource = new Map();   // source -> Set(confidence)
  const confValues = new Set();

  for (const e of entities) {
    if (summaryText(e).length > 30) sumOk++; else {
      // off_domain 只在摘要可用时判定（无摘要无法判断相关性）
    }
    if (tagList(e).length > 0) tagOk++;
    if (typeof e.doi === 'string' && e.doi.trim()) doiOk++;
    if ((typeof e.url === 'string' && e.url.trim()) || (typeof e.sourceUrl === 'string' && e.sourceUrl.trim())) urlOk++;

    const t = normTitle(e);
    if (t) titles.set(t, (titles.get(t) || 0) + 1);
    // 真重复键：有 DOI 用 DOI；无 DOI 用「标题+作者」——同一文献跨源重复时 DOI 相同，
    // 而无 DOI 的同一文献也必然标题与作者相同，这两条覆盖全部真重复情形。
    dedupeKeys.set(dedupeKey(e), (dedupeKeys.get(dedupeKey(e)) || 0) + 1);

    if (isBoilerplate(e)) boilerplate++;

    const c = e.confidence;
    if (typeof c === 'number') {
      confValues.add(c);
      const s = e.source ?? 'unknown';
      if (!confBySource.has(s)) confBySource.set(s, new Set());
      confBySource.get(s).add(c);
    }

    if (domainTerms && domainTerms.size) {
      const hay = `${(e.title ?? e.name) ?? ''} ${summaryText(e)}`.toLowerCase();
      let hits = 0;
      for (const d of domainTerms) if (hay.includes(d)) hits++;
      if (hits === 0) { offDom++; offDomJ++; }
    }
  }

  // 三个互不替代的指标，各自回答不同的问题：
  //  1. duplicate_rate      —— 「对外计数是否虚高」。真重复 = 同一文献入了多次。
  //                            2026-10-08 实测：全 30 站加权 0.00%（仅 carbon-neutral 2 条）。
  //                            这是唯一应该被门禁拦截的项。
  //  2. title_collision_rate —— 同名但 DOI 不同的记录占比。这是诊断指标，**不拦**。
  //                            旧口径把两者混为一谈：brain-science 的「Editorial Board」×394
  //                            是 394 篇 DOI 各不相同的期刊社论页，计数并没有虚高，
  //                            但旧口径报出 16.6% 重名率并把该站压到 10000 容量。
  //                            同类错误另有 v2 报告用 e.title 而非 e.name 导致重名率报 0.0%。
  //  3. boilerplate_rate     —— 前置页噪声（社论页/卷头/目录），无摘要无标签，对检索与统计有害。
  //                            这是内容质量问题，不是重复问题，单独治理。
  const countExcess = (m) => [...m.values()].reduce((a, v) => a + Math.max(0, v - 1), 0);
  const dups = countExcess(dedupeKeys);
  const titleCollisions = countExcess(titles);

  // confidence 是否为 source 的确定性函数：所有来源的 confidence 都是单值 → 伪信号
  const deterministicSources = [...confBySource.values()].filter(s => s.size <= 1).length;
  const confidence_source_deterministic = confBySource.size > 0 && deterministicSources === confBySource.size ? 1 : 0;

  return {
    n,
    summary_rate: round(sumOk / n),
    tag_rate: round(tagOk / n),
    doi_rate: round(doiOk / n),
    url_rate: round(urlOk / n),
    duplicate_rate: round(dups / n),
    title_collision_rate: round(titleCollisions / n),
    boilerplate_rate: round(boilerplate / n),
    off_domain_rate: domainTerms && domainTerms.size ? round(offDomJ / n) : 0,
    confidence_source_deterministic,
    confidence_distinct_values: confValues.size,
    duplicates: dups,
    thresholds: { ...THRESH },
    action: 'quality_check',
  };
}

function round(x) { return Math.round(x * 10000) / 10000; }

export function sitePath(site) { return path.join(ROOT, site, 'website', 'api'); }
export function listSites() {
  return fs.readdirSync(ROOT).filter(d => {
    try { return fs.statSync(path.join(ROOT, d, 'website', 'api', 'entities.json')).isFile(); } catch { return false; }
  }).sort();
}

// ==================== confidence 重建 ====================
function rebuildConfidence(sites, dryRun) {
  const q = loadDomainQueries();
  let written = 0, changed = 0, total = 0;
  const stats = {};

  for (const site of sites) {
    const dir = sitePath(site);
    const fp = path.join(dir, 'entities.json');
    const doc = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const ents = Array.isArray(doc) ? doc : (doc.entities ?? []);
    const terms = expandQueryTerms(site, q);

    const tierCount = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    const distinct = new Set();
    const bySource = new Map();
    let siteChanged = 0, noSummary = 0, noTag = 0;

    for (const e of ents) {
      const { confidence, quality_tier, confidence_breakdown } = computeConfidence(e, site, terms);
      // 派生数据不落盘：完整 breakdown 每个实体约 250 字符 × 300,000 ≈ 75MB 冗余，
      // 且快照会随摘要/标签修补而过期。breakdown 由 computeConfidence 随时可重算
      // （`--explain` 按需输出），保证「任何一条实体都能当场重算出分值」比写死快照更可信。
      if (e.confidence !== confidence) {
        e.confidence = confidence;
        siteChanged++;
        distinct.add(confidence);
        const s = e.source ?? 'unknown';
        if (!bySource.has(s)) bySource.set(s, 0);
        bySource.set(s, bySource.get(s) + 1);
      }
      e.quality_tier = quality_tier;
      tierCount[quality_tier] = tierCount[quality_tier] || 0;
      tierCount[quality_tier]++;
      if (confidence_breakdown.f_summary === 0.92) noSummary++;
      if (confidence_breakdown.f_tags === 0.95) noTag++;
      total++;
    }

    // 写回（保持 entities 的键名：数组 or {entities:[...]}）
    if (!dryRun) {
      if (Array.isArray(doc)) fs.writeFileSync(fp, JSON.stringify(doc, null, 2));
      else { doc.entities = ents; fs.writeFileSync(fp, JSON.stringify(doc, null, 2)); }
      written++;
    }
    changed += siteChanged;

    // 重建后的伪信号复检
    const srcVals = new Map();
    for (const e of ents) {
      const s = e.source ?? 'unknown';
      if (!srcVals.has(s)) srcVals.set(s, new Set());
      srcVals.get(s).add(e.confidence);
    }
    const stillDeterministic = [...srcVals.values()].every(s => s.size <= 1);

    stats[site] = {
      n: ents.length,
      tier_distribution: tierCount,
      distinct_confidence_values: new Set(ents.map(e => e.confidence)).size,
      still_source_deterministic: stillDeterministic ? 1 : 0,
      changed_this_run: siteChanged,
      no_summary_count: noSummary,
      no_tag_count: noTag,
    };
  }

  return { written, changed, total, stats };
}

// ==================== 双向回归自测 ====================
// 门禁的「自证有效」：注入故障必须被拦，达标必须放行。只跑一遍打绿灯的门禁不算门禁。
function selfTest() {
  const policy = loadPolicy('quality');
  let pass = 0;
  const results = [];

  function case_(name, ctx, expect) {
    const d = evalGuard(policy, ctx);
    const ok = d.decision === expect;
    results.push({ name, ctx, expect, got: d.decision, rule: d.rule_id, ok });
    if (ok) pass++;
  }

  const good = { action: 'quality_check', summary_rate: 0.85, tag_rate: 0.80, doi_rate: 0.98, url_rate: 1.0, duplicate_rate: 0.0, boilerplate_rate: 0.02, title_collision_rate: 0.107, off_domain_rate: 0.03, confidence_source_deterministic: 0, confidence_distinct_values: 180 };

  case_('✅ 全指标达标 → 放行', { ...good }, 'allow');
  case_('❌ 注入摘要率 0.42（neuromorphic 实测量级）→ 必须拦截', { ...good, summary_rate: 0.42 }, 'deny');
  case_('❌ 注入标签率 0.26（neuromorphic 实测量级）→ 必须拦截', { ...good, tag_rate: 0.26 }, 'deny');
  case_('❌ 注入 DOI 率 0.755（alien-minerals 实测量级）→ 必须拦截', { ...good, doi_rate: 0.755 }, 'deny');
  // —— 重复口径的双向回归：这是 v2 修正过的地方，必须锁死 ——
  case_('✅ 真重复率 0.00（30 站实测加权值）→ 放行', { ...good, duplicate_rate: 0.0 }, 'allow');
  case_('⚠️ 真重复率 0.01 恰好卡在阈值上 → 边界放行', { ...good, duplicate_rate: 0.01 }, 'allow');
  case_('❌ 真重复率 0.02 → 必须拦截（非零即入库缺陷，0.01 边界外的第一条）', { ...good, duplicate_rate: 0.02 }, 'deny');
  // 关键反例：同名碰撞率 0.107 是 30 站实测加权值，但它必须【不拦】。
  // 旧口径把它当重名率拦了 brain-science / edge-ai / exo-science 三个站。
  case_('⚠️ 同名碰撞 0.107（实测加权）不拦——它是诊断指标，不参与判定', { ...good, title_collision_rate: 0.107 }, 'allow');
  case_('⚠️ 同名碰撞 0.60 极端值也不拦——同名不同 DOI 是不同文献，计数不虚高', { ...good, title_collision_rate: 0.60 }, 'allow');
  case_('❌ 前置页噪声 0.0827（brain-science 实测最高）→ 必须拦截', { ...good, boilerplate_rate: 0.0827 }, 'deny');
  case_('⚠️ 前置页噪声 0.0189（实测加权）→ 放行', { ...good, boilerplate_rate: 0.0189 }, 'allow');
  case_('❌ 注入 confidence=f(source) 确定性映射 → 必须拦截', { ...good, confidence_source_deterministic: 1 }, 'deny');
  case_('❌ 注入 confidence 仅 7 档 → 必须拦截', { ...good, confidence_distinct_values: 7 }, 'deny');
  case_('❌ URL 率 0.97 → 必须拦截', { ...good, url_rate: 0.97 }, 'deny');
  case_('⚠️ 领域错配 0.15 → 放行（已降级为观察指标，避免假阳性训练团队忽略红灯）', { ...good, off_domain_rate: 0.15 }, 'allow');
  case_('❌ 领域错配 0.90 → 必须拦截（词表与站点根本不匹配 = 配置错误）', { ...good, off_domain_rate: 0.90 }, 'deny');
  case_('❌ 缺少 action 字段 → 必须落 default:deny', { summary_rate: 0.85 }, 'deny');
  case_('❌ 多指标同时违规（真实最差站组合）→ 必须拦截', { ...good, summary_rate: 0.42, tag_rate: 0.26, doi_rate: 0.91 }, 'deny');
  case_('⚠️ 摘要刚好卡在 0.60 阈值上 → 边界放行', { ...good, summary_rate: 0.60 }, 'allow');
  case_('❌ 摘要 0.5999 低于阈值 → 必须拦截', { ...good, summary_rate: 0.5999 }, 'deny');

  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name} → ${r.got} (${r.rule || 'default'})`);
  }
  console.log(`\n${pass}/${results.length} passed`);
  return pass === results.length;
}

// ==================== 可解释性：按需重算单条实体的分值来源 ====================
// confidence_breakdown 不落盘（避免 300,000 × ~250B ≈ 75MB 冗余，且快照会随摘要修补过期），
// 用本模式随时证明「这个分值是怎么来的」。
function explain(sites) {
  const q = loadDomainQueries();
  const n = Number(argv.find(a => a.startsWith('--n='))?.split('=')[1] || 3);
  for (const site of sites) {
    const fp = path.join(sitePath(site), 'entities.json');
    const doc = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const ents = Array.isArray(doc) ? doc : (doc.entities ?? []);
    const terms = expandQueryTerms(site, q);
    console.log(`\n=== ${site}（${ents.length} 实体，抽样 ${n} 条）===`);
    const idx = [0, Math.floor(ents.length / 3), Math.floor(ents.length * 2 / 3)];
    for (const i of idx.slice(0, n)) {
      const e = ents[i];
      const r = computeConfidence(e, site, terms);
      const b = r.confidence_breakdown;
      console.log(`\n  ${String((e.title ?? e.name) ?? '').slice(0, 78)}`);
      console.log(`  source=${e.source}  →  base=${b.source_base}  tier=${r.quality_tier}  confidence=${r.confidence}`);
      console.log(`  f_summary=${b.f_summary}(len=${b.summary_len}) × f_doi=${b.f_doi}(doi=${b.has_doi}) × f_tags=${b.f_tags}(n=${b.tag_count}) × f_domain=${b.f_domain}(hits=${b.domain_hits ?? 'n/a'}) × f_fresh=${b.f_fresh}(age=${b.years_old ?? 'n/a'}) × f_cited=${b.f_cited}(n=${b.citation_count})`);
    }
  }
}

// ==================== 主流程 ====================
// 主流程封装为函数：本文件同时是「库」（导出 computeConfidence / loadDomainQueries /
// listSites / sitePath / expandQueryTerms）和「脚本」。若主流程留在顶层，其中的
// process.exit() 会在模块加载阶段触发，导致任何 import 本文件的调用方被静默终止——
// 症状是「import 之后自己的代码一行都没执行、无报错、退出码 0」，极难排查（2026-10-08 实测踩到）。
// 与 tools/guard-eval.mjs 的冒烟测试防护同一手法：比较 argv[1] 是否指向本文件。
export function runMain(argvOverride) {
const argv = argvOverride ?? process.argv.slice(2);
const ciMode = argv.includes('--ci');
const selfTestMode = argv.includes('--self-test');
const rebuild = argv.includes('--rebuild-confidence');
const dryRun = argv.includes('--dry-run');
const siteArg = argv.find(a => a.startsWith('--site='));
const sites = siteArg ? siteArg.split('=').slice(1).join('=').split(',').map(s => s.trim()).filter(Boolean) : listSites();

if (selfTestMode) {
  const ok = selfTest();
  process.exit(ok ? 0 : 2);
}

if (argv.includes('--explain')) {
  explain(sites);
  process.exit(0);
}

if (rebuild) {
  console.log(`=== confidence 重建（${dryRun ? 'DRY-RUN' : '写盘'}）：${sites.length} 站 ===`);
  const t0 = Date.now();
  const r = rebuildConfidence(sites, dryRun);
  const ms = Date.now() - t0;
  let bad = 0;
  console.log('\n  站点'.padEnd(22) + '实体'.padEnd(9) + '档位分布'.padEnd(34) + '去档数'.padEnd(9) + '伪信号'.padEnd(8));
  for (const [s, v] of Object.entries(r.stats)) {
    const td = v.tier_distribution;
    const dist = ['A', 'B', 'C', 'D', 'E'].map(k => `${k}:${(td[k] || 0)}`).join(' ');
    console.log(`  ${s}`.padEnd(22) + String(v.n).padEnd(9) + dist.padEnd(34) + String(v.distinct_confidence_values).padEnd(9) + (v.still_source_deterministic ? '❌是' : '✅否').padEnd(8));
    if (v.still_source_deterministic) bad++;
  }
  console.log(`\n合计 ${r.total} 实体，${r.changed} 条 confidence 被修正，${dryRun ? '未写盘' : `已写回 ${r.written} 站`}，耗时 ${(ms / 1000).toFixed(1)}s`);
  console.log(bad ? `❌ ${bad} 站重建后仍为伪信号` : `✅ 全部站点 confidence 已脱离 source 确定性映射`);
  process.exit(bad ? 1 : 0);
}

// ==================== 前置页噪声清理 ====================
// 与 --rebuild-confidence 不同：这里是**删除**而非改写，是不可逆操作，
// 因此默认只做 DRY-RUN，必须显式加 --write 才落盘。
// 删除判据是 isBoilerplate 的三重与（标题命中泛化词表 AND 无摘要 AND 无标签），
// 三重条件缺一即保留，所以不会删掉「vantage6」×140 这类带摘要的真实出版物。
if (argv.includes('--purge-boilerplate')) {
  const doWrite = argv.includes('--write');
  const q = loadDomainQueries();
  console.log(`=== 前置页噪声清理（${doWrite ? '写入' : 'DRY-RUN，加 --write 落盘'}）：${sites.length} 站 ===\n`);
  console.log('  站点'.padEnd(22) + '清理前'.padEnd(9) + '删除'.padEnd(7) + '清理后'.padEnd(9) + '噪声率变化'.padEnd(20) + '真重复');
  let totalRemoved = 0, totalBefore = 0, written = 0;
  for (const site of sites) {
    const fp = path.join(sitePath(site), 'entities.json');
    if (!fs.existsSync(fp)) continue;
    const doc = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const ents = Array.isArray(doc) ? doc : (doc.entities ?? []);
    const before = computeSiteMetrics(ents, site, expandQueryTerms(site, q));
    const keep = ents.filter(e => !isBoilerplate(e));
    const after = computeSiteMetrics(keep, site, expandQueryTerms(site, q));
    const removed = ents.length - keep.length;
    totalRemoved += removed; totalBefore += ents.length;
    console.log(`  ${site}`.padEnd(22) + String(ents.length).padEnd(9) + String(removed).padEnd(7) + String(keep.length).padEnd(9)
      + `${(before.boilerplate_rate * 100).toFixed(2)}% → ${(after.boilerplate_rate * 100).toFixed(2)}%`.padEnd(20)
      + `${(before.duplicate_rate * 100).toFixed(2)}% → ${(after.duplicate_rate * 100).toFixed(2)}%`);
    if (doWrite && removed > 0) {
      if (Array.isArray(doc)) fs.writeFileSync(fp, JSON.stringify(keep, null, 2));
      else { doc.entities = keep; fs.writeFileSync(fp, JSON.stringify(doc, null, 2)); }
      written++;
    }
  }
  console.log(`\n合计 ${totalBefore} 实体，拟删除 ${totalRemoved} 条前置页噪声（${(totalRemoved / totalBefore * 100).toFixed(2)}%），${doWrite ? `已写回 ${written} 站` : '未写盘（加 --write 生效）'}`);
  if (!doWrite) console.log('提示：清理后可直接跑 `node operations-plan/pipeline-quality-gate.js` 复检门禁判定');
  process.exit(0);
}

// 默认：扫描 + 门禁评估
const policy = loadPolicy('quality');
const q = loadDomainQueries();
const rows = [];
let denied = 0;

for (const site of sites) {
  const fp = path.join(sitePath(site), 'entities.json');
  const doc = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  const ents = Array.isArray(doc) ? doc : (doc.entities ?? []);
  const terms = expandQueryTerms(site, q);
  const metrics = computeSiteMetrics(ents, site, terms);
  const d = evalGuard(policy, metrics);
  if (d.decision !== 'allow') denied++;
  rows.push({ site, ...metrics, decision: d.decision, rule_id: d.rule_id, reason: d.reason, policy_version: d.policy_version });
  console.log(`${d.decision === 'allow' ? '✅' : '❌'} ${site}`.padEnd(24) +
    `摘要${Math.round(metrics.summary_rate * 100)}% 标签${Math.round(metrics.tag_rate * 100)}% DOI${Math.round(metrics.doi_rate * 100)}% 重复${(metrics.duplicate_rate * 100).toFixed(2)}% 噪声${(metrics.boilerplate_rate * 100).toFixed(1)}% 错配${(metrics.off_domain_rate * 100).toFixed(1)}% conf档数${metrics.confidence_distinct_values}`.padEnd(82) +
    `${d.decision}(${d.rule_id})`);
}

const passRows = rows.filter(r => r.decision === 'allow');
const agg = (k) => round(rows.reduce((a, r) => a + r[k] * r.n, 0) / rows.reduce((a, r) => a + r.n, 0));
const aggregate = {
  generatedAt: new Date().toISOString(),
  policy_id: policy.id,
  policy_version: policy.version,
  sites_scanned: rows.length,
  sites_allowed: passRows.length,
  sites_denied: denied,
  aggregate_rates: {
    summary_rate: agg('summary_rate'),
    tag_rate: agg('tag_rate'),
    doi_rate: agg('doi_rate'),
    url_rate: agg('url_rate'),
    duplicate_rate: agg('duplicate_rate'),
    title_collision_rate: agg('title_collision_rate'),
    boilerplate_rate: agg('boilerplate_rate'),
    off_domain_rate: agg('off_domain_rate'),
  },
  thresholds: THRESH,
  sites: rows,
};

fs.mkdirSync(REPORTS, { recursive: true });
const date = new Date().toISOString().slice(0, 10);
const out = path.join(REPORTS, `quality-metrics-${date}.json`);
fs.writeFileSync(out, JSON.stringify(aggregate, null, 2));

console.log(`\n=== 汇总 ===`);
console.log(`放行 ${passRows.length}/${rows.length} 站，拒绝 ${denied} 站`);
console.log(`加权摘要率 ${(aggregate.aggregate_rates.summary_rate * 100).toFixed(1)}%  加权标签率 ${(aggregate.aggregate_rates.tag_rate * 100).toFixed(1)}%  加权DOI率 ${(aggregate.aggregate_rates.doi_rate * 100).toFixed(1)}%`);
console.log(`加权真重复 ${(aggregate.aggregate_rates.duplicate_rate * 100).toFixed(2)}%  同名碰撞 ${(aggregate.aggregate_rates.title_collision_rate * 100).toFixed(1)}%（仅诊断）  前置页噪声 ${(aggregate.aggregate_rates.boilerplate_rate * 100).toFixed(2)}%`);
console.log(`报告 → ${path.relative(ROOT, out)}`);
console.log(ciMode ? `CI 模式：${denied === 0 ? '全绿通过' : `${denied} 站被门禁拒绝，阻断流水线`}` : '非 CI 模式：退出码 0（加 --ci 让不达标阻断流水线）');

process.exit(ciMode && denied > 0 ? 1 : 0);
}

// 仅「直接执行本文件」时跑主流程；被 import 时静默，只暴露导出的函数
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMain();
}
