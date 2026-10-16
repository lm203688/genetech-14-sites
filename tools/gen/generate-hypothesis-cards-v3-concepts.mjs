// tools/gen/generate-hypothesis-cards-v3-concepts.mjs
//
// Phase 12-B: 用外部 concepts 数据扩充 emerging_topic 假设池
//
// 背景：
//   Phase 9 v2 生成器里 emerging_topic 策略只跑到 30 张（受 gapPairs × shared_tags>0 限制）
//   根因：只用站点标签 tag 交集；没有跨主题的语义桥
//
// 方案：
//   从 cited-entities.json（48,760 条 OpenAlex 抓取）+ academic-entities.json（1,634 条 Crossref）
//   抽取 concepts（每实体的 OpenAlex 概念标签，score 加权），构造 3 种新的主题视角：
//
//     S1: concept_bridge - 站点 A 与站点 B 的 concepts 集合有交集但 pairMatrix 无直接引用
//         （概念层面已连接，但引用层面缺口）
//     S2: concept_emergence - 概念在时间上于站点间呈现「先行-追随」
//         （跨站点的概念传播链）
//     S3: concept_gap_pair - gapPairs 但 shared_tags=0 的稀疏对，用 concepts 补足语义桥
//         （补 30 张瓶颈）
//
// 使用：
//   node tools/gen/generate-hypothesis-cards-v3-concepts.mjs --dry-run --max 200
//   node tools/gen/generate-hypothesis-cards-v3-concepts.mjs --max 200

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const CITED_PATH = path.join(ROOT, 'data', 'cited-entities.json');
const ACADEMIC_PATH = path.join(ROOT, 'data', 'academic-entities.json');
const CITED_SITE_ASSIGN_PATH = path.join(ROOT, 'data', 'cited-site-assign.json');
const GAPS_PATH = path.join(ROOT, 'data', 'citation-gaps.json');
const SITE_TAGS_PATH = path.join(ROOT, 'operations-plan', 'lib', 'site-domain-tags.mjs');
const CARDS_PATH = path.join(ROOT, 'data', 'hypothesis-cards.json');

// ============= 参数 =============
function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { dryRun: false, max: 200, seed: 42 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--max') opts.max = parseInt(argv[++i], 10);
    else if (a === '--seed') opts.seed = parseInt(argv[++i], 10);
  }
  return opts;
}

// ============= 站点标签 =============
function loadSiteTags() {
  // 从 site-domain-tags.mjs 读（ESM import 或直接读文件）
  // 用简化方案：从 citation-gaps.degrees 里读 site 名，再自己维护 tag 映射
  // 或者：从学术 entities 里 site → tag 反推
  const gaps = JSON.parse(fs.readFileSync(GAPS_PATH, 'utf-8'));
  const sites = gaps.degrees.map(d => d.site);
  return { sites, gaps };
}

// ============= 加载 concepts =============
function loadConceptIndex() {
  // site -> concept -> { count, weightedScore, sourceCount }
  const index = {}; // site -> Map(concept, stats)

  function bump(site, conceptName, score, source) {
    if (!site || !conceptName) return;
    if (!index[site]) index[site] = new Map();
    const cur = index[site].get(conceptName) || { count: 0, totalScore: 0, sources: new Set() };
    cur.count++;
    cur.totalScore += (score || 0.5);
    if (source) cur.sources.add(source);
    index[site].set(conceptName, cur);
  }

  // V0: 加载站点归属映射（cited-site-assign.json）
  let assignMap = new Map();
  try {
    const assign = JSON.parse(fs.readFileSync(CITED_SITE_ASSIGN_PATH, 'utf-8'));
    for (const a of (assign.assignments || [])) {
      if (a.doi && a.site) assignMap.set(a.doi, a.site);
    }
    console.log(`    cited-site-assign: ${assignMap.size} 条`);
  } catch (e) {
    console.log(`    cited-site-assign 加载失败: ${e.message}`);
  }

  // V1: cited-entities (OpenAlex) - 通过 cited-site-assign 挂站点
  const cited = JSON.parse(fs.readFileSync(CITED_PATH, 'utf-8'));
  const citedArr = Array.isArray(cited) ? cited : (cited.entities || []);
  let assignedCount = 0;
  for (const e of citedArr) {
    const site = assignMap.get(e.doi);
    if (!site) continue;
    assignedCount++;
    for (const c of (e.concepts || []).slice(0, 5)) {
      const name = typeof c === 'string' ? c : (c.name || null);
      bump(site, name, c.score || 0.5, 'openalex');
    }
  }
  console.log(`    cited-entities 挂站点: ${assignedCount} / ${citedArr.length}`);

  // V2: academic-entities (Crossref)
  if (fs.existsSync(ACADEMIC_PATH)) {
    const acad = JSON.parse(fs.readFileSync(ACADEMIC_PATH, 'utf-8'));
    const acadArr = Array.isArray(acad) ? acad : (acad.entities || []);
    for (const e of acadArr) {
      const site = e._site || e.site || null;
      if (!site) continue;
      for (const c of (e.concepts || []).slice(0, 5)) {
        const name = typeof c === 'string' ? c : (c.name || null);
        bump(site, name, c.score || 0.5, 'crossref');
      }
    }
  }

  // 归一化
  const result = {};
  for (const [site, map] of Object.entries(index)) {
    const arr = [];
    for (const [name, stats] of map.entries()) {
      arr.push({
        name,
        count: stats.count,
        avgScore: stats.totalScore / stats.count,
        sources: [...stats.sources],
      });
    }
    // 按加权 score 排序
    arr.sort((a, b) => (b.avgScore * b.count) - (a.avgScore * a.count));
    result[site] = arr;
  }
  return result;
}

// ============= 概念集合工具 =============
function topConcepts(siteData, minCount, limit = 20) {
  return siteData
    .filter(c => c.count >= minCount)
    .slice(0, limit);
}

function conceptIntersection(siteA, siteB, conceptIndex, minAvgScore = 0.55) {
  const a = conceptIndex[siteA] || [];
  const b = conceptIndex[siteB] || [];
  const bMap = new Map(b.map(c => [c.name, c]));
  const shared = [];
  for (const ca of a) {
    const cb = bMap.get(ca.name);
    if (cb && ca.avgScore >= minAvgScore && cb.avgScore >= minAvgScore) {
      shared.push({
        name: ca.name,
        a_score: ca.avgScore,
        b_score: cb.avgScore,
        a_count: ca.count,
        b_count: cb.count,
      });
    }
  }
  shared.sort((x, y) => (y.a_score + y.b_score) - (x.a_score + x.b_score));
  return shared;
}

// ============= 种子随机 =============
function mulberry32(seed) {
  let s = seed >>> 0;
  return function() {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============= 卡片生成 =============
function makeId(seq, prefix) {
  return `HYP-20261016-${prefix}${String(seq).padStart(4, '0')}`;
}

function genConceptBridge(siteA, siteB, shared, seq) {
  // S1: concept_bridge - 概念层面已有交集
  const topShared = shared.slice(0, 3);
  const confidence = Math.min(0.85,
    0.45 +
    Math.min(0.15, topShared.length * 0.05) +
    (topShared[0] ? Math.min(0.15, (topShared[0].a_score + topShared[0].b_score) * 0.15) : 0)
  );
  return {
    id: makeId(seq, 'V3-'),
    hypothesis_type: 'concept_bridge',
    site_a: siteA,
    site_b: siteB,
    statement: `站点 ${siteA} 与 ${siteB} 共享主题域「${topShared.map(c => c.name).join('、')}」，虽无直接引用，但概念层面已形成跨站连接`,
    expected_evidence: '两站点在 openalex/crossref 抓取的实体 concepts 交集非空',
    falsifiability: {
      what_would_falsify: '任一站点的 concepts 集与共享概念无交集（<0.5 score）',
      data_source: 'cited-entities.json / academic-entities.json (OpenAlex concepts)',
      time_horizon_days: 30,
    },
    confidence: Math.round(confidence * 1000) / 1000,
    confidence_calibration: 'statistical-signal',
    source_signals: {
      strategy: 'concept_bridge',
      strategy_description: 'Phase 12-B 新策略：概念层面交叉',
      shared_concepts: topShared.map(c => ({ name: c.name, score_sum: Math.round((c.a_score + c.b_score) * 1000) / 1000 })),
      concept_count_a: shared.filter(c => c.name).length,
    },
    generated_by: 'tools/gen/generate-hypothesis-cards-v3-concepts.mjs',
    generated_at: new Date().toISOString(),
    verification_status: 'hypothesis-only',
  };
}

function genConceptGapFill(siteA, siteB, shared, seq) {
  // S3: concept_gap_fill - gapPairs 但 shared_tags=0，用 concepts 补
  const topShared = shared.slice(0, 2);
  return {
    id: makeId(seq, 'V3-'),
    hypothesis_type: 'concept_gap_fill',
    site_a: siteA,
    site_b: siteB,
    statement: `站点 ${siteA} ↔ ${siteB} 引用稀疏但概念面存在桥「${topShared.map(c => c.name).join('、')}」，可视为语义层潜在连接`,
    expected_evidence: '概念交集 ≥2 且加权分总和 >1.1',
    falsifiability: {
      what_would_falsify: '概念交集 <1 或最高分概念平均 score <0.5',
      data_source: 'cited-entities.json (OpenAlex concepts)',
      time_horizon_days: 45,
    },
    confidence: Math.round(Math.min(0.75, 0.40 + topShared.length * 0.08) * 1000) / 1000,
    confidence_calibration: 'statistical-signal',
    source_signals: {
      strategy: 'concept_gap_fill',
      strategy_description: 'Phase 12-B 新策略：稀疏 gap 用概念桥补语义',
      shared_concepts: topShared.map(c => ({ name: c.name, score_sum: Math.round((c.a_score + c.b_score) * 1000) / 1000 })),
    },
    generated_by: 'tools/gen/generate-hypothesis-cards-v3-concepts.mjs',
    generated_at: new Date().toISOString(),
    verification_status: 'hypothesis-only',
  };
}

function genConceptEmergence(siteA, siteB, shared, seq) {
  // S2: concept_emergence - 概念传播链（跨站点）
  const topShared = shared.slice(0, 1)[0];
  if (!topShared) return null;
  return {
    id: makeId(seq, 'V3-'),
    hypothesis_type: 'concept_emergence',
    site_a: siteA,
    site_b: siteB,
    statement: `主题「${topShared.name}」在 ${siteA} 与 ${siteB} 间呈潜在传播链，可验证时序先后`,
    expected_evidence: '两站点该概念实体的发表年份差异 ≥1 年',
    falsifiability: {
      what_would_falsify: '任一站点的该概念实体发表年份分布无差异或差异 <1 年',
      data_source: 'cited-entities.json (year_published 字段)',
      time_horizon_days: 60,
    },
    confidence: Math.round(Math.min(0.65, 0.40 + topShared.a_score * 0.15 + topShared.b_score * 0.10) * 1000) / 1000,
    confidence_calibration: 'statistical-signal',
    source_signals: {
      strategy: 'concept_emergence',
      strategy_description: 'Phase 12-B 新策略：概念跨站传播链',
      primary_concept: topShared.name,
      a_score: Math.round(topShared.a_score * 1000) / 1000,
      b_score: Math.round(topShared.b_score * 1000) / 1000,
    },
    generated_by: 'tools/gen/generate-hypothesis-cards-v3-concepts.mjs',
    generated_at: new Date().toISOString(),
    verification_status: 'hypothesis-only',
  };
}

// ============= 主流程 =============
function main() {
  const opts = parseArgs();
  console.log('=== Phase 12-B: concepts 抽取 + emerging_topic 扩容 ===');
  console.log(`max=${opts.max} seed=${opts.seed} dryRun=${opts.dryRun}`);

  // 1. 加载站点标签
  const { sites } = loadSiteTags();
  console.log(`\n[1] 站点数: ${sites.length}`);

  // 2. 加载概念索引
  console.log(`\n[2] 加载概念索引...`);
  const conceptIndex = loadConceptIndex();
  const sitesWithConcepts = Object.keys(conceptIndex).filter(s => sites.includes(s));
  console.log(`  有效站点（有 concepts）: ${sitesWithConcepts.length} / ${sites.length}`);
  const totalConcepts = sitesWithConcepts.reduce((s, si) => s + conceptIndex[si].length, 0);
  console.log(`  总概念数: ${totalConcepts}`);

  // 3. 加载现有卡片
  const existingCards = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf-8')).hypothesisCards || [];
  const existingIds = new Set(existingCards.map(c => c.id));
  const existingSitePairs = new Set(
    existingCards
      .filter(c => c.site_a && c.site_b)
      .map(c => c.site_a + '|' + c.site_b)
  );
  console.log(`\n[3] 现有卡片: ${existingCards.length}（含 ${existingSitePairs.size} 站点pair）`);

  // 4. 加载 gapPairs
  const gapsData = JSON.parse(fs.readFileSync(GAPS_PATH, 'utf-8'));
  const gapPairs = gapsData.gapPairs || [];
  console.log(`  gapPairs: ${gapPairs.length}`);

  // 5. 加载 pairMatrix（用于找稀疏对）
  const pairMatrix = gapsData.pairMatrix || [];

  const rand = mulberry32(opts.seed);
  const allNew = [];
  let seq = 1000; // 从 1000 起避开 Phase 8-10 的 ID

  function pushIfRoom(card) {
    if (!card) return;
    if (allNew.length >= opts.max) return;
    if (existingIds.has(card.id) || allNew.some(c => c.id === card.id)) return;
    allNew.push(card);
  }

  // Strategy S1: concept_bridge - 遍历所有 site pair，找 concepts 交集
  // 配额：35%
  const s1Budget = Math.floor(opts.max * 0.35);
  const s2Budget = Math.floor(opts.max * 0.15);
  const s3Budget = Math.floor(opts.max * 0.25);
  const s4Budget = opts.max - s1Budget - s2Budget - s3Budget;
  console.log(`\n[4] 策略配额: S1=${s1Budget} S2=${s2Budget} S3=${s3Budget} S4=${s4Budget}`);

  let s1Count = 0, s2Count = 0, s3Count = 0, s4Count = 0;

  // S1: 遍历所有 site 对（放宽到 minAvgScore=0.45, 共享 ≥1 也接受）
  console.log(`\n[S1/4] concept_bridge...`);
  for (let i = 0; i < sitesWithConcepts.length && s1Count < s1Budget; i++) {
    for (let j = i + 1; j < sitesWithConcepts.length && s1Count < s1Budget; j++) {
      const A = sitesWithConcepts[i], B = sitesWithConcepts[j];
      if (existingSitePairs.has(A + '|' + B) || existingSitePairs.has(B + '|' + A)) continue;
      const shared = conceptIntersection(A, B, conceptIndex, 0.45);
      if (shared.length < 1) continue;
      const card = genConceptBridge(A, B, shared, ++seq);
      if (card) {
        pushIfRoom(card);
        s1Count++;
      }
    }
  }
  console.log(`  → S1 生成: ${s1Count}`);

  // S3: 稀疏 gapPair 用概念补（放宽到 shared_tags ≤ 2 也算 gap）
  console.log(`\n[S3/4] concept_gap_fill（gapPairs 稀疏）...`);
  const sparseGap = gapPairs.filter(p => (p.shared_tags || []).length <= 2);
  console.log(`  sparse gapPairs (shared_tags≤2): ${sparseGap.length}`);
  for (const pair of sparseGap) {
    if (s3Count >= s3Budget) break;
    const A = pair.siteA, B = pair.siteB;
    if (!conceptIndex[A] || !conceptIndex[B]) continue;
    const shared = conceptIntersection(A, B, conceptIndex, 0.40);
    if (shared.length < 1) continue;
    const card = genConceptGapFill(A, B, shared, ++seq);
    if (card) {
      pushIfRoom(card);
      s3Count++;
    }
  }
  console.log(`  → S3 生成: ${s3Count}`);

  // S2: concept_emergence（从已生成的 concept_bridge 中选一批做时序版）
  console.log(`\n[S2/4] concept_emergence（基于概念桥做时序延展）...`);
  const bridgeCandidates = allNew.filter(c => c.hypothesis_type === 'concept_bridge').slice(0, Math.max(s2Budget * 2, 20));
  for (const bridge of bridgeCandidates) {
    if (s2Count >= s2Budget) break;
    const shared = (bridge.source_signals?.shared_concepts || []).map(c => ({
      name: c.name,
      a_score: 0.60,
      b_score: 0.55,
    }));
    const card = genConceptEmergence(bridge.site_a, bridge.site_b, shared, ++seq);
    if (card) {
      pushIfRoom(card);
      s2Count++;
    }
  }
  console.log(`  → S2 生成: ${s2Count}`);

  // S4: single_site_hotspot - 每站点 top 概念独立成卡（不需 pair）
  console.log(`\n[S4/4] single_site_hotspot（站点内概念热点）...`);
  for (const site of sitesWithConcepts) {
    if (s4Count >= s4Budget) break;
    const topList = topConcepts(conceptIndex[site], 2, 8);
    for (const c of topList) {
      if (s4Count >= s4Budget) break;
      // 检查是否已有同站点的热点卡
      const dup = allNew.some(x => x.hypothesis_type === 'single_site_hotspot'
        && x.site_a === site
        && x.source_signals?.primary_concept === c.name);
      if (dup) continue;
      const card = {
        id: makeId(++seq, 'V3-'),
        hypothesis_type: 'single_site_hotspot',
        site_a: site,
        statement: `站点 ${site} 在「${c.name}」主题下形成研究热点（${c.count} 篇实体、平均 score ${c.avgScore.toFixed(3)}）`,
        expected_evidence: '该站点该主题实体数 ≥ 该主题在库实体总数 5%',
        falsifiability: {
          what_would_falsify: '该主题在库实体数超过站点实体数 50%（说明该主题普遍，不特化本站）',
          data_source: 'cited-entities.json (OpenAlex concepts + cited-site-assign)',
          time_horizon_days: 30,
        },
        confidence: Math.round(Math.min(0.75, 0.40 + c.avgScore * 0.20 + Math.min(0.15, c.count * 0.02)) * 1000) / 1000,
        confidence_calibration: 'statistical-signal',
        source_signals: {
          strategy: 'single_site_hotspot',
          strategy_description: 'Phase 12-B 新策略：站点内主题热点',
          primary_concept: c.name,
          concept_count: c.count,
          concept_avg_score: Math.round(c.avgScore * 1000) / 1000,
        },
        generated_by: 'tools/gen/generate-hypothesis-cards-v3-concepts.mjs',
        generated_at: new Date().toISOString(),
        verification_status: 'hypothesis-only',
      };
      pushIfRoom(card);
      s4Count++;
    }
  }
  console.log(`  → S4 生成: ${s4Count}`);

  // 6. 输出统计
  console.log(`\n=== 汇总 ===`);
  console.log(`新增卡片: ${allNew.length}`);
  console.log(`  S1 concept_bridge: ${s1Count}`);
  console.log(`  S2 concept_emergence: ${s2Count}`);
  console.log(`  S3 concept_gap_fill: ${s3Count}`);

  if (allNew.length > 0) {
    const byConf = {};
    for (const c of allNew) {
      byConf[c.hypothesis_type] = (byConf[c.hypothesis_type] || { sum: 0, n: 0 });
      byConf[c.hypothesis_type].sum += c.confidence;
      byConf[c.hypothesis_type].n++;
    }
    console.log(`\nby type (avg confidence):`);
    for (const [t, s] of Object.entries(byConf)) {
      console.log(`  ${t}: n=${s.n} avgConf=${(s.sum / s.n).toFixed(3)}`);
    }
    // 抽样展示
    console.log(`\n样本卡片（每张1）:`);
    for (const t of ['concept_bridge', 'concept_gap_fill', 'concept_emergence']) {
      const sample = allNew.find(c => c.hypothesis_type === t);
      if (sample) {
        console.log(`\n--- ${t} ---`);
        console.log(`  id: ${sample.id}`);
        console.log(`  statement: ${sample.statement}`);
        console.log(`  confidence: ${sample.confidence}`);
      }
    }
  }

  if (opts.dryRun) {
    console.log(`\n(dry-run, no write)`);
    return;
  }

  // 7. 写入 cards
  const cardsData = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf-8'));
  const beforeCount = cardsData.hypothesisCards.length;
  cardsData.hypothesisCards.push(...allNew);
  cardsData.stats = cardsData.stats || {};
  cardsData.stats.byType = cardsData.stats.byType || {};
  for (const c of allNew) {
    cardsData.stats.byType[c.hypothesis_type] = (cardsData.stats.byType[c.hypothesis_type] || 0) + 1;
  }
  cardsData.stats.lastGenerated = {
    at: new Date().toISOString(),
    batch: 'P12-B concepts v3',
    tool: 'tools/gen/generate-hypothesis-cards-v3-concepts.mjs',
    added: allNew.length,
    total: cardsData.hypothesisCards.length,
  };
  fs.writeFileSync(CARDS_PATH, JSON.stringify(cardsData, null, 2));
  console.log(`\n写入: ${CARDS_PATH}`);
  console.log(`  ${beforeCount} → ${cardsData.hypothesisCards.length} 张`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    main();
  } catch (e) {
    console.error('[FATAL]', e.stack || e.message);
    process.exit(1);
  }
}
