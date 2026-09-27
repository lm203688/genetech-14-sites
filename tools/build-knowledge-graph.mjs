#!/usr/bin/env node
/**
 * tools/build-knowledge-graph.mjs
 * 重建 GeneTech 实体级知识图谱（data/knowledge-graph.json + data/knowledge-graph-entities.json）。
 *
 * 设计目标：
 *  - 真正聚合全站 30 站 / 30 万实体（此前 pipeline-self-db-build.js 只产出 98 节点 / 0 边，是玩具图谱）。
 *  - 生成"有意义的关系"：跨站桥接 (cross_site) + 主题共现 (shared_tag，连到高屏标签枢纽)。
 *  - 有界可部署：节点上限 20k、边上限 90k、产物 ≤ 8MB（保护 Pages 99% 容量硬约束）。
 *
 * 用法：node tools/build-knowledge-graph.mjs [--dry-run] [--limit-nodes=20000] [--limit-edges=90000]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const REPORTS_DIR = path.join(ROOT, 'reports');

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
// 解析数字参数。注意：不能用 `Number(x) || default` —— 那样 --limit-cotopic=0
// 会被当成 falsy 而回落到默认 3000，导致限幅开关失效（2026-09-27 实测踩坑）。
function argNum(prefix, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  if (!hit) return fallback;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) ? n : fallback;
}
const LIMIT_NODES = argNum('--limit-nodes=', 14000);
const LIMIT_EDGES = argNum('--limit-edges=', 90000);
// 产物体积硬上限。约束依据是 Pages 容量而非本文件自身：
//   Pages 单仓库上限约 1014MB；_site 实测约 654MB（2026-09-24 清理后），余量约 360MB。
//   本图谱写两个副本（knowledge-graph.json + knowledge-graph-entities.json），
//   14k 节点 / 72k 边时每个约 11.7MB，合计约 23.5MB ≈ 余量的 6.5%，安全。
// 早期该上限曾被设为 9MB，导致 14k 节点的全覆盖图谱被强制降级到 10k 节点，
// 反而牺牲了跨站桥接覆盖度（项目核心差异化能力）。现按真实余量重设为 12MB。
const MAX_BYTES = 12 * 1024 * 1024;
// 实体-实体直接边（co_topic）预算：共享 ≥2 个枢纽标签的实体对。
// 2026-09-27 实测：按「每标签 Top60 实体」抽样，299,274 个组合中有 266,567 对
// 共享 ≥2 标签。全量展开会远超 9MB 产物上限，故硬限幅并让枢纽边优先占预算。
const LIMIT_CO_TOPIC_EDGES = argNum('--limit-cotopic=', 3000);
const CO_TOPIC_TAG_MEMBER_CAP = 60;

const isStation = (name) => !name.startsWith('.') && !name.startsWith('_');

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function main() {
  const t0 = Date.now();
  console.log('[kg] 扫描站点实体…');
  const stations = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && isStation(e.name))
    .map(e => e.name);

  // id -> 所属站集合
  const entitySites = new Map();
  // id -> { name, source, url, confidence, tags:Set }
  const meta = new Map();
  const tagCount = new Map();

  let entityTotal = 0;
  for (const st of stations) {
    const p = path.join(ROOT, st, 'website/api/entities.json');
    const arr = readJsonSafe(p);
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      if (!x || !x.id) continue;
      entityTotal++;
      if (!entitySites.has(x.id)) entitySites.set(x.id, new Set());
      entitySites.get(x.id).add(st);
      let m = meta.get(x.id);
      if (!m) { m = { name: x.name || x.title || x.id, source: x.source || '', url: x.url || '', confidence: x.confidence || 0, tags: new Set() }; meta.set(x.id, m); }
      if (x.confidence != null) m.confidence = Math.max(m.confidence, x.confidence || 0);
      if (x.url) m.url = x.url;
      if (Array.isArray(x.tags)) for (const t of x.tags) { if (t) { m.tags.add(t); tagCount.set(t, (tagCount.get(t) || 0) + 1); } }
    }
  }
  console.log(`[kg] 站点 ${stations.length} | 实体记录 ${entityTotal} | 唯一实体 ${meta.size} | 标签种类 ${tagCount.size}`);

  // 跨站实体（桥接信号，最有价值）
  const crossSite = [];
  for (const [id, sites] of entitySites) if (sites.size > 1) crossSite.push(id);
  console.log(`[kg] 跨站实体（桥接）: ${crossSite.length}`);

  // 标签枢纽：出现频次 Top-N
  const TAG_HUBS = 300;
  const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, TAG_HUBS).map(e => e[0]);
  const topTagSet = new Set(topTags);
  console.log(`[kg] 标签枢纽 Top${TAG_HUBS} 已选`);

  // 选定实体节点：跨站实体（桥接信号，优先）+ 高频标签实体（按置信度补位）。
  // 注意：LIMIT_NODES 是**硬上限**，跨站实体超量时也要按置信度裁剪。
  // 此前实现无条件塞入全部 12,862 个跨站实体，导致 --limit-nodes 低于该值时
  // 完全不生效、产物体积失控（2026-09-27 实测，11.44MB > 9MB 上限）。
  const nodeIds = new Set();
  const crossSiteTrimmed = crossSite.length > LIMIT_NODES;
  const rankedCross = crossSite
    .sort((a, b) => meta.get(b).confidence - meta.get(a).confidence)
    .slice(0, LIMIT_NODES);
  rankedCross.forEach(id => nodeIds.add(id));
  if (crossSiteTrimmed) {
    console.log(`[kg] 跨站实体 ${crossSite.length} 超过节点上限，按置信度裁剪至 ${LIMIT_NODES}`);
  }
  if (nodeIds.size < LIMIT_NODES) {
    const rest = [...meta.keys()]
      .filter(id => !nodeIds.has(id) && (meta.get(id).tags.size >= 3))
      .sort((a, b) => meta.get(b).confidence - meta.get(a).confidence)
      .slice(0, LIMIT_NODES - nodeIds.size);
    rest.forEach(id => nodeIds.add(id));
  }
  console.log(`[kg] 实体节点数: ${nodeIds.size}`);

  const nodes = [];
  const idIndex = new Map(); // 新索引 id -> 数组下标
  let idx = 0;
  // 站枢纽节点
  for (const st of stations) { nodes.push({ id: `station:${st}`, name: st, type: 'station' }); idIndex.set(`station:${st}`, idx++); }
  // 标签枢纽节点
  for (const t of topTags) { nodes.push({ id: `tag:${t}`, name: t, type: 'tag', weight: tagCount.get(t) }); idIndex.set(`tag:${t}`, idx++); }
  // 实体节点
  for (const id of nodeIds) {
    const m = meta.get(id);
    nodes.push({
      id,
      name: m.name,
      type: 'entity',
      source: m.source,
      confidence: +m.confidence.toFixed(3),
      url: m.url,
      sites: [...entitySites.get(id)],
      // 标签关系已由 shared_tag 边表达，节点内仅保留用于枢纽定位的精简标签，控制产物体积（保护 Pages 容量）
      tags: [...m.tags].filter(t => topTagSet.has(t)).slice(0, 4),
    });
    idIndex.set(id, idx++);
  }
  console.log(`[kg] 总节点: ${nodes.length} (站 ${stations.length} + 标签 ${topTags.length} + 实体 ${nodeIds.size})`);

  // 边：跨站桥接（实体→站枢纽）+ 主题共现（实体→标签枢纽）
  const edges = [];
  const seen = new Set();
  const pushEdge = (s, t, relation, weight) => {
    if (edges.length >= LIMIT_EDGES) return false;
    const sk = `${s}|${t}`;
    if (seen.has(sk)) return true;
    seen.add(sk);
    edges.push({ source: s, target: t, relation, weight: weight || 1 });
    return true;
  };
  for (const id of nodeIds) {
    const sites = entitySites.get(id);
    for (const st of sites) pushEdge(id, `station:${st}`, 'cross_site');
    const m = meta.get(id);
    let w = 0;
    for (const t of m.tags) if (topTagSet.has(t)) { if (!pushEdge(id, `tag:${t}`, 'shared_tag')) break; w++; }
  }
  console.log(`[kg] 枢纽边: ${edges.length} (cross_site + shared_tag)`);

  // ---- 实体-实体直接边（co_topic）：共享 ≥2 个枢纽标签的实体对 ----
  // 用途：让「相似实体 / 跨域桥接」可一跳直达，不必经标签枢纽中转。
  // 算力护栏：每个标签只取置信度最高的 CO_TOPIC_TAG_MEMBER_CAP 个成员参与配对，
  // 避免大标签的 O(n²) 爆炸；枢纽边已先占预算，本层只能在剩余预算内出边。
  const tagMembers = new Map(); // tag -> [entityId, ...]
  for (const id of nodeIds) {
    const m = meta.get(id);
    if (!m || m.tags.size < 2) continue;
    for (const t of m.tags) {
      if (!topTagSet.has(t)) continue;
      if (!tagMembers.has(t)) tagMembers.set(t, []);
      tagMembers.get(t).push(id);
    }
  }
  for (const [, ids] of tagMembers) ids.sort((a, b) => meta.get(b).confidence - meta.get(a).confidence);

  const pairScore = new Map(); // "a|b" -> 共享标签数
  let pairCandidates = 0;
  for (const [t, ids] of tagMembers) {
    const head = ids.slice(0, CO_TOPIC_TAG_MEMBER_CAP);
    for (let i = 0; i < head.length; i++)
      for (let j = i + 1; j < head.length; j++) {
        const k = [head[i], head[j]].sort().join('|');
        pairScore.set(k, (pairScore.get(k) || 0) + 1);
        pairCandidates++;
      }
  }
  const coTopicPairs = [...pairScore.entries()]
    .filter(([, v]) => v >= 2)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, LIMIT_CO_TOPIC_EDGES);

  const budgetLeft = Math.max(0, LIMIT_EDGES - edges.length);
  let coTopic = 0;
  for (const [k, score] of coTopicPairs) {
    if (coTopic >= budgetLeft) break;
    const [a, b] = k.split('|');
    const sk = `${a}|${b}`;
    if (seen.has(sk)) continue;
    seen.add(sk);
    edges.push({ source: a, target: b, relation: 'co_topic', weight: score });
    coTopic++;
  }
  console.log(`[kg] co_topic 候选对 ${pairCandidates} | 共享≥2标签 ${pairScore.size} | 产出直接边 ${coTopic}`);
  console.log(`[kg] 边数合计: ${edges.length}`);

  const graph = {
    builtAt: new Date().toISOString(),
    version: 3,
    schema: 'genetech-knowledge-graph/v3',
    stats: {
      stations: stations.length,
      uniqueEntities: meta.size,
      crossSiteEntities: crossSite.length,
      tagKinds: tagCount.size,
      nodes: nodes.length,
      edges: edges.length,
      crossSiteEdges: edges.filter((e) => e.relation === 'cross_site').length,
      sharedTagEdges: edges.filter((e) => e.relation === 'shared_tag').length,
      coTopicEdges: coTopic,
      entityEntityEdges: coTopic,
      pairCandidates,
    },
    nodes,
    edges,
  };

  const json = JSON.stringify(graph);
  console.log(`[kg] 产物体积: ${(json.length / 1024 / 1024).toFixed(2)} MB`);
  if (json.length > MAX_BYTES) {
    console.error(`[kg][WARN] 产物 ${(json.length/1024/1024).toFixed(2)}MB 超过 ${MAX_BYTES/1024/1024}MB 上限，请下调 LIMIT 后重试（保护 Pages 容量）。`);
  }

  // ---- 回归护栏（2026-09-27 新增）----
  // CI runner 若拉取到的站点数据不完整（部分 */website/api/entities.json 缺失或为空），
  // 会产出退化图谱。必须保留旧图谱，避免把 14k/37k 的好图谱回退成 98/0 的空壳。
  // 判定：新图谱节点或边数低于旧图谱的 50%（旧图谱 ≥1000 节点时生效）即拒绝写入。
  const existing = readJsonSafe(path.join(DATA_DIR, 'knowledge-graph.json'));
  const oldNodes = Array.isArray(existing?.nodes) ? existing.nodes.length : 0;
  const oldEdges = Array.isArray(existing?.edges) ? existing.edges.length : 0;
  if (!DRY && oldNodes >= 1000 && (nodes.length < oldNodes * 0.5 || edges.length < oldEdges * 0.5)) {
    console.error(
      `[kg][ABORT] 新图谱 ${nodes.length} 节点 / ${edges.length} 边，低于旧图谱 ${oldNodes} 节点 / ${oldEdges} 边的 50%。\n` +
      `[kg][ABORT] 判定为站点数据不全导致的退化图谱，拒绝写入 data/knowledge-graph.json。请检查 runner 上 */website/api/entities.json 的完整性后重跑。`
    );
    process.exit(3);
  }

  if (!DRY) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'knowledge-graph.json'), json);
    // 部署副本（与旧文件名保持一致，供下游消费）
    fs.writeFileSync(path.join(DATA_DIR, 'knowledge-graph-entities.json'), json);
    const report = { pipeline: 'build-knowledge-graph', timestamp: graph.builtAt, dryRun: false, ...graph.stats, bytes: json.length };
    fs.writeFileSync(path.join(REPORTS_DIR, `report-knowledge-graph-${Date.now()}.json`), JSON.stringify(report, null, 2));
    // 保留策略：本脚本已接入每日 CI（ops-extra.yml 的 kgbuild 任务），
    // 时间戳报告文件会无限累积。只保留最近 KEEP_REPORTS 份，避免仓库噪声。
    const KEEP_REPORTS = argNum('--keep-reports=', 30);
    const keep = fs.readdirSync(REPORTS_DIR)
      .filter((f) => /^report-knowledge-graph-\d+\.json$/.test(f))
      .sort()
      .slice(-KEEP_REPORTS);
    const stale = fs.readdirSync(REPORTS_DIR)
      .filter((f) => /^report-knowledge-graph-\d+\.json$/.test(f) && !keep.includes(f));
    for (const f of stale) {
      try { fs.unlinkSync(path.join(REPORTS_DIR, f)); } catch { /* 删除失败不影响主流程 */ }
    }
    if (stale.length) console.log(`[kg] 已清理过期报告 ${stale.length} 份（保留最近 ${KEEP_REPORTS} 份）`);
    console.log(`[kg] 已写入 data/knowledge-graph.json + data/knowledge-graph-entities.json`);
  } else {
    console.log('[kg] dry-run，未写入');
  }
  console.log(`[kg] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}


// CLI 守卫：本脚本被 ops-extra.yml 的 kgbuild 任务直接执行，但也可能被其他
// 脚本 import 复用。与 insights-narrate.mjs 同类风险 —— 若无守卫，被 import
// 时顶层 main() 会杀掉宿主进程（tools/check-build-contract.mjs 的 cli-guard 检查）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
