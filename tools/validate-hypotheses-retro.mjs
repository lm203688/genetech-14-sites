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

// 1) 站点标签集 + id->年份
const sites = fs.readdirSync(ROOT).filter(d =>
  fs.existsSync(path.join(ROOT, d, 'website/api/entities.json')));
const siteTags = new Map();
const idYear = new Map();
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

// 4) 统计 + 随机基线
const emerged = pairs.filter(p => p.post > 0);
const allPairs = [];
for (let i = 0; i < sites.length; i++) for (let j = 0; j < sites.length; j++) if (i !== j) allPairs.push(sites[i] + '|' + sites[j]);
const randEmergence = allPairs.reduce((a, k) => a + ((post.get(k) || 0) > 0 ? 1 : 0), 0) / allPairs.length;
const emergenceRate = pairs.length ? emerged.length / pairs.length : 0;

const report = {
  method: 'retrospective-validation (Swanson-style)',
  generatedAt: new Date().toISOString(),
  T0, T0Y,
  sites: sites.length,
  candidateBridges: pairs.length,
  emergedBridges: emerged.length,
  emergenceRate,
  randomPairEmergenceRate: randEmergence,
  lift: randEmergence ? emergenceRate / randEmergence : null,
  edgesTotal: edges.length,
  edgesSkippedNoYear: skip,
  topExamples: emerged.sort((a, b) => b.post - a.post).slice(0, 20)
    .map(p => ({ pair: `${p.A}→${p.B}`, sharedTags: p.sharedSample, postCitations: p.post })),
};
fs.mkdirSync('reports', { recursive: true });
const out = `reports/retro-validation-${T0}.json`;
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`[retro] 站点 ${sites.length} | 候选桥 ${pairs.length} | 涌现 ${emerged.length} | 涌现率 ${(emergenceRate * 100).toFixed(1)}%`);
console.log(`[retro] 随机对涌现率 ${(randEmergence * 100).toFixed(1)}% | lift ${report.lift?.toFixed(2)} | 跳过无年份边 ${skip}`);
console.log(`[retro] → ${out}`);
