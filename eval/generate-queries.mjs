#!/usr/bin/env node
/**
 * eval/generate-queries.mjs
 *
 * 生成可复现的检索评测集。报告 §8 T1-4「可复现评测 + 公开 leaderboard」的骨架。
 *
 * 思路：从每个站点的实体中抽样，用 title + tags + abstract 前 N 词作为 query，
 * 该实体 id 作为 ground truth（relevant 集合只有 1 条 —— 单文档相关集）。
 * 这不是"完美"的人工标注评测集，但：
 *   1. 完全可复现（种子固定、抽样算法固定）
 *   2. 与我们的检索栈（BM25/token-match）直接对齐——query 词就是实体自身字段词，
 *      任何正确检索器都应召回 target 实体
 *   3. 一旦换到向量检索（T1-3），可零成本复用同一份评测集对比基线
 *
 * 用法
 *   node eval/generate-queries.mjs                # 每站抽 5 条，共 ~150 条
 *   node eval/generate-queries.mjs --per-site=10  # 更多样本
 *   node eval/generate-queries.mjs --seed=2026    # 换随机种子
 *   node eval/generate-queries.mjs --dry-run      # 只打印统计
 *
 * 输出
 *   eval/queries.jsonl              # JSONL 格式（每行一条 query）
 *   eval/queries.manifest.json      # 元信息（种子、样本量、生成时间、每站分布）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'eval');

function parseArgs() {
  const argv = process.argv.slice(2);
  const args = { perSite: 5, seed: 20261010, dryRun: false };
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

/** 从实体生成 query 文本 */
function queryFor(entity) {
  const parts = [];
  if (entity.name) parts.push(entity.name);
  if (Array.isArray(entity.tags)) parts.push(...entity.tags.slice(0, 3));
  if (entity.abstract) {
    // 取 abstract 前 20 词，去掉过长摘要的噪声
    const words = entity.abstract.split(/\s+/).slice(0, 20).join(' ');
    parts.push(words);
  }
  return parts.join(' ').slice(0, 400);
}

function stationSlugs() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory()
      && fs.existsSync(path.join(ROOT, e.name, 'website', 'api', 'entities.json')))
    .map((e) => e.name)
    .sort();
}

function main() {
  const args = parseArgs();
  const rng = mulberry32(args.seed);
  const slugs = stationSlugs();
  const out = [];
  const perStation = {};

  for (const slug of slugs) {
    const p = path.join(ROOT, slug, 'website', 'api', 'entities.json');
    let raw;
    try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const entities = Array.isArray(raw) ? raw : (raw.entities || []);
    if (entities.length === 0) { perStation[slug] = 0; continue; }

    // 优先挑"信息量足"的实体：有 title + tags + abstract 中至少 2 项非空
    const scored = entities.map((e) => ({
      e,
      score: (e.name ? 1 : 0) + (Array.isArray(e.tags) && e.tags.length ? 1 : 0) + (e.abstract ? 1 : 0) + rng() * 0.5,
    })).sort((a, b) => b.score - a.score);

    const picked = [];
    const target = Math.min(args.perSite, scored.length);
    while (picked.length < target) {
      const idx = Math.floor(rng() * scored.length);
      const cand = scored[idx];
      if (!picked.some((x) => x.e.id === cand.e.id)) picked.push(cand);
    }

    for (const { e } of picked) {
      const q = queryFor(e);
      if (q.length < 20) continue; // 太短的 query 没有信息量
      out.push({
        query: q,
        site: slug,
        relevantIds: [e.id], // 单文档相关集
        // 保留一些原字段便于调试，但**不进评测指标**
        groundTruth: {
          name: e.name,
          doi: e.doi || null,
          tags: Array.isArray(e.tags) ? e.tags.slice(0, 3) : [],
        },
      });
    }
    perStation[slug] = picked.length;
  }

  // 打乱顺序（否则按站聚集，检索器可能被"站先验"帮到）
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  console.log(`[eval/gen] 站点 ${slugs.length} 个 | query ${out.length} 条 | 每站 ${args.perSite} | 种子 ${args.seed}`);

  if (args.dryRun) {
    console.log(`[eval/gen] --dry-run：不落盘`);
    console.log(`[eval/gen] 每站分布:`);
    for (const s in perStation) console.log(`  ${s}: ${perStation[s]}`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonl = out.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(OUT_DIR, 'queries.jsonl'), jsonl, 'utf8');

  const manifest = {
    generatedAt: new Date().toISOString(),
    generator: 'eval/generate-queries.mjs',
    seed: args.seed,
    perSite: args.perSite,
    totalQueries: out.length,
    perStation,
    // 与哪些数据文件对齐
    dataSources: slugs.map((s) => `${s}/website/api/entities.json`),
    // 使用契约：
    // 1. 评测时，任何检索器都必须返回一个 top-K 有序列表
    // 2. 指标：nDCG@10 与 Recall@10，均基于 relevantIds 单文档相关集
    // 3. 换随机种子 = 换一批 query，不是同一个 benchmark
    // 4. 修改 queries.jsonl 会导致 baseline 与 leaderboard 不可比 —— 用 manifest 做指纹
    fingerprint: crypto.createHash('sha256').update(jsonl).digest('hex').slice(0, 16),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'queries.manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`[eval/gen] 已写入 eval/queries.jsonl (${out.length} 条)`);
  console.log(`[eval/gen] 已写入 eval/queries.manifest.json (指纹 ${manifest.fingerprint})`);
}

main();
