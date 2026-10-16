#!/usr/bin/env node
// tools/gen/generate-hypothesis-cards.mjs — 从 citation-gaps + bridges + 实体标签生成首批可证伪假设卡
//
// 核心：Swanson LBD（Literature-Based Discovery）+ 跨域桥接
//   输入: data/citation-gaps.json (140 gapPairs + 30 bridges) + 30 站实体 tags
//   输出: data/hypothesis-cards.json (首批假设卡)
//
// 生成策略：
//   1) LBD 缺口连接 — 无引用的两站若有 topic 共现 → 假设存在被遗漏的引用
//   2) Bridge 反向 — 已有边但边稀疏（<50）→ 假设"连接应更强"
//   3) 时序承接 — 高 in-degree 站的新增实体 → 假设"承接高引站"
//
// 诚实性原则：每张卡都带 falsifiability + evidence_requirement + evidence_status='hypothesis_only'
// 不做验证，只生成 + 记录验证计划。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// ============== 站点标签加载 ==============

function loadSiteTags() {
  const tagsFile = path.join(ROOT, 'operations-plan', 'lib', 'site-domain-tags.mjs');
  if (!fs.existsSync(tagsFile)) return {};
  // Simple extraction: match "siteName": "tag"
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

// ============== 通用标签池（回退） ==============

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

// ============== 假设卡生成器 ==============

const SCHEMA_VERSION = '1.0.0';
const GENERATOR_NAME = 'tools/gen/generate-hypothesis-cards.mjs';
const today = new Date();
const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');

function makeHypId(seq) {
  return `HYP-${dateStr}-${String(seq).padStart(4, '0')}`;
}

function sha8(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 8);
}

function sharedTags(a, b, tags) {
  const ta = tags[a] || FALLBACK_TAGS[a] || [];
  const tb = tags[b] || FALLBACK_TAGS[b] || [];
  return [...new Set(ta)].filter(t => tb.includes(t));
}

// 假设类型 1: LBD 缺口连接
function genLbdGapHyp(pair, tags, seq) {
  const { from, to, combinedSize } = pair;
  const shared = sharedTags(from, to, tags);
  const id = makeHypId(seq);
  const stmtEn = `There may be unrecorded research connections between ${from} and ${to}: ${shared.length} shared topic(s) (${shared.join(', ')}) but zero citations between these ${combinedSize} entities suggest missed references.`;
  const stmtZh = `站点 ${from} 与 ${to} 之间存在未被记录的引用关系：两站共 ${combinedSize} 实体、${shared.length} 个共享主题（${shared.join(', ')}），但引用边为 0，提示存在被遗漏的学术连接。`;
  return {
    id,
    statement: stmtEn,
    statement_zh: stmtZh,
    hypothesis_type: 'litellbridge',
    confidence: Math.min(0.4 + shared.length * 0.15, 0.85),
    confidence_calibration: 'statistical-signal',
    evidence_status: 'insufficient_evidence',
    falsifiability: {
      falsification_condition: `If we perform OpenAlex reverse-citation queries on ${from} entities (top 100 by citationCount) and find ZERO citing papers from ${to} domain within the past 5 years, the hypothesis is falsified.`,
      falsification_test: `1. Take top 100 ${from} entities by citationCount\n2. Query OpenAlex for each entity's cited-works\n3. Filter cited-works by subject area matching ${to}'s tags\n4. If citation count = 0 across all 100, falsified; if >= 3, hypothesis strengthened.`,
      falsification_time_horizon_days: 14,
    },
    evidence_requirement: {
      min_evidence_count: 3,
      evidence_types: ['citation', 'topic_overlap'],
      evidence_sources: [`${from}/website/api/entities.json`, `${to}/website/api/entities.json`],
    },
    verification_plan: {
      step1_search: `Query OpenAlex for reverse-citation from top 100 ${from} entities`,
      step2_analyze: `Cross-reference cited-works' primary_topic with ${to}'s topic tags`,
      step3_report: `Report discovered citation edges; if >= 3 found, escalate to hypothesis engine`,
      estimated_effort: 'medium',
    },
    source_signals: {
      citation_gap_pair: `${from}→${to}`,
      shared_tags: shared,
      signal_type: 'citation_absence',
    },
    status: 'new',
    generated_at: today.toISOString(),
    generator: { tool: GENERATOR_NAME, version: SCHEMA_VERSION },
    history: [{ ts: today.toISOString(), event: 'created', actor: 'hypothesis-generator-v1', note: `Generated from ${from}/${to} gap pair with ${shared.length} shared tags` }],
    provenance: { generated_by: 'citation-gaps.json', data_versions: [sha8(JSON.stringify(pair))] },
  };
}

// 假设类型 2: Bridge 反向（稀疏边 → 应更密）
function genSparseBridgeHyp(bridge, tags, seq) {
  const { from, to, edges } = bridge;
  const shared = sharedTags(from, to, tags);
  if (edges >= 500) return null; // 只有稀疏边才生成假设
  const id = makeHypId(seq);
  const stmtEn = `The bridge between ${from} and ${to} is sparse (${edges} edges). Given ${shared.length} shared topic(s) (${shared.join(', ') || 'none'}), the actual interdisciplinary connection should be denser — current edge count likely underestimates cross-domain influence.`;
  const stmtZh = `站点 ${from} 与 ${to} 之间的边较稀疏（${edges} 条）。基于 ${shared.length} 个共享主题，实际跨域影响应该更密集——当前边数可能低估了跨域连接。`;
  return {
    id,
    statement: stmtEn,
    statement_zh: stmtZh,
    hypothesis_type: 'cross_domain_bridge',
    confidence: Math.max(0.3, 0.7 - edges / 500),
    confidence_calibration: 'statistical-signal',
    evidence_status: 'insufficient_evidence',
    falsifiability: {
      falsification_condition: `If a full-text scan of ${from} and ${to} papers shows co-citation rate < 0.1% in both directions, the hypothesis that the connection is under-represented is falsified.`,
      falsification_test: `1. Sample 500 papers from each site\n2. Extract reference lists\n3. Compute co-citation rate between sites\n4. If rate < 0.1%, falsified.`,
      falsification_time_horizon_days: 21,
    },
    evidence_requirement: {
      min_evidence_count: 5,
      evidence_types: ['citation', 'topic_overlap', 'co_author'],
      evidence_sources: ['OpenAlex', 'Crossref'],
    },
    verification_plan: {
      step1_search: `Sample papers from both sites, extract reference lists`,
      step2_analyze: `Compute co-citation rate`,
      step3_report: `Compare to current edge count; report delta`,
      estimated_effort: 'high',
    },
    source_signals: {
      citation_gap_pair: `${from}↔${to}`,
      shared_tags: shared,
      signal_type: 'topic_overlap',
    },
    status: 'new',
    generated_at: today.toISOString(),
    generator: { tool: GENERATOR_NAME, version: SCHEMA_VERSION },
    history: [{ ts: today.toISOString(), event: 'created', actor: 'hypothesis-generator-v1', note: `Generated from sparse bridge ${from}↔${to} (${edges} edges)` }],
    provenance: { generated_by: 'citation-gaps.json bridges', data_versions: [sha8(JSON.stringify(bridge))] },
  };
}

// 假设类型 3: 跨域新兴主题（两站都有共同关键词但都没引用）
function genEmergingTopicHyp(pair, tags, seq) {
  const { from, to } = pair;
  const shared = sharedTags(from, to, tags);
  if (shared.length === 0) return null;
  const id = makeHypId(seq);
  const stmtEn = `The shared topic(s) "${shared.join('", "')}" appear in both ${from} and ${to} corpora but with no cross-citations, suggesting an emerging interdisciplinary frontier not yet formally acknowledged.`;
  const stmtZh = `共同主题 "${shared.join('", "')}" 同时出现在 ${from} 和 ${to} 语料中但无交叉引用，提示存在未被正式承认的新兴跨学科前沿。`;
  return {
    id,
    statement: stmtEn,
    statement_zh: stmtZh,
    hypothesis_type: 'emerging_topic',
    confidence: Math.min(0.3 + shared.length * 0.12, 0.7),
    confidence_calibration: 'statistical-signal',
    evidence_status: 'hypothesis_only',
    falsifiability: {
      falsification_condition: `If the shared topics "${shared.join('", "')}" appear only as peripheral keywords (< 1% entity coverage in each site) rather than central themes, this is not an emerging frontier but tagging noise.`,
      falsification_test: `1. For each site, count entities where each shared topic is in primary tags vs. secondary tags\n2. If < 1% of site's entities have topic in primary tags, falsified.`,
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
    status: 'new',
    generated_at: today.toISOString(),
    generator: { tool: GENERATOR_NAME, version: SCHEMA_VERSION },
    history: [{ ts: today.toISOString(), event: 'created', actor: 'hypothesis-generator-v1', note: `Emerging topic hypothesis` }],
    provenance: { generated_by: 'shared tag analysis', data_versions: [sha8(JSON.stringify({ from, to, shared }))] },
  };
}

// ============== CLI ==============

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { maxHyps: 100, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max') opts.maxHyps = parseInt(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
  }
  return opts;
}

function run() {
  const opts = parseArgs();
  const gapsPath = path.join(ROOT, 'data', 'citation-gaps.json');
  if (!fs.existsSync(gapsPath)) {
    console.error(`✗ Not found: ${gapsPath}`);
    process.exit(1);
  }
  const gaps = JSON.parse(fs.readFileSync(gapsPath, 'utf-8'));
  const tags = loadSiteTags();
  const hypotheses = [];
  let seq = 1;

  console.log(`▸ citation-gaps: ${gaps.stats.gapPairs} gapPairs, ${gaps.bridges.length} bridges`);
  console.log(`▸ site tags loaded: ${Object.keys(tags).length} sites (fallback covers 30)`);

  // 1) LBD 缺口连接（Top 40 缺口对）
  console.log(`\n[1/3] LBD gap connections...`);
  const lbdCount = Math.min(opts.maxHyps, gaps.gapPairs.length);
  for (let i = 0; i < lbdCount; i++) {
    const h = genLbdGapHyp(gaps.gapPairs[i], tags, seq++);
    if (h) hypotheses.push(h);
    if (hypotheses.length >= opts.maxHyps) break;
  }
  console.log(`  → ${hypotheses.length} hypotheses`);

  // 2) 稀疏桥（边数 < 500）
  if (hypotheses.length < opts.maxHyps) {
    console.log(`\n[2/3] Sparse bridge hypotheses...`);
    const sparse = gaps.bridges.filter(b => b.edges < 500).sort((a, b) => a.edges - b.edges);
    for (const b of sparse) {
      if (hypotheses.length >= opts.maxHyps) break;
      const h = genSparseBridgeHyp(b, tags, seq++);
      if (h) hypotheses.push(h);
    }
    console.log(`  → total ${hypotheses.length}`);
  }

  // 3) 新兴主题（Top 20 缺口对再算一次）
  if (hypotheses.length < opts.maxHyps) {
    console.log(`\n[3/3] Emerging topic hypotheses...`);
    for (let i = 0; i < Math.min(20, gaps.gapPairs.length) && hypotheses.length < opts.maxHyps; i++) {
      const h = genEmergingTopicHyp(gaps.gapPairs[i], tags, seq++);
      if (h) hypotheses.push(h);
    }
    console.log(`  → total ${hypotheses.length}`);
  }

  // 汇总
  const byType = {};
  const byStatus = {};
  for (const h of hypotheses) {
    byType[h.hypothesis_type] = (byType[h.hypothesis_type] || 0) + 1;
    byStatus[h.evidence_status] = (byStatus[h.evidence_status] || 0) + 1;
  }
  const avgConf = hypotheses.length ? hypotheses.reduce((s, h) => s + h.confidence, 0) / hypotheses.length : 0;

  const output = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: today.toISOString(),
    generator: { tool: GENERATOR_NAME, version: SCHEMA_VERSION },
    sourceData: {
      citationGapsVersion: gaps.version,
      citationGapsBuiltAt: gaps.builtAt,
      stats: gaps.stats,
    },
    stats: {
      total: hypotheses.length,
      byType,
      byEvidenceStatus: byStatus,
      avgConfidence: Math.round(avgConf * 1000) / 1000,
    },
    hypothesisCards: hypotheses,
  };

  const outDir = opts.out || path.join(ROOT, 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'hypothesis-cards.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✓ output: ${outPath}`);
  console.log(`✓ total: ${output.stats.total} hypotheses`);
  console.log(`  by type: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`  avg confidence: ${output.stats.avgConfidence}`);
  return output;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try { run(); } catch (e) { console.error('✗', e); process.exit(1); }
}
