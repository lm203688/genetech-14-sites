#!/usr/bin/env node
/**
 * 从**真实引用声明**重建跨站引用边：pipeline-citation-edges-refs.js
 *
 * 背景（2026-10-04 修的漏存）
 *   pipeline-academic-datasets.js 原先只把 referenceCount（一个数字）存进产物，
 *   引用列表数组本身被丢掉。于是 /v1/citation/edges 只能靠
 *   pipeline-openalex-citation.js --stride=13 的抽样重抓来喂 —— 25,635 条边，
 *   方向还是抽样推断出来的，不是论文实际声明的。
 *   本脚本读的是**已经抓回来的真实 references[]**：1,139 篇论文声明的 59,623 条
 *   被引 DOI（说明见 state/academic-refs-cache.json 那次 --rebuild-references）。
 *
 * 边语义（与 pipeline-citation-gaps.js 保持一致）
 *   [ doiA, doiB, siteA, siteB ] = siteA 的某篇论文**引用了** siteB 的一篇论文。
 *   方向必须可信：方向反了，「谁在给谁供养分」这个卖点就是错的。

 * 与旧边合并不覆盖
 *   pipeline-openalex-citation.js（stride 抽样）的 25,635 条边是另一种覆盖
 *   （源论文更多、方向是抽样推断的），本脚本的 1,139 篇论文是另一种（方向真实）。
 *   两者互补，去重后合并，任何一条都不会丢。
 *
 * fail-loud：引用边 0 条时退出 3，不写一个「全零矩阵」出去糊弄下游。
 *
 * 用法：node operations-plan/pipeline-citation-edges-refs.js [--out=<file>] [--no-merge]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const ARGV = process.argv.slice(2);
const DRY = ARGV.includes('--dry-run');
const NO_MERGE = ARGV.includes('--no-merge');
// --with-inferred：把「按 concepts 推断归属到站」的被引文档也算进边。
// 推断边**单独成数组**（edgesInferred），绝不并进 edges ——
// 那是两种可信度完全不同的东西：edges 是「被引文档确实是某个站的实体」，
// edgesInferred 是「被引文档不是任何站实体，靠概念匹配推给了一个站」。
// 混在一起 = 把低精度结论当事实分发，而我们对外卖的第一结论恰恰是「缺口」。
const WITH_INFERRED = ARGV.includes('--with-inferred');
const INFERRED_CONF =
  (ARGV.find((a) => typeof a === 'string' && a.startsWith('--inferred-confidence=')) || '')
    .slice('--inferred-confidence='.length) || 'high';
const OUT = path.join(
  DATA_DIR,
  (ARGV.find((a) => a.startsWith('--out=')) || '').slice(6) || 'citation-edges.json'
);

const normDoi = (v) => {
  if (v == null) return '';
  let s = String(v).trim();
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '').replace(/\s+/g, '').toLowerCase();
  return s;
};

// ---- DOI → 站点集合（全库映射，用于把被引 DOI 归到站）----
// overlayPath：可选。data/library-expand.json 里的 fills 本身就带「DOI → 该选哪个站」
// 的归属（打分+margin 选出来的），它可以当**覆盖层**直接喂进映射表 ——
// 这样产出的边和「真把 905 条写进 30 个站点实体文件」完全一致，
// 但不用推 487MB 的实体 blob。真扩库（--write）随时可以再做，边不会因此漂移
// —— 因为覆盖层归属和写盘归属是同一份打分算出来的。
function buildDoiSiteMap(overlayPath) {
  const map = new Map();
  const siteDirs = fs
    .readdirSync(ROOT)
    .filter((d) => {
      try { return fs.statSync(path.join(ROOT, d)).isDirectory(); } catch { return false; }
    })
    .filter((d) => fs.existsSync(path.join(ROOT, d, 'website/api/entities.json')));
  let scanned = 0;
  for (const site of siteDirs) {
    let wrap;
    try { wrap = JSON.parse(fs.readFileSync(path.join(ROOT, site, 'website/api/entities.json'), 'utf8')); } catch { continue; }
    const list = Array.isArray(wrap) ? wrap : (wrap.entities || []);
    scanned += list.length;
    for (const e of list) {
      const d = normDoi(e && e.doi);
      if (!d) continue;
      if (!map.has(d)) map.set(d, new Set());
      map.get(d).add(site);
    }
  }

  let overlay = 0, overlaySkipped = 0;
  if (overlayPath && fs.existsSync(overlayPath)) {
    let ov = {};
    try { ov = JSON.parse(fs.readFileSync(overlayPath, 'utf8')); } catch { ov = {}; }
    for (const [site, list] of Object.entries(ov.fills || {})) {
      if (!siteDirs.includes(site) || !Array.isArray(list)) continue;
      for (const t of list) {
        const d = normDoi(t && t.doi);
        if (!d) continue;
        if (!map.has(d)) map.set(d, new Set());
        const set = map.get(d);
        // 原生表已经把这条 DOI 归给本站 → 覆盖层不必再加，加了只会重复计同一条边
        if (set.has(site)) { overlaySkipped++; continue; }
        set.add(site);
        overlay++;
      }
    }
    console.log(`  覆盖层（${path.basename(overlayPath)} 填充清单）：+${overlay} 条 DOI→站 归属${overlaySkipped ? `，${overlaySkipped} 条与原生表重复已跳过` : ''}`);
  }
  return { map, siteDirs, scanned, overlay };
}

(async () => {
  const t0 = Date.now();
  const ovArg = ARGV.find((a) => typeof a === 'string' && a.startsWith('--lib-expand='));
  const OVERLAY = ovArg ? ovArg.slice('--lib-expand='.length) : path.join(DATA_DIR, 'library-expand.json');
  const { map: doiSite, siteDirs, scanned, overlay } = buildDoiSiteMap(OVERLAY);
  console.log(`DOI→站映射：${siteDirs.length} 站 / 扫 ${scanned} 实体 / 去重后 ${doiSite.size} 个 DOI`);

  // ---- 推断归属表（仅在 --with-inferred 时启用）----
  const inferredDoiSite = new Map();
  let inferredRows = 0, inferredAssigned = 0;
  if (WITH_INFERRED) {
    const p = path.join(DATA_DIR, 'cited-site-assign.json');
    if (!fs.existsSync(p)) {
      console.error('[GATE] 指定了 --with-inferred 但缺 data/cited-site-assign.json —— 先跑 pipeline-cited-site-assign.js --write');
      process.exit(3);
    }
    let doc = {};
    try { doc = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { doc = {}; }
    const list = Array.isArray(doc.assignments) ? doc.assignments : [];
    inferredRows = list.length;
    for (const a of list) {
      if (!a || !a.doi || !a.site) continue;
      if (a.confidence && a.confidence !== INFERRED_CONF) continue;
      const d = normDoi(a.doi);
      // 只在原生表里**查不到**时才用推断 —— 原生归属是硬事实，不能被推断顶掉
      if (!d || doiSite.has(d)) continue;
      inferredDoiSite.set(d, a.site);
      inferredAssigned++;
    }
    console.log(`推断归属：候选 ${inferredRows} 条，取 ${INFERRED_CONF} 置信且原生表查不到的 ${inferredAssigned} 个 DOI`);
  }

  const academicPath = path.join(DATA_DIR, 'academic-entities.json');
  if (!fs.existsSync(academicPath)) {
    console.error('[GATE] 缺 data/academic-entities.json，没有引用声明可展开');
    process.exit(3);
  }
  const wrap = JSON.parse(fs.readFileSync(academicPath, 'utf8'));
  const records = Array.isArray(wrap) ? wrap : (wrap.entities || []);
  const withRefs = records.filter((e) => Array.isArray(e.references) && e.references.length);
  if (!withRefs.length) {
    console.error('[GATE] academic-entities.json 里没有任何 references[]。没有引用边可建，拒绝产出空边集。');
    process.exit(3);
  }
  console.log(`引用声明源：${records.length} 条记录，其中 ${withRefs.length} 条带 references[]`);

  // ---- 展开边 ----
  const edgeMap = new Map();
  let srcLinks = 0;   // 源→被引 的声明总数（能归到站的）
  let unresolved = 0; // 被引 DOI 不在本站库里（正常，学术库只收录一部分）
  let selfSite = 0;   // 同站自引
  const inferredEdgeMap = new Map();
  let inferredLinks = 0;
  for (const e of withRefs) {
    const siteFrom = (e.sites && e.sites[0]) || null;
    if (!siteFrom || !e.doi) continue;
    for (const refDoi of e.references) {
      const d = normDoi(refDoi);
      if (!d) continue;
      let targets = doiSite.get(d);
      let byInferred = false;
      if (!targets && WITH_INFERRED) {
        const s = inferredDoiSite.get(d);
        if (s) { targets = new Set([s]); byInferred = true; }
      }
      if (!targets) { unresolved++; continue; }
      for (const siteTo of targets) {
        if (siteTo === siteFrom) { selfSite++; continue; }
        if (byInferred) {
          inferredLinks++;
          inferredEdgeMap.set(`${normDoi(e.doi)}|${d}|${siteFrom}|${siteTo}`, [normDoi(e.doi), d, siteFrom, siteTo]);
          continue;
        }
        srcLinks++;
        edgeMap.set(`${normDoi(e.doi)}|${d}|${siteFrom}|${siteTo}`, [normDoi(e.doi), d, siteFrom, siteTo]);
      }
    }
  }
  if (inferredEdgeMap.size) {
    console.log(`  其中 ${inferredEdgeMap.size} 条边来自**推断归属**（原生表查不到、靠 concepts 推的站）—— 单独放在 edgesInferred，不进 edges`);
  }

  // ---- 与旧边合并（不覆盖）----
  let mergedFrom = 0;
  if (!NO_MERGE && fs.existsSync(OUT)) {
    let old = [];
    try { const o = JSON.parse(fs.readFileSync(OUT, 'utf8')); old = Array.isArray(o) ? o : (o.edges || []); } catch { old = []; }
    for (const edge of old) {
      if (!Array.isArray(edge) || edge.length < 4) continue;
      const [a, b, sa, sb] = edge;
      const key = `${normDoi(a)}|${normDoi(b)}|${sa}|${sb}`;
      if (!edgeMap.has(key)) { edgeMap.set(key, [normDoi(a), normDoi(b), sa, sb]); mergedFrom++; }
    }
  }

  const allEdges = Array.from(edgeMap.values());
  if (!allEdges.length) {
    console.error('[GATE] 展开后引用边 0 条 —— 不写一个空边文件出去。');
    process.exit(3);
  }

  // 排序键必须显式比较，否则 Map 插入序受上游遍历顺序影响，同一份输入两天跑出两份文件
  allEdges.sort((x, y) => (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : x[3] < y[3] ? -1 : x[3] > y[3] ? 1 : x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));

  if (DRY) {
    console.log(`[dry-run] 将写入 ${path.relative(ROOT, OUT)}：边 ${allEdges.length} 条（新展开 ${srcLinks}，合并旧边 ${mergedFrom}）`);
    return;
  }

  const allInferred = Array.from(inferredEdgeMap.values())
    .sort((x, y) => (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : x[3] < y[3] ? -1 : x[3] > y[3] ? 1 : x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));

  const payload = {
    generatedAt: new Date().toISOString(),
    scope: 'cross-site citation edges (references[] expanded from academic-entities.json)',
    stats: {
      sourceRecords: records.length,
      withReferences: withRefs.length,
      declarations: withRefs.reduce((s, e) => s + e.references.length, 0),
      resolvedEdges: srcLinks,
      unresolvedRefDoi: unresolved,
      selfSiteEdgesSkipped: selfSite,
      mergedFromOldEdges: mergedFrom,
      totalEdges: allEdges.length,
      sites: new Set(allEdges.flatMap((e) => [e[2], e[3]])).size,
      // 推断通道：单独计数，互不影响
      inferredEnabled: WITH_INFERRED,
      inferredConfidence: WITH_INFERRED ? INFERRED_CONF : null,
      inferredResolvedEdges: inferredLinks,
      inferredTotalEdges: allInferred.length,
      inferredShare: Number(((100 * allInferred.length) / Math.max(1, allEdges.length + allInferred.length)).toFixed(1)),
    },
    edgeFormat: '[doiFrom, doiTo, siteFrom, siteTo]  siteFrom 的论文引用了 siteTo 的论文',
    // ⚠️ edges 与 edgesInferred 是两种可信度完全不同的东西，下游不要混用：
    //   edges         = 被引文档确实是某个站的实体（硬事实）
    //   edgesInferred = 被引文档不是任何站实体，由 concept 匹配推给了某一站（推断，精度未审计到可用水平前只当候选）
    edges: allEdges,
    edgesInferred: allInferred,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload), 'utf-8');
  console.log(
    `\n[citation-edges] 边 ${allEdges.length} 条（新展开 ${srcLinks} / 合并旧边 ${mergedFrom} / 库内未命中 ${unresolved} / 同站自引跳过 ${selfSite}）` +
    ` · 涉及 ${payload.stats.sites} 站 · ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
})().catch((e) => {
  console.error('[FATAL]', e && e.message ? e.message : e);
  process.exit(1);
});
