#!/usr/bin/env node
/**
 * scripts/rebuild-time-machine.mjs
 *
 * 用途：
 *   - 从 data/knowledge-graph.json 生成 data/time-machine/snapshots.json 的 live 快照
 *   - 支持 --query <YYYY-MM-DD> 查询给定日期最近的快照
 *   - 支持 --append-live 把当前生产快照追加到已有 snapshots.json
 *
 * 契约（time-machine v1）：
 *   - milestone anchor 快照只存元数据占位（无实测 nodes/edges）
 *   - live 快照存完整 stats + edge relation 分布 + tier 分布
 *   - 3 个固定锚点：2026-06-01(v1) / 2026-07-15(v3) / 2026-08-20(v4)
 *   - live 快照 sha256 前 16 位取自 stats JSON 稳定哈希
 *
 * 用法：
 *   node scripts/rebuild-time-machine.mjs                 # 覆盖生成
 *   node scripts/rebuild-time-machine.mjs --query 2026-06-01
 *   node scripts/rebuild-time-machine.mjs --query 2026-10-17
 *   node scripts/rebuild-time-machine.mjs --append-live
 *
 * exit code:
 *   0 = 成功
 *   1 = KG 文件缺失或损坏
 *   2 = --query 未命中
 *   3 = 参数错误
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const KG_PATH = path.join(ROOT, 'data/knowledge-graph.json');
const TM_PATH = path.join(ROOT, 'data/time-machine/snapshots.json');

const MILESTONE_ANCHORS = [
  {
    snapshotId: 'snap-2026-06-v1-baseline',
    asOf: '2026-06-01T00:00:00.000Z',
    schemaVersion: 1,
    schema: 'genetech-knowledge-graph/v1',
    sizeBytes: null,
    sha256Prefix: null,
    stats: { uniqueEntities: null, nodes: null, edges: null },
    note: 'v1 骨架基线占位。原基线数据未保留，此为里程碑锚点。',
    provenance: 'milestone-anchor-only',
  },
  {
    snapshotId: 'snap-2026-07-v3-tier',
    asOf: '2026-07-15T00:00:00.000Z',
    schemaVersion: 3,
    schema: 'genetech-knowledge-graph/v3',
    sizeBytes: null,
    sha256Prefix: null,
    stats: { tierEnabled: true, uniqueEntities: null },
    note: 'v3 引入 tier 分级。里程碑锚点，非实测。',
    provenance: 'milestone-anchor-only',
  },
  {
    snapshotId: 'snap-2026-08-v4-citation',
    asOf: '2026-08-20T00:00:00.000Z',
    schemaVersion: 4,
    schema: 'genetech-knowledge-graph/v4',
    sizeBytes: null,
    sha256Prefix: null,
    stats: { tierEnabled: true, citationEdges: null },
    note: 'v4 引入 citation edges。里程碑锚点，非实测。',
    provenance: 'milestone-anchor-only',
  },
];

function parseArgs(argv) {
  const args = { query: null, appendLive: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--query') { args.query = argv[++i]; if (!args.query) throw new Error('--query 需要 YYYY-MM-DD'); }
    else if (a === '--append-live') args.appendLive = true;
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
    else throw new Error(`未知参数: ${a}`);
  }
  return args;
}

function printUsage() {
  console.log('用法: node scripts/rebuild-time-machine.mjs [--query YYYY-MM-DD | --append-live]');
}

function readKG() {
  if (!fs.existsSync(KG_PATH)) throw Object.assign(new Error(`KG 不存在: ${KG_PATH}`), { code: 1 });
  try {
    return JSON.parse(fs.readFileSync(KG_PATH, 'utf8'));
  } catch (e) {
    throw Object.assign(new Error(`KG 解析失败: ${e.message}`), { code: 1 });
  }
}

function buildLiveSnapshot(kg) {
  const stats = kg.stats || {};
  const edgeRel = new Map();
  const tierDist = new Map();
  for (const e of kg.edges || []) {
    const r = e.relation || '?';
    edgeRel.set(r, (edgeRel.get(r) || 0) + 1);
    const t = e.tier ?? '?';
    tierDist.set(String(t), (tierDist.get(String(t)) || 0) + 1);
  }
  const sortByCount = (m) => Object.fromEntries([...m.entries()].sort((a,b)=>b[1]-a[1]));
  const statsHash = crypto.createHash('sha256').update(JSON.stringify(stats, Object.keys(stats).sort())).digest('hex').slice(0,16);

  return {
    snapshotId: `snap-${kg.builtAt?.slice(0,10) || 'unknown'}-live`,
    asOf: kg.builtAt,
    schemaVersion: kg.version,
    schema: kg.schema,
    sizeBytes: fs.statSync(KG_PATH).size,
    sha256Prefix: statsHash,
    stats: {
      uniqueEntities: stats.uniqueEntities ?? null,
      crossSiteEntities: stats.crossSiteEntities ?? null,
      nodes: stats.nodes ?? null,
      edges: stats.edges ?? null,
      crossSiteEdges: stats.crossSiteEdges ?? null,
      citationEdges: stats.citationEdges ?? null,
      citationEdgeShare: stats.citationEdgeShare ?? null,
      stubNodes: stats.stubNodes ?? null,
      tagKinds: stats.tagKinds ?? null,
      stations: stats.stations ?? null,
      tierDistribution: stats.tierDistribution ?? null,
      dualTimestamp: stats.dualTimestamp ?? null,
      tierEnabled: stats.tierEnabled ?? null,
    },
    edgeRelationDistribution: sortByCount(edgeRel),
    tierDistributionEdge: sortByCount(tierDist),
    note: '从当前生产 KG 提取的元数据快照；完整节点/边数据未嵌入以避免 3×31MB 存储膨胀',
  };
}

function wrapSnapshots(liveSnap) {
  return {
    schema: 'genetech-time-machine/v1',
    created: liveSnap.asOf,
    generatedBy: 'scripts/rebuild-time-machine.mjs',
    anchorPolicy: {
      milestoneAnchors: '3 个历史里程碑（2026-06/07/08）仅存元数据占位，不含实测节点/边数据',
      liveSnapshot: '当前生产快照含完整元数据 + 站点级统计',
      reason: 'KG 全量 31MB，多版本全存会膨胀；元数据层足以支撑「演进轨迹」查询',
    },
    snapshots: [...MILESTONE_ANCHORS, liveSnap],
    queryExamples: [
      'node scripts/rebuild-time-machine.mjs --query 2026-06-01',
      'node scripts/rebuild-time-machine.mjs --query 2026-10-17',
    ],
  };
}

function querySnapshot(dateStr) {
  if (!fs.existsSync(TM_PATH)) {
    console.error('[fail] snapshots.json 不存在，请先无参数运行一次生成');
    process.exit(2);
  }
  const doc = JSON.parse(fs.readFileSync(TM_PATH, 'utf8'));
  // 日期语义：查询 <YYYY-MM-DD> 应返回该日 EOD 前的最新快照
  const dayMs = 86400000;
  const targetStart = Date.parse(dateStr + 'T00:00:00.000Z');
  if (Number.isNaN(targetStart)) {
    console.error(`[fail] 日期格式错误: ${dateStr}（应为 YYYY-MM-DD）`);
    process.exit(3);
  }
  const target = targetStart + dayMs - 1; // 当日 23:59:59.999Z
  const snaps = doc.snapshots.filter(s => s.asOf).map(s => ({ ...s, _ms: new Date(s.asOf).getTime() }));
  const before = snaps.filter(s => s._ms <= target).sort((a,b) => b._ms - a._ms);
  if (!before.length) {
    console.error(`[fail] 无早于或等于 ${dateStr} 的快照`);
    process.exit(2);
  }
  const hit = before[0];
  // 同一日历日 → 0；否则向下取整天差
  const hitDay = new Date(hit._ms).toISOString().slice(0, 10);
  const distanceDays = hitDay === dateStr ? 0 : Math.floor((target - hit._ms) / dayMs);
  delete hit._ms;
  console.log(JSON.stringify({ query: dateStr, hit, distanceDays }, null, 2));
}

function appendLive(existing, liveSnap) {
  const idx = existing.snapshots.findIndex(s => s.snapshotId === liveSnap.snapshotId);
  if (idx >= 0) existing.snapshots[idx] = liveSnap;
  else existing.snapshots.push(liveSnap);
  existing.created = new Date().toISOString();
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (!isDirect) {
  module.exports = { buildLiveSnapshot, wrapSnapshots, MILESTONE_ANCHORS };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.query) {
    querySnapshot(args.query);
    process.exit(0);
  }

  const kg = readKG();
  const live = buildLiveSnapshot(kg);

  if (args.appendLive) {
    if (!fs.existsSync(TM_PATH)) throw Object.assign(new Error('--append-live 需要已有 snapshots.json'), { code: 3 });
    const existing = JSON.parse(fs.readFileSync(TM_PATH, 'utf8'));
    appendLive(existing, live);
    fs.mkdirSync(path.dirname(TM_PATH), { recursive: true });
    fs.writeFileSync(TM_PATH, JSON.stringify(existing, null, 2));
    console.log(`[ok] append-live: ${live.snapshotId}`);
    process.exit(0);
  }

  const doc = wrapSnapshots(live);
  fs.mkdirSync(path.dirname(TM_PATH), { recursive: true });
  fs.writeFileSync(TM_PATH, JSON.stringify(doc, null, 2));
  console.log(`[ok] 生成 ${doc.snapshots.length} 快照 → ${path.relative(ROOT, TM_PATH)}`);
  process.exit(0);
} catch (e) {
  console.error(`[fail] ${e.message}`);
  process.exit(e.code || 1);
}
