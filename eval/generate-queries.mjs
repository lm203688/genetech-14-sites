#!/usr/bin/env node
/**
 * eval/generate-queries.mjs（10-13 重写：查询与答案不同源）
 * ----------------------------------------------------------------------------
 * 旧版问题（10-13 报告 N3）：query = 目标实体自己的 name + tags + abstract 前 20 词，
 * 答案就嵌在 query 里 → Recall@10 = 100% / missCount = 0 是**构造保证的恒等式**，
 * 不是检索质量。leaderboard 展示 100% 会被读成质量结论（"绿灯 ≠ 有效"）。
 *
 * 本版改成四种**查询与答案不同源**的构造，mix 权重可复现（种子固定）：
 *
 *   type A「tags 反查」（40%）：
 *     query = 该实体的 tags（取 2 个），答案 = 实体本身 + 同 tag 其它实体。
 *     query 里**不含 name/abstract 任何字面词**，检索器必须靠 tags→实体的
 *     泛化能力命中，而非字面复制。同 tag 的其它实体也相关 → multi-relevant。
 *
 *   type B「摘要中段短语」（30%）：
 *     query = abstract 第 30-55 词（跳过开篇客套/背景），答案 = 实体本身。
 *     首词往往就是标题词（旧版取前 20 词 = 变相抄答案），中段是方法/结果
 *     细节，与标题字面重合度低。
 *
 *   type C「跨实体关键词交叉」（20%）：
 *     query = 同站另一实体的 2 个 tags + 本实体的 1 个 tag（混合），
 *     答案 = 两个实体（multi-relevant，|relevant|=2）。
 *     考查"部分词命中不同实体"时的排序能力，恢复 NDCG 区分度。
 *
 *   type D「站点级主题词」（10%）：
 *     query = 该实体第 1 个 tag，答案 = 同 tag 下所有实体（multi-relevant）。
 *     最接近真实使用的"按主题浏览"查询。
 *
 * multi-relevant 的作用：单文档相关集下 Recall/MRR 上限就是 1，无法区分
 * "排第 1"和"排第 3"；多文档相关集让 NDCG 真正有斜率。
 *
 * 保留 groundTruth 便于人工抽查，但**不进评测指标**。
 * manifest.fingerprint 仍是 queries.jsonl 的 sha256 前 16 位——换构造方式
 * = 换 benchmark，baseline 与 leaderboard 必须用同一指纹。
 *
 * 用法
 *   node eval/generate-queries.mjs                # 每站 10 条，共 ~296 条
 *   node eval/generate-queries.mjs --per-site=20  # 更多样本
 *   node eval/generate-queries.mjs --seed=20261013
 *   node eval/generate-queries.mjs --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'eval');

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = { perSite: 10, seed: 20261013, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--per-site=')) args.perSite = parseInt(a.slice(11), 10);
    else if (a.startsWith('--seed=')) args.seed = parseInt(a.slice(7), 10);
  }
  return args;
}

/** 确定性 PRNG（mulberry32），保证不同机器上抽样一致 */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** tag 清洗：去单字符、纯数字、过长（URL 残渣） */
function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map(String)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && t.length <= 40 && !/^\d+$/.test(t));
}

/** 停用词：无区分度的通用词（跨实体高频，进了 query 只会稀释信号） */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'using', 'based',
  'study', 'studies', 'paper', 'results', 'result', 'method', 'methods',
  'approach', 'analysis', 'review', 'article', 'research', 'new', 'novel',
]);

function words(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5+#.-]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

function stationSlugs() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory()
      && fs.existsSync(path.join(ROOT, e.name, 'website', 'api', 'entities.json')))
    .map((e) => e.name)
    .sort();
}

/** 同 tag 实体索引：tag -> [entityId,...]（multi-relevant 用） */
function buildTagIndex(entities) {
  const idx = new Map();
  for (const e of entities) {
    for (const t of cleanTags(e.tags)) {
      if (!idx.has(t)) idx.set(t, []);
      idx.get(t).push(e.id);
    }
  }
  return idx;
}

/**
 * 生成一条评测样本。返回 null 表示该实体信息量不足（跳过）。
 * type 由 rng 决定（40/30/20/10 权重）。
 */
function makeSample(entity, entities, tagIdx, rng) {
  const tags = cleanTags(entity.tags);
  const absWords = words(entity.abstract);
  const roll = rng();

  // ---- type A：tags 反查（40%）----
  if (roll < 0.4 && tags.length >= 2) {
    const picked = [];
    const pool = [...tags];
    while (picked.length < 2 && pool.length) {
      const i = Math.floor(rng() * pool.length);
      picked.push(pool.splice(i, 1)[0]);
    }
    // relevant = 同 tag 的其它实体（multi-relevant），上限 8 条防集合爆炸
    const rel = new Set();
    for (const t of picked) {
      for (const id of (tagIdx.get(t) || [])) {
        if (id !== entity.id) rel.add(id);
        if (rel.size >= 8) break;
      }
    }
    rel.add(entity.id);
    if (rel.size < 2) return null;
    return {
      type: 'tags-inverse',
      query: picked.join(' '),
      relevantIds: [...rel].slice(0, 9),
      targetId: entity.id,
      groundTruth: { name: entity.name, doi: entity.doi || null },
    };
  }

  // ---- type B：摘要中段短语（30%）----
  if (roll < 0.7 && absWords.length >= 40) {
    const mid = absWords.slice(30, 55);
    if (mid.length < 8) return null;
    return {
      type: 'abstract-mid',
      query: mid.slice(0, 18).join(' '),
      relevantIds: [entity.id],
      targetId: entity.id,
      groundTruth: { name: entity.name, doi: entity.doi || null },
    };
  }

  // ---- type C：跨实体关键词交叉（20%）----
  if (roll < 0.9 && tags.length >= 1 && entities.length > 10) {
    const other = entities[Math.floor(rng() * entities.length)];
    if (!other || other.id === entity.id) return null;
    const otherTags = cleanTags(other.tags);
    if (otherTags.length < 1) return null;
    const a = tags[Math.floor(rng() * tags.length)];
    const b1 = otherTags[0];
    const b2 = otherTags[1] || '';
    const rel = new Set([entity.id, other.id]);
    // 同 tag 共现的第三实体（上限 5）
    for (const t of [a, b1]) {
      for (const id of (tagIdx.get(t) || [])) {
        rel.add(id);
        if (rel.size >= 5) break;
      }
    }
    if (rel.size < 2) return null;
    return {
      type: 'cross-entity',
      query: [a, b1, b2].filter(Boolean).join(' '),
      relevantIds: [...rel].slice(0, 5),
      targetId: entity.id,
      groundTruth: { name: entity.name, doi: entity.doi || null },
    };
  }

  // ---- type D：站点级主题词（10%）----
  if (tags.length >= 1) {
    const t = tags[0];
    const rel = new Set([entity.id]);
    for (const id of (tagIdx.get(t) || [])) {
      rel.add(id);
      if (rel.size >= 6) break;
    }
    if (rel.size < 2) return null;
    return {
      type: 'site-topic',
      query: t,
      relevantIds: [...rel].slice(0, 6),
      targetId: entity.id,
      groundTruth: { name: entity.name, doi: entity.doi || null },
    };
  }

  return null;
}

function main() {
  const args = parseArgs();
  const rng = mulberry32(args.seed);
  const slugs = stationSlugs();
  const out = [];
  const perStation = {};
  const typeCount = { 'tags-inverse': 0, 'abstract-mid': 0, 'cross-entity': 0, 'site-topic': 0 };

  for (const slug of slugs) {
    const p = path.join(ROOT, slug, 'website', 'api', 'entities.json');
    let raw;
    try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const entities = Array.isArray(raw) ? raw : (raw.entities || []);
    if (entities.length === 0) { perStation[slug] = 0; continue; }

    const tagIdx = buildTagIndex(entities);
    const picked = [];
    const seenIds = new Set();
    let guard = 0;
    while (picked.length < args.perSite && guard < args.perSite * 30) {
      guard++;
      const cand = entities[Math.floor(rng() * entities.length)];
      if (!cand || seenIds.has(cand.id)) continue;
      const sample = makeSample(cand, entities, tagIdx, rng);
      if (!sample) continue;
      seenIds.add(cand.id);
      picked.push({ ...sample, site: slug });
      typeCount[sample.type]++;
    }
    perStation[slug] = picked.length;
    out.push(...picked);
  }

  // 打乱顺序（否则按站聚集，检索器可能被"站先验"帮到）
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  const multiCount = out.filter((r) => r.relevantIds.length > 1).length;
  console.log(`[eval/gen] 站点 ${slugs.length} 个 | query ${out.length} 条 | 每站 <=${args.perSite} | 种子 ${args.seed}`);
  console.log(`[eval/gen] 构造分布: ${Object.entries(typeCount).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`[eval/gen] multi-relevant 样本: ${multiCount}/${out.length}（${out.length ? ((multiCount / out.length) * 100).toFixed(1) : 0}%）`);

  if (args.dryRun) {
    console.log('[eval/gen] --dry-run：不落盘');
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonl = out.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(OUT_DIR, 'queries.jsonl'), jsonl, 'utf8');

  const manifest = {
    generatedAt: new Date().toISOString(),
    generator: 'eval/generate-queries.mjs',
    version: 2, // 10-13 N3：查询与答案不同源（v1 = 循环构造，Recall 恒 100%）
    seed: args.seed,
    perSite: args.perSite,
    totalQueries: out.length,
    multiRelevantCount: multiCount,
    constructionTypes: typeCount,
    constructionNote:
      'v2 查询与答案不同源：A=tags反查(40%) B=摘要中段(30%) C=跨实体交叉(20%) D=站点主题(10%)。' +
      'relevant 为 multi-relevant（同 tag/共现实体），Recall/MRR 不再有构造性上限 1。' +
      'v1 指纹不同，两版 benchmark 不可直接比分。',
    perStation,
    dataSources: slugs.map((s) => `${s}/website/api/entities.json`),
    fingerprint: crypto.createHash('sha256').update(jsonl).digest('hex').slice(0, 16),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'queries.manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`[eval/gen] 已写入 eval/queries.jsonl (${out.length} 条)`);
  console.log(`[eval/gen] 已写入 eval/queries.manifest.json (指纹 ${manifest.fingerprint})`);
}

main();
