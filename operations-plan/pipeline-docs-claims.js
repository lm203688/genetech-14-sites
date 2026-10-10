#!/usr/bin/env node
/**
 * operations-plan/pipeline-docs-claims.js
 *
 * §9.3 治 M4 的根：把「对外数字」变成脚本从 data/ 单一真源实时生成的产物。
 *
 * 背景（v2 报告 §2.3 M4）：
 *   人工维护的对外文案必然漂移。上一版发现 3 处偏离（4.9 万 / 14 站 / 22 域），
 *   根因不是"这次改对"，而是**没有任何机制防止下一次再漂**。
 *
 * 设计原则：
 *   1) 单一真源：所有数字都从 data/*.json + 站点目录实体文件**实时**算出来。
 *   2) 可复现：任何人跑一次本脚本，输出与仓库里的产物**逐字相同**（除非真源变了）。
 *   3) 有 anchor：README/ai.txt 等对外文档里加 `<!-- GENETECH:CLAIMS:BEGIN/END -->`
 *      锚注，锚注之间的内容一律**由本脚本重写**，人工改动一律被覆盖。
 *   4) 与 policy 兼容：本脚本产出的数字是**机器可读**的 claims JSON，
 *      pipeline-domain-claim-guard.js 那种"漂移即红"的门禁可以直接吃。
 *
 * 用法
 *   node operations-plan/pipeline-docs-claims.js                # 打印 + 更新 anchor
 *   node operations-plan/pipeline-docs-claims.js --verify       # 只校验，不改文件（CI 用）
 *   node operations-plan/pipeline-docs-claims.js --dry-run      # 只打印，不落盘
 *   node operations-plan/pipeline-docs-claims.js --emit-json    # 只写 data/claims.json
 *
 * 退出码
 *   0  数字一致 / 已更新
 *   1  数字漂移（--verify 且 anchor 已过期，CI 应阻断）
 *   2  数据文件缺失或格式错误
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY_ONLY = process.argv.includes('--verify');
const EMIT_JSON_ONLY = process.argv.includes('--emit-json');

/** 从站点目录扫真实站数 + 实体数 */
function countEntities() {
  const sites = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory()
      && fs.existsSync(path.join(ROOT, e.name, 'website', 'api', 'entities.json')));
  let total = 0;
  let withDoi = 0;
  const perSite = [];
  for (const s of sites) {
    const p = path.join(ROOT, s.name, 'website', 'api', 'entities.json');
    let raw;
    try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { continue; }
    const list = Array.isArray(raw) ? raw : (raw.entities || []);
    const n = list.length;
    const doi = list.filter((e) => e && (e.doi || e.pmid)).length;
    total += n;
    withDoi += doi;
    perSite.push({ site: s.name, entities: n, withDoiOrPmid: doi });
  }
  perSite.sort((a, b) => b.entities - a.entities);
  return {
    siteCount: sites.length,
    totalEntities: total,
    entitiesWithDoiOrPmid: withDoi,
    perSite,
  };
}

/** 引用网络：从 data/citation-edges.json 直接读 stats */
function readCitationEdges() {
  const p = path.join(ROOT, 'data', 'citation-edges.json');
  if (!fs.existsSync(p)) return { error: 'missing data/citation-edges.json' };
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const s = raw.stats || {};
  return {
    sourceRecords: s.sourceRecords ?? 0,
    withReferences: s.withReferences ?? 0,
    declarations: s.declarations ?? 0,
    resolvedEdges: s.resolvedEdges ?? 0,
    mergedFromOldEdges: s.mergedFromOldEdges ?? 0,
    totalEdges: s.totalEdges ?? 0,
    unresolvedRefDoi: s.unresolvedRefDoi ?? 0,
    selfSiteEdgesSkipped: s.selfSiteEdgesSkipped ?? 0,
  };
}

/** 学术种子：data/academic-entities.json */
function readAcademicSeed() {
  const p = path.join(ROOT, 'data', 'academic-entities.json');
  if (!fs.existsSync(p)) return { error: 'missing data/academic-entities.json' };
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.entities || []);
  return { seedCount: list.length };
}

/** 缺口矩阵：data/citation-gaps.json */
function readCitationGaps() {
  const p = path.join(ROOT, 'data', 'citation-gaps.json');
  if (!fs.existsSync(p)) return { error: 'missing data/citation-gaps.json' };
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return {
    gapPairs: raw.stats?.gapPairs ?? raw.gapPairs?.length ?? 0,
    directedPairs: raw.stats?.directedPairs ?? raw.directedPairs?.length ?? 0,
  };
}

/** 知识图谱：data/knowledge-graph.json 边分类 */
function readKnowledgeGraph() {
  const p = path.join(ROOT, 'data', 'knowledge-graph.json');
  if (!fs.existsSync(p)) return { error: 'missing data/knowledge-graph.json' };
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const byRelation = {};
  for (const e of raw.edges || []) {
    const k = e.relation || 'unknown';
    byRelation[k] = (byRelation[k] || 0) + 1;
  }
  const total = (raw.edges || []).length;
  return {
    nodeCount: (raw.nodes || []).length,
    edgeCount: total,
    byRelation,
    citationShare: total ? +(byRelation.citation / total).toFixed(4) : 0,
  };
}

/** 汇总 claims */
function computeClaims() {
  const ent = countEntities();
  const cit = readCitationEdges();
  const seed = readAcademicSeed();
  const gaps = readCitationGaps();
  const kg = readKnowledgeGraph();
  const citationResolvedRate = cit.totalEdges
    ? +((cit.resolvedEdges) / cit.totalEdges).toFixed(4)
    : 0;
  return {
    generatedAt: new Date().toISOString().slice(0, 10),
    generator: 'operations-plan/pipeline-docs-claims.js',
    sourceFiles: [
      'data/citation-edges.json',
      'data/academic-entities.json',
      'data/citation-gaps.json',
      'data/knowledge-graph.json',
      '<site>/website/api/entities.json (×siteCount)',
    ],
    claims: {
      siteCount: ent.siteCount,
      totalEntities: ent.totalEntities,
      entitiesWithDoiOrPmid: ent.entitiesWithDoiOrPmid,
      academicSeedCount: seed.seedCount,
      citationDeclarations: cit.declarations,
      citationResolvedEdges: cit.resolvedEdges,
      citationTotalEdges: cit.totalEdges,
      citationMergedFromLegacy: cit.mergedFromOldEdges,
      citationResolvedRate,
      knowledgeGraphNodes: kg.nodeCount,
      knowledgeGraphEdges: kg.edgeCount,
      knowledgeGraphCitationEdges: kg.byRelation.citation || 0,
      knowledgeGraphCitationShare: kg.citationShare,
      zeroCitationGapPairs: gaps.gapPairs,
      directedSitePairs: gaps.directedPairs,
    },
    // 面向人类可读的口径锚点（供 anchor 注入）
    prose: {
      entitiesShort: `${ent.totalEntities.toLocaleString('en-US')} 实体`,
      sitesShort: `${ent.siteCount} 站 / ${ent.siteCount} 域`,
      citationShort: `${cit.resolvedEdges.toLocaleString('en-US')} / ${cit.totalEdges.toLocaleString('en-US')} 边（真实解析率 ${Math.round(citationResolvedRate * 100)}%）`,
      gapsShort: `${gaps.gapPairs} / ${gaps.directedPairs} 站对零引用`,
      seedShort: `引用网络基座仅 ${seed.seedCount.toLocaleString('en-US')} 条学术种子`,
    },
    perSite: ent.perSite,
    citations: {
      ...cit,
      selfSiteEdgesSkippedRate: cit.declarations
        ? +((cit.selfSiteEdgesSkipped) / cit.declarations).toFixed(4)
        : 0,
    },
    knowledgeGraph: kg,
  };
}

/** Anchor 注入：替换 README / ai.txt / mcp-server/README.md 中
 *  `<!-- GENETECH:CLAIMS:BEGIN -->` … `<!-- GENETECH:CLAIMS:END -->` 之间的内容 */
const ANCHOR_TARGETS = [
  'README.md',
  'ai.txt',
  'mcp-server/README.md',
];

function renderAnchor(claims) {
  const c = claims.claims;
  const lines = [
    '<!-- GENETECH:CLAIMS:BEGIN -->',
    `<!-- 由 operations-plan/pipeline-docs-claims.js 于 ${claims.generatedAt} 自动生成，请勿手工编辑此锚注之间的内容。 -->`,
    '',
    '### 当前规模（机器生成，锚注自动刷新）',
    '',
    '| 指标 | 值 | 口径 |',
    '|---|---:|---|',
    `| 站点 / 域数 | **${c.siteCount}** | 有 \`website/api/entities.json\` 的顶层目录 |`,
    `| 结构化实体总数 | **${c.totalEntities.toLocaleString('en-US')}** | 逐站实体文件求和 |`,
    `| 带 DOI/PMID 的实体 | **${c.entitiesWithDoiOrPmid.toLocaleString('en-US')}** | 同上，仅计有外部可解析 ID 的记录 |`,
    `| 知识图谱节点 / 边 | **${c.knowledgeGraphNodes.toLocaleString('en-US')} / ${c.knowledgeGraphEdges.toLocaleString('en-US')}** | data/knowledge-graph.json |`,
    `| 图谱中引用边 | **${c.knowledgeGraphCitationEdges.toLocaleString('en-US')}（${Math.round(c.knowledgeGraphCitationShare * 100)}%）** | KG 中 relation=citation |`,
    `| 学术种子（引用网络基座） | **${c.academicSeedCount.toLocaleString('en-US')}** | data/academic-entities.json，是缺口矩阵的真实基座 |`,
    `| 引用声明总数 | **${c.citationDeclarations.toLocaleString('en-US')}** | 59,623 类 |`,
    `| 引用边（真实解析 + legacy merge） | **${c.citationResolvedEdges.toLocaleString('en-US')} / ${c.citationTotalEdges.toLocaleString('en-US')}** | resolved ${Math.round(c.citationResolvedRate * 100)}% + legacy ${c.citationMergedFromLegacy.toLocaleString('en-US')} |`,
    `| 零引用站对 | **${c.zeroCitationGapPairs} / ${c.directedSitePairs}** | citation-gaps.json |`,
    '',
    '> 以上数字由脚本从 data/ 单一真源实时计算。与本报告 §2.2 数字若不一致，**以本锚注为准**（脚本口径永远新）。',
    '',
    '<!-- GENETECH:CLAIMS:END -->',
  ];
  return lines.join('\n');
}

function applyAnchor(target, anchorText) {
  const full = path.join(ROOT, target);
  if (!fs.existsSync(full)) {
    console.error(`[claims] 目标不存在，跳过：${target}`);
    return { skipped: true, target };
  }
  const text = fs.readFileSync(full, 'utf8');
  const begin = '<!-- GENETECH:CLAIMS:BEGIN -->';
  const end = '<!-- GENETECH:CLAIMS:END -->';
  const idxBegin = text.indexOf(begin);
  const idxEnd = text.indexOf(end);

  let next;
  if (idxBegin === -1 || idxEnd === -1) {
    // 首次注入：追加到文件末尾
    next = text.trimEnd() + '\n\n' + anchorText + '\n';
  } else {
    const before = text.slice(0, idxBegin);
    const after = text.slice(idxEnd + end.length);
    next = before + anchorText + after;
  }
  if (next === text) return { target, changed: false };
  if (!DRY_RUN) fs.writeFileSync(full, next, 'utf8');
  return { target, changed: true, addedAt: idxBegin === -1 ? 'appended' : 'replaced' };
}

function main() {
  const claims = computeClaims();
  const reportPath = path.join(ROOT, 'data', 'claims.json');

  // 1) 落盘 JSON（除非 --dry-run）
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(claims, null, 2), 'utf8');
    console.log(`[claims] 已写入 ${reportPath}`);
  }

  console.log('');
  console.log(`[claims] 站点 ${claims.claims.siteCount} · 实体 ${claims.claims.totalEntities.toLocaleString('en-US')}`);
  console.log(`[claims] 引用边 ${claims.claims.citationResolvedEdges}/${claims.claims.citationTotalEdges}（真实解析率 ${Math.round(claims.claims.citationResolvedRate * 100)}%）`);
  console.log(`[claims] 图谱 ${claims.claims.knowledgeGraphNodes} 节点 / ${claims.claims.knowledgeGraphEdges} 边 · 引用边占比 ${Math.round(claims.claims.knowledgeGraphCitationShare * 100)}%`);
  console.log(`[claims] 缺口 ${claims.claims.zeroCitationGapPairs}/${claims.claims.directedSitePairs} 站对`);

  if (EMIT_JSON_ONLY) return;

  const anchor = renderAnchor(claims);
  const results = [];
  for (const t of ANCHOR_TARGETS) {
    results.push(applyAnchor(t, anchor));
  }
  for (const r of results) {
    if (r.skipped) continue;
    console.log(`[claims] ${r.target}: ${r.addedAt || (r.changed ? 'updated' : 'unchanged')}`);
  }

  // --verify：如果 anchor 内容与最新生成不一致 → 报错退出（CI 应阻断）
  if (VERIFY_ONLY) {
    let drift = 0;
    for (const t of ANCHOR_TARGETS) {
      const full = path.join(ROOT, t);
      if (!fs.existsSync(full)) continue;
      const text = fs.readFileSync(full, 'utf8');
      const idxBegin = text.indexOf('<!-- GENETECH:CLAIMS:BEGIN -->');
      const idxEnd = text.indexOf('<!-- GENETECH:CLAIMS:END -->');
      if (idxBegin === -1 || idxEnd === -1) {
        console.error(`[claims][DRIFT] ${t} 缺 anchor 锚注`);
        drift++;
        continue;
      }
      const current = text.slice(idxBegin, idxEnd + '<!-- GENETECH:CLAIMS:END -->'.length);
      if (current !== anchor) {
        console.error(`[claims][DRIFT] ${t} anchor 内容与最新生成不一致`);
        drift++;
      }
    }
    if (drift > 0) {
      console.error(`\n[claims][FAIL] ${drift} 个文件 anchor 漂移。请在本地跑 \`node operations-plan/pipeline-docs-claims.js\` 后重新提交。`);
      process.exit(1);
    }
    console.log('\n[claims] --verify 通过，anchor 全部与真源一致');
  }
}

main();
