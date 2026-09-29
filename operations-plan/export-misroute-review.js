#!/usr/bin/env node
/**
 * export-misroute-review.js — 错路由人工复核清单
 *
 * 为什么需要这个脚本
 *   pipeline-label-program.js 只把错路由写进报告的 byTag / bySite 聚合 + 50 条 sample。
 *   88,889 条错路由是「站点标签被摘要信号否决」的判断，需要人过一遍才能决定是否重路由。
 *   本脚本产出可操作的清单：每条带**否决理由**（命中的正交簇证据标签）与**应去哪里**
 *   （labelModel 的 top 提案），按证据强度排序取前 N 条。
 *
 * 排序键（strength）—— 注意：不是「跨簇越多越可疑」
 *   第一版我用「正交簇数优先」排序，结果 top500 全部是跨 ≥3 簇的实体。这是错的：
 *   摘要覆盖 3 个以上学科簇的实体，恰好是**跨学科论文**，是最典型的误报，不是错路由。
 *   真正的错路由信号是**证据集中在一个特定的正交簇**——站点是量子计算，摘要从头
 *   到尾都在讲临床。所以改为按「主簇集中度」排序：
 *     concentration = 主簇证据标签数 / 全部正交证据标签数
 *     purity        = 1 / 正交簇数（只有 1 个正交簇时最高，簇数越多越可能是跨学科）
 *     focusScore    = 主簇标签数 × concentration
 *     strength      = round(focusScore × 100 × purity + topConfidence × 10)
 *   每条额外标记 kind：
 *     cross-domain  — 只有 1 个正交簇，最可能是真错路由
 *     cross-cutting — ≥3 个正交簇，最可能是跨学科论文（误报高发区）
 *     mixed         — 2 个正交簇
 *
 * 与 pipeline 的关系
 *   复用 lib/labeling-functions.mjs 的标定 + labelModel，不改其逻辑。
 *   标定约 89s（与 pipeline 第三遍同量级），是一次性离线脚本。
 *
 * 用法
 *   node operations-plan/export-misroute-review.js                  # 前 500 条
 *   node operations-plan/export-misroute-review.js --limit=2000     # 更多
 *   node operations-plan/export-misroute-review.js --sites=agritech,quantum-computing
 *   node operations-plan/export-misroute-review.js --threshold=0.35
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPORTS = path.join(ROOT, 'reports');

// ============================================================
// CLI 参数（与 pipeline-label-program.js 保持同一套命名）
// ============================================================
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const LIMIT = Number(arg('limit', '500'));
const THRESHOLD = Number(arg('threshold', '0.35'));
const MAX_TAGS = Number(arg('max-tags', '8'));
const CALIB_CAP = Number(arg('sample', '30000'));
const SITE_FILTER = (arg('sites', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const MD_PREVIEW = 60;

// ============================================================
// 站点发现（与 pipeline 一致）
// ============================================================
function discoverSites() {
  return fs.readdirSync(ROOT)
    .filter(d => {
      try { return fs.statSync(path.join(ROOT, d)).isDirectory(); } catch { return false; }
    })
    .filter(d => fs.existsSync(path.join(ROOT, d, 'website', 'api', 'entities.json')))
    .filter(d => !SITE_FILTER.length || SITE_FILTER.includes(d))
    .sort();
}

const loadEntities = site => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, site, 'website', 'api', 'entities.json'), 'utf8'));
  return Array.isArray(j) ? j : (j.entities || j.data || []);
};

const tagsOf = e => e.tags || e.topics || e.keywords || [];
const textOf = (e, k) => {
  const v = e[k];
  return Array.isArray(v) ? v.join(' ') : (v == null ? null : String(v));
};
const normTag = t => String(t).toLowerCase().trim().replace(/\s+/g, ' ');
const abbr = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

// ============================================================
// 主流程
// ============================================================
async function main() {
  const startedAt = Date.now();
  const sites = discoverSites();
  console.log(`[MisrouteReview] 站点 ${sites.length}，阈值 ${THRESHOLD}，清单上限 ${LIMIT}`);

  const toUrl = p => require('url').pathToFileURL(p).href;
  const lib = await import(toUrl(path.join(__dirname, 'lib', 'labeling-functions.mjs')));
  const {
    LABELING_FUNCTIONS, labelPriors, calibrateLfs,
    estimateLfCorrelation, lfWeights, labelModel,
    lfMisrouteDetector, lfAbstractKeywords, clusterOf, SITE_DOMAIN,
  } = lib;

  // ---- 第一遍：扫描，分校验集 ----
  const allEntities = [];
  const calibrationPool = [];
  for (const site of sites) {
    const ents = loadEntities(site);
    for (const e of ents) {
      e.__site = site;
      allEntities.push(e);
      if (tagsOf(e).length && calibrationPool.length < CALIB_CAP) calibrationPool.push(e);
    }
  }
  console.log(`[MisrouteReview] 实体 ${allEntities.length}，已标注 ${calibrationPool.length}`);

  // ---- 标定 LF（与 pipeline 第二遍相同） ----
  const tCal = Date.now();
  const calib = calibrateLfs(LABELING_FUNCTIONS, calibrationPool);
  const corr = estimateLfCorrelation(LABELING_FUNCTIONS, allEntities, 4000);
  const weights = lfWeights(LABELING_FUNCTIONS, calib, corr);
  const priors = labelPriors(calibrationPool);
  const calibMs = Date.now() - tCal;
  console.log(`[MisrouteReview] 标定完成（${calibMs}ms）`);

  // ---- 第三遍：逐实体判错路由 + 收集证据 ----
  const tRun = Date.now();
  const rows = [];
  let judged = 0, withEvidence = 0;

  for (const e of allEntities) {
    const site = e.__site;
    const siteTags = site && SITE_DOMAIN[site];
    if (!siteTags) continue;

    const a = textOf(e, 'abstract') || textOf(e, 'summary');
    if (!a || a.length < 40) continue;

    // 摘要侧证据：复用 LF-04 的命中结果，拿到「命中了哪些标签、各属哪簇」
    const abst = lfAbstractKeywords.run(e);
    if (abst.size < 2) continue;
    judged++;

    const vr = lfMisrouteDetector.run(e);
    if (!vr.size) continue;

    const evidence = [];
    for (const [tag, vote] of abst) {
      if (vote <= 0) continue;
      evidence.push({ tag, cluster: clusterOf(tag) });
    }
    const evidenceClusters = [...new Set(evidence.map(x => x.cluster))];

    for (const [rejectedTag, vote] of vr) {
      if (vote > 0) continue;
      const ownCluster = clusterOf(rejectedTag);
      // 只保留「跨簇」证据——同簇标签不构成否决理由
      const ortho = evidence.filter(x => x.cluster !== ownCluster);
      if (!ortho.length) continue;
      withEvidence++;

      const r = labelModel(e, LABELING_FUNCTIONS, weights, THRESHOLD, MAX_TAGS, priors);
      const prop = r.labels.slice(0, 3).map(l => ({ tag: l.tag, confidence: +l.confidence.toFixed(3) }));
      const topConf = prop.length ? prop[0].confidence : 0;
      const clusters = new Set(ortho.map(x => x.cluster));

      // 主簇 = 正交证据里最集中的簇。集中度越高、正交簇越少 → 越像真错路由。
      const perCluster = {};
      for (const x of ortho) perCluster[x.cluster] = (perCluster[x.cluster] || 0) + 1;
      let topCluster = null, topClusterTags = 0;
      for (const [c, n] of Object.entries(perCluster)) if (n > topClusterTags) { topClusterTags = n; topCluster = c; }
      const concentration = +(topClusterTags / ortho.length).toFixed(3);
      const purity = +(1 / clusters.size).toFixed(3);
      const focusScore = +(topClusterTags * concentration).toFixed(3);
      const kind = clusters.size === 1 ? 'cross-domain' : (clusters.size >= 3 ? 'cross-cutting' : 'mixed');

      rows.push({
        id: e.id,
        site,
        title: abbr(e.name || e.title || e.publicationTitle || '', 160),
        abstract: abbr(a, 240),
        rejectedTag,
        siteCluster: ownCluster,
        kind,
        topCluster,
        topClusterTags,
        concentration,
        purity,
        focusScore,
        evidenceTags: ortho.map(x => `${x.tag} [${x.cluster}]`),
        evidenceClusters: [...clusters],
        orthogonalClusters: clusters.size,
        orthogonalTags: ortho.length,
        proposal: prop,
        strength: Math.round(focusScore * 100 * purity + topConf * 10),
        source: abbr(e.source || '', 60),
        url: e.sourceUrl || e.url || e.doiUrl || null,
      });
    }
  }
  const runMs = Date.now() - tRun;
  console.log(`[MisrouteReview] 扫描 ${judged} 条有摘要实体，${withEvidence} 条产生跨簇否决`);

  // ---- 排序取前 N ----
  rows.sort((x, y) => y.strength - x.strength
    || (y.concentration - x.concentration)
    || (y.topClusterTags - x.topClusterTags));
  const top = rows.slice(0, LIMIT).map((r, i) => ({ rank: i + 1, ...r }));

  // ---- 汇总 ----
  const bySite = {};
  const byCluster = {};
  const byRejected = {};
  const byKind = {};
  const kindCountsPool = {};
  const byTargetCluster = {};
  const kindCounts = {};
  for (const r of top) {
    bySite[r.site] = (bySite[r.site] || 0) + 1;
    byRejected[r.rejectedTag] = (byRejected[r.rejectedTag] || 0) + 1;
    for (const c of r.evidenceClusters) byCluster[c] = (byCluster[c] || 0) + 1;
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    kindCounts[r.kind] = (kindCounts[r.kind] || 0) + 1;
    if (r.topCluster) byTargetCluster[r.topCluster] = (byTargetCluster[r.topCluster] || 0) + 1;
  }
  // 全量候选池的 kind 分布（比 top N 更能说明误报占比）
  for (const r of rows) kindCountsPool[r.kind] = (kindCountsPool[r.kind] || 0) + 1;
  const sortDesc = o => Object.entries(o).sort((a, b) => b[1] - a[1]);

  const report = {
    generatedAt: new Date().toISOString(),
    source: 'operations-plan/export-misroute-review.js',
    params: { limit: LIMIT, threshold: THRESHOLD, maxTags: MAX_TAGS, calibCap: CALIB_CAP, sites: SITE_FILTER.length ? SITE_FILTER : 'all' },
    pipeline: {
      entities: allEntities.length,
      labeledCalibSet: calibrationPool.length,
      scannedWithAbstract: judged,
      crossClusterRejections: withEvidence,
      totalRowsBeforeCut: rows.length,
      elapsedMs: { calibrate: calibMs, run: runMs, total: Date.now() - startedAt },
    },
    ranking: 'strength = round(主簇标签数×集中度×纯度×100 + topConfidence×10)；纯度=1/正交簇数',
    kindLegend: {
      'cross-domain': '只有 1 个正交簇——最可能是真错路由',
      'mixed': '2 个正交簇',
      'cross-cutting': '≥3 个正交簇——最可能是跨学科论文（误报高发区）',
    },
    summary: {
      byKind: sortDesc(byKind).map(([kind, count]) => ({ kind, count })),
      byKindWholePool: sortDesc(kindCountsPool).map(([kind, count]) => ({ kind, count, share: +(count / rows.length * 100).toFixed(1) })),
      byTargetCluster: sortDesc(byTargetCluster).slice(0, 20).map(([cluster, count]) => ({ cluster, count })),
      bySite: sortDesc(bySite).map(([site, count]) => ({ site, count })),
      byRejectedTag: sortDesc(byRejected).slice(0, 20).map(([tag, count]) => ({ tag, count })),
      byEvidenceCluster: sortDesc(byCluster).map(([cluster, count]) => ({ cluster, count })),
    },
    items: top,
  };

  fs.mkdirSync(REPORTS, { recursive: true });
  const jsonPath = path.join(REPORTS, `misroute-review-top${top.length}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  const mdPath = path.join(REPORTS, `misroute-review-top${top.length}.md`);
  fs.writeFileSync(mdPath, renderMd(report), 'utf8');

  console.log(`[MisrouteReview] 总错路由候选 ${rows.length}，导出前 ${top.length}`);
  console.log(`[MisrouteReview] → ${path.relative(ROOT, jsonPath)} (${(fs.statSync(jsonPath).size / 1024).toFixed(1)} KB)`);
  console.log(`[MisrouteReview] → ${path.relative(ROOT, mdPath)}`);
  console.log(`[MisrouteReview] 耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log('');
  console.log('候选池的三类分布（估误报率）：');
  for (const [k, n] of sortDesc(kindCountsPool)) console.log(`  ${k.padEnd(14)} ${String(n).padStart(6)}  (${(n / rows.length * 100).toFixed(1)}%)`);
  console.log('');
  console.log('本次导出的证据主簇（Top 8）：');
  for (const [c, n] of sortDesc(byTargetCluster).slice(0, 8)) console.log(`  ${c.padEnd(8)} ${n}`);
}

// ============================================================
// Markdown 渲染
// ============================================================
function renderMd(r) {
  const L = [];
  L.push(`# 错路由人工复核清单（前 ${r.items.length} 条）`);
  L.push('');
  L.push(`生成时间：${r.generatedAt}`);
  L.push(`来源：\`${r.source}\`（参数：limit=${r.params.limit}, threshold=${r.params.threshold}）`);
  L.push('');
  L.push('## 这个清单是什么');
  L.push('');
  L.push('每条是「实体的**站点标签**被其**摘要**里的正交学科簇证据否决」的候选。');
  L.push('否决不是猜测——`lf_misroute_detector` 要求摘要至少命中 2 个标签、且这些标签的学科簇与站点标签不同。');
  L.push('');
  L.push('**排序键**：`strength = round(主簇标签数 × 集中度 × 纯度 × 100 + topConfidence×10)`。');
  L.push('集中度 = 主簇证据标签数 / 全部正交证据标签数；纯度 = 1 / 正交簇数。');
  L.push('**证据越集中在单一簇越靠前**——「站点是量子计算但摘要从头到尾在讲临床」才是错路由。');
  L.push('摘要横跨 3 个以上学科簇的实体排在靠后，因为那更像跨学科论文（误报高发区）。');
  L.push('');
  L.push('### 三种类型的含义');
  L.push('');
  for (const [k, v] of Object.entries(r.kindLegend)) L.push(`- **\`${k}\`** — ${v}`);
  L.push('');
  L.push('## 怎么用它');
  L.push('');
  L.push('1. 从上往下过。看 `title` 与 `abstract`，判断摘要里的学科簇是不是真的不属于当前站点。');
  L.push('2. 如果是 → 记为**真错路由**，看 `proposal` 里的 top 提案决定重路由目标站点。');
  L.push('3. 如果否（跨学科论文、方法论通用论文）→ 记为**误报**，无需动作。');
  L.push('4. 抽样验证精确率后，再决定是否批量重路由。**在此之前不要动 entities.json。**');
  L.push('');
  L.push('## 汇总统计');
  L.push('');
  L.push(`- 语料实体：${r.pipeline.entities.toLocaleString()}`);
  L.push(`- 有摘要可判：${r.pipeline.scannedWithAbstract.toLocaleString()}，产生跨簇否决：${r.pipeline.crossClusterRejections.toLocaleString()}`);
  L.push(`- 候选池 ${r.pipeline.totalRowsBeforeCut.toLocaleString()} 条，本次导出前 ${r.items.length} 条`);
  L.push('');
  L.push('### 候选池的三类分布（这是估误报率的关键）');
  L.push('');
  L.push('| 类型 | 条数 | 占比 |');
  L.push('|---|---|---|');
  for (const { kind, count, share } of r.summary.byKindWholePool) L.push(`| \`${kind}\` | ${count.toLocaleString()} | ${share}% |`);
  L.push('');
  L.push('### 本次导出的三类分布');
  L.push('');
  L.push('| 类型 | 条数 |');
  L.push('|---|---|');
  for (const { kind, count } of r.summary.byKind) L.push(`| \`${kind}\` | ${count} |`);
  L.push('');
  L.push('### 证据主簇分布（「应该去哪个学科」）');
  L.push('');
  L.push('| 主簇 | 条数 |');
  L.push('|---|---|');
  for (const { cluster, count } of r.summary.byTargetCluster) L.push(`| \`${cluster}\` | ${count} |`);
  L.push('');
  L.push('### 按被否决的站点标签（Top 20）');
  L.push('');
  L.push('| 被否决标签 | 条数 |');
  L.push('|---|---|');
  for (const { tag, count } of r.summary.byRejectedTag) L.push(`| \`${tag}\` | ${count} |`);
  L.push('');
  L.push('### 按站点');
  L.push('');
  L.push('| 站点 | 条数 |');
  L.push('|---|---|');
  for (const { site, count } of r.summary.bySite) L.push(`| \`${site}\` | ${count} |`);
  L.push('');
  L.push(`## 明细（前 ${Math.min(MD_PREVIEW, r.items.length)} 条）`);
  L.push('');
  for (const it of r.items.slice(0, MD_PREVIEW)) {
    L.push(`### #${it.rank} \`${it.site}\` \`${it.kind}\` — ${it.title || '(无标题)'}`);
    L.push('');
    L.push(`- **否决**：站点标签 \`${it.rejectedTag}\`（簇 \`${it.siteCluster}\`）`);
    L.push(`- **证据**：主簇 \`${it.topCluster}\`，${it.topClusterTags}/${it.orthogonalTags} 个正交标签（集中度 ${it.concentration}，正交簇 ${it.orthogonalClusters} 个）`);
    L.push(`- **证据标签**：${it.evidenceTags.slice(0, 8).join('、')}${it.evidenceTags.length > 8 ? ' …' : ''}`);
    L.push(`- **提案**：${it.proposal.map(p => `${p.tag} (${p.confidence})`).join('、') || '(弃权)'}`);
    if (it.source) L.push(`- **来源**：${it.source}`);
    if (it.url) L.push(`- **链接**：${it.url}`);
    if (it.abstract) L.push(`- **摘要**：${it.abstract}`);
    L.push('');
    L.push('- [ ] 真错路由 → 应重路由到：`________________`');
    L.push('- [ ] 误报（跨学科 / 方法通用），无需动作');
    L.push('');
  }
  if (r.items.length > MD_PREVIEW) {
    L.push(`> 余 ${r.items.length - MD_PREVIEW} 条见 \`misroute-review-top${r.items.length}.json\``);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('**注意**：这份清单是待复核的**提案**，不是结论。');
  L.push('`cross-cutting` 类型大多是误报——跨学科论文天然命中多个簇，站点路由未必错了。');
  L.push('真正值得动作的是 `cross-domain` 类型：证据完全集中在一个与站点无关的学科。');
  L.push('抽样验证精确率之后再考虑批量动作。');
  return L.join('\n');
}

main().catch(err => {
  console.error('[MisrouteReview] FATAL:', err);
  process.exit(1);
});
