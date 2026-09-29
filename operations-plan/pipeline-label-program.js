#!/usr/bin/env node
/**
 * pipeline-label-program.js — 数据编程流水线（Snorkel Labeling Functions + LabelModel）
 *
 * 做什么
 *   对 30 站 entities.json 的全部实体跑一轮"规则投票 → 统计加权合并"的标签编程：
 *     1. 已标注实体（有 tags）构成校验集，标定每个 LF 的准确率（对应 Snorkel 的
 *        validation split——不是在没有 ground truth 的数据上盲估可靠性）
 *     2. 估计 LF 两两相关度，高度冗余的 LF 自动降权（LabelModel 的核心）
 *     3. 对全部实体产出置信度加权标签，低于阈值即弃权（宁可空着，不硬猜）
 *     4. 错路由检测：站点标签被摘要信号否决 → 产出人工复核清单
 *     5. 自适应字段解析统计：识别"字段名不统一导致的假缺失"
 *
 * 为什么不直接写回 entities.json
 *   CF Pages 存储已用 ~99.1%（1014MB 上限），再灌任何数据即超限、整站下线。
 *   因此本流水线默认只产出报告，写入动作必须显式 --write 且先做容量核算。
 *
 * 用法
 *   node pipeline-label-program.js                 # 只出报告（默认）
 *   node pipeline-label-program.js --sites=a,b     # 限定站点
 *   node pipeline-label-program.js --threshold=0.35 --sample=30000  # 调参与标定集上限
 *   node pipeline-label-program.js --write         # 显式写回（需先确认 Pages 容量）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const REPORTS = path.join(ROOT, 'reports');

// ============================================================
// CLI 参数
// ============================================================
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const WRITE = argv.includes('--write');
const THRESHOLD = Number(arg('threshold', '0.30'));
const MAX_TAGS = Number(arg('max-tags', '8'));
const CALIB_CAP = Number(arg('sample', '30000'));
const SITE_FILTER = (arg('sites', '') || '').split(',').map(s => s.trim()).filter(Boolean);

// ============================================================
// 站点发现
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

function loadEntities(site) {
  const f = path.join(ROOT, site, 'website', 'api', 'entities.json');
  const raw = fs.readFileSync(f, 'utf8');
  const j = JSON.parse(raw);
  return Array.isArray(j) ? j : (j.entities || j.data || []);
}

const tagsOf = e => e.tags || e.topics || e.keywords || [];

// ============================================================
// 主流程
// ============================================================
async function main() {
  const startedAt = Date.now();
  const sites = discoverSites();
  console.log(`[LabelProgram] 发现 ${sites.length} 个站点（阈值 ${THRESHOLD}，标定集上限 ${CALIB_CAP}）`);
  console.log(WRITE ? '[LabelProgram] ⚠️ --write 已启用，将修改 entities.json' : '[LabelProgram] dry-run：仅产出报告');

  // Windows 上绝对路径必须转成 file:// URL，否则 ESM loader 报 ERR_UNSUPPORTED_ESM_URL_SCHEME
  const toUrl = p => require('url').pathToFileURL(p).href;
  const {
    LABELING_FUNCTIONS, labelPriors, calibrateLfs,
    estimateLfCorrelation, lfWeights, labelModel,
  } = await import(toUrl(path.join(__dirname, 'lib', 'labeling-functions.mjs')));
  const { fieldFingerprint, driftReport } = await import(toUrl(path.join(__dirname, 'lib', 'adaptive-fields.mjs')));

  // ---- 第一遍：扫描全部实体，分出校验集与目标集 ----
  const allEntities = [];
  const calibrationPool = [];
  const perSiteScan = [];
  const allAbstracts = [];

  for (const site of sites) {
    const ents = loadEntities(site);
    for (const e of ents) {
      e.__site = site;
      allEntities.push(e);
      if (tagsOf(e).length) {
        if (calibrationPool.length < CALIB_CAP) calibrationPool.push(e);
      }
    }
    perSiteScan.push({ site, total: ents.length, withTags: ents.filter(e => tagsOf(e).length).length });
  }

  const unlabeled = allEntities.filter(e => !tagsOf(e).length);
  console.log(`[LabelProgram] 实体 ${allEntities.length}，已标注 ${calibrationPool.length}，待标注 ${unlabeled.length}`);

  // ---- 第二遍：标定 LF + 估计相关度 ----
  const tCal = Date.now();
  const calib = calibrateLfs(LABELING_FUNCTIONS, calibrationPool);
  const corrInfo = estimateLfCorrelation(LABELING_FUNCTIONS, allEntities, 4000);
  const weights = lfWeights(LABELING_FUNCTIONS, calib, corrInfo);
  const priors = labelPriors(calibrationPool);
  console.log(`[LabelProgram] 标定完成（${Date.now() - tCal}ms）：${LABELING_FUNCTIONS.length} 个 LF，${priors.size} 个标签先验`);

  // ---- 第三遍：标注 + 错路由检测 ----
  const tRun = Date.now();
  const proposals = new Map();
  const misroutes = [];
  let abstained = 0, filled = 0, totalLabels = 0, confSum = 0;
  const tagFreq = new Map();

  for (const e of allEntities) {
    const r = labelModel(e, LABELING_FUNCTIONS, weights, THRESHOLD, MAX_TAGS, priors);
    proposals.set(e.id, r.labels);
    if (r.abstained) { abstained++; continue; }
    filled++;
    for (const l of r.labels) {
      totalLabels++; confSum += l.confidence;
      tagFreq.set(l.tag, (tagFreq.get(l.tag) || 0) + 1);
    }
    // 错路由：站点 LF 被误路由检测器否决的标签
    const vr = LABELING_FUNCTIONS.find(f => f.id === 'lf_misroute_detector').run(e);
    for (const [tag, vote] of vr) {
      if (vote < 0) {
        misroutes.push({ id: e.id, site: e.__site, name: e.name || e.title, rejectedTag: tag });
      }
    }
  }
  console.log(`[LabelProgram] 标注完成（${Date.now() - tRun}ms）：filled=${filled} abstained=${abstained} 标签=${totalLabels} 错路由=${misroutes.length}`);

  // ---- 第四遍：自适应字段漂移统计（抽样，避免全量二次扫描） ----
  const driftSample = allEntities.filter((_, i) => i % 25 === 0);
  const abstractFp = fieldFingerprint(driftSample, 'abstract');
  const drift = driftReport(driftSample);

  // ---- 聚合报告 ----
  const report = {
    generatedAt: new Date().toISOString(),
    mode: WRITE ? 'write' : 'dry-run',
    threshold: THRESHOLD,
    maxTags: MAX_TAGS,
    engine: {
      lfs: LABELING_FUNCTIONS.length,
      calibrationSet: calibrationPool.length,
      calibrationMethod: '已标注子集上的 LF 命中率（Snorkel validation split）',
      correlationSamples: 4000,
    },
    corpus: {
      sites: sites.length,
      entities: allEntities.length,
      labeled: allEntities.length - unlabeled.length,
      unlabeled: unlabeled.length,
      unlabeledRate: +(unlabeled.length / allEntities.length).toFixed(4),
      perSite: perSiteScan.map(s => ({
        site: s.site, total: s.total, withTags: s.withTags,
        withTagsRate: +(s.withTags / s.total).toFixed(4),
      })),
    },
    labelProgram: {
      abstained,
      filled,
      abstainRate: +(abstained / allEntities.length).toFixed(4),
      totalLabels,
      avgConfidence: totalLabels ? +(confSum / totalLabels).toFixed(4) : 0,
      avgLabelsPerEntity: filled ? +(totalLabels / filled).toFixed(3) : 0,
      distinctTags: tagFreq.size,
      topTags: [...tagFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
        .map(([tag, count]) => ({ tag, count, share: +(count / allEntities.length).toFixed(4) })),
    },
    lfReport: weights.map(w => ({
      id: w.id, desc: w.desc,
      accuracy: +w.accuracy.toFixed(3),
      negReliability: +w.negReliability.toFixed(3),
      abstainRate: +w.abstainRate.toFixed(3),
      novelty: +w.novelty.toFixed(3),
      weight: +w.weight.toFixed(3),
    })).sort((a, b) => b.weight - a.weight),
    misroutes: {
      count: misroutes.length,
      byTag: (() => {
        const m = new Map();
        for (const x of misroutes) m.set(x.rejectedTag, (m.get(x.rejectedTag) || 0) + 1);
        return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => ({ tag: t, count: c }));
      })(),
      bySite: (() => {
        const m = new Map();
        for (const x of misroutes) m.set(x.site, (m.get(x.site) || 0) + 1);
        return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([s, c]) => ({ site: s, count: c }));
      })(),
      sample: misroutes.slice(0, 50),
    },
    adaptiveFields: {
      sampleSize: driftSample.length,
      abstract: {
        resolvedRate: abstractFp.resolvedRate,
        driftRate: abstractFp.driftRate,
        coverageLoss: abstractFp.coverageLoss,
        schemaDriftDetected: abstractFp.schemaDriftDetected,
        hitDistribution: abstractFp.hitDistribution.filter(h => h.hits > 0),
      },
      driftEvents: drift,
    },
    elapsedMs: Date.now() - startedAt,
    samples: [...proposals.entries()].slice(0, 50).map(([id, labels]) => ({ id, labels })),
  };

  // ---- 写出 ----
  fs.mkdirSync(REPORTS, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const reportPath = path.join(REPORTS, 'label-program-2026-09-29.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`[LabelProgram] 报告 → ${path.relative(ROOT, reportPath)}`);

  if (WRITE) {
    // 写回：只补 tags 字段，不动其它字段；逐站原子写
    let written = 0;
    for (const site of sites) {
      const f = path.join(ROOT, site, 'website', 'api', 'entities.json');
      const ents = loadEntities(site);
      let changed = 0;
      for (const e of ents) {
        const existing = tagsOf(e);
        if (existing.length) continue;
        const p = proposals.get(e.id);
        if (!p || !p.length) continue;
        e.tags = p.map(l => l.tag);
        e.tagConfidence = p.map(l => l.confidence);
        e.tagSource = 'label-program';
        changed++;
      }
      if (changed) {
        fs.writeFileSync(f, JSON.stringify(ents, null, 1), 'utf8');
        written += changed;
        console.log(`[LabelProgram] ${site}: 补标签 ${changed} 条`);
      }
    }
    console.log(`[LabelProgram] 共写回 ${written} 条`);
  } else {
    console.log('[LabelProgram] dry-run：未修改任何实体文件。如需写回请加 --write 并先核算 Pages 容量');
  }

  // 控制台摘要
  console.log('\n================ 摘要 ================');
  console.log(`实体总数        : ${report.corpus.entities}`);
  console.log(`待标注          : ${report.corpus.unlabeled} (${(report.corpus.unlabeledRate * 100).toFixed(1)}%)`);
  console.log(`本次填充        : ${report.labelProgram.filled}  弃权: ${report.labelProgram.abstained}`);
  console.log(`平均置信度      : ${report.labelProgram.avgConfidence}`);
  console.log(`不同标签数      : ${report.labelProgram.distinctTags}`);
  console.log(`错路由检出      : ${report.misroutes.count}`);
  console.log(`摘要字段解析率  : ${(abstractFp.resolvedRate * 100).toFixed(1)}%  漂移率: ${(abstractFp.driftRate * 100).toFixed(1)}%`);
  console.log(`LF 权重 Top5    : ${report.lfReport.slice(0, 5).map(w => `${w.id}=${w.weight}`).join(', ')}`);
  console.log(`耗时            : ${(report.elapsedMs / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error('[LabelProgram] 失败:', e); process.exitCode = 1; });
