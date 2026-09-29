#!/usr/bin/env node
/**
 * estimate-write-capacity.js — --write 容量核算
 *
 * 为什么要先算这个
 *   pipeline-label-program.js 的 --write 会把 tags/tagConfidence/tagSource 写进
 *   <site>/website/api/entities.json。CF Pages 上限 1014.7 MB，历史产物已到 ~99%。
 *   不核算就写回 = 下次 build 超限、整站下线。本脚本在**内存里**模拟写回，
 *   量出精确增量，不碰任何磁盘上的生产数据。
 *
 * 关键细节（算错就会得出错误结论）
 *   1. 源文件 entities.json 是 `JSON.stringify(ents, null, 1)`（缩进 1）。
 *      但 build-site.mjs 写入 _site 时是 `JSON.stringify(s.entities)` **无缩进**。
 *      决定 Pages 体积的是后者，所以本脚本一律按 minified 计算。
 *   2. 写回只补 `tagsOf(e).length === 0` 的实体（pipeline 第 232 行），
 *      已标注实体不动 → 增量与「无标签实体占比 × 每站标签密度」强相关。
 *   3. 每站单独报增量，不能只用平均值外推——各站标签填充率差异很大。
 *
 * 与 pipeline 的关系
 *   复用 lib/labeling-functions.mjs 的标定 + labelModel，与 pipeline 第三遍完全同参。
 *   一次标定两用（容量核算 + 可选错路由统计），标定约 89s。
 *
 * 用法
 *   node operations-plan/estimate-write-capacity.js
 *   node operations-plan/estimate-write-capacity.js --threshold=0.35
 *   node operations-plan/estimate-write-capacity.js --threshold=0.45   # 更保守，增量更小
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(ROOT, '_site');
const REPORTS = path.join(ROOT, 'reports');

// Pages 单站存储上限（历史实测 1014.7 MB 触顶）
const PAGES_LIMIT_MB = 1014.7;
// 安全水位：留 10% 余量给 sitemap / facets / citations.csl.json 等 build 副产物漂移
const SAFE_RATIO = 0.90;

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const THRESHOLD = Number(arg('threshold', '0.35'));
const MAX_TAGS = Number(arg('max-tags', '8'));
const CALIB_CAP = Number(arg('sample', '30000'));

const discoverSites = () => fs.readdirSync(ROOT)
  .filter(d => {
    try { return fs.statSync(path.join(ROOT, d)).isDirectory(); } catch { return false; }
  })
  .filter(d => fs.existsSync(path.join(ROOT, d, 'website', 'api', 'entities.json')))
  .sort();

const loadEntities = site => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, site, 'website', 'api', 'entities.json'), 'utf8'));
  return Array.isArray(j) ? j : (j.entities || j.data || []);
};

const tagsOf = e => e.tags || e.topics || e.keywords || [];
const textOf = (e, k) => {
  const v = e[k];
  return Array.isArray(v) ? v.join(' ') : (v == null ? null : String(v));
};

/** 递归统计一个目录的字节总量与文件数 */
function dirSize(dir) {
  let bytes = 0, files = 0;
  const walk = d => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else {
        try { bytes += fs.statSync(p).size; files++; } catch { /* 忽略偶发 */ }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { bytes, files };
}

async function main() {
  const startedAt = Date.now();
  const sites = discoverSites();
  console.log(`[Capacity] 站点 ${sites.length}，阈值 ${THRESHOLD}`);

  const toUrl = p => require('url').pathToFileURL(p).href;
  const {
    LABELING_FUNCTIONS, labelPriors, calibrateLfs,
    estimateLfCorrelation, lfWeights, labelModel,
  } = await import(toUrl(path.join(__dirname, 'lib', 'labeling-functions.mjs')));

  // ---- 第一遍：载入全部实体 + 标定集 ----
  const bySite = new Map();
  const allEntities = [];
  const calibrationPool = [];
  let loadedBytes = 0;
  for (const site of sites) {
    const raw = fs.readFileSync(path.join(ROOT, site, 'website', 'api', 'entities.json'), 'utf8');
    loadedBytes += Buffer.byteLength(raw, 'utf8');
    const ents = JSON.parse(raw);
    const list = Array.isArray(ents) ? ents : (ents.entities || ents.data || []);
    bySite.set(site, list);
    for (const e of list) {
      e.__site = site;
      allEntities.push(e);
      if (tagsOf(e).length && calibrationPool.length < CALIB_CAP) calibrationPool.push(e);
    }
  }
  console.log(`[Capacity] 载入 ${allEntities.length} 实体（源文件 ${(loadedBytes / 1048576).toFixed(1)} MB）`);

  // ---- 标定 ----
  const tCal = Date.now();
  const calib = calibrateLfs(LABELING_FUNCTIONS, calibrationPool);
  const corr = estimateLfCorrelation(LABELING_FUNCTIONS, allEntities, 4000);
  const weights = lfWeights(LABELING_FUNCTIONS, calib, corr);
  const priors = labelPriors(calibrationPool);
  const calibMs = Date.now() - tCal;

  // ---- 内存模拟写回：逐站量 minified 体积差 ----
  // 源文件是缩进 1 的格式，但 Pages 吃的是 build-site 的 minified 输出，
  // 所以 before/after 都按 JSON.stringify(x) 无缩进计量。
  const perSite = [];
  let filled = 0, abstained = 0, noProposal = 0;

  for (const site of sites) {
    const ents = bySite.get(site);
    const before = Buffer.byteLength(JSON.stringify(ents), 'utf8');

    let changed = 0;
    for (const e of ents) {
      if (tagsOf(e).length) continue;                 // pipeline 第 232 行：已标注跳过
      const r = labelModel(e, LABELING_FUNCTIONS, weights, THRESHOLD, MAX_TAGS, priors);
      if (r.abstained) { abstained++; continue; }
      if (!r.labels.length) { noProposal++; continue; }
      // 与 pipeline 第 235-237 行完全一致的字段
      e.tags = r.labels.map(l => l.tag);
      e.tagConfidence = r.labels.map(l => l.confidence);
      e.tagSource = 'label-program';
      changed++;
      filled++;
    }
    const after = Buffer.byteLength(JSON.stringify(ents), 'utf8');
    perSite.push({
      site,
      entities: ents.length,
      filledHere: changed,
      beforeMb: +(before / 1048576).toFixed(3),
      afterMb: +(after / 1048576).toFixed(3),
      deltaMb: +((after - before) / 1048576).toFixed(3),
      deltaPct: before ? +((after - before) / before * 100).toFixed(2) : 0,
    });
    // 关键：释放内存。after 已经算完，把注入字段删掉以免 487MB × 2 撑爆堆。
    for (const e of ents) { delete e.tags; delete e.tagConfidence; delete e.tagSource; delete e.__site; }
  }

  // ---- 汇总 ----
  const totalBefore = perSite.reduce((s, x) => s + x.beforeMb, 0);
  const totalAfter = perSite.reduce((s, x) => s + x.afterMb, 0);
  const delta = +(totalAfter - totalBefore).toFixed(3);
  const srcAll = dirSize(ROOT);
  const siteNow = dirSize(SITE_DIR);

  const nowMb = +(siteNow.bytes / 1048576).toFixed(2);
  const afterWriteMb = +(nowMb + delta).toFixed(2);
  const utilNow = +(nowMb / PAGES_LIMIT_MB * 100).toFixed(1);
  const utilAfter = +(afterWriteMb / PAGES_LIMIT_MB * 100).toFixed(1);
  const safeCeilMb = +(PAGES_LIMIT_MB * SAFE_RATIO).toFixed(1);
  const headroomMb = +(PAGES_LIMIT_MB - afterWriteMb).toFixed(2);
  const headroomSafeMb = +(safeCeilMb - afterWriteMb).toFixed(2);

  const verdict = afterWriteMb > PAGES_LIMIT_MB
    ? 'BLOCK 超过 Pages 硬上限，写回会导致构建失败/整站下线'
    : afterWriteMb > safeCeilMb
      ? `RISK 未超硬上限但已越过 ${SAFE_RATIO * 100}% 安全水位，建议先瘦身再写`
      : 'OK 有足够余量，可以写回';

  const result = {
    generatedAt: new Date().toISOString(),
    source: 'operations-plan/estimate-write-capacity.js',
    params: { threshold: THRESHOLD, maxTags: MAX_TAGS, calibCap: CALIB_CAP },
    assumptions: [
      '增量按 build-site 的 minified 输出（JSON.stringify 无缩进）计量，而非源文件的缩进格式',
      '写回只补无标签实体，已标注实体不动（pipeline 第 232 行）',
      '写入字段固定为 tags / tagConfidence / tagSource 三个（pipeline 第 235-237 行）',
      '假设 build 副产物（citations.csl.json / facets.json / HTML 页面）体积不变——新标签不会改变这些',
    ],
    limits: { pagesLimitMb: PAGES_LIMIT_MB, safeRatio: SAFE_RATIO, safeCeilingMb: safeCeilMb },
    current: {
      siteTotalMb: nowMb,
      siteFiles: siteNow.files,
      entitiesSourceTotalMb: +(loadedBytes / 1048576).toFixed(2),
      utilizationNow: `${utilNow}%`,
    },
    projection: {
      entitiesAfterMb: +totalAfter.toFixed(2),
      deltaMb: delta,
      deltaPct: +(delta / totalBefore * 100).toFixed(2),
      siteAfterMb: afterWriteMb,
      utilizationAfter: `${utilAfter}%`,
      headroomMb: headroomMb,
      headroomAboveSafeWaterMb: headroomSafeMb,
    },
    outcome: {
      filled: filled,
      abstained: abstained,
      noProposal: noProposal,
      entities: allEntities.length,
      fillRate: +(filled / allEntities.length * 100).toFixed(2),
    },
    verdict,
    elapsedMs: { calibrate: calibMs, total: Date.now() - startedAt },
    perSite: perSite.sort((a, b) => b.deltaMb - a.deltaMb),
  };

  fs.mkdirSync(REPORTS, { recursive: true });
  const p = path.join(REPORTS, 'write-capacity-2026-09-29.json');
  fs.writeFileSync(p, JSON.stringify(result, null, 2), 'utf8');

  console.log('');
  console.log('================ 容量核算 ================');
  console.log(`当前 _site          ${nowMb} MB   (${utilNow}% / ${PAGES_LIMIT_MB} MB)`);
  console.log(`写回后 _site 预估   ${afterWriteMb} MB   (${utilAfter}%)`);
  console.log(`增量                +${delta} MB  (+${result.projection.deltaPct}% of entities 部分)`);
  console.log(`距硬上限余量        ${headroomMb} MB`);
  console.log(`距 ${SAFE_RATIO * 100}% 安全水位余量  ${headroomSafeMb} MB`);
  console.log(`判定：${verdict}`);
  console.log('');
  console.log(`填充 ${filled} / 弃权 ${abstained} / 无提案 ${noProposal}（共 ${allEntities.length}）`);
  console.log('');
  console.log('增量最大的 8 站：');
  console.log('  站点'.padEnd(22) + '实体'.padStart(8) + '  填充'.padStart(7) + '  前MB'.padStart(10) + '  后MB'.padStart(10) + '  ΔMB'.padStart(9) + '  Δ%'.padStart(8));
  for (const x of perSite.slice(0, 8)) {
    console.log(
      x.site.slice(0, 20).padEnd(22) +
      String(x.entities).padStart(8) +
      String(x.filledHere).padStart(7) +
      x.beforeMb.toFixed(2).padStart(10) +
      x.afterMb.toFixed(2).padStart(10) +
      x.deltaMb.toFixed(2).padStart(9) +
      x.deltaPct.toFixed(2).padStart(8)
    );
  }
  console.log('');
  console.log(`→ ${path.relative(ROOT, p)}`);
  console.log(`[Capacity] 耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch(err => {
  console.error('[Capacity] FATAL:', err);
  process.exit(1);
});
