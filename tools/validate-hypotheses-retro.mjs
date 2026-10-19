#!/usr/bin/env node
/**
 * tools/validate-hypotheses-retro.mjs
 *
 * 回溯验证（无需人类专家）：证明"共享主题但历史零引用"的跨域桥接规则
 * 能预测真实涌现的跨域连接 —— 即本项目假设生成方法的有效性。
 *
 * 方法（Swanson 式 retrospective validation）：
 *   1. 以 T0 为切分点，只用 publishedDate < T0 的引用边定义"历史状态"。
 *   2. 候选桥 = 两个域"共享 ≥1 个 tag"但历史引用数 == 0 的域对（完全复刻假设卡的生成规则）。
 *   3. 验证：同一域对在 T0 之后（publishedDate ≥ T0）是否真出现了引用 → "涌现命中"。
 *   4. 与随机域对涌现率对比，给出 lift（证明共享主题信号胜过随机）。
 *
 * 这是方法/数据类论文可接受的主要验证手段，完全离线、可复现。
 *
 * 用法：
 *   node tools/validate-hypotheses-retro.mjs --t0=2023-01-01
 *   node tools/validate-hypotheses-retro.mjs --t0=2022-01-01
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const T0 = process.argv.find(a => a.startsWith('--t0='))?.slice(5) || '2023-01-01';
const T0Y = parseInt(T0.slice(0, 4), 10);

// 1) 站点标签集 + id->年份 + doi->标签（用于"特定主题涌现"收紧）
const sites = fs.readdirSync(ROOT).filter(d =>
  fs.existsSync(path.join(ROOT, d, 'website/api/entities.json')));
const siteTags = new Map();
const idYear = new Map();
const doiTags = new Map();
for (const s of sites) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, s, 'website/api/entities.json'), 'utf8'));
  const arr = Array.isArray(raw) ? raw : (raw.entities || []);
  const tags = new Set();
  for (const e of arr) {
    if (e.id) {
      const y = parseInt(String(e.publishedDate || '').slice(0, 4), 10);
      if (!isNaN(y)) {
        idYear.set(e.id, y);
        if (e.doi) idYear.set(e.doi, y); // 引用边 citing 用裸 DOI，需按 doi 匹配
      }
    }
    for (const t of (e.tags || [])) tags.add(t);
    if (e.doi) {
      if (!doiTags.has(e.doi)) doiTags.set(e.doi, new Set());
      for (const t of (e.tags || [])) doiTags.get(e.doi).add(t);
    }
  }
  siteTags.set(s, tags);
}

// 2) 引用边按时间分桶
const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/citation-edges.json'), 'utf8'));
const edges = c.edges || [];
const hist = new Map();
const post = new Map();
const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
let skip = 0;
for (const e of edges) {
  const y = idYear.get(e.citing);
  if (y === undefined) { skip++; continue; }
  const k = e.fromSite + '|' + e.toSite;
  if (y < T0Y) inc(hist, k); else inc(post, k);
}

// 3) 生成候选桥（共享主题但历史零引用）
const pairs = [];
for (let i = 0; i < sites.length; i++) {
  for (let j = 0; j < sites.length; j++) {
    if (i === j) continue;
    const A = sites[i], B = sites[j];
    const shared = [...siteTags.get(A)].filter(t => siteTags.get(B).has(t));
    if (!shared.length) continue;
    const k = A + '|' + B;
    if ((hist.get(k) || 0) === 0) {
      pairs.push({ A, B, sharedCount: shared.length, sharedSample: shared.slice(0, 5), post: post.get(k) || 0 });
    }
  }
}

// 3b) "特定主题涌现"收紧：从 post-T0 边中找出端点（citing/cited DOI）标签命中共享主题的边
//     → 只有"在共享主题上"真出现引用的域对，才算方法真正预测的涌现（而非泛泛互引）。
const sharedSetByPair = new Map();
for (const p of pairs) sharedSetByPair.set(p.A + '|' + p.B, new Set(p.sharedSample));
const topicSpecificHit = new Set();
for (const e of edges) {
  const y = idYear.get(e.citing);
  if (y === undefined || y < T0Y) continue;
  const k = e.fromSite + '|' + e.toSite;
  const ss = sharedSetByPair.get(k);
  if (!ss || !ss.size) continue;
  const tagsCiting = doiTags.get(e.citing), tagsCited = doiTags.get(e.cited);
  const hit = (tagsCiting && [...tagsCiting].some(t => ss.has(t))) ||
              (tagsCited && [...tagsCited].some(t => ss.has(t)));
  if (hit) topicSpecificHit.add(k);
}

// 4) 统计 + 随机基线
const emerged = pairs.filter(p => p.post > 0);
const emergedTopicSpecific = emerged.filter(p => topicSpecificHit.has(p.A + '|' + p.B));
const nonObvious = pairs.filter(p => p.sharedCount <= 2); // 仅 1-2 个共享主题 = 更具体的桥
const allPairs = [];
for (let i = 0; i < sites.length; i++) for (let j = 0; j < sites.length; j++) if (i !== j) allPairs.push(sites[i] + '|' + sites[j]);
const randEmergence = allPairs.reduce((a, k) => a + ((post.get(k) || 0) > 0 ? 1 : 0), 0) / allPairs.length;
const emergenceRate = pairs.length ? emerged.length / pairs.length : 0;
const topicSpecificRate = pairs.length ? emergedTopicSpecific.length / pairs.length : 0;

// 4b) 反事实对照：**标签随机化 null 模型（permutation test）**
//     关键发现：30 站两两都至少共享 1 个 tag（不共享对数为 0），"不共享主题对"
//     这个反事实集在本数据上为空，无法直接对比。
//     正确做法：随机打乱各站标签集（保持每站标签数不变），重算"共享主题候选桥"
//     涌现率作为 null 基线。等价于置换检验的 H0：站点标签分配与涌现独立。
//     若"共享主题"是涌现的有效信号，则真实 lift 应显著 > 1。
const K = 100; // 采样次数
const rng = (n) => Math.floor(Math.random() * n);
let nullEmergenceSum = 0;
let nullPairCountTotal = 0;
for (let iter = 0; iter < K; iter++) {
  // 1) 收集所有站标签并 Fisher-Yates 洗牌（保持每站标签数不变）
  const allTags = [];
  const tagCounts = [];
  for (const s of sites) {
    const tags = [...siteTags.get(s)];
    tagCounts.push(tags.length);
    for (const t of tags) allTags.push(t);
  }
  for (let i = allTags.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [allTags[i], allTags[j]] = [allTags[j], allTags[i]];
  }
  // 2) 按原每站标签数重新切分（打乱后的"假站点标签"）
  const shuffledSiteTags = new Map();
  let idx = 0;
  for (let si = 0; si < sites.length; si++) {
    shuffledSiteTags.set(sites[si], new Set(allTags.slice(idx, idx + tagCounts[si])));
    idx += tagCounts[si];
  }
  // 3) 用打乱后的标签重算候选桥（共享主题 + 历史零引用）
  let nullPairs = 0, nullEmerged = 0;
  for (let i = 0; i < sites.length; i++) {
    for (let j = 0; j < sites.length; j++) {
      if (i === j) continue;
      const A = sites[i], B = sites[j];
      const shared = [...shuffledSiteTags.get(A)].filter(t => shuffledSiteTags.get(B).has(t));
      if (!shared.length) continue;
      const k = A + '|' + B;
      if ((hist.get(k) || 0) === 0) {
        nullPairs++;
        if ((post.get(k) || 0) > 0) nullEmerged++;
      }
    }
  }
  if (nullPairs > 0) {
    nullEmergenceSum += nullEmerged / nullPairs;
    nullPairCountTotal += nullPairs;
  }
}
const nullEmergenceRate = K ? nullEmergenceSum / K : 0;

const report = {
  method: 'retrospective-validation (Swanson-style)',
  generatedAt: new Date().toISOString(),
  T0, T0Y,
  sites: sites.length,
  candidateBridges: pairs.length,
  emergedBridges: emerged.length,
  emergenceRate,
  emergedTopicSpecific: emergedTopicSpecific.length,
  topicSpecificRate,
  nonObviousBridges: nonObvious.length,
  // 随机基线 1：任意域对的涌现率（弱对照，含"共享主题"贡献，偏乐观）
  randomPairEmerenceRate: randEmergence,
  // 随机基线 2：标签随机化 null 模型（permutation test，K=100）
  //   H0：站点标签分配与涌现独立；若"共享主题"是涌现的有效信号，则真实 lift > 1
  nullPermutationTrials: K,
  nullEmergenceRate,
  // lift_vs_randomPairs = 候选桥涌现率 / 任意对涌现率（原定义，保留以便对照）
  lift_vs_randomPairs: randEmergence ? emergenceRate / randEmergence : null,
  // lift = 候选桥涌现率 / null 涌现率（标签随机化对照，正确的 lift 定义）
  lift: nullEmergenceRate ? emergenceRate / nullEmergenceRate : null,
  // liftTopicSpecific_deprecated：原实现有 bug，分母用 randEmergence（含共享主题贡献），
  // 与分子"主题特定涌现"语义不对齐。此字段保留但标记为 deprecated。
  liftTopicSpecific_deprecated: randEmergence ? topicSpecificRate / randEmergence : null,
  // 正确的主题特定 lift：分子分母语义对齐——
  //   分子 = 真实共享主题候选桥的主题特定涌现率
  //   分母 = 标签随机化后的候选桥涌现率（null 基线）
  liftTopicSpecific: nullEmergenceRate ? topicSpecificRate / nullEmergenceRate : null,
  // 已涌现候选桥中"主题特定涌现"的占比（0-1，值越高说明方法预测越聚焦）
  topicSpecificShareOfEmerged: emerged.length ? emergedTopicSpecific.length / emerged.length : 0,
  edgesTotal: edges.length,
  edgesSkippedNoYear: skip,
  topExamples: emerged.sort((a, b) => b.post - a.post).slice(0, 20)
    .map(p => ({ pair: `${p.A}→${p.B}`, sharedTags: p.sharedSample, postCitations: p.post, topicSpecific: topicSpecificHit.has(p.A + '|' + p.B) })),
};
fs.mkdirSync('reports', { recursive: true });
const out = `reports/retro-validation-${T0}.json`;
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`[retro] 站点 ${sites.length} | 候选桥 ${pairs.length} | 涌现 ${emerged.length} (${(emergenceRate * 100).toFixed(1)}%) | 主题特定涌现 ${emergedTopicSpecific.length} (${(topicSpecificRate * 100).toFixed(1)}%)`);
console.log(`[retro] 任意对涌现率 ${(randEmergence * 100).toFixed(1)}% | 标签随机化 null 涌现率(${K}次) ${(nullEmergenceRate * 100).toFixed(1)}%`);
console.log(`[retro] lift(vs 任意对) ${report.lift_vs_randomPairs?.toFixed(3)} | lift(vs null 随机化) ${report.lift?.toFixed(3)} | lift(主题,vs null) ${report.liftTopicSpecific?.toFixed(3)} | 主题特定占已涌现 ${(report.topicSpecificShareOfEmerged * 100).toFixed(1)}%`);
console.log(`[retro] → ${out}`);
