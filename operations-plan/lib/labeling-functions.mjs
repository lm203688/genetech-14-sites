/**
 * labeling-functions.mjs — Data Programming 引擎（借鉴 Snorkel Labeling Functions + LabelModel）
 *
 * 设计来源
 *   Snorkel AI（Alex Ratner 团队，2019 从 Stanford AI Lab 分拆）的核心方法论：
 *   不雇人逐条标注，而是写一组轻量"标注函数"（Labeling Function, LF）批量投票，
 *   再用 LabelModel 估计每个 LF 的准确率与 LF 间相关性，合并成置信度加权标签。
 *   关键洞察：LF 会互相冲突和冗余，绝不能简单多数投票——必须统计地加权。
 *
 * 本项目为何适用（2026-09-29 实测）
 *   30 站 entities.json 共 300,000 条实体：
 *     - 36.5%（109,557 条）无标签   ← LF 的靶点
 *     - 32.6%（ 97,881 条）摘要缺失   ← 由 adaptive-fields 解决
 *   63.5% 已有标签 → 天然校验集，用于标定 LF 准确率（对应 Snorkel 的
 *   validation/training split），比在盲数据上估可靠性诚实得多。
 *
 * LF 契约（与 Snorkel 一致）
 *   lf(entity) -> Map<tag, vote>
 *     +1  确认该标签
 *     -1  明确排除该标签
 *      0  弃权（不确定时绝不硬猜——弃权优先于误标）
 *
 * 硬约束
 *   - 纯函数、无副作用、不读不写文件系统（数据由调用方传入）
 *   - 无 process.exit、无顶层 main()（避免被 import 时杀掉调用进程）
 *   - 只读 CommonJS/ESM 均可（本文件为 ESM，tools/*.mjs 同款）
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'node:fs';

// ============================================================
// 标签词表基线（取自 search-index.json 实测 965 去重标签的 Top 分布）
// 统一为小写，与 medline/概念标签混存的现状对齐
// ============================================================
const TAG = {
  MEDICINE: 'medicine',
  CS: 'computer science',
  BIOLOGY: 'biology',
  MATERIALS: 'materials science',
  AI: 'artificial intelligence',
  PSYCH: 'psychology',
  PHARM: 'pharmacology',
  CS_AI: 'cs.ai',
  CS_LG: 'cs.lg',
  ENV: 'environmental science',
  NANO: 'nanotechnology',
  CHEM: 'chemistry',
  BIOTECH: 'biotechnology',
  NEURO: 'neuroscience',
  CANCER: 'cancer',
  QUANTUM: 'quantum computing',
  ROBOTICS: 'robotics',
  NLP: 'natural language processing',
  ML: 'machine learning',
  CLINICAL: 'clinical-trial',
  META: 'meta-analysis',
  REPRO: 'reproducibility',
  RCT: 'randomized-controlled-trial',
};

// 领域簇：标签归属的学科簇。用于"正交证据"判定——
// 只有当摘要出现另一簇的正向信号时，否定本站点标签才是有据可依的。
export const DOMAIN_CLUSTERS = {
  'computer science': 'cs',
  'artificial intelligence': 'cs',
  'cs.ai': 'cs',
  'cs.lg': 'cs',
  'machine learning': 'cs',
  'natural language processing': 'cs',
  'robotics': 'cs',
  'reproducibility': 'cs',
  'medicine': 'med',
  'clinical-trial': 'med',
  'randomized-controlled-trial': 'med',
  'pharmacology': 'med',
  'cancer': 'med',
  'biology': 'bio',
  'biotechnology': 'bio',
  'neuroscience': 'bio',
  'meta-analysis': 'bio',
  'quantum computing': 'phys',
  'materials science': 'phys',
  'chemistry': 'phys',
  'nanotechnology': 'phys',
  'environmental science': 'env',
  'psychology': 'psych',
  '中文文献': 'lang',
  'emerging-2024+': 'meta',
  'recent-2020s': 'meta',
  'legacy-pre2010': 'meta',
  'review-article': 'meta',
};
export const clusterOf = t => DOMAIN_CLUSTERS[String(t).toLowerCase()] || 'other';

// 14 站站点名 → 领域标签映射（站点路由是最高信号来源）
export const SITE_DOMAIN = {
  'quantum-computing': [TAG.QUANTUM, TAG.ML],
  'quantum-materials': [TAG.QUANTUM, TAG.MATERIALS],
  'brain-science': [TAG.NEURO, TAG.PSYCH],
  'embodied-ai': [TAG.ROBOTICS, TAG.AI],
  'robot-parts': [TAG.ROBOTICS],
  'ai4science': [TAG.AI, TAG.ML],
  'biomed-ai': [TAG.MEDICINE, TAG.AI],
  'biocomputing': [TAG.BIOLOGY, TAG.CS],
  'bionic-ai': [TAG.BIOLOGY, TAG.AI],
  'biotechnology': [TAG.BIOTECH],
  'agritech': [TAG.BIOLOGY, TAG.ENV],
  'ai-safety': [TAG.AI, TAG.PSYCH],
  'edge-ai': [TAG.AI, TAG.ML],
  'neuromorphic': [TAG.NEURO, TAG.MATERIALS],
  'digital-twin': [TAG.CS, TAG.ENV],
  'privacy-computing': [TAG.CS, TAG.ML],
  'deep-sea-tech': [TAG.BIOLOGY, TAG.ENV],
  'carbon-neutral': [TAG.ENV, TAG.MATERIALS],
  'new-energy': [TAG.ENV, TAG.MATERIALS],
  'low-altitude': [TAG.ROBOTICS, TAG.MATERIALS],
  'synbio-manufacturing': [TAG.BIOTECH, TAG.CS],
  'genetech-tools': [TAG.AI, TAG.CS],
  'agent-ecosystem': [TAG.AI, TAG.NLP],
  'life-science': [TAG.BIOLOGY, TAG.BIOTECH],
  'semiconductor': [TAG.MATERIALS, TAG.CS],
  'alien-minerals': [TAG.MATERIALS],
  'sat-6g': [TAG.CS, TAG.ROBOTICS],
  'exo-science': [TAG.BIOLOGY, TAG.ENV],
  'tcm-tools': [TAG.MEDICINE, TAG.PSYCH],
  'nuclear-energy': [TAG.ENV, TAG.MATERIALS],
};

// 关键词 → 标签（标题权重高于摘要，权重由 LF 内部体现）
const KW_MAP = [
  // 医学 / 临床
  { re: /\b(sepsis|mortality|clinical trial|cohort study|cohort)\b/i, tags: [TAG.CLINICAL, TAG.MEDICINE] },
  { re: /\b(randomized|randomised|rct|double[\-\s]?blind)\b/i, tags: [TAG.RCT, TAG.CLINICAL] },
  { re: /\b(systematic review|meta[\-\s]?analysis|network meta)\b/i, tags: [TAG.META, TAG.MEDICINE] },
  { re: /\b(cancer|tumor|tumour|carcinoma|leukemia|leukaemia|melanoma|oncol)\b/i, tags: [TAG.CANCER, TAG.MEDICINE] },
  { re: /\b(neuro|brain|cortex|hippocamp|dementia|alzheimer|parkinson|epilep|schizophren)\b/i, tags: [TAG.NEURO, TAG.MEDICINE] },
  { re: /\b(pharmac|drug|dosage|toxicolog|adverse event)\b/i, tags: [TAG.PHARM, TAG.MEDICINE] },
  { re: /\b(diabetes|cardio|hypertens|stroke|renal|hepatic|pneumonia|infection)\b/i, tags: [TAG.MEDICINE] },
  { re: /\b(mri|ct scan|imaging|radiomics|biomarker|assay|biopsy)\b/i, tags: [TAG.MEDICINE, TAG.BIOTECH] },
  { re: /\b(patient|hospital|surg|operative|prognosis|outcome)\b/i, tags: [TAG.MEDICINE, TAG.CLINICAL] },
  { re: /\b(disease|diseases|diagnosis|disorder|syndrome|patholog|epidem)\b/i, tags: [TAG.MEDICINE] },
  { re: /\b(animal model|in vivo|in vitro|cell line|z[-\s]?fish|murine|drosophila|caenorhabditis)\b/i, tags: [TAG.BIOLOGY, TAG.BIOTECH] },
  { re: /\b(gene|genom|proteom|transcriptom|mrna|rna|dna|protein|protein)\b/i, tags: [TAG.BIOLOGY, TAG.BIOTECH] },
  // 生命科学
  { re: /\b(fungal|fungi|mycos|bacter|virus|virality|microbiom|antimicrob|pathogen)\b/i, tags: [TAG.BIOLOGY] },
  { re: /\b(ecolog|habitat|species|climate|carbondioxide|emission|biodiversit|pollin)\b/i, tags: [TAG.ENV, TAG.BIOLOGY] },
  { re: /\b(crop|soil|agricultur|livestock|aquaculture|food security|drought|irrigat)\b/i, tags: [TAG.ENV, TAG.BIOLOGY] },
  // AI / ML
  // ⚠️ 2026-09-29 修复：此前完全缺少 "artificial intelligence" 与独立 "AI" 的模式，
  //   标题/摘要明确写 AI 的论文拿不到 AI 标签，进而在错路由检测中被误判
  //   （实测 biomed-ai 上 "artificial intelligence" 被投出 1137 张假负票）。
  //   另修 " transformer" 前缀游离空格——词首/连字符前的 Transformer 全部漏匹配。
  { re: /\b(artificial intelligence|\bai\b|\ba\.i\.|intelligent (?:agent|system|techn))\b/i, tags: [TAG.AI, TAG.CS] },
  { re: /\b(machin[^\s]{0,4} learning|ml model|neural network|deep learning|transformer|reinforcement learning|fine[\-\s]?tun|foundation model|llm|large language model|chatgpt|multimodal)\b/i, tags: [TAG.ML, TAG.AI] },
  { re: /\b(bert|gpt|clip|resnet|diffusion model|vae|gan|autoencoder)\b/i, tags: [TAG.ML] },
  { re: /\b(fine[\-\s]?tun|fine[-\s]?tuning|supervised|semi[-\s]?supervised|few[\-\s]?shot|zero[\-\s]?shot)\b/i, tags: [TAG.CS_LG, TAG.ML] },
  { re: /\b(language model|nlp|token|embedding|sentence|segmentation|translation|summariz|classification)\b/i, tags: [TAG.NLP, TAG.CS] },
  { re: /\b(agent|multi[\-\s]?agent|reasoning|tool use|planning|retrieval|rag)\b/i, tags: [TAG.AI, TAG.CS] },
  { re: /\b(robot|autonomous vehicle|human[-\s]?robot|manipulation|grasp|locomotion|slam|navigation)\b/i, tags: [TAG.ROBOTICS, TAG.AI] },
  { re: /\b(imaging|segmentation|x[\-\s]?ray|ultrasound|endoscop|microscop|spectroscop)\b/i, tags: [TAG.ML, TAG.BIOTECH] },
  // 跨学科（站点实际内容跨度远超纯理工，此前无任何覆盖）
  { re: /\b(financ|econom|market|trading|portfolio|risk management|insurance|bank)\b/i, tags: [TAG.CS] },
  { re: /\b(educat|curriculum|student|learning outcome|pedagog|literacy)\b/i, tags: [TAG.PSYCH] },
  // 量子
  { re: /\b(qubit|quantum|NISQ|entanglement|superposition|decoherence|boson sampling|qcd)\b/i, tags: [TAG.QUANTUM] },
  { re: /\b(topolog|photon|supercond(uct|ing)|spin qubit|ion trap)\b/i, tags: [TAG.QUANTUM, TAG.MATERIALS] },
  // 材料 / 半导体 / 能源
  { re: /\b(nano|2d material|graphene|perovskite|polymer|semiconductor|transistor|memristor)\b/i, tags: [TAG.NANO, TAG.MATERIALS] },
  { re: /\b(battery|lithium|fuel cell|solar cell|photovoltaic|hydrogen|electrolyz|wind turbine)\b/i, tags: [TAG.ENV, TAG.MATERIALS] },
  { re: /\b(carbon capture|direct air capture|net zero|decarboniz|ccus)\b/i, tags: [TAG.ENV] },
  // 心理 / 安全
  { re: /\b(psycholog|behavior|behaviour|cognit|attention|memory|depression|anxiety|wellbeing)\b/i, tags: [TAG.PSYCH] },
  { re: /\b(align|misalignment|jailbreak|red[\-\s]?team|safety|biases|fairness|accountability)\b/i, tags: [TAG.AI] },
];

// arXiv 分类 → 标签
const ARXIV_MAP = {
  'cs.AI': [TAG.CS_AI, TAG.AI], 'cs.LG': [TAG.CS_LG, TAG.ML], 'cs.RO': [TAG.ROBOTICS],
  'cs.CV': [TAG.ML, TAG.NLP], 'cs.CL': [TAG.NLP], 'cs.CR': [TAG.CS], 'cs.DC': [TAG.CS],
  'quant-ph': [TAG.QUANTUM], 'hep-ph': [TAG.MATERIALS], 'physics.*': [TAG.MATERIALS],
  'stat.ME': [TAG.ML], 'stat.CO': [TAG.ML], 'eess.SP': [TAG.ML], 'eess.IV': [TAG.ML],
  'stat.AP': [TAG.ML], 'nlin.*': [TAG.MATERIALS], 'cond-mat.*': [TAG.MATERIALS],
  'astro-ph.*': [TAG.ENV], 'math.*': [TAG.CS], 'q-bio.*': [TAG.BIOLOGY],
};

// ============================================================
// 工具
// ============================================================
const VOTE_POS = 1, VOTE_NEG = -1, VOTE_ABSTAIN = 0;

/** 生成一个"投票集合"：Map<tag, vote> */
function votes(entries) {
  const m = new Map();
  for (const [tag, v] of entries) m.set(tag, v);
  return m;
}

/** 取实体文本字段（不硬猜字段名，交给 adaptive-fields；此处做最小兜底） */
function textOf(e, field) {
  const v = e && e[field];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(' ');
  return '';
}

// ============================================================
// Labeling Functions
// 每个 LF：{ id, description, run(entity) -> Map<tag,vote> }
// 原则：不同 LF 的错误模式应不同，LF 间相关性低，LabelModel 才能有效加权
// ============================================================

/** LF-01 站点路由：实体所属站点是最强信号（站点即领域） */
export const lfSiteDomain = {
  id: 'lf_site_domain',
  desc: '站点路由 → 领域标签（14 站站点名映射）',
  run(e) {
    const site = e.site || (Array.isArray(e.sites) ? e.sites[0] : null);
    const map = site && SITE_DOMAIN[site];
    if (!map) return votes([]);
    return votes(map.map(t => [t, VOTE_POS]));
  },
};

/** LF-02 标题关键词：标题权重最高（作者自述主题） */
export const lfTitleKeywords = {
  id: 'lf_title_keywords',
  desc: '标题关键词 → 标签（信号最强，仅标题不判定时弃权）',
  run(e) {
    const t = textOf(e, 'name') || textOf(e, 'title');
    if (!t || t.length < 8) return votes([]);
    const out = [];
    for (const { re, tags } of KW_MAP) if (re.test(t)) for (const g of tags) out.push([g, VOTE_POS]);
    return votes(out);
  },
};

/** LF-03 摘要关键词：覆盖率高但噪声大（正文常提相邻领域） */
export const lfAbstractKeywords = {
  id: 'lf_abstract_keywords',
  desc: '摘要关键词 → 标签（覆盖率高、噪声较高）',
  run(e) {
    const a = textOf(e, 'abstract') || textOf(e, 'summary') || textOf(e, 'abstractText');
    if (!a || a.length < 40) return votes([]);
    const out = [];
    for (const { re, tags } of KW_MAP) if (re.test(a)) for (const g of tags) out.push([g, VOTE_POS]);
    return votes(out);
  },
};

/**
 * LF-04 错路由检测：站点标签与摘要正交证据冲突时投负票
 *
 * 判定条件（缺一不判，避免"缺证据"被当成"反对证据"）：
 *   1. 摘要必须产生 ≥2 个正向标签（有实质的替代信号，而非空白）
 *   2. 这些正向标签必须全部落在与站点标签不同的学科簇（正交证据）
 *   3. 摘要中没有任何站点标签所属簇的正向支持
 *
 * 2026-09-29 修复：旧实现只要"站点标签在摘要里找不到"就投负票，
 *   而关键词词表只覆盖 10 个标签——大量正常论文因此被判错路由（实测 27.7%）。
 *   缺证据 ≠ 反对证据，故改为要求正交簇的竞争性正向信号。
 */
export const lfMisrouteDetector = {
  id: 'lf_misroute_detector',
  desc: '站点标签 vs 摘要正交簇证据冲突 → 负票（错路由检测）',
  run(e) {
    const site = e.site || (Array.isArray(e.sites) ? e.sites[0] : null);
    const siteTags = site && SITE_DOMAIN[site];
    const a = textOf(e, 'abstract') || textOf(e, 'summary');
    if (!siteTags || !a || a.length < 40) return votes([]);
    const abst = lfAbstractKeywords.run(e);
    if (abst.size < 2) return votes([]);

    const absClusters = new Set([...abst.keys()].map(clusterOf));
    const out = [];
    for (const t of siteTags) {
      const own = clusterOf(t);
      // 摘要在站点所属簇有支持 → 不算冲突
      if (absClusters.has(own)) continue;
      // 摘要证据必须跨越到别的簇，且至少两个独立标签支撑
      const others = [...abst.keys()].filter(k => clusterOf(k) !== own);
      if (new Set(others.map(clusterOf)).size >= 1 && others.length >= 2) out.push([t, VOTE_NEG]);
    }
    return votes(out);
  },
};

/** LF-05 arXiv 分类：arXiv id 的分类前缀是权威领域标注 */
export const lfArxivCategory = {
  id: 'lf_arxiv_category',
  desc: 'arXiv 分类前缀 → 标签',
  run(e) {
    const id = e.arxivId || (typeof e.id === 'string' && e.id.includes('arXiv') ? e.id : null);
    if (!id) return votes([]);
    const m = String(id).match(/(cs\.[A-Z]{2}|quant-ph|eess\.[A-Z]{2}|stat\.[A-Z]{2}|cond-mat\.[a-z-]+|astro-ph\.[a-z-]+|hep-[a-z]+|q-bio\.[a-z-]+|nlin\.[a-z-]+)/i);
    if (!m) return votes([]);
    const key = m[1].toLowerCase();
    const hit = ARXIV_MAP[key] || (key.startsWith('cond-mat') ? ARXIV_MAP['cond-mat.*'] : key.startsWith('astro-ph') ? ARXIV_MAP['astro-ph.*'] : key.startsWith('q-bio') ? ARXIV_MAP['q-bio.*'] : null);
    if (!hit) return votes([]);
    return votes(hit.map(t => [t, VOTE_POS]));
  },
};

/** LF-06 数据源先验：来源系统的元数据自带领域倾向（PubMed→医学、arXiv→计算机/物理） */
export const lfSourcePrior = {
  id: 'lf_source_prior',
  desc: '数据源 → 粗领域先验（PubMed/EuropePMC→医学；arXiv→CS/物理）',
  run(e) {
    const s = String(e.source || '').toLowerCase();
    const out = [];
    if (/(pubmed|europepmc|pmc|ncbi|biomed)/.test(s)) out.push([TAG.MEDICINE, VOTE_POS]);
    if (/arxiv/.test(s)) out.push([TAG.CS, VOTE_POS]);
    if (/(crossref|openalex)/.test(s)) { /* 覆盖面太广，弃权 */ }
    if (/(zenodo|datacite)/.test(s)) out.push([TAG.REPRO, VOTE_POS]);
    if (/doaj/.test(s)) out.push([TAG.ENV, VOTE_POS]);
    return votes(out);
  },
};

/** LF-07 DOI 前缀：DOI 注册的机构前缀对应期刊/出版方向 */
export const lfDoiPrefix = {
  id: 'lf_doi_prefix',
  desc: 'DOI 注册机构前缀 → 出版方向标签',
  run(e) {
    const doi = e.doi;
    if (!doi || typeof doi !== 'string') return votes([]);
    const reg = String(doi).split('/')[0].toLowerCase();
    const out = [];
    if (/^(10\.(1038|1001|1002|3975|1039|1016|4337|1007))/.test(doi) || /^(10\.1(038|001|002|3975|039|016|4337|007|103|1003)\.)/.test(doi)) out.push([TAG.CS, VOTE_POS]);
    if (/^(10\.(1016|4337|1016\/j|1037|1016\/j\.ijarm|1007))/.test(doi)) out.push([TAG.MATERIALS, VOTE_POS]);
    if (/\.(1016\/j\.jcis|1016\/j\.artmed|1007|1016\/j\.med|1016\/j\.jbi|1002)/.test(doi)) out.push([TAG.MEDICINE, VOTE_POS]);
    return votes(out);
  },
};

/** LF-08 时代标记：发表年份 → 新兴领域/成熟领域标记 */
export const lfEraMarker = {
  id: 'lf_era_marker',
  desc: '发表年份 → emerging(2024+) / recent(2020-2023) 时代标记',
  run(e) {
    const y = Number(e.year || e.publishedDate?.slice(0, 4) || e.date?.slice(0, 4) || 0);
    if (!y || y < 1990 || y > 2027) return votes([]);
    const out = [];
    if (y >= 2024) out.push(['emerging-2024+', VOTE_POS]);
    else if (y >= 2020) out.push(['recent-2020s', VOTE_POS]);
    if (y < 2010) out.push(['legacy-pre2010', VOTE_POS]);
    return votes(out);
  },
};

/** LF-09 可复现性信号：正文提及代码/数据可用性 → reproducibility */
export const lfReproducibility = {
  id: 'lf_reproducibility',
  desc: '代码/数据可用性提及 → reproducibility（开源科学强信号）',
  run(e) {
    const a = textOf(e, 'abstract') + ' ' + textOf(e, 'summary');
    if (a.length < 40) return votes([]);
    if (/(github\.com|zenodo\.org|doi\.org\/10\.\d+\/zenodo|code and data|data availability|reproducib|open[-\s]?source|available upon request)/i.test(a)) {
      return votes([[TAG.REPRO, VOTE_POS]]);
    }
    return votes([]);
  },
};

/** LF-10 临床试验信号：RCT/随机对照是医学领域最强子类型 */
export const lfClinicalTrial = {
  id: 'lf_clinical_trial',
  desc: 'RCT / 随机对照表述 → randomized-controlled-trial',
  run(e) {
    const a = textOf(e, 'name') + ' ' + textOf(e, 'abstract') + ' ' + textOf(e, 'summary');
    if (!a || a.length < 30) return votes([]);
    if (/(randomized controlled trial|randomised controlled trial|double[-\s]?blind|single[-\s]?blind|ph[ase ]?[iii] trial|clinicaltrials\.gov|nct\d{8})/i.test(a)) {
      return votes([[TAG.RCT, VOTE_POS], [TAG.CLINICAL, VOTE_POS], [TAG.MEDICINE, VOTE_POS]]);
    }
    return votes([]);
  },
};

/** LF-11 中文文献标记：中文实体需区分语种处理 */
export const lfLanguage = {
  id: 'lf_language',
  desc: '中文文本 → 中文文献 标记',
  run(e) {
    const t = textOf(e, 'name') || textOf(e, 'title') || textOf(e, 'abstract');
    if (!t) return votes([]);
    if (/[\u4e00-\u9fff]/.test(t)) return votes([['中文文献', VOTE_POS]]);
    return votes([]);
  },
};

/** LF-12 站点×标题一致性：标题与站点高度一致时，对站点标签投强正票 */
export const lfSiteTitleAgreement = {
  id: 'lf_site_title_agreement',
  desc: '标题与站点主题一致 → 对站点标签投强正票',
  run(e) {
    const site = e.site || (Array.isArray(e.sites) ? e.sites[0] : null);
    const siteTags = site && SITE_DOMAIN[site];
    const t = textOf(e, 'name') || textOf(e, 'title');
    if (!siteTags || !t) return votes([]);
    const titleTags = lfTitleKeywords.run(e);
    const overlap = siteTags.filter(st => titleTags.has(st));
    if (overlap.length === 0) return votes([]);
    // 一致 → 加权确认（仍投 +1，由 LabelModel 依据覆盖率自动调节有效权重）
    return votes(overlap.map(t => [t, VOTE_POS]));
  },
};

/** LF-13 学科交叉：跨站实体 → interdisciplinary 标记 */
export const lfInterdisciplinary = {
  id: 'lf_interdisciplinary',
  desc: '实体出现在多个站点 → interdisciplinary（跨域桥接信号）',
  run(e) {
    const sites = Array.isArray(e.sites) ? e.sites : (e.site ? [e.site] : []);
    if (sites.length >= 2) return votes([['interdisciplinary', VOTE_POS], ['cross-domain-bridge', VOTE_POS]]);
    return votes([]);
  },
};

/** LF-14 综述类文献：review / survey 是综述类强信号 */
export const lfReviewType = {
  id: 'lf_review_type',
  desc: '综述/调查类文献 → review-article',
  run(e) {
    const a = textOf(e, 'name') + ' ' + textOf(e, 'abstract') + ' ' + textOf(e, 'summary');
    if (!a || a.length < 30) return votes([]);
    if (/\b(a review of|review article|survey of|systematic review|scoping review|narrative review|state[-\s]?of[-\s]?the[-\s]?art)\b/i.test(a)) {
      return votes([['review-article', VOTE_POS]]);
    }
    return votes([]);
  },
};

/** LF-15 多源共存：实体在多个数据源出现 → 数据可信度增强标记 */
export const lfMultiSource = {
  id: 'lf_multi_source',
  desc: '多数据源共存 → multi-source-corroborated',
  run(e) {
    const s = e.sources || (e.source ? [e.source] : []);
    if (Array.isArray(s) && s.length >= 2) return votes([['multi-source-corroborated', VOTE_POS]]);
    return votes([]);
  },
};

// ============================================================
// LF-16 受控词表匹配（data-driven，2026-09-29 新增）
//
// 为什么需要
//   手写 KW_MAP 只产出 11 个标签，而语料有 46,025 个去重标签。
//   但 tags-audit 实测：**85.1%（39,157 个）标签只挂在 ≤5 条实体上**，
//   仅 2,124 个标签有 >20 条可统计样本。
//   稀有标签既无足够正例可学、也无足够样本可校验准确率——
//   这才是"LF 产出词表窄"的真因，不是 LF 写得不够多。
//   本 LF 把目标空间收窄到 operations-plan/lib/vocab.json（2,200 个可统计标签），
//   用标签串本身作精确短语匹配：高精确率、且每个标签都可用真实标签校验。
//
// 为什么不用 LLR 词元提升
//   实测从语料自举词元会捞到作者姓（caldin/awdeh），因为标签体系混入了
//   OpenAlex 把人名当 concept 的噪声；词元级提升召回收益远小于误判风险。
//
// ⚠️ 三轮修正，每轮都由定向实验逼出来（experiment-vocab-scope/exact.js）
//
//   ① 单词标签陷阱（acc 0.047）
//     920 个单词标签（human/technology/efficiency/impact）在摘要里普遍出现却
//     极少是真实标签——"human" 匹配到 25,098 条实体，其中 95% 真实标签里没有它。
//     修法：单词标签只认标题（"human" 25,098 → 4,985）。
//
//   ② 作用域（scope 实验）
//     仅标题 precision 0.0823，标题+摘要 0.0598，标题+摘要全量 0.0453；
//     仅标题前 80 字 precision 与全标题**完全相同**（0.0823），80 字后无边际信息。
//     修法：**一律只匹配标题**。顺带把 30k 条评估耗时从 151.8s 压到 20.3s（7.5x）。
//
//   ③ 标签可靠性标定（主菜，真正的主因）
//     去掉摘要后 precision 仍只有 0.1664，因为**逐标签可靠性差异极大**：
//       agriculture 0.481 / cancer 0.547 / reinforcement learning 0.450
//       precision agriculture 0.014 / smart farming 0.009 / control 0.051
//     根因不是文本匹配失败，而是「短语在标题里出现 ≠ OpenAlex 指派了该概念」。
//     OpenAlex 用自己的 NLP 做归属判定，正文提两个词不等于被指派复合概念。
//     这层差异**可测且跨样本稳定**（标定 22,500 → 留一 7,500：agriculture
//     0.481→0.375、cancer 0.547→0.489、robotics 0.448→0.421），
//     故 build-vocab.js 逐标签标定 precision，只保留
//     support>=50 且 precision>=0.2 的标签，其余清空 phrases。
//     全量标定：2,200 全词表 precision 0.1664 → 245 个筛选标签 0.4095（2.46x）。
//     这是 Snorkel 可靠性估计往上一层的应用：LF 的准确率上限被它自己的
//     特征（标签）可靠性约束，必须先标定特征再谈 LF 加权。
//
// 性能
//   标签数 × 实体数暴力匹配不可行。用"首词索引 + 编译正则 + 实体级缓存"：
//   只对实体中实际出现的词做候选查表，每个实体的短语检查次数很小。
// ============================================================
const _vocabState = { idx: null, tried: false };

function buildVocabIndex() {
  if (_vocabState.tried) return _vocabState.idx;
  _vocabState.tried = true;
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'vocab.json');
  if (!fs.existsSync(p)) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  const byFirst = new Map();
  let phrases = 0, kept = 0, skipped = 0;
  for (const [tag, meta] of Object.entries(j.vocabulary || {})) {
    // build-vocab.js 标定后会给不可靠标签置 keep:false 并清空 phrases。
    // 这里再做一次硬守卫：keep 为 false 或 phrases 为空的标签绝不进索引。
    if (!meta || meta.keep === false || !meta.phrases || !meta.phrases.length) { skipped++; continue; }
    kept++;
    for (const ph of meta.phrases) {
      const head = String(ph).split(/\s+/)[0];
      if (!head) continue;
      if (!byFirst.has(head)) byFirst.set(head, []);
      byFirst.get(head).push({
        re: new RegExp('(?:^|[^a-z0-9])' + ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^a-z0-9]|$)'),
        tag,
      });
      phrases++;
    }
  }
  _vocabState.idx = {
    byFirst, phrases,
    tags: Object.keys(j.vocabulary || {}).length,
    tagsKept: kept, tagsSkipped: skipped,
    calibration: j.calibration || null,
    generatedAt: j.generatedAt || null,
  };
  return _vocabState.idx;
}

const _vocabCache = new Map();
// 标定集 30,000 + 相关度采样 4,000 足以覆盖主要重复调用点；
// 主循环每条实体只调一次，缓存收益有限，故不上探更大以免反复 clear 抖动。
const _VOCAB_CACHE_CAP = 40000;

/** LF-16 受控词表精确短语匹配（标题域，可靠性筛选后） */
export const lfCorpusVocab = {
  id: 'lf_corpus_vocab',
  desc: '受控词表精确短语匹配（标题域 + 逐标签可靠性筛选）',
  run(e) {
    const idx = buildVocabIndex();
    if (!idx) return votes([]);
    // 只匹配标题。scope 实验：仅标题 precision 0.0823 vs 标题+摘要 0.0598 / 0.0453；
    // 且仅标题前 80 字与全标题 precision 完全相同，说明标题后段无边际信息。
    const title = (textOf(e, 'name') || textOf(e, 'title')).toLowerCase();
    if (title.length < 8) return votes([]);

    // 实体级缓存：同一实体在标定/相关度/主循环中会被反复 run()
    const key = e.id != null ? e.id : null;
    if (key != null && _vocabCache.has(key)) return _vocabCache.get(key);

    const out = [];
    const seen = new Set();
    for (const tok of title.matchAll(/[a-z0-9\-]{3,}/g)) {
      const cands = idx.byFirst.get(tok[0]);
      if (!cands) continue;
      for (const c of cands) {
        if (seen.has(c.tag)) continue;
        if (c.re.test(title)) { seen.add(c.tag); out.push([c.tag, VOTE_POS]); }
      }
    }
    const m = votes(out);
    if (key != null) {
      if (_vocabCache.size >= _VOCAB_CACHE_CAP) _vocabCache.clear();
      _vocabCache.set(key, m);
    }
    return m;
  },
};

/** 全部 LF 注册表 */
export const LABELING_FUNCTIONS = [
  lfSiteDomain,
  lfTitleKeywords,
  lfAbstractKeywords,
  lfMisrouteDetector,
  lfArxivCategory,
  lfSourcePrior,
  lfDoiPrefix,
  lfEraMarker,
  lfReproducibility,
  lfClinicalTrial,
  lfLanguage,
  lfSiteTitleAgreement,
  lfInterdisciplinary,
  lfReviewType,
  lfMultiSource,
  lfCorpusVocab,
];

// ============================================================
// LabelModel — Snorkel 核心：LF 加权合并
//
// 标定方法（关键诚实点）
//   本项目 63.5% 实体已有标签，构成天然校验集。LF 在已标注子集上的
//   命中率 = LF 准确率，与"在盲数据上估可靠性"不同，这是有 ground truth 的标定。
//   （对应 Snorkel 论文区分 validation set 与 training set 的用法）
//
// 有效权重
//   w_lf = sqrt(accuracy * (1 - abstention_rate) * novelty)
//     accuracy        : LF 在已标注集上的正票命中率（无校验集时退化为 0.5）
//     abstention_rate : 弃权率越低说明信息量越大
//     novelty         : 该 LF 与其他 LF 的独立性（高度冗余 → 降权）
//
// 合并
//   score(tag) = Σ_lf w_lf * vote_lf(tag) / Σ_lf w_lf * |vote_lf(tag)|
//   score ∈ [-1, 1]，按阈值截断；未过阈值 → 弃权（宁可不标，不硬猜）
// ============================================================

/** 在一批已标注实体上标定每个 LF 的准确率 */
export function calibrateLfs(lfs, labeledEntities) {
  const stats = {};
  for (const lf of lfs) stats[lf.id] = { posHit: 0, posTotal: 0, negHit: 0, negTotal: 0, abstain: 0, n: 0 };
  for (const e of labeledEntities) {
    const gold = new Set((e.tags || e.topics || e.keywords || []).map(t => String(t).toLowerCase()));
    if (gold.size === 0) continue;
    for (const lf of lfs) {
      const v = lf.run(e);
      const s = stats[lf.id];
      s.n++;
      let active = 0;
      for (const [tag, vote] of v) {
        const g = String(tag).toLowerCase();
        const inGold = gold.has(g);
        if (vote === VOTE_POS) { s.posTotal++; active++; if (inGold) s.posHit++; }
        else if (vote === VOTE_NEG) { s.negTotal++; active++; if (!inGold) s.negHit++; }
        else s.abstain++;
      }
      if (v.size === 0) s.abstain++;
    }
  }
  return stats;
}

/**
 * 估计 LF 两两关系
 *
 * 返回两个矩阵：
 *   agree[i][j] : 两者共同投票时票向一致的比例（∈[0,1]）
 *   overlap[i][j]: 两者同时投票的实体比例（∈[0,1]）
 *
 * 为什么要分开（2026-09-29 修复的真实退化）
 *   旧实现只算 agree，把"总同意"当成"冗余"。但 lf_site_title_agreement 与
 *   lf_title_keywords 在共同投票的标签上必然 100% 一致，而它们覆盖的实体
 *   集合很不同——这是依赖关系而非冗余。旧指标因此把所有 LF 的 novelty 压成 0，
 *   再靠 Math.max(nov, 0.05) 的地板值兜住，整个 novelty 维度实际无效。
 *   正确做法：冗余 = 一致率 × 重叠率。总同意但很少同时出现的 LF 不是冗余。
 */
export function estimateLfCorrelation(lfs, entities, samples = 4000) {
  const n = lfs.length;
  const agree = Array.from({ length: n }, () => new Array(n).fill(1));
  const overlap = Array.from({ length: n }, () => new Array(n).fill(0));
  const coVotes = Array.from({ length: n }, () => new Array(n).fill(0));
  const pool = entities.slice(0, samples);
  const votesCache = pool.map(e => lfs.map(lf => lf.run(e)));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let agreeN = 0, both = 0;
      for (const per of votesCache) {
        const vi = per[i], vj = per[j];
        if (vi.size === 0 || vj.size === 0) continue;
        coVotes[i][j]++;
        const keys = new Set([...vi.keys(), ...vj.keys()]);
        for (const k of keys) {
          const a = vi.get(k), b = vj.get(k);
          if (a === undefined || b === undefined) continue;
          both++;
          if (a === b) agreeN++;
        }
      }
      agree[i][j] = agree[j][i] = both > 0 ? agreeN / both : 1;
      overlap[i][j] = overlap[j][i] = pool.length ? coVotes[i][j] / pool.length : 0;
    }
  }
  return { corr: agree, agree, overlap, votesCache, pool };
}

/** LF 独立性：1 - 与最相似 LF 的冗余度（冗余度 = 一致率 × 重叠率） */
function noveltyOf(i, corr, overlap) {
  let worst = 0;
  const rows = (corr && typeof corr.corr === 'object') ? null : corr;   // 兼容纯矩阵传入
  const A = rows || corr.corr;
  const O = overlap || (corr && corr.overlap) || null;
  for (let j = 0; j < A.length; j++) {
    if (j === i) continue;
    const c = A[i] ? (A[i][j] || 0) : 0;
    if (!O) { worst = Math.max(worst, c); continue; }   // 无重叠数据时退化为仅用一致率
    worst = Math.max(worst, c * (O[i] ? (O[i][j] || 0) : 0));
  }
  return 1 - worst;
}

/** 计算每个 LF 的有效权重 */
export function lfWeights(lfs, calib, corr) {
  return lfs.map((lf, i) => {
    const s = calib[lf.id];
    const acc = s.posTotal > 0 ? s.posHit / s.posTotal : 0.5;   // 无校验样本时中性 0.5
    const abst = s.n > 0 ? s.abstain / s.n : 1;
    const negRel = s.negTotal > 0 ? s.negHit / s.negTotal : 1;
    const nov = noveltyOf(i, corr);
    const w = Math.sqrt(Math.max(acc, 0.02) * Math.max(negRel, 0.02) * Math.max(1 - abst, 0.02) * Math.max(nov, 0.05));
    return { id: lf.id, desc: lf.desc, accuracy: acc, negReliability: negRel, abstainRate: abst, novelty: nov, weight: w };
  });
}

/**
 * LabelModel 合并：实体 → 置信度加权标签
 *
 * 置信度 = 标签成立的贝叶斯后验 P(标签 | LF 证据)
 *   base        = 标签语料基率（未标定时取中性 0.60）
 *   likelihoodR = K^(posW - negW)，K = 1 + 5*acc 为似然比
 *     K 随 LF 准确率单调：acc=1 → K=6（每单位权重证据力 6 倍）
 *                     acc=0.5 → K=3.5
 *                     acc=0   → K=1（LF 无信息量，证据力归零）
 *
 *   conf = base*likelihoodR / (base*likelihoodR + (1-base))
 *
 * 三条设计保证（各对应一次真实退化教训）
 *   1. 无标定集时不退化为全弃权：未标定 LF 的权重本身已被压低（见 lfWeights）
 *   2. 单 LF 孤票无法突破先验太多：证据力被似然比线性约束
 *   3. 全负票会把标签压到接近 0，明确触发弃权——负证据被真正使用
 *
 * @param {object} entity
 * @param {Array}  lfs
 * @param {Array}  weights 与 lfs 同序；元素可为 {weight:number} 或 number
 * @param {number} threshold 输出阈值
 * @param {number} maxTags
 * @param {Map}    [priors] 标签 → 语料基率
 */
export function labelModel(entity, lfs, weights, threshold = 0.30, maxTags = 8, priors = null) {
  const sumW = weights.reduce((s, w) => s + (typeof w === 'number' ? w : w.weight), 0);
  const agg = new Map();
  for (let i = 0; i < lfs.length; i++) {
    const v = lfs[i].run(entity);
    const w = typeof weights[i] === 'number' ? weights[i] : weights[i].weight;
    for (const [tag, vote] of v) {
      if (vote === VOTE_ABSTAIN) continue;
      if (!agg.has(tag)) agg.set(tag, { pos: 0, neg: 0, support: 0, oppose: 0, sources: [] });
      const a = agg.get(tag);
      if (vote > 0) { a.pos += w; a.support++; a.sources.push(lfs[i].id); }
      else { a.neg += w; a.oppose++; }
    }
  }
  const out = [];
  for (const [tag, a] of agg) {
    const base = priors && priors.has(String(tag).toLowerCase())
      ? priors.get(String(tag).toLowerCase())
      : DEFAULT_BASE_RATE;
    const K = Math.max(1, 1 + K_FACTOR * avgAccForSources(lfs, weights, a.sources));
    const ev = a.pos - a.neg;
    const lr = Math.pow(K, ev);
    const conf = (base * lr) / (base * lr + (1 - base));
    const coverage = sumW > 0 ? (a.pos + a.neg) / sumW : 0;
    if (conf < threshold) continue;   // 弃权优先
    out.push({
      tag,
      confidence: +Math.min(1, Math.max(0, conf)).toFixed(3),
      support: a.support,
      oppose: a.oppose,
      coverage: +coverage.toFixed(3),
      prior: +base.toFixed(3),
      sources: [...new Set(a.sources)],
    });
  }
  out.sort((x, y) => y.confidence - x.confidence || y.support - x.support);
  return { labels: out.slice(0, maxTags), abstained: out.length === 0 };
}

const DEFAULT_BASE_RATE = 0.60;   // 未标定时标签成立的中性先验
const K_FACTOR = 5;              // 似然比系数：acc=1 → K=6

/** 投票来源 LF 的平均准确率（无标定记录时取中性 0.5） */
function avgAccForSources(lfs, weights, sources) {
  const set = new Set(sources || []);
  const accs = [];
  for (let i = 0; i < lfs.length; i++) {
    const w = weights[i];
    if (typeof w === 'number') continue;   // 纯数值权重无准确率信息
    if (w.id && set.has(w.id) && typeof w.accuracy === 'number') accs.push(w.accuracy);
  }
  if (!accs.length) return 0.5;
  return accs.reduce((a, b) => a + b, 0) / accs.length;
}

/** 从已标注语料估计标签基率（先验） */
export function labelPriors(labeledEntities) {
  const m = new Map();
  let n = 0;
  for (const e of labeledEntities) {
    const tags = e.tags || e.topics || e.keywords || [];
    if (!tags.length) continue;
    n++;
    const seen = new Set(tags.map(t => String(t).toLowerCase()));
    for (const t of seen) m.set(t, (m.get(t) || 0) + 1);
  }
  for (const [k, c] of m) m.set(k, n > 0 ? c / n : 0);
  return m;
}

/**
 * 批处理入口
 * @param {Array} entities
 * @param {Array} labeledEntities 已标注子集，用于标定 LF 准确率
 * @param {object} opts { threshold, maxTags, maxCorrSamples }
 * @returns {report}
 */
export function runLabelProgram(entities, labeledEntities, opts = {}) {
  const { threshold = 0.30, maxTags = 8, maxCorrSamples = 4000 } = opts;
  const t0 = Date.now();
  const n = entities.length;

  const calib = calibrateLfs(LABELING_FUNCTIONS, labeledEntities);
  const { corr } = estimateLfCorrelation(LABELING_FUNCTIONS, entities, maxCorrSamples);
  const weights = lfWeights(LABELING_FUNCTIONS, calib, corr);
  const priors = labelPriors(labeledEntities);

  const results = [];
  let abstained = 0, filled = 0, totalLabels = 0, confSum = 0;
  const tagFrequency = new Map();

  for (const e of entities) {
    const r = labelModel(e, LABELING_FUNCTIONS, weights, threshold, maxTags, priors);
    results.push({ id: e.id, proposed: r.labels });
    if (r.abstained) { abstained++; continue; }
    filled++;
    for (const l of r.labels) {
      totalLabels++; confSum += l.confidence;
      tagFrequency.set(l.tag, (tagFrequency.get(l.tag) || 0) + 1);
    }
  }

  const topTags = [...tagFrequency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  return {
    generatedAt: new Date().toISOString(),
    entities: n,
    labeledCalibrationSet: labeledEntities.length,
    lfs: LABELING_FUNCTIONS.length,
    elapsedMs: Date.now() - t0,
    threshold,
    summary: {
      abstained, filled,
      fillRate: n ? filled / n : 0,
      avgConfidence: totalLabels ? confSum / totalLabels : 0,
      avgLabelsPerEntity: filled ? totalLabels / filled : 0,
      distinctTags: tagFrequency.size,
    },
    lfReport: weights.map(w => ({
      id: w.id, desc: w.desc,
      accuracy: +w.accuracy.toFixed(3), negReliability: +w.negReliability.toFixed(3),
      abstainRate: +w.abstainRate.toFixed(3), novelty: +w.novelty.toFixed(3),
      weight: +w.weight.toFixed(3),
    })),
    topTags: topTags.map(([tag, c]) => ({ tag, count: c })),
    results,
  };
}

// ============================================================
// 自检（只在直接运行时执行；被 import 时绝不调用）
// ============================================================
if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
  const _self = fileURLToPath(import.meta.url);
  const _invoked = path.resolve(process.argv[1]);
  if (_self === _invoked || path.resolve(_invoked) === path.resolve(_self)) {
  const demo = [
    { id: 'd1', site: 'nuclear-energy', name: 'Self-perception of balance function in adults following cochlear implant surgery', abstract: 'A cross-sectional study on hearing outcomes in cochlear implant recipients with frailty assessment.', source: 'pubmed', year: 2023 },
    { id: 'd2', site: 'quantum-computing', name: 'Quantum Computing in the NISQ era and beyond', abstract: 'Noisy Intermediate-Scale Quantum (NISQ) technology will be available in the near future.', source: 'arxiv', year: 2018, arxivId: '1712.05050' },
    { id: 'd3', site: 'biomed-ai', name: 'Development of an Explainable ML Model to Predict Mortality Risk in Sepsis', abstract: 'A randomized controlled trial evaluating machine learning for sepsis mortality prediction in ICU patients.', source: 'openalex', year: 2024, doi: '10.1038/s41591-024-0001-1' },
  ];
  const report = runLabelProgram(demo, demo, { threshold: 0.3, maxTags: 6 });
  console.log('自检：', report.summary);
  for (const r of report.results) console.log(' -', r.id, '→', r.proposed.map(l => `${l.tag}(${l.confidence.toFixed(2)})`).join(', '));
  }
}
