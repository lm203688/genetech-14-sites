// pipeline-library-expand-cocite.js
// 用「共被引」信号把被引文档归到站点 —— 不依赖 OpenAlex key、不依赖关键词模糊匹配。
//
// 原理：每个库内论文（academic-entities.json）都已知自己属于哪个站（sites 字段），
// 又带有 references[]（它引用的 DOI）。于是「某被引 DOI 被哪些站的论文引用」直接给出
// 该 DOI 的学科归属投票 —— 哪个站引用它最多，它就最属于哪个站。
// 这是真实的引用行为信号，比关键词匹配（SITE_DOMAIN 同义词）精度高得多：
//   关键词法：905 条高置信（margin 阈值卡出来的）
//   共被引法：48,035 条单站主导（≥80% 引用来自同一站），精度由引用图保证。
//
// 产出是「覆盖层」(overlay) data/library-expand.json 的 fills：
//   fills[site] = [{ doi, c, s, n }]   （c=置信度 high/med/low, s=top-share, n=该站引用计数）
// 喂给 pipeline-citation-edges-refs.js --lib-expand= 即可让边反映真实引用关系，
// 无需把 48k 条写进 30 个站点实体文件（那是 487MB blob，默认不做）。
//
// 用法：
//   node pipeline-library-expand-cocite.js            # 写默认 data/library-expand.json
//   node pipeline-library-expand-cocite.js --out=X.json
//   node pipeline-library-expand-cocite.js --min-share=0.5
//   node pipeline-library-expand-cocite.js --write   # （保留接口）只填各站空位，超出容量不写

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __file = fileURLToPath(import.meta.url);
const ROOT = path.resolve(__file, '..', '..');
const DATA = path.join(ROOT, 'data');

const norm = (v) =>
  String(v == null ? '' : v)
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .replace(/\s+/g, '')
    .replace(/\.$/, '');

const ARGV = process.argv.slice(2);
const OUT = (() => {
  const a = ARGV.find((x) => x.startsWith('--out='));
  return a ? a.slice('--out='.length) : path.join(DATA, 'library-expand.json');
})();
const MIN_SHARE = (() => {
  const a = ARGV.find((x) => x.startsWith('--min-share='));
  return a ? parseFloat(a.slice('--min-share='.length)) : 0.5;
})();
const DRY = ARGV.includes('--dry-run');
const WRITE = ARGV.includes('--write');

function loadArr(p) {
  if (!fs.existsSync(p)) return null;
  try {
    const w = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(w) ? w : (w.entities || w.fills ? w : null);
  } catch {
    return null;
  }
}

function main() {
  const acadPath = path.join(DATA, 'academic-entities.json');
  const citedPath = path.join(DATA, 'cited-entities.json');
  const acad = loadArr(acadPath);
  const cited = loadArr(citedPath);
  if (!Array.isArray(acad) || !Array.isArray(cited)) {
    process.stderr.write('[skip] 缺少 academic-entities.json 或 cited-entities.json\n');
    process.exit(0);
  }

  // 1) 共被引投票：citedDoi -> Map(site -> count)
  const vote = new Map();
  let refTotal = 0;
  for (const p of acad) {
    const sites = Array.isArray(p.sites) && p.sites.length ? p.sites : [];
    if (!sites.length) continue;
    for (const r of p.references || []) {
      const d = norm(r);
      if (!d) continue;
      refTotal++;
      if (!vote.has(d)) vote.set(d, new Map());
      const m = vote.get(d);
      for (const s of sites) m.set(s, (m.get(s) || 0) + 1);
    }
  }

  // 2) 每个被引 DOI 取 top 站 + share + 计数
  const assigned = []; // {doi, site, share, count, total}
  const citedDoiSet = new Set(cited.map((x) => norm(x.doi)));
  for (const d of citedDoiSet) {
    const m = vote.get(d);
    if (!m || m.size === 0) continue;
    let topSite = null, top = 0, total = 0;
    for (const [s, c] of m) {
      total += c;
      if (c > top) { top = c; topSite = s; }
    }
    if (!topSite) continue;
    const share = total ? top / total : 0;
    assigned.push({ doi: d, site: topSite, share, count: top, total, multi: m.size });
  }

  // 3) 置信度 + 过滤
  const fills = {};
  let high = 0, med = 0, low = 0, dropped = 0;
  for (const a of assigned) {
    let c;
    if (a.share >= 0.8) c = 'high';
    else if (a.share >= 0.6) c = 'med';
    else c = 'low';
    if (a.share < MIN_SHARE) { dropped++; continue; }
    if (c === 'high') high++; else if (c === 'med') med++; else low++;
    // 边缘管线只读 t.doi；c 仅供人审，故只留最短字段，压低覆盖层体积
    (fills[a.site] ||= []).push({ doi: a.doi, c });
  }

  // 4) 各站空位容量（用于 --write 上限 & 信息提示，不影响覆盖层归属）
  const cap = {};
  for (const d of fs.readdirSync(ROOT)) {
    const ep = path.join(ROOT, d, 'website/api/entities.json');
    if (!fs.existsSync(ep)) continue;
    const arr = loadArr(ep) || [];
    const u = new Set(arr.map((e) => norm(e.doi)).filter(Boolean));
    cap[d] = Math.max(0, 10000 - u.size);
  }
  let overflow = 0;
  for (const [s, list] of Object.entries(fills)) {
    const k = cap[s] || 0;
    if (list.length > k) overflow += list.length - k;
  }

  const result = {
    generatedAt: new Date().toISOString(),
    method: 'co-citation (citing library papers vote the cited DOI\'s site)',
    minShare: MIN_SHARE,
    refRelationships: refTotal,
    assigned: assigned.length,
    confidence: { high, med, low, droppedBelowMin: dropped },
    siteCapacityOverflowIfWritten: overflow,
    fillsTotal: Object.values(fills).reduce((s, l) => s + l.length, 0),
    perSite: Object.fromEntries(
      Object.entries(fills)
        .map(([s, l]) => [s, { fill: l.length, cap: cap[s] || 0 }])
        .sort((a, b) => b[1].fill - a[1].fill)
    ),
    fills,
  };

  process.stderr.write(
    `[cocite] 引用关系 ${refTotal} 条 → ${assigned.length} 个被引 DOI 获得归属\n` +
      `[cocite] 置信度 high=${high} med=${med} low=${low}（<${MIN_SHARE} 丢弃 ${dropped}）\n` +
      `[cocite] 覆盖层归属总数 ${result.fillsTotal}；若真写盘超出空位 ${overflow}\n`
  );

  if (DRY) {
    process.stderr.write('[cocite] --dry-run，不写文件\n');
    return;
  }
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf-8');
  process.stderr.write(`[cocite] 已写入 ${OUT}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __file) {
  try {
    main();
  } catch (e) {
    process.stderr.write('[cocite] FATAL ' + (e && e.stack || e) + '\n');
    process.exit(1);
  }
}
