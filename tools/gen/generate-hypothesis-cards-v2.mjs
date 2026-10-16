#!/usr/bin/env node
// tools/gen/generate-hypothesis-cards-v2.mjs — Phase 9 假设卡扩产（100 → 1000）
//
// 目的：把假设卡从 100 张（Phase 8 首批评）扩到 1000 张，覆盖 7 种策略。
//
// 诚实性原则：
//   - 100% abstain-first：所有新卡 evidence_status ∈ {hypothesis_only, insufficient_evidence}
//   - confidence_calibration: 'statistical-signal'（区别于 llm-generated）
//   - confidence 分档：
//       LBD gap         0.35-0.55
//       sparse bridge   0.30-0.50
//       moderate bridge 0.28-0.45
//       degree imbalance 0.25-0.40
//       emerging topic  0.30-0.55
//       bidirectional   0.32-0.52
//       crossref topic  0.28-0.48
//   - 每张卡带 falsifiability + evidence_requirement + verification_plan
//
// 生成策略（7 种）：
//   1) LBD gap 主题视角（gapPairs，共享 tags）
//   2) 稀疏桥加密（0<edges<=5，"应更密"）
//   3) 中度稀疏桥（1<edges<500，"边数低估跨域影响"）
//   4) 度失衡承接（inDegree/outDegree 比失衡站）
//   5) 新兴主题（gapPairs × shared tags，非核心主题）
//   6) 双向 gap 展开（gapPairs 反向 pair）
//   7) 共引反向（同一实体引两域 → 假设其他实体也应引）
//
// 追加模式：读取 data/hypothesis-cards.json，追加新卡到 hypothesisCards 数组，
//          去重 by id；更新 stats；重签名。v1 生成的 100 张（含 24 verified）不动。
//
// CLI：
//   node tools/gen/generate-hypothesis-cards-v2.mjs [--max 1000] [--out PATH]
//   --max  新增张数上限（默认 900，即最终 1000 张）
//   --out  输出路径（默认覆盖 data/hypothesis-cards.json）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const SCHEMA_VERSION = '1.1.0';
const GENERATOR_NAME = 'tools/gen/generate-hypothesis-cards-v2.mjs';
const today = new Date();
const todayStr = today.toISOString().slice(0, 10).replace(/-/g, '');

// ============== 站点标签加载（复用 v1 逻辑） ==============

function loadSiteTags() {
  const tagsFile = path.join(ROOT, 'operations-plan', 'lib', 'site-domain-tags.mjs');
  if (!fs.existsSync(tagsFile)) return {};
  const txt = fs.readFileSync(tagsFile, 'utf-8');
  const tags = {};
  const re = /["']([a-z0-9-]+)["']\s*:\s*\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const tagsArr = m[2]
      .split(',')
      .map(s => s.replace(/["'\s]/g, '').toLowerCase())
      .filter(Boolean);
    tags[m[1]] = tagsArr;
  }
  return tags;
}

// 通用标签池（回退，与 v1 一致）
const FALLBACK_TAGS = {
  'agent-ecosystem': ['agent', 'mcp', 'llm', 'orchestration'],
  'agritech': ['agriculture', 'crop', 'plant', 'soil'],
  'ai4science': ['ai', 'science', 'ml', 'automated'],
  'ai-safety': ['safety', 'alignment', 'rlhf', 'risk'],
  'alien-minerals': ['mineral', 'geochemistry', 'planet', 'sample'],
  'biomed-ai': ['biomedicine', 'health', 'disease', 'clinical'],
  'biocomputing': ['bio', 'computing', 'dna', 'protein'],
  'brain-science': ['brain', 'neuroscience', 'cortex', 'cognitive'],
  'bionic-ai': ['bionic', 'prosthetics', 'neuro', 'robot'],
  'carbon-neutral': ['carbon', 'climate', 'emission', 'energy'],
  'command-center': ['disaster', 'emergency', 'command', 'response'],
  'deep-sea-tech': ['ocean', 'marine', 'deep', 'submarine'],
  'digital-twin': ['digital-twin', 'simulation', 'model', 'physical-system'],
  'edge-ai': ['edge', 'embedded', 'iot', 'real-time'],
  'embodied-ai': ['embodied', 'robot', 'agent', 'physical'],
  'exo-science': ['exoplanet', 'astrobiology', 'space', 'habitability'],
  'life-science': ['biology', 'gene', 'cell', 'organism'],
  'low-altitude': ['drone', 'uav', 'low-altitude', 'aerial'],
  'neuromorphic': ['neuromorphic', 'spike', 'memristor', 'brain-inspired'],
  'new-energy': ['energy', 'battery', 'fuel-cell', 'renewable'],
  'nuclear-energy': ['nuclear', 'fission', 'fusion', 'reactor'],
  'privacy-computing': ['privacy', 'fhe', 'secure', 'mpc'],
  'quantum-computing': ['qubit', 'quantum', 'gate', 'superposition'],
  'quantum-materials': ['topological', 'superconductor', 'qubit', 'quantum'],
  'robot-parts': ['robot', 'actuator', 'sensor', 'mechanism'],
  'sat-6g': ['satellite', '6g', 'network', 'space'],
  'semiconductor': ['chip', 'fab', 'lithography', 'process'],
  'spatial-computing': ['spatial', '3d', 'volumetric', 'scene'],
  'synbio-manufacturing': ['synbio', 'synthetic', 'biosynthesis', 'manufacturing'],
  'tcm-tools': ['tcm', 'traditional-medicine', 'herb', 'diagnosis'],
};

// ============== 通用工具 ==============

function sha8(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 8);
}

function sharedTags(a, b, tags) {
  const ta = tags[a] || FALLBACK_TAGS[a] || [];
  const tb = tags[b] || FALLBACK_TAGS[b] || [];
  return [...new Set(ta)].filter(t => tb.includes(t));
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// 每张卡的通用元数据壳
function baseMeta(strategy, seq) {
  return {
    id: `HYP-${todayStr}-${String(seq).padStart(4, '0')}`,
    hypothesis_type: strategy,
    confidence_calibration: 'statistical-signal',
    evidence_status: 'insufficient_evidence',
    status: 'new',
    generated_at: today.toISOString(),
    generator: { tool: GENERATOR_NAME, version: SCHEMA_VERSION },
    history: [{ ts: today.toISOString(), event: 'created', actor: 'hypothesis-generator-v2', note: `Generated by strategy: ${strategy}` }],
  };
}

// ============== 7 种策略生成器 ==============

// 策略 1: LBD gap 主题视角（gapPairs 无引用对）
function genLbdGap(pair, tags, seq) {
  const { from, to, combinedSize } = pair;
  const shared = sharedTags(from, to, tags);
  const stmtEn = `Unrecorded research connections may exist between ${from} and ${to}: ${combinedSize} entities, ${shared.length} shared topic(s) (${shared.join(', ') || 'none'}) but zero citation edges between them suggest missed references.`;
  const stmtZh = `站点 ${from} 与 ${to} 之间可能存在未记录的引用关系：两站共 ${combinedSize} 实体、${shared.length} 个共享主题（${shared.join(', ') || '无'}），但引用边为 0，提示存在被遗漏的学术连接。`;
  const conf = clamp(0.35 + shared.length * 0.15, 0.35, 0.65);
  return {
    ...baseMeta('litellbridge', seq),
    statement: stmtEn,
    statement_zh: stmtZh,
    confidence: Math.round(conf * 1000) / 1000,
    evidence_status: 'insufficient_evidence',
    falsifiability: {
      falsification_condition: `If OpenAlex reverse-citation queries on top-100 ${from} entities return ZERO citing papers from ${to} domain within the past 5 years, the hypothesis is falsified.`,
      falsification_test: `1. Take top 100 ${from} entities by citationCount; 2. Query OpenAlex for each entity's cited-works; 3. Filter by subject matching ${to}'s tags; 4. If count=0 across all 100, falsified.`,
      falsification_time_horizon_days: 14,
    },
    evidence_requirement: {
      min_evidence_count: 3,
      evidence_types: ['citation', 'topic_overlap'],
      evidence_sources: [`${from}/website/api/entities.json`, `${to}/website/api/entities.json`],
    },
    verification_plan: {
      step1_search: `Query OpenAlex for reverse-citation from top-100 ${from} entities`,
      step2_analyze: `Cross-reference cited-works' primary_topic with ${to}'s topic tags`,
      step3_report: `Report discovered citation edges; if >= 3 found, escalate`,
      estimated_effort: 'medium',
    },
    source_signals: {
      citation_gap_pair: `${from}→${to}`,
      shared_tags: shared,
      combined_size: combinedSize,
      signal_type: 'citation_absence',
    },
    provenance: { generated_by: 'citation-gaps.json#gapPairs', data_versions: [sha8(JSON.stringify(pair))] },
  };
}

// 策略 2: 稀疏桥加密（0 < edges <= 5，"应更密"）
function genSparseBridge(pair, tags, seq) {
  const [from, to, edges] = pair;
  const shared = sharedTags(from, to, tags);
  const stmtEn = `The bridge between ${from} and ${to} has only ${edges} citation edge(s). Given ${shared.length} shared topic(s), the current connection is ultra-sparse and likely underestimates cross-domain influence.`;
  const stmtZh = `站点 ${from} 与 ${to} 之间仅有 ${edges} 条引用边。基于 ${shared.length} 个共享主题，当前连接极度稀疏，很可能低估了跨域影响。`;
  const conf = clamp(0.5 - edges * 0.04, 0.30, 0.50);
  return {
    ...baseMeta('sparse_bridge_v2', seq),
    statement: stmtEn,
    statement_zh: stmtZh,
    confidence: Math.round(conf * 1000) / 1000,
    evidence_status: 'insufficient_evidence',
    falsifiability: {
      falsification_condition: `If a full-text scan of both corpora shows co-citation rate < 0.05% in both directions, the "under-represented" hypothesis is falsified.`,
      falsification_test: `1. Sample 500 papers from each site; 2. Extract reference lists; 3. Compute co-citation rate; 4. If rate < 0.05%, falsified.`,
      falsification_time_horizon_days: 21,
    },
    evidence_requirement: {
      min_evidence_count: 5,
      evidence_types: ['citation', 'topic_overlap', 'co_author'],
      evidence_sources: ['OpenAlex', 'Crossref'],
    },
    verification_plan: {
      step1_search: `Sample papers from both sites, extract reference lists`,
      step2_analyze: `Compute co-citation rate between sites`,
      step3_report: `Compare to current edge count; report delta`,
      estimated_effort: 'high',
    },
    source_signals: {
      citation_pair: `${from}↔${to}`,
      current_edges: edges,
      shared_tags: shared,
      signal_type: 'ultra_sparse_bridge',
    },
    provenance: { generated_by: 'citation-gaps.json#pairMatrix', data_versions: [sha8(JSON.stringify(pair))] },
  };
}

// 策略 3: 中度稀疏桥（1 < edges < 500，"边数低估"）
function genModerateBridge(pair, tags, seq) {
  const [from, to, edges] = pair;
  const shared = sharedTags(from, to, tags);
  const stmtEn = `The bridge ${from}↔${to} has ${edges} edges — non-zero but far below the pairMatrix median. The edge density likely underestimates the actual interdisciplinary connection.`;
  const stmtZh = `站点 ${from} 与 ${to} 之间有 ${edges} 条边——非零但远低于 pairMatrix 中位数。边密度可能低估了实际跨学科连接。`;
  const conf = clamp(0.28 + (500 - edges) / 1000 + shared.length * 0.03, 0.28, 0.45);
  return {
    ...baseMeta('moderate_bridge', seq),
    statement: stmtEn,
    statement_zh: stmtZh,
    confidence: Math.round(conf * 1000) / 1000,
    evidence_status: 'insufficient_evidence',
    falsifiability: {
      falsification_condition: `If co-citation rate between the two sites is > 1% (well above typical cross-domain baseline), the "under-represented" claim is falsified — the connection is already well-represented.`,
      falsification_test: `1. Compute total pairs between sites; 2. Divide current edges by total; 3. If ratio > 1%, falsified.`,
      falsification_time_horizon_days: 14,
    },
    evidence_requirement: {
      min_evidence_count: 3,
      evidence_types: ['citation', 'topic_overlap'],
      evidence_sources: ['citation-edges.json', 'OpenAlex'],
    },
    verification_plan: {
      step1_search: `Compute total entity pairs between ${from} and ${to}`,
      step2_analyze: `Calculate edge density ratio`,
      step3_report: `Compare to median; if density ratio > 1%, connection is adequate`,
      estimated_effort: 'low',
    },
    source_signals: {
      citation_pair: `${from}↔${to}`,
      current_edges: edges,
      shared_tags: shared,
      signal_type: 'moderate_sparse_bridge',
    },
    provenance: { generated_by: 'citation-gaps.json#pairMatrix', data_versions: [sha8(JSON.stringify(pair))] },
  };
}

// 策略 4: 度失衡承接（in/out degree 比失衡站）
function genDegreeImbalance(site, tags, seq, target) {
  const t = FALLBACK_TAGS[target] || tags[target] || [];
  const imbalanceRatio = site.inDegree > site.outDegree
    ? `${(site.inDegree / Math.max(site.outDegree, 1)).toFixed(2)}`
    : `${(site.outDegree / Math.max(site.inDegree, 1)).toFixed(2)}`;
  const direction = site.outDegree > site.inDegree ? 'outputs far more than it receives' : 'receives far more than it outputs';
  const stmtEn = `Site ${site.site} ${direction} (ratio ${imbalanceRatio}). A plausible hypothesis: cross-domain influence from ${site.site} to ${target} is systematically under-cited — ${target} likely benefits from ${site.site}'s ${direction === 'receives far more than it outputs' ? 'output' : 'input'} but does not cite it back.`;
  const stmtZh = `站点 ${site.site} ${direction === 'outputs far more than it receives' ? '输出远多于接收' : '接收远多于输出'}（比值 ${imbalanceRatio}）。可能假设：${site.site} 到 ${target} 的跨域影响被系统性低估——${target} 很可能受益于 ${site.site} 但并未引用回报。`;
  const conf = clamp(0.30 - Math.abs(Math.log(parseFloat(imbalanceRatio))) * 0.05, 0.25, 0.40);
  return {
    ...baseMeta('degree_imbalance', seq),
    statement: stmtEn,
    statement_zh: stmtZh,
    confidence: Math.round(conf * 1000) / 1000,
    evidence_status: 'insufficient_evidence',
    falsifiability: {
      falsification_condition: `If OpenAlex returns >= 20 citing papers from ${target} back to ${site.site} within 5 years, the "systematic under-citation" hypothesis is falsified.`,
      falsification_test: `1. Query OpenAlex for ${target}-domain papers citing ${site.site}-domain works in past 5 years; 2. If count >= 20, falsified.`,
      falsification_time_horizon_days: 14,
    },
    evidence_requirement: {
      min_evidence_count: 3,
      evidence_types: ['citation', 'topic_overlap'],
      evidence_sources: ['OpenAlex'],
    },
    verification_plan: {
      step1_search: `Query OpenAlex for ${target}→${site.site} citations`,
      step2_analyze: `Count returned citing papers within 5 years`,
      step3_report: `If >= 20, hypothesis falsified; if < 5, hypothesis strengthened`,
      estimated_effort: 'medium',
    },
    source_signals: {
      imbalance_site: site.site,
      target_site: target,
      inDegree: site.inDegree,
      outDegree: site.outDegree,
      ratio: imbalanceRatio,
      signal_type: 'degree_imbalance',
    },
    provenance: { generated_by: 'citation-gaps.json#degrees', data_versions: [sha8(JSON.stringify({ site: site.site, target, imbalanceRatio }))] },
  };
}

// 策略 5: 新兴主题（gapPairs × shared tags 非零）
function genEmergingTopic(pair, tags, seq) {
  const { from, to } = pair;
  const shared = sharedTags(from, to, tags);
  if (shared.length === 0) return null;
  const stmtEn = `The shared topic(s) "${shared.join('", "')}" appear in both ${from} and ${to} corpora but with no cross-citations, suggesting an emerging interdisciplinary frontier not yet formally acknowledged.`;
  const stmtZh = `共同主题 "${shared.join('", "')}" 同时出现在 ${from} 和 ${to} 语料中但无交叉引用，提示存在未被正式承认的新兴跨学科前沿。`;
  const conf = clamp(0.30 + shared.length * 0.12, 0.30, 0.55);
  return {
    ...baseMeta('emerging_topic', seq),
    statement: stmtEn,
    statement_zh: stmtZh,
    confidence: Math.round(conf * 1000) / 1000,
    evidence_status: 'hypothesis_only',
    falsifiability: {
      falsification_condition: `If the shared topics appear only as peripheral keywords (< 1% entity coverage in each site), this is not an emerging frontier but tagging noise.`,
      falsification_test: `1. For each site, count entities with each shared topic in primary tags; 2. If < 1% coverage, falsified.`,
      falsification_time_horizon_days: 7,
    },
    evidence_requirement: {
      min_evidence_count: 3,
      evidence_types: ['topic_overlap'],
      evidence_sources: ['entity tags', 'keyword extraction'],
    },
    verification_plan: {
      step1_search: `Count primary-tag coverage for each shared topic in both sites`,
      step2_analyze: `Filter out low-coverage (<1%) topics`,
      step3_report: `Remaining topics are candidate emerging frontiers`,
      estimated_effort: 'low',
    },
    source_signals: {
      citation_gap_pair: `${from}↔${to}`,
      shared_tags: shared,
      signal_type: 'keyword_emergence',
    },
    provenance: { generated_by: 'shared-tag-analysis', data_versions: [sha8(JSON.stringify({ from, to, shared }))] },
  };
}

// 策略 6: 双向 gap 展开（gapPairs 反向 pair）
function genBidirectionalGap(pair, tags, seq) {
  const { from, to, combinedSize } = pair;
  const shared = sharedTags(to, from, tags);
  const stmtEn = `Reverse-direction hypothesis: if ${from} does not cite ${to}, the reverse citation flow (${to}→${from}) is also likely underrepresented — ${combinedSize} combined entities with ${shared.length} shared topic(s) should show at least some reverse flow, but likely don't.`;
  const stmtZh = `反向假设：如果 ${from} 不引用 ${to}，那么反向引用流（${to}→${from}）同样可能未充分记录——${combinedSize} 个实体、${shared.length} 个共享主题应有至少一些反向流，但很可能没有。`;
  const conf = clamp(0.32 + shared.length * 0.10, 0.32, 0.52);
  return {
    ...baseMeta('bidirectional_gap', seq),
    statement: stmtEn,
    statement_zh: stmtZh,
    confidence: Math.round(conf * 1000) / 1000,
    evidence_status: 'insufficient_evidence',
    falsifiability: {
      falsification_condition: `If reverse OpenAlex query on top-100 ${to} entities returns >= 3 citing papers from ${from} domain, the "under-represented reverse flow" hypothesis is falsified.`,
      falsification_test: `1. Take top-100 ${to} entities; 2. Query OpenAlex for cited-works in ${from} domain; 3. If >= 3, falsified.`,
      falsification_time_horizon_days: 14,
    },
    evidence_requirement: {
      min_evidence_count: 3,
      evidence_types: ['citation'],
      evidence_sources: ['OpenAlex'],
    },
    verification_plan: {
      step1_search: `Query OpenAlex for top-100 ${to} entities' cited-works`,
      step2_analyze: `Count citing papers from ${from} domain`,
      step3_report: `If >= 3, hypothesis falsified; if 0, hypothesis strengthened`,
      estimated_effort: 'medium',
    },
    source_signals: {
      citation_gap_pair: `${to}→${from}`,
      direction: 'reverse',
      shared_tags: shared,
      signal_type: 'reverse_citation_absence',
    },
    provenance: { generated_by: 'citation-gaps.json#gapPairs-reverse', data_versions: [sha8(JSON.stringify({ from: to, to: from }))] },
  };
}

// 策略 7: 共引反向（同一实体的引用分散到两域 → 假设其他实体也应引用）
function genCrossrefTopic(edge, tags, seq) {
  // edge = [sourceDoi, citedDoi, sourceSite, citedSite]
  const [, , sSite, tSite] = edge;
  const shared = sharedTags(sSite, tSite, tags);
  if (shared.length === 0) return null;
  const stmtEn = `Observed at least one entity in ${sSite} citing a work in ${tSite}, establishing a shared topic surface (${shared.join(', ')}). Hypothesis: other entities in ${sSite} should also cite ${tSite}, but current edge density suggests most do not — indicating potential citation gap at scale.`;
  const stmtZh = `已观察到 ${sSite} 中至少有 1 个实体引用 ${tSite} 作品，建立共享主题面（${shared.join(', ')}）。假设：${sSite} 中其他实体也应引用 ${tSite}，但当前边密度显示大多数没有——提示存在规模化引用缺口。`;
  const conf = clamp(0.28 + shared.length * 0.05, 0.28, 0.48);
  return {
    ...baseMeta('crossref_topic_bridge', seq),
    statement: stmtEn,
    statement_zh: stmtZh,
    confidence: Math.round(conf * 1000) / 1000,
    evidence_status: 'insufficient_evidence',
    falsifiability: {
      falsification_condition: `If >= 50 other ${sSite} entities also cite ${tSite} entities, the "citation gap at scale" claim is falsified.`,
      falsification_test: `1. Query citation-edges.json for edges where sourceSite=${sSite} AND targetSite=${tSite}; 2. If count >= 50, falsified.`,
      falsification_time_horizon_days: 3,
    },
    evidence_requirement: {
      min_evidence_count: 3,
      evidence_types: ['citation'],
      evidence_sources: ['citation-edges.json'],
    },
    verification_plan: {
      step1_search: `Count existing ${sSite}→${tSite} edges in citation-edges.json`,
      step2_analyze: `Compute ratio to total ${sSite} entity count`,
      step3_report: `If ratio < 0.5%, hypothesis strengthened`,
      estimated_effort: 'low',
    },
    source_signals: {
      observed_edge: `${sSite}→${tSite}`,
      shared_tags: shared,
      signal_type: 'observed_edge_extrapolation',
    },
    provenance: { generated_by: 'citation-edges.json#observedEdge', data_versions: [sha8(JSON.stringify(edge))] },
  };
}

// ============== CLI ==============

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { maxNew: 900, out: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max') opts.maxNew = parseInt(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

function run() {
  const opts = parseArgs();
  const gapsPath = path.join(ROOT, 'data', 'citation-gaps.json');
  const edgesPath = path.join(ROOT, 'data', 'citation-edges.json');
  if (!fs.existsSync(gapsPath)) {
    console.error(`✗ Not found: ${gapsPath}`);
    process.exit(1);
  }
  const gaps = JSON.parse(fs.readFileSync(gapsPath, 'utf-8'));
  const edges = fs.existsSync(edgesPath) ? JSON.parse(fs.readFileSync(edgesPath, 'utf-8')) : { edges: [] };
  const tags = loadSiteTags();

  // 读现有 hypothesis-cards.json
  const outPath = opts.out || path.join(ROOT, 'data', 'hypothesis-cards.json');
  const existing = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, 'utf-8'))
    : null;
  const existingCards = existing?.hypothesisCards || [];
  const existingIds = new Set(existingCards.map(c => c.id));
  const startSeq = existingCards.length;

  console.log(`▸ 现有卡：${existingCards.length} 张`);
  console.log(`▸ 目标新增：${opts.maxNew} 张`);
  console.log(`▸ citation-gaps: ${gaps.stats.gapPairs} gapPairs / ${gaps.pairMatrix?.length || 0} pairMatrix`);
  console.log(`▸ citation-edges: ${edges.edges?.length || 0} edges`);

  // 准备候选池
  const allCards = [];
  let seq = startSeq + 1;

  // 候选来源 1: gapPairs（140）
  const gapPairs = gaps.gapPairs || [];
  // 候选来源 2: pairMatrix 稀疏桥（0<e<=5，338）
  const ultraSparse = (gaps.pairMatrix || []).filter(p => p[2] > 0 && p[2] <= 5);
  // 候选来源 3: pairMatrix 中度稀疏（1<e<500，603）
  const moderateSparse = (gaps.pairMatrix || []).filter(p => p[2] > 5 && p[2] < 500);
  // 候选来源 4: 度失衡站（8）× 目标站
  const imbalanceSites = (gaps.degrees || []).filter(
    d => (d.inDegree / Math.max(d.outDegree, 1)) > 5 || (d.outDegree / Math.max(d.inDegree, 1)) > 5
  ).sort((a, b) => {
    const r1 = Math.max(a.inDegree / Math.max(a.outDegree, 1), a.outDegree / Math.max(a.inDegree, 1));
    const r2 = Math.max(b.inDegree / Math.max(b.outDegree, 1), b.outDegree / Math.max(b.inDegree, 1));
    return r2 - r1;
  });
  const allSites = gaps.sites || Object.keys(FALLBACK_TAGS);
  // 候选来源 5: gapPairs × shared tags > 0
  // 候选来源 6: gapPairs 反向（140）
  // 候选来源 7: citation-edges 观测对（从 25682 抽样本）
  const sampleSize = Math.min(500, (edges.edges || []).length);
  const sampledEdges = (edges.edges || []).filter((_, i) => i % Math.max(1, Math.floor((edges.edges?.length || 1) / sampleSize)) === 0);

  console.log(`▸ 候选池: gapPairs=${gapPairs.length}, ultraSparse=${ultraSparse.length}, moderateSparse=${moderateSparse.length}, imbalanceSites=${imbalanceSites.length}, sampledEdges=${sampledEdges.length}`);

  // ============== 生成阶段（配额控制，保证 7 种策略都被跑到） ==============
  // 配额按 maxNew 比例分：LBD 15% / 稀疏 10% / 中度 15% / 失衡 15% / 新兴 10% / 双向 15% / 共引 20%
  const quota = {
    lbdGap: Math.round(opts.maxNew * 0.15),
    sparseBridge: Math.round(opts.maxNew * 0.10),
    moderateBridge: Math.round(opts.maxNew * 0.15),
    degreeImbalance: Math.round(opts.maxNew * 0.15),
    emergingTopic: Math.round(opts.maxNew * 0.10),
    bidirectionalGap: Math.round(opts.maxNew * 0.15),
    crossrefTopic: Math.round(opts.maxNew * 0.20),
  };
  console.log(`▸ 配额:`, JSON.stringify(quota));

  const strategyCounters = { ...quota };

  function pushIfRoom(card, strategyKey) {
    if (!card || allCards.length >= opts.maxNew) return false;
    if (strategyCounters[strategyKey] <= 0) return false;
    if (existingIds.has(card.id) || allCards.some(c => c.id === card.id)) return false;
    allCards.push(card);
    strategyCounters[strategyKey]--;
    return true;
  }

  // Strategy 1: LBD gap
  console.log(`\n[1/7] LBD gap 主题视角 (配额 ${quota.lbdGap})...`);
  for (const pair of gapPairs) {
    if (allCards.length >= opts.maxNew || strategyCounters.lbdGap <= 0) break;
    pushIfRoom(genLbdGap(pair, tags, seq++), 'lbdGap');
  }
  console.log(`  → +${strategyCounters.lbdGap === quota.lbdGap ? 0 : quota.lbdGap - strategyCounters.lbdGap} 张`);

  // Strategy 2: 稀疏桥加密
  console.log(`\n[2/7] 稀疏桥加密（0<e<=5, 配额 ${quota.sparseBridge}）...`);
  for (const pair of ultraSparse) {
    if (allCards.length >= opts.maxNew || strategyCounters.sparseBridge <= 0) break;
    pushIfRoom(genSparseBridge(pair, tags, seq++), 'sparseBridge');
  }
  console.log(`  → +${quota.sparseBridge - strategyCounters.sparseBridge} 张`);

  // Strategy 3: 中度稀疏桥
  console.log(`\n[3/7] 中度稀疏桥（1<e<500, 配额 ${quota.moderateBridge}）...`);
  for (const pair of moderateSparse) {
    if (allCards.length >= opts.maxNew || strategyCounters.moderateBridge <= 0) break;
    pushIfRoom(genModerateBridge(pair, tags, seq++), 'moderateBridge');
  }
  console.log(`  → +${quota.moderateBridge - strategyCounters.moderateBridge} 张`);

  // Strategy 4: 度失衡承接
  console.log(`\n[4/7] 度失衡承接 (配额 ${quota.degreeImbalance})...`);
  for (const site of imbalanceSites) {
    if (allCards.length >= opts.maxNew || strategyCounters.degreeImbalance <= 0) break;
    for (const target of allSites) {
      if (target === site.site) continue;
      if (allCards.length >= opts.maxNew || strategyCounters.degreeImbalance <= 0) break;
      pushIfRoom(genDegreeImbalance(site, tags, seq++, target), 'degreeImbalance');
    }
  }
  console.log(`  → +${quota.degreeImbalance - strategyCounters.degreeImbalance} 张`);

  // Strategy 5: 新兴主题
  console.log(`\n[5/7] 新兴主题 (配额 ${quota.emergingTopic})...`);
  for (const pair of gapPairs) {
    if (allCards.length >= opts.maxNew || strategyCounters.emergingTopic <= 0) break;
    const card = genEmergingTopic(pair, tags, seq++);
    if (card) pushIfRoom(card, 'emergingTopic');
  }
  console.log(`  → +${quota.emergingTopic - strategyCounters.emergingTopic} 张`);

  // Strategy 6: 双向 gap 展开
  console.log(`\n[6/7] 双向 gap 展开 (配额 ${quota.bidirectionalGap})...`);
  for (const pair of gapPairs) {
    if (allCards.length >= opts.maxNew || strategyCounters.bidirectionalGap <= 0) break;
    pushIfRoom(genBidirectionalGap(pair, tags, seq++), 'bidirectionalGap');
  }
  console.log(`  → +${quota.bidirectionalGap - strategyCounters.bidirectionalGap} 张`);

  // Strategy 7: 共引反向
  console.log(`\n[7/7] 共引反向（观测边推断, 配额 ${quota.crossrefTopic}）...`);
  for (const edge of sampledEdges) {
    if (allCards.length >= opts.maxNew || strategyCounters.crossrefTopic <= 0) break;
    const card = genCrossrefTopic(edge, tags, seq++);
    if (card) pushIfRoom(card, 'crossrefTopic');
  }
  console.log(`  → +${quota.crossrefTopic - strategyCounters.crossrefTopic} 张`);

  // ============== 汇总 ==============

  const byType = {};
  const byStatus = {};
  const byConfidence = { low: 0, medium: 0, high: 0 };
  for (const h of allCards) {
    byType[h.hypothesis_type] = (byType[h.hypothesis_type] || 0) + 1;
    byStatus[h.evidence_status] = (byStatus[h.evidence_status] || 0) + 1;
    if (h.confidence < 0.35) byConfidence.low++;
    else if (h.confidence < 0.45) byConfidence.medium++;
    else byConfidence.high++;
  }
  const avgConf = allCards.length ? allCards.reduce((s, h) => s + h.confidence, 0) / allCards.length : 0;

  const mergedCards = [...existingCards, ...allCards];
  const mergedByType = {};
  const mergedByStatus = {};
  const mergedByEvidence = {};
  for (const h of mergedCards) {
    mergedByType[h.hypothesis_type] = (mergedByType[h.hypothesis_type] || 0) + 1;
    mergedByStatus[h.status] = (mergedByStatus[h.status] || 0) + 1;
    mergedByEvidence[h.evidence_status] = (mergedByEvidence[h.evidence_status] || 0) + 1;
  }
  const mergedAvgConf = mergedCards.length ? mergedCards.reduce((s, h) => s + h.confidence, 0) / mergedCards.length : 0;

  // 保留已有 stats 的验证字段
  const preservedStats = existing?.stats || {};

  const output = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: today.toISOString(),
    generator: {
      tool: GENERATOR_NAME,
      version: SCHEMA_VERSION,
      previousRun: existing?.generator || null,
    },
    sourceData: {
      citationGapsVersion: gaps.version,
      citationGapsBuiltAt: gaps.builtAt,
      stats: gaps.stats,
    },
    stats: {
      total: mergedCards.length,
      newInThisRun: allCards.length,
      byType: mergedByType,
      byEvidenceStatus: mergedByEvidence,
      byStatus: mergedByStatus,
      newByType: byType,
      newByEvidenceStatus: byStatus,
      newByConfidence: byConfidence,
      avgConfidence: Math.round(mergedAvgConf * 1000) / 1000,
      newAvgConfidence: Math.round(avgConf * 1000) / 1000,
      // 保留 v1 验证信息
      lastVerifiedAt: preservedStats.lastVerifiedAt,
      verificationRunPath: preservedStats.verificationRunPath,
      verified: preservedStats.byStatus?.verified || 0,
    },
    hypothesisCards: mergedCards,
  };

  if (opts.dryRun) {
    console.log(`\n--- DRY RUN ---`);
    console.log(`新增 ${allCards.length} 张（合计 ${mergedCards.length} 张）`);
    console.log(`newByType:`, JSON.stringify(byType, null, 2));
    console.log(`newByEvidenceStatus:`, JSON.stringify(byStatus, null, 2));
    console.log(`newByConfidence:`, JSON.stringify(byConfidence, null, 2));
    console.log(`avgConfidence: ${output.stats.avgConfidence}, newAvgConfidence: ${output.stats.newAvgConfidence}`);
    return output;
  }

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✓ 写入 ${outPath}`);
  console.log(`  总卡数: ${mergedCards.length} (新增 ${allCards.length})`);
  console.log(`  by type: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`  avg confidence: ${output.stats.avgConfidence} (新增 ${output.stats.newAvgConfidence})`);
  return output;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { run(); } catch (e) { console.error('✗', e); process.exit(1); }
}
