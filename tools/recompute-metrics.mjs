#!/usr/bin/env node
/**
 * tools/recompute-metrics.mjs  (T1.1 — 统一数字口径 / 建立唯一真源)
 *
 * 背景（SCI达标提升方案-2026-10-18.md §T1.1 / W8）：
 *   对外数字曾出现「唯一 DOI」三口径冲突：
 *     · 276,769 = cross-source 去重后的唯一 DOI（来自 data/identity-map.json）
 *     · 271,099 = 30 站实体中「带 DOI/PMID 的实体数」（覆盖率口径，本就是不同指标）
 *     · 256,086 = 旧 round9 管线口径（已弃用）
 *   根因：把两个不同定义（"唯一 DOI" vs "带 DOI 的实体数"）都叫"唯一 DOI"，且多处硬编码。
 *
 * 本脚本建立 data/metrics.json 作为**唯一真源**，对每个指标明确定义、注明来源文件，
 * 使后续 ai.txt / whitepaper / claims.json / README 只引用它，不再各自硬编码。
 *
 * 计算口径（写进 metrics.definitions，机器+人可读）：
 *   - totalEntities        30 站 entities.json 逐站求和（含无 DOI 的实体）
 *   - entitiesWithDoiOrPmid 30 站实体中 e.doi || e.pmid 非空的实体数（覆盖率）
 *   - uniqueDoi             data/identity-map.json 中 canonical entry.doi != null 的去重计数
 *                          （identity-map 已是跨源/cross-site 去重层，故=唯一 DOI）
 *   - uniquePmid            data/identity-map.json 中 entry.pmid 存在的去重计数（辅助）
 *   - stubCount/stubRate    30 站实体中 abstract 为空或空白的「存根」数量与比例
 *   - siteCount             有 website/api/entities.json 的顶层目录数
 *
 * 用法：node tools/recompute-metrics.mjs [--dry-run]
 *   --dry-run  仅打印，不写 data/metrics.json
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DRY_RUN = process.argv.includes('--dry-run');

const STUB_ABSTRACT_MIN = 1; // abstract 去掉空白后长度 < 该值视为 stub（空/纯空白）

/** 扫描 30 站实体文件，逐站聚合 */
function countEntities() {
  const siteDirs = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory()
      && fs.existsSync(path.join(ROOT, e.name, 'website', 'api', 'entities.json')));

  let total = 0;
  let withDoiOrPmid = 0;
  let stubCount = 0;
  const perSite = [];

  for (const s of siteDirs) {
    const p = path.join(ROOT, s.name, 'website', 'api', 'entities.json');
    let list = [];
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      list = Array.isArray(raw) ? raw : (raw.entities || []);
    } catch (err) {
      console.error(`[metrics] 跳过无法解析的站点文件: ${p} (${err.message})`);
      continue;
    }
    let sWith = 0;
    let sStub = 0;
    for (const e of list) {
      if (!e || typeof e !== 'object') continue;
      if (e.doi || e.pmid) sWith++;
      const abs = typeof e.abstract === 'string' ? e.abstract.trim() : '';
      if (abs.length < STUB_ABSTRACT_MIN) sStub++;
    }
    total += list.length;
    withDoiOrPmid += sWith;
    stubCount += sStub;
    perSite.push({
      site: s.name,
      entities: list.length,
      withDoiOrPmid: sWith,
      stub: sStub,
      stubRate: list.length ? +(sStub / list.length).toFixed(4) : 0,
    });
  }
  perSite.sort((a, b) => b.entities - a.entities);
  return { siteCount: siteDirs.length, totalEntities: total, entitiesWithDoiOrPmid: withDoiOrPmid, stubCount, perSite };
}

/**
 * 从 identity-map.json 计算跨源唯一 DOI/PMID（它已是去重层）。
 * 严谨口径：uniqueDoi = 去重后的「不同 DOI 字符串」数（不是"有 DOI 的 entry 数"，
 * 因为同一 DOI 可能挂在不同 native 源的 entry 上，按 entry 数会重复计数）。
 */
function countIdentityMap() {
  const p = path.join(ROOT, 'data', 'identity-map.json');
  if (!fs.existsSync(p)) {
    console.error('[metrics] 缺失 data/identity-map.json，跳过 uniqueDoi 计算');
    return { uniqueDoi: null, entriesWithDoi: null, uniquePmid: null, identityEntries: null };
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const entries = raw.entries || {};
  const doiSet = new Set();
  const pmidSet = new Set();
  let entriesWithDoi = 0;
  for (const key in entries) {
    const e = entries[key];
    if (e && e.doi) { doiSet.add(e.doi); entriesWithDoi++; }
    if (e && e.pmid) pmidSet.add(e.pmid); // 兼容未来 pmid 字段
  }
  return {
    uniqueDoi: doiSet.size,
    entriesWithDoi,
    uniquePmid: pmidSet.size,
    identityEntries: Object.keys(entries).length,
  };
}

function main() {
  const ent = countEntities();
  const idm = countIdentityMap();

  const stubRate = ent.totalEntities ? +(ent.stubCount / ent.totalEntities).toFixed(4) : 0;
  const doiCoverage = ent.totalEntities ? +(ent.entitiesWithDoiOrPmid / ent.totalEntities).toFixed(4) : 0;

  const metrics = {
    $schema: 'genetech-metrics-v1',
    generatedAt: new Date().toISOString(),
    generator: 'tools/recompute-metrics.mjs',
    sourceFiles: [
      '<site>/website/api/entities.json (×' + ent.siteCount + ')',
      'data/identity-map.json',
    ],
    definitions: {
      totalEntities: '30 站 entities.json 逐站实体数求和（含无外部 ID 的实体）。',
      entitiesWithDoiOrPmid: '30 站实体中 e.doi 或 e.pmid 非空的实体数（"覆盖率"口径，不是唯一数）。',
      identityEntries: 'data/identity-map.json 的 canonical entry 总数（跨源/cross-site 去重后的实体键数，含 arxiv/oa/pmid 等无 DOI 的条目）。',
      entriesWithDoi: 'identity-map 中 doi 字段非空的 entry 数（按 entry 计，会重复计数同一 DOI 跨多源的情况）。',
      uniqueDoi: 'identity-map 中不同 DOI 字符串的去重计数 —— 这才是严谨的"唯一 DOI"。',
      uniquePmid: 'identity-map 中不同 pmid 字符串的去重计数（辅助口径，当前源无 pmid 字段故为 0）。',
      stubCount: '30 站实体中 abstract 为空/纯空白的"存根"实体数。',
      stubRate: 'stubCount / totalEntities。',
    },
    metrics: {
      siteCount: ent.siteCount,
      totalEntities: ent.totalEntities,
      entitiesWithDoiOrPmid: ent.entitiesWithDoiOrPmid,
      doiCoverageRate: doiCoverage,
      identityEntries: idm.identityEntries,
      entriesWithDoi: idm.entriesWithDoi,
      uniqueDoi: idm.uniqueDoi,
      uniquePmid: idm.uniquePmid,
      stubCount: ent.stubCount,
      stubRate,
    },
    perSite: ent.perSite,
    // 一致性自检：覆盖实体数应 ≤ 总实体数；唯一 DOI 与带 DOI 实体数是不同口径，不应被混用
    selfCheck: {
      entitiesWithDoiOrPmid_le_totalEntities: ent.entitiesWithDoiOrPmid <= ent.totalEntities,
      note: 'uniqueDoi 与 entitiesWithDoiOrPmid 是不同定义：前者为跨源去重后的唯一 DOI 数，后者为 30 站带外部 ID 的实体数。切勿在对外文档中混用或互相替代。',
    },
    // 历史口径冲突的诚实记录（W8）：说明旧数字是怎么来的、为什么现在是错的
    legacyConfusion: {
      reported_276769: '旧文档称"唯一 DOI 276,769"。实测 identityEntries=276,960（≈276,769），说明旧口径把"identity-map 全部条目数"误当作"唯一 DOI"——但其中大量条目是 arxiv/oa 等无 DOI 实体。',
      reported_256086: '旧 round9 管线称"唯一 DOI 256,086"，接近本脚本的 distinct uniqueDoi（见 metrics.uniqueDoi），是三者中最接近真值的口径。',
      reported_271099: '旧文档把"实体带 DOI/PMID 数 271,099"与"唯一 DOI"混用。两者定义不同：271,099 是 30 站覆盖口径，uniqueDoi 是跨源去重口径。',
      resolved_uniqueDoi: idm.uniqueDoi,
      resolution: '以本 metrics.json 的 metrics.uniqueDoi（去重后的不同 DOI 字符串数）作为"唯一 DOI"的唯一权威口径。',
    },
  };

  const out = path.join(ROOT, 'data', 'metrics.json');
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(metrics, null, 2), 'utf8');
    console.log(`[metrics] 已写入 ${out}`);
  } else {
    console.log('[metrics] --dry-run，不落盘');
  }

  console.log('');
  console.log(JSON.stringify(metrics.metrics, null, 2));
  console.log('');
  console.log(`[metrics] stubRate=${(stubRate * 100).toFixed(2)}%  doiCoverage=${(doiCoverage * 100).toFixed(2)}%`);
}

main();
