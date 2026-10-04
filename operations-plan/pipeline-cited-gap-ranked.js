#!/usr/bin/env node
// 被引文档补齐产物 → 扩库候选清单
//
// 背景（2026-10-04 实测）：
//   59,623 条引用声明展开出 57,764 个 unique 被引 DOI，补齐前只有 2,170 条（3.8%）在我们 30 站库里。
//   pipeline-cited-backfill.js 把 48,760 条补齐了（上游确认无此 DOI 的 6,834 条记入 state.missing）。
//   补齐的文档现在有了 venue/year/abstract —— 于是「谁在引、被引的是什么、发在哪儿」第一次可离线统计。
//
// 本脚本只做派生，不写上游、不联网（OpenAlex 免费层按 IP 日预算，补齐任务自己把当天预算打光了，
// 任何新的上游探查都会 429；所以这里全部本地读取）。
//
// 产物：data/cited-gap-ranked.json
//   - stats：声明数 / unique 被引 DOI / 在库 / 已解析到站 / 完全外部未知 的拆分
//   - byVenue：按期刊（venue）排序的扩库候选，带 unique DOI 数、引用声明数、来源示例
//   - byYear / byCitedBy：按年份、按被引用热度
//   - coverage：我们对「被引侧」的覆盖度快报
//
// 用法：node operations-plan/pipeline-cited-gap-ranked.js [--limit=N] [--write]
//   --limit=N   只看前 N 条引用声明（默认全量）
//   --write     才落盘（默认 dry-run）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const OUT = path.join(ROOT, 'data', 'cited-gap-ranked.json');
const ARGV = process.argv.slice(2);

const LIMIT = (() => {
  const hit = ARGV.find((a) => a.startsWith('--limit='));
  if (!hit) return 0;
  const n = Number(hit.slice(8));
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
const WRITE = ARGV.includes('--write');

const SITE_DIR = path.join(ROOT, 'data', 'search-index');
const CITED = path.join(ROOT, 'data', 'cited-entities.json');
const ACADEMIC = path.join(ROOT, 'data', 'academic-entities.json');
const ASSIGN = path.join(ROOT, 'data', 'cited-site-assign.json');

const normDoi = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\/doi\.org\//i, '').replace(/^doi:/i, '').replace(/\s+$/g, '');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

const isDoiShape = (d) => /^10\.\d{4,9}\//.test(d);
const normDoiStrict = (v) => {
  const d = normDoi(v);
  return isDoiShape(d) ? d : '';
};

// 「库」= 30 站实体文件 <站>/website/api/entities.json 的 doi 字段（与 pipeline-cited-backfill.js 同一口径）。
// 不要用分片当库：实测（2026-10-04）分片内的真 DOI 是库的子集，而库里 24.0% 的 DOI 没进分片索引。
function loadLibraryDois(onProgress) {
  const set = new Set();
  let files = 0;
  let entities = 0;
  for (const site of fs.readdirSync(ROOT)) {
    const p = path.join(ROOT, site, 'website', 'api', 'entities.json');
    if (!fs.existsSync(p)) continue;
    let arr = [];
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      arr = Array.isArray(j) ? j : j.entities || [];
    } catch (e) {
      process.stderr.write(`[WARN] 实体文件读不动，跳过：${site} (${e.message})\n`);
      continue;
    }
    files += 1;
    entities += arr.length;
    for (const e of arr) {
      const d = normDoiStrict(e && e.doi);
      if (d) set.add(d);
    }
    if (onProgress) onProgress(files);
  }
  return { set, files, entities };
}

// 分片索引保真度快报：分片里的 DOI 是否都在库里、库里有多少没进分片
function loadShardDois(onProgress) {
  const set = new Set();
  let files = 0;
  if (!fs.existsSync(SITE_DIR)) return { set, files };
  const names = fs.readdirSync(SITE_DIR).filter((f) => f.endsWith('.json.gz')).sort();
  for (const f of names) {
    let arr = [];
    try {
      const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SITE_DIR, f))).toString('utf8'));
      arr = Array.isArray(j) ? j : j.entities || [];
    } catch (e) {
      process.stderr.write(`[WARN] 分片读不动，跳过：${f} (${e.message})\n`);
      continue;
    }
    for (const e of arr) {
      const raw = String(e && e.id || '');
      const d = normDoiStrict(raw.startsWith('doi:') ? raw.slice(4) : raw);
      if (d) set.add(d);
    }
    files += 1;
    if (onProgress) onProgress(files, names.length);
  }
  return { set, files };
}

function main() {
  const t0 = Date.now();
  process.stdout.write('[i] 载入 30 站实体库 DOI 集合 ...\n');
  const { set: siteDois, files: libFiles, entities: libEntities } = loadLibraryDois();
  process.stdout.write(`[i] 库：${siteDois.size} 个 DOI（${libFiles} 站 / ${libEntities} 实体）\n`);

  process.stdout.write('[i] 载入分片索引 DOI 集合（保真度快报）...\n');
  const { set: shardDois, files: shardFiles } = loadShardDois();
  let shardMissingFromLib = 0;
  for (const d of shardDois) if (!siteDois.has(d)) shardMissingFromLib += 1;
  const libMissingFromShard = siteDois.size - shardDois.size + shardMissingFromLib;
  process.stdout.write(
    `[i] 分片：${shardDois.size} 个 DOI / 库内没有的 ${shardMissingFromLib} / 库内有但没进分片的 ${libMissingFromShard}\n`
  );

  const cited = readJson(CITED);
  const citedArr = Array.isArray(cited) ? cited : (cited && cited.entities) || [];
  const byCited = new Map();
  for (const e of citedArr) {
    const d = normDoi(e && e.doi);
    if (d) byCited.set(d, e);
  }
  process.stdout.write(`[i] 已补齐被引文档：${byCited.size}\n`);

  const assignDoc = readJson(ASSIGN);
  const assignArr = Array.isArray(assignDoc) ? assignDoc : (assignDoc && (assignDoc.assignments || assignDoc.items)) || [];
  const assignByDoi = new Map();
  for (const a of assignArr) {
    if (!a || !a.doi) continue;
    assignByDoi.set(normDoi(a.doi), a);
  }
  process.stdout.write(`[i] 已归属到站的被引文档：${assignByDoi.size}\n`);

  const aca = readJson(ACADEMIC);
  const acaArr = Array.isArray(aca) ? aca : (aca && aca.entities) || [];

  // 展开引用声明：每条声明 = (来源论文 DOI → 被引 DOI)
  const declCount = new Map(); // refDoi -> 声明次数
  const declFrom = new Map(); // refDoi -> 样例来源 DOI
  let totalDecls = 0;
  let scanned = 0;
  for (const rec of acaArr) {
    scanned += 1;
    if (LIMIT && scanned > LIMIT) break;
    const from = normDoi(rec.doi);
    const refs = Array.isArray(rec.references) ? rec.references : [];
    for (const r of refs) {
      const d = normDoi(r);
      if (!d) continue;
      totalDecls += 1;
      declCount.set(d, (declCount.get(d) || 0) + 1);
      if (!declFrom.has(d)) declFrom.set(d, from);
    }
  }
  process.stdout.write(`[i] 展开引用声明：${totalDecls} 条（来自 ${scanned} 篇源论文）\n`);

  // 分类
  const bins = { inLibrary: new Set(), assigned: new Set(), unknown: new Set(), missingUpstream: new Set() };
  const venueAgg = new Map(); // venue -> {dois:Set, decls:number, froms:Set, cited:number, years:Set}
  const yearAgg = new Map();
  for (const [refDoi, decls] of declCount) {
    if (siteDois.has(refDoi)) {
      bins.inLibrary.add(refDoi);
      continue;
    }
    if (assignByDoi.has(refDoi)) {
      bins.assigned.add(refDoi);
      continue;
    }
    if (!byCited.has(refDoi)) {
      bins.missingUpstream.add(refDoi); // 上游没有这条被引文档（state.missing）
      continue;
    }
    bins.unknown.add(refDoi);
    const e = byCited.get(refDoi);
    const venue = String(e.venue || e.type || 'unknown').trim() || 'unknown';
    let v = venueAgg.get(venue);
    if (!v) {
      v = { dois: new Set(), decls: 0, froms: new Set(), cited: 0, years: new Set() };
      venueAgg.set(venue, v);
    }
    v.dois.add(refDoi);
    v.decls += decls;
    if (declFrom.has(refDoi)) v.froms.add(declFrom.get(refDoi));
    v.cited += Number(e.citedByCount || 0);
    if (e.year) v.years.add(Number(e.year));
    const y = Number(e.year);
    if (Number.isFinite(y) && y > 1800) yearAgg.set(y, (yearAgg.get(y) || 0) + 1);
  }

  const allUnique = declCount.size;
  const known = bins.inLibrary.size + bins.assigned.size + bins.unknown.size;
  process.stdout.write(
    `[i] unique 被引 DOI ${allUnique} = 在库 ${bins.inLibrary.size} + 已归属 ${bins.assigned.size} + 未知外部 ${bins.unknown.size} + 上游缺 ${bins.missingUpstream.size}\n`
  );

  const rankVenues = Array.from(venueAgg.entries())
    .map(([venue, v]) => ({
      venue,
      uniqueDois: v.dois.size,
      declarations: v.decls,
      citingRecords: v.froms.size,
      avgCitedBy: v.dois.size ? +(v.cited / v.dois.size).toFixed(1) : 0,
      yearMin: v.years.size ? Math.min(...v.years) : null,
      yearMax: v.years.size ? Math.max(...v.years) : null,
    }))
    .sort((a, b) => b.uniqueDois - a.uniqueDois || b.declarations - a.declarations);

  const rankYears = Array.from(yearAgg.entries())
    .map(([year, n]) => ({ year, uniqueDois: n }))
    .sort((a, b) => b.year - a.year);

  const topUnknownVenues = rankVenues.slice(0, 40);
  const topUnknownDois = Array.from(bins.unknown)
    .slice(0, 25)
    .map((d) => {
      const e = byCited.get(d) || {};
      return {
        doi: d,
        title: String(e.title || '').slice(0, 140),
        year: e.year || null,
        venue: e.venue || e.type || null,
        citedByCount: Number(e.citedByCount || 0),
        declarations: declCount.get(d) || 0,
        citingFrom: declFrom.get(d) || null,
      };
    });

  const payload = {
    version: 1,
    builtAt: new Date().toISOString(),
    derivedFrom: {
      siteDois: 'data/search-index/site-*.json.gz (30 站全量实体)',
      citedEntities: 'data/cited-entities.json',
      academicEntities: 'data/academic-entities.json',
      citedSiteAssign: 'data/cited-site-assign.json',
    },
    stats: {
      sourceRecords: scanned,
      declarations: totalDecls,
      uniqueCitedDois: allUnique,
      inLibrary: bins.inLibrary.size,
      assignedToSite: bins.assigned.size,
      unknownExternal: bins.unknown.size,
      missingUpstream: bins.missingUpstream.size,
      knownNodes: known,
      knownShare: allUnique ? +(known / allUnique).toFixed(4) : 0,
      sites: libFiles,
      libEntities: libEntities,
      missingUpstreamShare: allUnique ? +(bins.missingUpstream.size / allUnique).toFixed(4) : 0,
    },
    indexFidelity: {
      note: '分片检索索引 vs 站点实体库，两边是不是同一代数据。verify-shard-live.mjs 只查每片内部字段完整度，查不出这条。',
      shardDois: shardDois.size,
      shardNotInLibrary: shardMissingFromLib,
      libraryNotInShards: libMissingFromShard,
      libraryNotInShardShare: siteDois.size ? +(libMissingFromShard / siteDois.size).toFixed(4) : 0,
      shards: shardFiles,
    },
    interpretation: {
      headline:
        '这是对「我们引了谁、而那些人不在库里」的直接统计。unknownExternal 就是扩库目标池：把它们在库，引用边才会变多、缺口矩阵才会变准。',
      caveats: [
        '本脚本离线运行，不查上游；unknownExternal 的 DOI 只有 metadata（来自 cited-entities.json），没有站点归属。',
        '“上游缺”（missingUpstream）是 OpenAlex 确认过没有该 DOI 的，不需要再补，属于可永久放弃的部分。',
        'venue 来自 OpenAlex 的 primary_location.source.display_name，可能为空（记 unknown），也可能一家期刊多个写法。',
        '扩库优先级建议按 uniqueDois 排，而不是 declarations：一个 DOI 被反复引用只说明它热，不代表需要一篇新文档。',
      ],
    },
    coverage: {
      note: 'knownShare = 在库 + 已归属 / unique 被引 DOI。这是“被引侧覆盖度”，与 citation-gaps.json 的“站对缺口”是两个维度。',
      knownShare: allUnique ? +(known / allUnique).toFixed(4) : 0,
      unknownShare: allUnique ? +(bins.unknown.size / allUnique).toFixed(4) : 0,
    },
    topVenues: topUnknownVenues,
    venueTotal: venueAgg.size,
    topYears: rankYears,
    sampleUnknownDois: topUnknownDois,
  };

  process.stdout.write(
    `[i] 扩库候选：${payload.stats.unknownExternal} 个 unique DOI / ${venueAgg.size} 个 venue\n`
  );
  process.stdout.write('[i] Top 10 缺库期刊：\n');
  for (const v of rankVenues.slice(0, 10)) {
    process.stdout.write(`   ${v.uniqueDois}\t${v.declarations}\t${v.venue}\n`);
  }

  if (WRITE) {
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf-8');
    process.stdout.write(`[o] 写出 ${OUT} (${fs.statSync(OUT).size} B)\n`);
  } else {
    process.stdout.write('[i] dry-run，未写盘（加 --write 落盘）\n');
  }
  process.stdout.write(`[i] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`[FATAL] ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
}
