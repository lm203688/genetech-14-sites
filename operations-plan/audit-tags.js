#!/usr/bin/env node
/**
 * audit-tags.js — 标签体系质量审计
 *
 * 为什么要先做这个（2026-09-29）
 *   尝试从语料自举关键词词表时失败：生成 3 个标签，且词元仍是作者姓
 *   （awdeh、auwera）。根因不是算法，是**标签体系本身污染**——
 *   OpenAlex 概念包含人名，且同一人名存在倒序重复（"luigi Usai" 与 "Usai Luigi" 是两个标签）。
 *   脏词表 → LF 准确率不可评判 → LabelModel 标定维度失效。
 *   因此先量化污染，产出清洗后的可用词表，再谈自举。
 *
 * 审计维度
 *   1. 人名标签：标签词元命中实体 authors 词元集合
 *   2. 倒序重复：A B 与 B A 同时存在（人名常见）
 *   3. 单实体标签：只挂在 ≤3 条实体上（无统计意义）
 *   4. 超宽标签：覆盖 >20% 实体（粗领域，判别力弱）
 *   5. 重复大小写/空格变体
 *
 * 用法：node operations-plan/audit-tags.js [--out=reports/tag-audit.json]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const h = argv.find(a => a.startsWith(`--${k}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const OUT = arg('out', path.join(ROOT, 'reports', 'tag-audit.json'));
const SINGLETON_MAX = Number(arg('singleton', '3'));
const BROAD_SHARE = Number(arg('broad', '0.20'));

const STOP = new Set(String.raw`the a an and or but if then else of in on at to for from by with without into onto within across through over under above below between among during before after since until while as is are was were be been being have has had do does did will would shall should can could may might must not no nor so that this these those it its they them their we our he she his her you your who whom which what when where why how all any both each few more most other some such only own same than too very s t don just now also up down out off here there`.split(/\s+/));
function tokenize(text) {
  if (!text) return [];
  return [...String(text).toLowerCase().matchAll(/[a-z][a-z\-]{3,30}/g)]
    .map(m => m[0].replace(/^-+|-+$/g, ''))
    .filter(w => w.length >= 4 && !STOP.has(w));
}
function discoverSites() {
  return fs.readdirSync(ROOT)
    .filter(d => { try { return fs.statSync(path.join(ROOT, d)).isDirectory(); } catch { return false; } })
    .filter(d => fs.existsSync(path.join(ROOT, d, 'website', 'api', 'entities.json')))
    .sort();
}

function main() {
  const t0 = Date.now();
  const sites = discoverSites();
  console.log(`[audit] 扫描 ${sites.length} 个站点`);

  // 作者名精确集合（2026-09-29 修复 ×2）
  //   第一次修：旧实现用词元匹配，"computer science" 这类通用词组被误判为人名。
  //   第二次修：加后缀索引后又误判——实测存在 "gaurika gupta computer science"
  //             这类机构后缀粘进姓名的畸形作者串，后缀 "computer science" 污染索引。
  //   最终：仅精确匹配 2–4 词的作者名，弃用后缀索引。
  //   倒序人名重复（"luigi Usai" / "Usai Luigi"）由下面的 reversedPairs 单独捕获。
  const authorNames = new Set();
  let malformedAuthors = 0;
  for (const site of sites) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, site, 'website', 'api', 'entities.json'), 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.entities || raw.data || []);
    for (const e of arr) {
      const authors = Array.isArray(e.authors) ? e.authors : [];
      for (const a of authors) {
        if (typeof a !== 'string') continue;
        const k = a.toLowerCase().trim().replace(/\s+/g, ' ');
        const parts = k.split(' ');
        if (parts.length < 2 || parts.length > 4) { malformedAuthors++; continue; }
        if (k.length < 4) continue;
        authorNames.add(k);
      }
    }
  }
  console.log(`[audit] 作者名精确集合 ${authorNames.size}（畸形作者串跳过 ${malformedAuthors}）（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  const tagDf = new Map();        // tag -> 实体数
  const tagRaw = new Map();       // tag -> 原始大小写样例
  const tagSampleEntity = new Map();
  let total = 0, withTags = 0;

  for (const site of sites) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, site, 'website', 'api', 'entities.json'), 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.entities || raw.data || []);
    for (const e of arr) {
      total++;
      const tags = e.tags || e.topics || e.keywords || [];
      if (!tags.length) continue;
      withTags++;
      const seen = new Set();
      for (const t of tags) {
        const k = String(t).toLowerCase().trim().replace(/\s+/g, ' ');
        if (seen.has(k)) continue;
        seen.add(k);
        tagDf.set(k, (tagDf.get(k) || 0) + 1);
        if (!tagRaw.has(k)) tagRaw.set(k, String(t));
        if (!tagSampleEntity.has(k)) tagSampleEntity.set(k, { site, name: String(e.name || e.title || '').slice(0, 90) });
      }
    }
  }
  console.log(`[audit] 实体 ${total}，有标签 ${withTags}，去重标签 ${tagDf.size}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  // ---- 1. 人名标签（仅精确匹配，见上方作者名集合注释）----
  const personTags = [];
  for (const [tag, n] of tagDf) {
    if (authorNames.has(tag)) personTags.push({ tag, n, sample: tagSampleEntity.get(tag) });
  }
  personTags.sort((a, b) => b.n - a.n);

  // ---- 2. 倒序重复 ----
  const tagSet = new Set(tagDf.keys());
  const reversedPairs = [];
  const seenRev = new Set();
  for (const tag of tagSet) {
    const parts = tag.split(' ');
    if (parts.length < 2) continue;
    const rev = parts.slice().reverse().join(' ');
    if (rev === tag || seenRev.has(rev)) continue;
    if (tagSet.has(rev)) {
      const pair = [tag, rev].sort();
      const key = pair.join('|');
      if (seenRev.has(key)) continue;
      seenRev.add(key);
      reversedPairs.push({ a: pair[0], b: pair[1], aN: tagDf.get(pair[0]), bN: tagDf.get(pair[1]) });
    }
  }
  reversedPairs.sort((x, y) => (y.aN + y.bN) - (x.aN + x.bN));

  // ---- 3. 单实体标签 / 4. 超宽标签 ----
  const singletons = [...tagDf.entries()].filter(([, n]) => n <= SINGLETON_MAX).sort((a, b) => a[1] - b[1]);
  const broad = [...tagDf.entries()].filter(([, n]) => n / withTags > BROAD_SHARE).sort((a, b) => b[1] - a[1]);

  // ---- 分布 ----
  const dist = { 1: 0, '2-5': 0, '6-20': 0, '21-100': 0, '101-1000': 0, '1000+': 0 };
  for (const [, n] of tagDf) {
    if (n === 1) dist[1]++;
    else if (n <= 5) dist['2-5']++;
    else if (n <= 20) dist['6-20']++;
    else if (n <= 100) dist['21-100']++;
    else if (n <= 1000) dist['101-1000']++;
    else dist['1000+']++;
  }

  // ---- 清洗后可用词表 ----
  const drop = new Set(personTags.map(p => p.tag));
  for (const p of reversedPairs) drop.add(p.a);          // 倒序对中保留频次更高的一方
  const cleaned = [...tagDf.entries()]
    .filter(([t, n]) => !drop.has(t) && n > SINGLETON_MAX && n / withTags <= BROAD_SHARE)
    .map(([t, n]) => ({ tag: t, n }))
    .sort((a, b) => b.n - a.n);

  const report = {
    generatedAt: new Date().toISOString(),
    corpus: { entities: total, withTags, distinctTags: tagDf.size, authorNames: authorNames.size },
    distribution: dist,
    issues: {
      personTags: {
        count: personTags.length,
        entitiesAffected: personTags.reduce((s, p) => s + p.n, 0),
        shareOfCorpus: +(personTags.reduce((s, p) => s + p.n, 0) / withTags).toFixed(4),
        top: personTags.slice(0, 40),
      },
      reversedDuplicates: {
        count: reversedPairs.length,
        top: reversedPairs.slice(0, 30),
      },
      singletons: { count: singletons.length, threshold: `<= ${SINGLETON_MAX}`, sample: singletons.slice(0, 20).map(([t, n]) => ({ tag: t, n })) },
      broad: { threshold: `> ${BROAD_SHARE} of ${withTags}`, count: broad.length, items: broad.slice(0, 30).map(([t, n]) => ({ tag: t, n, share: +(n / withTags).toFixed(4) })) },
    },
    cleanedVocabulary: {
      count: cleaned.length,
      dropped: { personTags: personTags.length, reversedDuplicates: reversedPairs.length, singletons: singletons.length, broad: broad.length },
      tags: cleaned,
    },
    elapsedMs: Date.now() - t0,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1), 'utf8');

  console.log(`\n=== 标签体系审计 ===`);
  console.log(`去重标签        : ${tagDf.size}`);
  console.log(`作者名精确集合 : ${authorNames.size} 个`);
  console.log(`① 人名标签      : ${personTags.length} 个，影响 ${report.issues.personTags.entitiesAffected} 条 (${(report.issues.personTags.shareOfCorpus * 100).toFixed(1)}%)`);
  console.log(`② 倒序重复      : ${reversedPairs.length} 对`);
  console.log(`③ 单实体标签    : ${singletons.length} 个 (<=${SINGLETON_MAX} 条)`);
  console.log(`④ 超宽标签      : ${broad.length} 个 (>${BROAD_SHARE * 100}%)`);
  console.log(`分布            : ${JSON.stringify(dist)}`);
  console.log(`清洗后可用词表  : ${cleaned.length} 个标签`);
  console.log(`\nTop 人名标签:`);
  for (const p of personTags.slice(0, 8)) console.log(`  ${p.tag.padEnd(28)} n=${String(p.n).padStart(5)}  ${p.sample.name.slice(0, 50)}`);
  console.log(`\nTop 倒序重复对:`);
  for (const p of reversedPairs.slice(0, 6)) console.log(`  "${p.a}" (${p.aN}) ↔ "${p.b}" (${p.bN})`);
  console.log(`\nTop 超宽标签:`);
  for (const [t, n] of broad.slice(0, 8)) console.log(`  ${t.padEnd(34)} n=${n}  ${(n / withTags * 100).toFixed(1)}%`);
  console.log(`\n清洗后词表 Top 15:`);
  for (const { tag, n } of cleaned.slice(0, 15)) console.log(`  ${tag.padEnd(34)} n=${n}`);
  console.log(`\n报告 → ${path.relative(ROOT, OUT)}`);
}

main();
