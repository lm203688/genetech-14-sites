#!/usr/bin/env node
/**
 * tests/schema-validator.test.mjs — 数据 schema 校验测试（F4）
 * ─────────────────────────────────────────────────────────────────────────
 * 背景
 *   报告 §2 硬骨头动作 2：「现在 entities.json 没有任何 schema 校验——30 站同构
 *   只是约定，不是约束」。lib/schema-validator.cjs 已实现简单 JSON Schema draft-07
 *   校验器，data/schemas/ 下有 4 份 schema 文件，但零测试覆盖。
 *
 * 测试内容（10 条）
 *   SV1  · validateSchema 基本类型检查（string/number/object/array）
 *   SV2  · required 字段缺失应报错
 *   SV3  · properties 递归校验（嵌套字段）
 *   SV4  · items 数组元素校验
 *   SV5  · enum 值不在白名单应报错
 *   SV6  · additionalProperties: false 时额外字段报错
 *   SV7  · oneOf 至少匹配一个子 schema
 *   SV8  · validateEntities 批量校验 + 错误上限
 *   SV9  · schema 缓存（同 schema 多次调用结果一致）
 *   SV10 · schema 文件缺失应优雅降级（不抛异常）
 *
 * 用法
 *   npm run test:schema-validator     # 只跑本文件
 *   npm test                          # 跑本文件 + 其它 tests/**
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const { validate, validateEntities, validateSchema, loadSchema } = require(
  resolve(ROOT, 'lib', 'schema-validator.cjs')
);

// ==================== 测试 1：基本类型检查 ====================

test('SV1 · validateSchema 基本类型检查（string/number/object/array）', () => {
  // string 类型
  assert.equal(validateSchema('hello', { type: 'string' }).length, 0);
  assert.equal(validateSchema(42, { type: 'string' }).length, 1);
  assert.match(validateSchema(42, { type: 'string' })[0], /expected string, got number/);

  // number 类型
  assert.equal(validateSchema(42, { type: 'number' }).length, 0);
  assert.equal(validateSchema('42', { type: 'number' }).length, 1);

  // object 类型
  assert.equal(validateSchema({ a: 1 }, { type: 'object' }).length, 0);
  assert.equal(validateSchema('str', { type: 'object' }).length, 1);
  assert.equal(validateSchema(null, { type: 'object' }).length, 1);

  // array 类型
  assert.equal(validateSchema([1, 2], { type: 'array' }).length, 0);
  assert.equal(validateSchema({ a: 1 }, { type: 'array' }).length, 1);
  assert.equal(validateSchema('str', { type: 'array' }).length, 1);

  // boolean 类型
  assert.equal(validateSchema(true, { type: 'boolean' }).length, 0);
  assert.equal(validateSchema('true', { type: 'boolean' }).length, 1);
});

// ==================== 测试 2：required 字段缺失 ====================

test('SV2 · required 字段缺失应报错', () => {
  const schema = {
    type: 'object',
    required: ['id', 'name', 'source'],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      source: { type: 'string' },
    },
  };

  // 完整数据应通过
  const fullData = { id: 'doi:1', name: 'Test', source: 'crossref' };
  assert.equal(validateSchema(fullData, schema).length, 0);

  // 缺少 id 应报错
  const missingId = { name: 'Test', source: 'crossref' };
  const errors = validateSchema(missingId, schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing required field 'id'/);

  // 缺少多个字段应报多个错误
  const missingAll = {};
  const allErrors = validateSchema(missingAll, schema);
  assert.equal(allErrors.length, 3);
  assert.match(allErrors.join('\n'), /missing required field 'id'/);
  assert.match(allErrors.join('\n'), /missing required field 'name'/);
  assert.match(allErrors.join('\n'), /missing required field 'source'/);

  // null 不算缺失（但会报类型错误）
  assert.equal(validateSchema(null, schema).length, 1);
  assert.match(validateSchema(null, schema)[0], /expected object/);
});

// ==================== 测试 3：properties 递归校验 ====================

test('SV3 · properties 递归校验（嵌套字段）', () => {
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      meta: {
        type: 'object',
        properties: {
          createdAt: { type: 'string' },
        },
        required: ['createdAt'],
      },
    },
  };

  // 完整数据应通过
  const good = { id: 'doi:1', meta: { createdAt: '2024-01-01' } };
  assert.equal(validateSchema(good, schema).length, 0);

  // meta 里缺 createdAt 应报错
  const bad = { id: 'doi:1', meta: {} };
  const errors = validateSchema(bad, schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /root\.meta: missing required field 'createdAt'/);
});

// ==================== 测试 4：items 数组元素校验 ====================

test('SV4 · items 数组元素校验', () => {
  const schema = {
    type: 'array',
    items: { type: 'string' },
  };

  // 全 string 应通过
  assert.equal(validateSchema(['a', 'b'], schema).length, 0);

  // 含 number 应报错
  const errors = validateSchema(['a', 42, 'c'], schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /root\[1\]: expected string, got number/);
});

// ==================== 测试 5：enum 值检查 ====================

test('SV5 · enum 值不在白名单应报错', () => {
  const schema = { type: 'string', enum: ['crossref', 'openalex', 'pubmed'] };

  assert.equal(validateSchema('crossref', schema).length, 0);
  const errors = validateSchema('arxiv', schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /value 'arxiv' not in enum/);
});

// ==================== 测试 6：additionalProperties ====================

test('SV6 · additionalProperties: false 时额外字段报错', () => {
  const schema = {
    type: 'object',
    properties: { id: { type: 'string' } },
    additionalProperties: false,
  };

  assert.equal(validateSchema({ id: 'doi:1' }, schema).length, 0);
  const errors = validateSchema({ id: 'doi:1', extra: 'x' }, schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /additional property 'extra' not allowed/);
});

// ==================== 测试 7：oneOf ====================

test('SV7 · oneOf 至少匹配一个子 schema', () => {
  const schema = {
    oneOf: [
      { type: 'string' },
      { type: 'number' },
    ],
  };

  assert.equal(validateSchema('str', schema).length, 0);
  assert.equal(validateSchema(42, schema).length, 0);
  const errors = validateSchema(true, schema);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /does not match any of the 2 schemas/);
});

// ==================== 测试 8：validateEntities 批量校验 ====================

test('SV8 · validateEntities 批量校验 + 错误上限', () => {
  // 造 12 条无效数据（每条缺 id）
  const badEntities = [];
  for (let i = 0; i < 12; i++) {
    badEntities.push({
      name: 'Test',
      source: 'crossref',
      abstract: 'x',
      url: 'http://x',
      tags: [],
      confidence: 0.9,
      sites: ['site1'],
      addedAt: '2024-01-01T00:00:00Z',
    });
  }

  const result = validateEntities(badEntities, 'entity');
  assert.equal(result.valid, false);
  assert.equal(result.stats.total, 12);
  assert.equal(result.stats.invalid, 12);
  // 错误上限：最多 10 条详细错误 + 1 条 "and N more"
  assert.ok(result.errors.length <= 11);
  assert.match(result.errors.join('\n'), /more errors/);
});

// ==================== 测试 9：schema 缓存 ====================

test('SV9 · schema 缓存（同 schema 多次加载结果一致）', () => {
  // 连续加载两次同一 schema，应返回同一引用（缓存命中）
  const schema1 = loadSchema('entity');
  const schema2 = loadSchema('entity');
  assert.equal(schema1, schema2, '应命中缓存（同一引用）');
});

// ==================== 测试 10：schema 文件缺失优雅降级 ====================

test('SV10 · schema 文件缺失应优雅降级（不抛异常）', () => {
  // validate 应返回 { valid: false, errors: [...] } 而不是抛异常
  const result = validate({ any: 'data' }, 'non-existent-schema-name');
  assert.equal(result.valid, false);
  assert.match(result.errors[0], /Failed to load schema/);

  // validateEntities 同理
  const result2 = validateEntities([{ a: 1 }], 'non-existent-schema-name');
  assert.equal(result2.valid, false);
  assert.match(result2.errors[0], /Failed to load schema/);
});
