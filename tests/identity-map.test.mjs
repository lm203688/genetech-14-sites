#!/usr/bin/env node
/**
 * tests/identity-map.test.mjs — ID 规范化 + 别名表测试（F5）
 * ─────────────────────────────────────────────────────────────────────────
 * 背景
 *   报告 §0 实测：跨站重复 DOI 15,013 条，同一篇论文在多个站点有不同 ID
 *   前缀（doi: / oa: / pmid: / arxiv- 等），没有统一别名表就无法做跨站去重、
 *   引用边匹配、图谱节点合并。lib/identity-map.cjs 已实现 ID 解析和别名表
 *   构建，但零测试覆盖。
 *
 * 测试内容（8 条）
 *   IM1  · parseId 支持所有已知格式（doi:, oa:, pmid:, arxiv-, arxiv URL, DOI URL, 裸 DOI, pp:）
 *   IM2  · parseId 对无法识别的格式返回 null
 *   IM3  · canonicalId 格式正确（genetech:<ns>:<native>）
 *   IM4  · canonicalFromEntity DOI 优先级（有 doi 字段时用 doi 而不是 id）
 *   IM5  · canonicalFromEntity 降级到 id 字段（无 doi 时用 id）
 *   IM6  · verifyIdentityMap 校验别名和站点完整性
 *   IM7  · reportStats 统计按 namespace 和站点分布
 *   IM8  · loadExistingMap 处理缺失/损坏文件（优雅降级）
 *
 * 用法
 *   npm run test:identity-map     # 只跑本文件
 *   npm test                      # 跑本文件 + 其它 tests/**
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, rmSync, existsSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const {
  parseId,
  canonicalId,
  canonicalFromEntity,
  verifyIdentityMap,
  reportStats,
  loadExistingMap,
} = require(resolve(ROOT, 'lib', 'identity-map.cjs'));

// ==================== 测试 1：parseId 支持所有已知格式 ====================

test('IM1 · parseId 支持所有已知格式', () => {
  // doi: 前缀
  assert.deepEqual(parseId('doi:10.1000/test'), { ns: 'doi', native: '10.1000/test' });

  // oa: 前缀
  assert.deepEqual(parseId('oa:W2345678901'), { ns: 'oa', native: 'W2345678901' });

  // pmid: 前缀
  assert.deepEqual(parseId('pmid:12345'), { ns: 'pmid', native: '12345' });

  // arxiv- 前缀
  assert.deepEqual(parseId('arxiv-2304.01234v1'), { ns: 'arxiv', native: '2304.01234v1' });

  // epmc: 前缀
  assert.deepEqual(parseId('epmc:12345'), { ns: 'epmc', native: '12345' });

  // ss: 前缀
  assert.deepEqual(parseId('ss:12345678'), { ns: 'ss', native: '12345678' });

  // pp: 前缀
  assert.deepEqual(parseId('pp:12345'), { ns: 'pp', native: '12345' });

  // DOI URL
  assert.deepEqual(parseId('https://doi.org/10.1000/test'), { ns: 'doi', native: '10.1000/test' });

  // DOI URL with doi: prefix
  assert.deepEqual(parseId('doi:https://doi.org/10.1000/test'), { ns: 'doi', native: '10.1000/test' });

  // arXiv URL
  assert.deepEqual(parseId('https://arxiv.org/abs/2304.01234'), { ns: 'arxiv', native: '2304.01234' });

  // 裸 DOI
  assert.deepEqual(parseId('10.1000/test'), { ns: 'doi', native: '10.1000/test' });

  // 大小写不敏感
  assert.deepEqual(parseId('DOI:10.1000/test'), { ns: 'doi', native: '10.1000/test' });

  // 前后空格
  assert.deepEqual(parseId('  doi:10.1000/test  '), { ns: 'doi', native: '10.1000/test' });
});

// ==================== 测试 2：parseId 对无法识别的格式返回 null ====================

test('IM2 · parseId 对无法识别的格式返回 null', () => {
  assert.equal(parseId(null), null);
  assert.equal(parseId(''), null);
  assert.equal(parseId('unknown-prefix:value'), null);
  assert.equal(parseId('just-a-string'), null);
  assert.equal(parseId(42), null);
  assert.equal(parseId({ id: 'doi:10.1000/test' }), null);
});

// ==================== 测试 3：canonicalId 格式正确 ====================

test('IM3 · canonicalId 格式正确（genetech:<ns>:<native>）', () => {
  const parsed = parseId('doi:10.1000/test');
  const canonical = canonicalId(parsed);
  assert.equal(canonical, 'genetech:doi:10.1000/test');
  assert.match(canonical, /^genetech:[a-z]+:.+$/);
});

// ==================== 测试 4：canonicalFromEntity DOI 优先级 ====================

test('IM4 · canonicalFromEntity DOI 优先级（有 doi 字段时用 doi 而不是 id）', () => {
  const entity = {
    id: 'oa:W2345678901',
    doi: '10.1000/test',
  };
  const canonical = canonicalFromEntity(entity);
  // 应该用 doi 而不是 id（DOI 是最高优先级）
  assert.equal(canonical, 'genetech:doi:10.1000/test');
});

// ==================== 测试 5：canonicalFromEntity 降级到 id 字段 ====================

test('IM5 · canonicalFromEntity 降级到 id 字段（无 doi 时用 id）', () => {
  const entity = {
    id: 'oa:W2345678901',
    // 无 doi 字段
  };
  const canonical = canonicalFromEntity(entity);
  assert.equal(canonical, 'genetech:oa:W2345678901');

  // id 是裸 DOI
  const entity2 = { id: '10.1000/test' };
  const canonical2 = canonicalFromEntity(entity2);
  assert.equal(canonical2, 'genetech:doi:10.1000/test');

  // 无法解析
  assert.equal(canonicalFromEntity({ id: 'unknown' }), null);
  assert.equal(canonicalFromEntity({}), null);
});

// ==================== 测试 6：verifyIdentityMap 校验别名和站点完整性 ====================

test('IM6 · verifyIdentityMap 校验别名和站点完整性', () => {
  // 完整条目应通过
  const goodMap = {
    entries: {
      'genetech:doi:10.1000/test': {
        canonical: 'genetech:doi:10.1000/test',
        aliases: ['doi:10.1000/test', '10.1000/test'],
        sites: ['site1', 'site2'],
        doi: '10.1000/test',
        firstSeenAt: '2024-01-01T00:00:00Z',
        lastSeenAt: '2024-01-01T00:00:00Z',
        entityCount: 2,
      },
    },
  };
  const goodResult = verifyIdentityMap(goodMap);
  assert.equal(goodResult.ok, true);
  assert.equal(goodResult.missing, 0);
  assert.equal(goodResult.verified, 1);

  // 缺别名的条目应报错
  const badMap = {
    entries: {
      'genetech:doi:10.1000/test': {
        canonical: 'genetech:doi:10.1000/test',
        aliases: [], // 无别名
        sites: ['site1'],
        doi: '10.1000/test',
        firstSeenAt: '2024-01-01T00:00:00Z',
        lastSeenAt: '2024-01-01T00:00:00Z',
        entityCount: 1,
      },
    },
  };
  const badResult = verifyIdentityMap(badMap);
  assert.equal(badResult.ok, false);
  assert.equal(badResult.missing, 1);
  assert.match(badResult.errors[0], /无别名/);
});

// ==================== 测试 7：reportStats 统计按 namespace 和站点分布 ====================

test('IM7 · reportStats 统计按 namespace 和站点分布', () => {
  const map = {
    entries: {
      'genetech:doi:10.1000/test': {
        canonical: 'genetech:doi:10.1000/test',
        aliases: ['doi:10.1000/test', '10.1000/test'],
        sites: ['site1', 'site2'],
        doi: '10.1000/test',
        firstSeenAt: '2024-01-01T00:00:00Z',
        lastSeenAt: '2024-01-01T00:00:00Z',
        entityCount: 2,
      },
      'genetech:oa:W2345678901': {
        canonical: 'genetech:oa:W2345678901',
        aliases: ['oa:W2345678901'],
        sites: ['site2'],
        doi: null,
        firstSeenAt: '2024-01-01T00:00:00Z',
        lastSeenAt: '2024-01-01T00:00:00Z',
        entityCount: 1,
      },
    },
  };
  const stats = reportStats(map);
  assert.equal(stats.totalCanonical, 2);
  assert.equal(stats.totalAliases, 3); // 2 + 1
  assert.equal(stats.maxAliases, 2);
  assert.equal(stats.byNamespace.doi, 1);
  assert.equal(stats.byNamespace.oa, 1);
  assert.equal(stats.bySite.site1, 1);
  assert.equal(stats.bySite.site2, 2); // site2 出现在两个条目里
});

// ==================== 测试 8：loadExistingMap 处理缺失/损坏文件 ====================

test('IM8 · loadExistingMap 处理缺失/损坏文件（优雅降级）', () => {
  // 临时目录
  const tmpDir = join(ROOT, 'identity-map-test');
  mkdirSync(tmpDir, { recursive: true });

  // 场景 A：模拟缺失文件（传入不存在的 path）→ 返回默认结构
  const missingPath = join(tmpDir, 'missing.json');
  const defaultMap = loadExistingMap(missingPath);
  assert.equal(defaultMap.$schema, 'identity-map-v1');
  // 用 deepEqual 而非 equal：{} 是对象，equal 走引用相等永远 fail
  assert.deepEqual(defaultMap.entries, {});
  assert.equal(defaultMap.$generatedAt, null);

  // 场景 B：模拟损坏 JSON 文件 → 返回默认结构（不抛异常）
  const corruptPath = join(tmpDir, 'corrupt.json');
  writeFileSync(corruptPath, '{invalid json');
  const corruptMap = loadExistingMap(corruptPath);
  assert.ok(corruptMap.entries !== undefined);
  assert.deepEqual(corruptMap.entries, {});

  // 场景 C：模拟超过 50MB 阈值的文件 → 优雅降级（跳过加载不 OOM）
  // 用 ftruncate 造一个稀疏大文件（不占实际磁盘空间），验证 stat 分支生效
  const largePath = join(tmpDir, 'large.json');
  const fh = openSync(largePath, 'w');
  ftruncateSync(fh, 60 * 1024 * 1024); // 60MB 稀疏
  closeSync(fh);
  const largeMap = loadExistingMap(largePath);
  assert.deepEqual(largeMap.entries, {});

  // 清理
  rmSync(tmpDir, { recursive: true, force: true });
});
