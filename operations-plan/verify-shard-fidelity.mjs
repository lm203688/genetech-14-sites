#!/usr/bin/env node
// 分片检索索引 vs 站点实体库 —— 保真度门禁
//
// 为什么要有这个（2026-10-04 实测）：
//   verify-shard-live.mjs 只查「每片自己炸没炸、字段齐不齐」，查不出索引和库是不是同一代数据。
//   实测：库里 260,689 个真 DOI，30 个分片只含 198,114 个 —— **62,575 个（24.0%）根本没进索引**；
//   分片里的 DOI 则 100% 都在库里（是子集，所以现状不算错，只是不全）。
//   也就是说线上语义检索对这 24% 的实体是「搜不到的」，而这个事实之前的任何门禁都不报告。
//
// 判定（保守，宁可不出声）：
//   exit 0  保真度正常（超集/子集差在容忍内）
//   exit 1  ★ 分片里有库里没有的 DOI（方向错了，索引混入了非库数据）
//   exit 2  库里没进分片的比例 > LIB_MISS_MAX（索引漏了太多，检索召回会明显偏低）
//   exit 3  ★★ 无法判定：库或分片一个 DOI 都没加载起来（输入缺失，不是结论）
//
// ★ 为什么必须有 exit 3（2026-10-04 实测的假失败）
//   CI 里出现过一次「库 0 DOI / 分片 198114 DOI」→ 因为库是空的，
//   分片 100% 都算「库里没有的」→ 判成 exit 1「索引混入非库数据」。
//   一个**门禁自己加载失败**被翻译成了对数据的判决：CI 红，但红的原因
//   和索引质量毫无关系。凡是「分子分母来自被加载的输入」的门禁，
//   都必须先证明输入非空，否则它算出来的任何百分比都是噪声。
//   现在库/分片任意一侧为 0 就 exit 3 并打印 files/entities 明细，
//   下次一眼能看出是「文件没找到」还是「文件里没 DOI」。
//
// 用法：node operations-plan/verify-shard-fidelity.mjs [--lib-miss=0.10] [--shard-extra=0.01]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const argStr = (name, dflt) => {
  const hit = process.argv.find((a) => typeof a === 'string' && a.startsWith(name));
  return hit ? hit.slice(name.length) : dflt;
};
// --lib-dir / --shard-dir：只为**门禁的双向回归测试**存在。
// 门禁必须能被证伪：把任一侧指到一个空目录，必须 exit 3（无法判定），
// 而不是算出 0% / 100% 这种噪声去误导 CI。
const SHARD_DIR = path.resolve(argStr('--shard-dir=', path.join(ROOT, 'data', 'search-index')));
const LIB_DIR = path.resolve(argStr('--lib-dir=', ROOT));

const argNum = (p, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  if (!hit) return d;
  const n = Number(hit.slice(p.length));
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const LIB_MISS_MAX = argNum('--lib-miss=', 0.1);
const SHARD_EXTRA_MAX = argNum('--shard-extra=', 0.01);

// 只认真 DOI（10.xxxx/yyy）：分片 id 还有 oa: / pmid: / arxiv: 这些非 DOI 形态，
// 它们本来就代表「没有 DOI 的实体」，不该算进保真度统计。
const isDoiShape = (d) => /^10\.\d{4,9}\//.test(d);
const normDoi = (v) => {
  if (!v) return '';
  return String(v)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:/, '')
    .replace(/\s+$/, '');
};
const strictDoi = (v) => {
  const d = normDoi(v);
  return isDoiShape(d) ? d : '';
};

function libraryDois() {
  const set = new Set();
  let files = 0;
  let entities = 0;
  for (const site of fs.readdirSync(LIB_DIR)) {
    const p = path.join(LIB_DIR, site, 'website', 'api', 'entities.json');
    if (!fs.existsSync(p)) continue;
    let arr = [];
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      arr = Array.isArray(j) ? j : j.entities || [];
    } catch {
      continue;
    }
    files += 1;
    entities += arr.length;
    for (const e of arr) {
      const d = strictDoi(e && e.doi);
      if (d) set.add(d);
    }
  }
  return { set, files, entities };
}

function shardDois() {
  const set = new Set();
  let files = 0;
  if (!fs.existsSync(SHARD_DIR)) return { set, files };
  for (const f of fs.readdirSync(SHARD_DIR).filter((x) => x.endsWith('.json.gz')).sort()) {
    let arr = [];
    try {
      const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SHARD_DIR, f))).toString('utf8'));
      arr = Array.isArray(j) ? j : j.entities || [];
    } catch (e) {
      process.stderr.write(`[WARN] 分片读不动，跳过：${f} (${e.message})\n`);
      continue;
    }
    files += 1;
    for (const e of arr) {
      const raw = String(e && e.id || '');
      const d = strictDoi(raw.startsWith('doi:') ? raw.slice(4) : raw);
      if (d) set.add(d);
    }
  }
  return { set, files };
}

const lib = libraryDois();
const shd = shardDois();

let extra = 0;
for (const d of shd.set) if (!lib.set.has(d)) extra += 1;
const libMiss = lib.set.size - (shd.set.size - extra); // 库里有、分片里没有
const libMissShare = lib.set.size ? libMiss / lib.set.size : 0;
const extraShare = shd.set.size ? extra / shd.set.size : 0;

const out = {
  checkedAt: new Date().toISOString(),
  library: { entities: lib.entities, sites: lib.files, dois: lib.set.size },
  shards: { files: shd.files, dois: shd.set.size },
  shardNotInLibrary: extra,
  shardNotInLibraryShare: +extraShare.toFixed(4),
  libraryNotInShards: libMiss,
  libraryNotInShardsShare: +libMissShare.toFixed(4),
  thresholds: { libMissMax: LIB_MISS_MAX, shardExtraMax: SHARD_EXTRA_MAX },
};

// ---- 输入非空守卫：先证明两侧都真加载到了，再谈百分比 ----
process.stderr.write(
  `[fidelity] 库 ${lib.files} 文件 / ${lib.entities} 实体 / ${lib.set.size} DOI；` +
    `分片 ${shd.files} 片 / ${shd.set.size} DOI\n`
);
if (lib.set.size === 0 || shd.set.size === 0) {
  out.verdict = 'UNDETERMINED';
  out.reason =
    lib.set.size === 0
      ? '读不到任何站点实体 DOI（站点 entities.json 没找到或里面没 DOI）—— 门禁无法判定，别拿这个百分比当结论。'
      : '读不到任何分片 DOI（data/search-index 下的 *.json.gz 为空或没下载）—— 门禁无法判定。';
  out.libraryFiles = lib.files;
  out.libraryEntities = lib.entities;
  out.shardFiles = shd.files;
  process.stderr.write(`[fidelity] INCOMPLETE ${out.reason}\n`);
  process.stderr.write(`[fidelity] ${{ 库文件: lib.files, 库实体: lib.entities, 片数: shd.files }}\n`);
  process.exit(3);
}

process.stderr.write(
  `[fidelity] 分片里有库里没有的：${extra}（${(extraShare * 100).toFixed(2)}%）\n` +
    `[fidelity] 库里有分片里没有的：${libMiss}（${(libMissShare * 100).toFixed(2)}%）\n`
);

if (extraShare > SHARD_EXTRA_MAX) {
  out.verdict = 'FAIL_EXTRA';
  out.reason = '分片里有库里没有的 DOI —— 索引混入了非库数据，方向不对。';
  process.stderr.write(`[fidelity] FAIL 分片混入非库数据 ${(extraShare * 100).toFixed(2)}% > ${(SHARD_EXTRA_MAX * 100).toFixed(2)}%\n`);
  process.exit(1);
}
if (libMissShare > LIB_MISS_MAX) {
  out.verdict = 'FAIL_MISSING';
  out.reason = '库里有超过阈值比例的 DOI 没进分片 —— 线上检索对这些实体搜不到，需重跑 pipeline-search-index.js --shards。';
  process.stderr.write(`[fidelity] FAIL 库漏进分片 ${(libMissShare * 100).toFixed(2)}% > ${(LIB_MISS_MAX * 100).toFixed(2)}%\n`);
  process.exit(2);
}
out.verdict = 'OK';
out.reason = '分片是库的子集，且漏进分片的比例在阈值内。';
process.stderr.write('[fidelity] OK\n');
try {
  fs.writeFileSync(path.join(ROOT, 'data', 'shard-fidelity.json'), JSON.stringify(out, null, 2), 'utf8');
} catch {}
process.exit(0);
