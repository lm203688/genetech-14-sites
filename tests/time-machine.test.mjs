/**
 * tests/time-machine.test.mjs
 *
 * 覆盖 P1-4 time-machine 快照层：
 *   - 4 快照存在（3 milestone + 1 live）
 *   - schema 版本号严格递增
 *   - live 快照 stats 与 KG 一致
 *   - milestone 快照诚实标注 provenance
 *   - CLI 查询语义正确
 *   - 边界日期不产生崩溃
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TM_PATH = path.join(ROOT, 'data/time-machine/snapshots.json');
const KG_PATH = path.join(ROOT, 'data/knowledge-graph.json');
const SCRIPT = path.join(ROOT, 'scripts/rebuild-time-machine.mjs');

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('snapshots.json 存在且结构完整', () => {
  assert.ok(fs.existsSync(TM_PATH), 'snapshots.json 必须存在');
  const doc = readJSON(TM_PATH);
  assert.equal(doc.schema, 'genetech-time-machine/v1');
  assert.ok(Array.isArray(doc.snapshots), 'snapshots 必须是数组');
  assert.equal(doc.snapshots.length, 4, '应有 3 milestone + 1 live = 4');
  assert.ok(doc.anchorPolicy, 'anchorPolicy 必须存在');
});

test('schema 版本号严格递增（按 asOf 排序）', () => {
  const doc = readJSON(TM_PATH);
  const sorted = [...doc.snapshots].sort((a,b) => new Date(a.asOf) - new Date(b.asOf));
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i].schemaVersion > sorted[i-1].schemaVersion,
      `版本应递增: ${sorted[i-1].schemaVersion} → ${sorted[i].schemaVersion}`);
  }
});

test('milestone 快照诚实标注 provenance=milestone-anchor-only', () => {
  const doc = readJSON(TM_PATH);
  const milestones = doc.snapshots.filter(s => !s.snapshotId.endsWith('-live'));
  assert.equal(milestones.length, 3, '应有 3 个 milestone');
  for (const m of milestones) {
    assert.equal(m.provenance, 'milestone-anchor-only', `${m.snapshotId} 应标注 milestone-anchor-only`);
    assert.equal(m.sizeBytes, null, 'milestone 不存 sizeBytes');
    assert.equal(m.sha256Prefix, null, 'milestone 不存 sha256');
  }
});

test('live 快照 stats 与 KG 一致', () => {
  const doc = readJSON(TM_PATH);
  const live = doc.snapshots.find(s => s.snapshotId.endsWith('-live'));
  assert.ok(live, '应有 live 快照');
  const kg = readJSON(KG_PATH);
  assert.equal(live.asOf, kg.builtAt, 'live.asOf 应等于 KG.builtAt');
  assert.equal(live.schemaVersion, kg.version, 'schemaVersion 应等于 KG.version');
  assert.equal(live.stats.nodes, kg.stats.nodes, 'nodes 数应与 KG 一致');
  assert.equal(live.stats.edges, kg.stats.edges, 'edges 数应与 KG 一致');
  assert.equal(live.stats.uniqueEntities, kg.stats.uniqueEntities, 'uniqueEntities 应与 KG 一致');
  assert.equal(live.stats.citationEdges, kg.stats.citationEdges, 'citationEdges 应与 KG 一致');
  assert.ok(live.sizeBytes > 0, 'live.sizeBytes 应 > 0');
  assert.ok(/^[0-9a-f]{16}$/.test(live.sha256Prefix), 'sha256Prefix 应为 16 位 hex');
});

test('live 快照 edge relation 分布总和等于 edges 数', () => {
  const doc = readJSON(TM_PATH);
  const live = doc.snapshots.find(s => s.snapshotId.endsWith('-live'));
  const dist = live.edgeRelationDistribution;
  const total = Object.values(dist).reduce((a,b) => a+b, 0);
  assert.equal(total, live.stats.edges, 'edgeRelationDistribution 总和应等于 edges');
});

test('tier 分布总和等于 edges 数', () => {
  const doc = readJSON(TM_PATH);
  const live = doc.snapshots.find(s => s.snapshotId.endsWith('-live'));
  const dist = live.tierDistributionEdge;
  const total = Object.values(dist).reduce((a,b) => a+b, 0);
  assert.equal(total, live.stats.edges, 'tierDistributionEdge 总和应等于 edges');
});

test('CLI 查询 2026-10-17 命中 live 快照', () => {
  const r = spawnSync('node', [SCRIPT, '--query', '2026-10-17'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hit.snapshotId.endsWith('-live'), true, '应命中 live 快照');
  assert.ok(out.distanceDays >= 0, 'distanceDays 应为非负数');
});

test('CLI 查询 2026-06-01 命中 v1 milestone', () => {
  const r = spawnSync('node', [SCRIPT, '--query', '2026-06-01'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hit.snapshotId, 'snap-2026-06-v1-baseline');
  assert.equal(out.hit.schemaVersion, 1);
  assert.equal(out.distanceDays, 0, '当日查询应 distanceDays=0');
});

test('CLI 查询边界日期（无早于目标）exit 2', () => {
  const r = spawnSync('node', [SCRIPT, '--query', '2020-01-01'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 2, `应 exit 2, stderr: ${r.stderr}`);
  assert.match(r.stderr, /无早于/);
});

test('CLI 重建 --append-live 幂等（重跑不重复插入）', () => {
  const before = readJSON(TM_PATH);
  const liveId = before.snapshots.find(s => s.snapshotId.endsWith('-live')).snapshotId;
  const liveCount = before.snapshots.filter(s => s.snapshotId === liveId).length;
  assert.equal(liveCount, 1);

  const r = spawnSync('node', [SCRIPT, '--append-live'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0, `append-live 应成功: ${r.stderr}`);

  const after = readJSON(TM_PATH);
  assert.equal(after.snapshots.length, before.snapshots.length, '总快照数不应增加');
  assert.equal(after.snapshots.filter(s => s.snapshotId === liveId).length, 1, '同 id 不应重复');
});

test('anchorPolicy.reason 显式说明存储策略', () => {
  const doc = readJSON(TM_PATH);
  assert.match(doc.anchorPolicy.reason, /31MB/, 'reason 应说明 31MB 存储考虑');
  assert.match(doc.anchorPolicy.milestoneAnchors, /占位/, 'milestoneAnchors 应说明占位性质');
});
