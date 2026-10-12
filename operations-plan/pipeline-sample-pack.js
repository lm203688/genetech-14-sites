#!/usr/bin/env node
/**
 * operations-plan/pipeline-sample-pack.js
 *
 * 生成 consumer-sdk/samples/sample-10k.jsonl —— 免费样本包（D4）。
 *
 * 为什么需要它
 *   consumer-sdk/ 曾经是一个空目录（只有 __pycache__）。README 与 package 描述
 *   都隐含"有 SDK"，实际为零。样本包是"先让人能上手"的最低成本交付物：
 *   不必申请 key、不必装 SDK，下载一个 JSONL 就能开始跑通整条链路。
 *   对标 A4（从空目录起步）：先给 10k 条免费样本，全量包按域切片报价。
 *
 * 可复现
 *   固定 seed + 确定性 PRNG（mulberry32），同样的仓库状态下产物逐字节一致。
 *   所以这个数字可以写进对外材料：任何人 clone 下来重跑，得到同一个文件。
 *
 * 体积取舍
 *   全量 abstract 平均约 800 字符，10k 条会把样本包撑到 15MB+。
 *   截断到 500 字符并保留 abstract_chars 原长，体积降到 ~7MB，
 *   字段结构不变，需要全文的用户走 API。
 *
 * 用法
 *   node operations-plan/pipeline-sample-pack.js              # 写入 samples/sample-10k.jsonl
 *   node operations-plan/pipeline-sample-pack.js --dry-run    # 只算不写
 *   node operations-plan/pipeline-sample-pack.js --limit=5000
 *
 * 注意：本脚本不修改任何 entities.json，只读它们。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'consumer-sdk', 'samples');
const OUT_JSONL = path.join(OUT_DIR, 'sample-10k.jsonl');
const OUT_MANIFEST = path.join(OUT_DIR, 'sample-10k.manifest.json');

const DRY = process.argv.includes('--dry-run');
const get = (prefix, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? Number(hit.slice(prefix.length)) : fallback;
};
const LIMIT = get('--limit=', 10000);
const SEED = 20261008;
const ABSTRACT_CAP = 500;

// 样本包保留的字段（与 DATA-DICTIONARY.md 对齐）
const KEEP = ['id', 'name', 'source', 'abstract', 'url', 'authors', 'tags', 'confidence', 'sites', 'publishedDate', 'quality_tier'];

/** 确定性 PRNG。不用 Math.random，否则样本包不可复现。 */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stations() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, e.name, 'website', 'api', 'entities.json')))
    .map((e) => e.name)
    .sort();
}

/** 从一个大数组里确定性取 n 条。 */
function sample(arr, n, rnd) {
  if (arr.length <= n) return arr.slice();
  // 部分洗牌（Fisher-Yates 前缀），O(n) 而不是 O(len)
  const copy = arr.slice();
  const take = Math.min(n, copy.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rnd() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, take);
}

function main() {
  const t0 = Date.now();
  const sts = stations();
  if (!sts.length) {
    console.error('[sample-pack][FAIL] 找不到任何 */website/api/entities.json');
    process.exit(2);
  }

  const perStation = Math.ceil(LIMIT / sts.length);
  const rnd = mulberry32(SEED);
  const out = [];
  const perStationStats = [];
  const sourceDist = {};
  const siteDist = {};
  const fieldStats = { withAbstract: 0, withTags: 0, withConfidence: 0, withQualityTier: 0, withPublishedDate: 0, abstractTruncated: 0 };

  for (const s of sts) {
    const p = path.join(ROOT, s, 'website', 'api', 'entities.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const recs = j.entities || j.records || j.data || (Array.isArray(j) ? j : []);
    const picked = sample(recs, perStation, rnd);
    for (const r of picked) {
      const rec = {};
      for (const k of KEEP) if (r[k] !== undefined) rec[k] = r[k];
      rec.site = s; // 样本包里补一个明确的站点标记
      if (typeof rec.abstract === 'string' && rec.abstract.length > ABSTRACT_CAP) {
        rec.abstract_chars = rec.abstract.length;
        rec.abstract_truncated = true;
        rec.abstract = rec.abstract.slice(0, ABSTRACT_CAP) + '…';
        fieldStats.abstractTruncated++;
      }
      if (typeof rec.abstract === 'string' && rec.abstract.trim()) fieldStats.withAbstract++;
      if (Array.isArray(rec.tags) && rec.tags.length) fieldStats.withTags++;
      if (rec.confidence !== undefined) fieldStats.withConfidence++;
      if (rec.quality_tier !== undefined) fieldStats.withQualityTier++;
      if (rec.publishedDate) fieldStats.withPublishedDate++;
      if (rec.source) sourceDist[rec.source] = (sourceDist[rec.source] || 0) + 1;
      for (const st of (r.sites || (r.site ? [r.site] : []))) siteDist[st] = (siteDist[st] || 0) + 1;
      out.push(rec);
    }
    perStationStats.push({ site: s, totalInStation: recs.length, sampled: picked.length });
  }

  out.sort((a, b) => String(a.site).localeCompare(String(b.site)) || String(a.id).localeCompare(String(b.id)));

  const jsonl = out.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const manifest = {
    artifact: 'sample-10k.jsonl',
    generatedAt: new Date().toISOString(),
    generatedBy: 'operations-plan/pipeline-sample-pack.js',
    seed: SEED,
    limit: LIMIT,
    abstractCap: ABSTRACT_CAP,
    reproducibility: '固定 seed + mulberry32 部分洗牌；同一仓库状态下重跑得同一文件',
    records: out.length,
    stations: sts.length,
    bytes: jsonl.length,
    sourceDist,
    perStation: perStationStats,
    fieldCompleteness: Object.fromEntries(Object.entries(fieldStats).map(([k, v]) => [k, { count: v, rate: out.length ? +(v / out.length).toFixed(4) : 0 }])),
    notes: [
      `abstract 超过 ${ABSTRACT_CAP} 字符的会截断，原长保留在 abstract_chars`,
      '全量与全文请走 API（https://api.swarmlabs.tools）或按域切片的全量包',
      '字段含义见 consumer-sdk/docs/DATA-DICTIONARY.md',
    ],
  };

  console.log(`[sample-pack] 站点 ${sts.length} | 每站抽样 ${perStation} | 目标 ${LIMIT}`);
  console.log(`[sample-pack] 实际产出 ${out.length} 条 | ${jsonl.length.toLocaleString()} 字节 (${(jsonl.length / 1048576).toFixed(2)} MB)`);
  console.log(`[sample-pack] 来源分布 ${JSON.stringify(sourceDist)}`);
  console.log(`[sample-pack] 字段完整率 ` +
    `abstract=${fieldStats.withAbstract}/${out.length} tags=${fieldStats.withTags}/${out.length} ` +
    `confidence=${fieldStats.withConfidence}/${out.length} quality_tier=${fieldStats.withQualityTier}/${out.length}`);
  console.log(`[sample-pack] abstract 截断 ${fieldStats.abstractTruncated} 条（超 ${ABSTRACT_CAP} 字符）`);
  console.log(`[sample-pack] 唯一站点覆盖 ${Object.keys(siteDist).length}`);

  if (DRY) {
    console.log('[sample-pack] dry-run，未写入');
    process.exit(0);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_JSONL, jsonl);
  fs.writeFileSync(OUT_MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`[sample-pack] 已写入 ${path.relative(ROOT, OUT_JSONL)}`);
  console.log(`[sample-pack] 已写入 ${path.relative(ROOT, OUT_MANIFEST)}`);
  console.log(`[sample-pack] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
