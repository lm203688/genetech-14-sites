/**
 * tests/citation-verify.test.mjs — Citation Verification 模块单测
 * ============================================================================
 * 覆盖 P1-2 独立端点的核心算法：
 *   1. normDoi 归一化（大小写 / URL 前缀 / doi: 前缀 / 版本后缀）
 *   2. buildVerifierIndex 索引正确性
 *   3. verifySingle 四类状态判定
 *   4. verifyBatch 汇总 + 边界（空 / 过多 / 非数组）
 *
 * 不变量断言（与 tests/invariants.test.mjs 一脉相承）：
 *   - 每条边必须恰好进入 bySource 或 byTarget 或两者
 *   - 归一化后同一 DOI 的键必须一致
 *   - 状态枚举只能落在 4 类之一
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normDoi,
  buildVerifierIndex,
  verifySingle,
  verifyBatch,
  VERIFY_MAX_DOIS,
} from '../lib/citation-verify.mjs';

// ---- fixture：手工构造，覆盖各种边界 ----
const SAMPLE_EDGES = [
  { citing: '10.1109/abc', cited: '10.5555/xyz', fromSite: 'siteA', toSite: 'siteB', resolvedAt: '2026-01-01' },
  { citing: '10.2222/def', cited: '10.1109/abc', fromSite: 'siteC', toSite: 'siteA', resolvedAt: '2026-01-02' },
  { citing: '10.3333/ghi', cited: '10.4444/jkl', fromSite: 'siteA', toSite: 'siteD', resolvedAt: '2026-01-03' },
  { citing: '10.5555/xyz', cited: '10.9999/zzz', fromSite: 'siteB', toSite: 'siteE', resolvedAt: '2026-01-04' },
];

// 也测试 legacy 4 元数组格式
const LEGACY_EDGES = [
  ['10.1109/abc', '10.5555/xyz', 'siteA', 'siteB'],
  ['10.6666/yyy', '10.1109/abc', 'siteF', 'siteA'],
];

// ---- normDoi ----

test('normDoi: 纯 DOI 不变', () => {
  assert.equal(normDoi('10.1109/abc'), '10.1109/abc');
});

test('normDoi: 大写转小写', () => {
  assert.equal(normDoi('10.1109/ABC'), '10.1109/abc');
});

test('normDoi: doi.org URL 前缀剥离', () => {
  assert.equal(normDoi('https://doi.org/10.1109/abc'), '10.1109/abc');
  assert.equal(normDoi('http://dx.doi.org/10.1109/abc'), '10.1109/abc');
});

test('normDoi: doi: 前缀剥离', () => {
  assert.equal(normDoi('doi:10.1109/abc'), '10.1109/abc');
});

test('normDoi: 空值与 undefined 安全', () => {
  assert.equal(normDoi(''), '');
  assert.equal(normDoi(null), '');
  assert.equal(normDoi(undefined), '');
});

test('normDoi: 版本后缀去除', () => {
  assert.equal(normDoi('10.48550/arXiv.2401.12345v2'), '10.48550/arxiv.2401.12345');
});

// ---- buildVerifierIndex ----

test('buildVerifierIndex: 对象格式正确建索引', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  assert.equal(idx.totalEdges, 4);
  // fixture 里 10.1109/abc 只作为 citing 出现在第 1 条边
  assert.equal(idx.bySource.get('10.1109/abc').length, 1);
  // 作为 cited 出现在第 2 条边
  assert.equal(idx.byTarget.get('10.1109/abc').length, 1);
});

test('buildVerifierIndex: 兼容 legacy 4 元数组格式', () => {
  const idx = buildVerifierIndex(LEGACY_EDGES);
  assert.equal(idx.totalEdges, 2);
  assert.ok(idx.bySource.get('10.1109/abc'));
  assert.ok(idx.byTarget.get('10.1109/abc'));
});

test('buildVerifierIndex: 空 edges 不抛错', () => {
  const idx = buildVerifierIndex([]);
  assert.equal(idx.totalEdges, 0);
  assert.equal(idx.bySource.size, 0);
  assert.equal(idx.byTarget.size, 0);
});

test('buildVerifierIndex: 空/畸形条目被静默跳过', () => {
  const idx = buildVerifierIndex([
    null,
    undefined,
    { citing: null, cited: null },
    { cited: '10.x/y' },           // 缺 citing
    ['10.a/b'],                    // 只有 1 个元素
  ]);
  assert.equal(idx.totalEdges, 0);
});

test('buildVerifierIndex: 大小写归一化 — 同 DOI 大小写不同键合并', () => {
  const idx = buildVerifierIndex([
    { citing: '10.1/ABC', cited: '10.2/X', fromSite: 'a', toSite: 'b' },
    { citing: '10.1/abc', cited: '10.3/Y', fromSite: 'a', toSite: 'c' },
  ]);
  // 两条边归一化后 citing 键相同
  assert.equal(idx.bySource.get('10.1/abc').length, 2);
});

// ---- verifySingle ----

test('verifySingle: resolved（既有入又有出）', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  const r = verifySingle('10.1109/abc', idx);
  assert.equal(r.status, 'resolved');
  assert.equal(r.citationsInDatabase.incoming, 1);
  assert.equal(r.citationsInDatabase.outgoing, 1);
  // 涉及站点：第 1 条边(fromSite=A→toSite=B)、第 2 条边(fromSite=C→toSite=A)
  assert.ok(r.sites.includes('siteA'));
  assert.ok(r.sites.includes('siteB'));
  assert.ok(r.sites.includes('siteC'));
});

test('verifySingle: resolved_outgoing_only', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  const r = verifySingle('10.3333/ghi', idx);
  assert.equal(r.status, 'resolved_outgoing_only');
  assert.equal(r.citationsInDatabase.incoming, 0);
  assert.equal(r.citationsInDatabase.outgoing, 1);
});

test('verifySingle: resolved_incoming_only', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  const r = verifySingle('10.4444/jkl', idx);
  assert.equal(r.status, 'resolved_incoming_only');
  assert.equal(r.citationsInDatabase.incoming, 1);
  assert.equal(r.citationsInDatabase.outgoing, 0);
});

test('verifySingle: not_in_database', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  const r = verifySingle('10.9999/nothing', idx);
  assert.equal(r.status, 'not_in_database');
  assert.equal(r.siteCount, 0);
  assert.equal(r.duplicateIngestion.length, 0);
});

test('verifySingle: DOI 大小写不敏感', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  const lower = verifySingle('10.1109/abc', idx);
  const upper = verifySingle('10.1109/ABC', idx);
  assert.equal(lower.status, upper.status);
  assert.deepEqual(lower.sites, upper.sites);
});

test('verifySingle: DOI 带 URL 前缀仍能命中', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  const r = verifySingle('https://doi.org/10.1109/abc', idx);
  assert.equal(r.status, 'resolved');
});

test('verifySingle: 跨站共现检测（同一 DOI 在多站）', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  const r = verifySingle('10.5555/xyz', idx);
  // 10.5555/xyz 出现在 fromSite=B 和 toSite=B 位置，还作为 citing 到 siteE
  assert.ok(r.sites.length >= 1);
  assert.equal(r.duplicateIngestion.length, r.sites.length);
});

test('verifySingle: sampleEdges 只返回前 5 条', () => {
  const manyEdges = [];
  for (let i = 0; i < 20; i++) {
    manyEdges.push({
      citing: '10.1109/abc',
      cited: `10.9/${i}`,
      fromSite: 'siteA',
      toSite: `site${i}`,
      resolvedAt: '2026-01-01',
    });
  }
  const idx = buildVerifierIndex(manyEdges);
  const r = verifySingle('10.1109/abc', idx);
  assert.equal(r.citationsInDatabase.outgoing, 20);
  assert.equal(r.sampleEdges.outgoing.length, 5);
});

// ---- verifyBatch ----

test('verifyBatch: 汇总统计正确', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  const batch = verifyBatch(['10.1109/abc', '10.3333/ghi', '10.9999/nothing'], idx);
  assert.equal(batch.summary.total, 3);
  assert.equal(batch.summary.notInDatabase, 1);
  assert.equal(batch.summary.resolvedStrict, 1); // 只有 10.1109/abc 是 resolved
  assert.equal(batch.summary.resolved, 2);        // 含 outgoing_only
});

test('verifyBatch: 空数组返回 empty_input', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  const r = verifyBatch([], idx);
  assert.equal(r.error, 'empty_input');
});

test('verifyBatch: 超过上限返回 too_many', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  const r = verifyBatch(Array(VERIFY_MAX_DOIS + 1).fill('10.x/y'), idx);
  assert.equal(r.error, 'too_many');
  assert.equal(r.limit, VERIFY_MAX_DOIS);
});

test('verifyBatch: 非数组返回 invalid_input', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  assert.equal(verifyBatch(null, idx).error, 'invalid_input');
  assert.equal(verifyBatch('string', idx).error, 'invalid_input');
  assert.equal(verifyBatch({}, idx).error, 'invalid_input');
});

test('verifyBatch: 返回 endpoint/cacheHint/edgeVersion', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  const r = verifyBatch(['10.1109/abc'], idx);
  assert.ok(r.endpoint.startsWith('/v1/citation/verify@'));
  assert.ok(r.cacheHint.ttlMs > 0);
  assert.equal(r.cacheHint.cacheScope, 'public');
  assert.ok(r.edgeVersion);
});

// ---- 不变量断言 ----

test('INVARIANT: 每条有效边必须进入 bySource 或 byTarget 或两者', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  for (const e of SAMPLE_EDGES) {
    const sk = normDoi(e.citing);
    const tk = normDoi(e.cited);
    assert.ok(idx.bySource.has(sk), `citing ${sk} 应在 bySource`);
    assert.ok(idx.byTarget.has(tk), `cited ${tk} 应在 byTarget`);
  }
});

test('INVARIANT: 状态枚举只能落在 4 类之一', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  const allowed = new Set(['resolved', 'resolved_outgoing_only', 'resolved_incoming_only', 'not_in_database']);
  for (const d of ['10.1109/abc', '10.3333/ghi', '10.4444/jkl', '10.9999/nothing']) {
    const r = verifySingle(d, idx);
    assert.ok(allowed.has(r.status), `非法状态: ${r.status}`);
  }
});

test('INVARIANT: 引用计数非负', () => {
  const idx = buildVerifierIndex(SAMPLE_EDGES);
  for (const d of ['10.1109/abc', '10.3333/ghi', '10.4444/jkl', '10.9999/nothing']) {
    const r = verifySingle(d, idx);
    assert.ok(r.citationsInDatabase.incoming >= 0);
    assert.ok(r.citationsInDatabase.outgoing >= 0);
    assert.ok(r.citationsInDatabase.total >= 0);
  }
});
