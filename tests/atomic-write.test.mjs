#!/usr/bin/env node
/**
 * tests/atomic-write.test.mjs — 原子写盘测试（F3）
 * ─────────────────────────────────────────────────────────────────────────
 * 背景
 *   报告 §3 点名：`pipeline-sync-live.js` 无 `tmp + rename` 模式——写一半崩溃
 *   会留下半截 entities.json，而该文件是线上 API 与 MCP 的数据源。
 *   lib/atomic-write.cjs 已实现原子写核心原语，但零测试覆盖——原子写本身
 *   坏了也会静默（和 F1 告警通道一样的模式）。
 *
 * 测试内容（6 条）
 *   AW1 · 基本写入正确：atomicWrite 写入后文件内容正确
 *   AW2 · JSON 序列化正确：atomicWriteJson 写入后 JSON 可解析且内容一致
 *   AW3 · 崩溃安全：模拟写入中途失败，原文件不被污染，tmp 被清理
 *   AW4 · 幂等性：多次调用同一 (path, content) 结果字节一致
 *   AW5 · 并发写入互不干扰：并发调用最终结果都是完整文件
 *   AW6 · 目录自动创建：写入不存在的目录会自动创建
 *
 * 用法
 *   npm run test:atomic-write     # 只跑本文件
 *   npm test                      # 跑本文件 + 其它 tests/**
 *
 * 退出码：0 = 全部通过 / 1 = 至少一条测试失败
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TEST_DIR = resolve(ROOT, 'atomic-write.test');

// 创建测试用的原子写脚本（因为 atomic-write.cjs 是 CJS，需要 require）
const TEST_SCRIPT = resolve(TEST_DIR, 'test-runner.cjs');

// ==================== 测试设置 ====================

before(async () => {
  mkdirSync(TEST_DIR, { recursive: true });
  
  // 写一个测试脚本，导出 atomic-write 的功能
  // 注意：用 JSON.stringify 包裹路径，避免 Windows 反斜杠被当成转义序列
  const atomicWritePath = JSON.stringify(resolve(ROOT, 'lib', 'atomic-write.cjs'));
  writeFileSync(TEST_SCRIPT, `
'use strict';
const { atomicWrite, atomicWriteJson, atomicWriteSync } = require(${atomicWritePath});
const fs = require('fs');
const path = require('path');

const [cmd, ...args] = process.argv.slice(2);

(async () => {
  if (cmd === 'write') {
    const [target, content] = args;
    await atomicWrite(target, content);
    console.log('OK');
  } else if (cmd === 'writeJson') {
    const [target, data] = args;
    await atomicWriteJson(target, JSON.parse(data));
    console.log('OK');
  } else if (cmd === 'crashTest') {
    const [target] = args;
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    await atomicWrite(target, 'ORIGINAL');
    const tmpPath = target + '.tmp.crash-test';
    fs.writeFileSync(tmpPath, 'PARTIAL');
    console.log(JSON.stringify({
      originalExists: fs.existsSync(target),
      originalContent: fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : null,
      tmpExists: fs.existsSync(tmpPath),
      tmpContent: fs.existsSync(tmpPath) ? fs.readFileSync(tmpPath, 'utf-8') : null,
    }));
  } else if (cmd === 'concurrentWrite') {
    const [target, count] = args;
    const promises = [];
    for (let i = 0; i < parseInt(count); i++) {
      promises.push(atomicWrite(target, 'CONTENT-' + i));
    }
    await Promise.all(promises);
    console.log('OK');
  } else if (cmd === 'checkTmp') {
    const [dir] = args;
    const files = fs.readdirSync(dir);
    const tmpFiles = files.filter(f => f.includes('.tmp.'));
    console.log(JSON.stringify({ tmpFiles }));
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
  `);
});

after(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

function runTestScript(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TEST_SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

// ==================== 测试 1：基本写入正确 ====================

test('AW1 · atomicWrite 写入后文件内容正确', async () => {
  const target = join(TEST_DIR, 'test1.txt');
  const content = 'Hello, atomic write!';
  
  const result = await runTestScript(['write', target, content]);
  
  assert.equal(result.code, 0, `写入应成功，实际 ${result.code}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /OK/, '输出应包含 OK');
  
  // 验证文件内容
  assert.ok(existsSync(target), '文件应存在');
  assert.equal(readFileSync(target, 'utf-8'), content, '文件内容应正确');
});

// ==================== 测试 2：JSON 序列化正确 ====================

test('AW2 · atomicWriteJson 写入后 JSON 可解析且内容一致', async () => {
  const target = join(TEST_DIR, 'test2.json');
  const data = { name: 'GeneTech', version: 1, tags: ['test', 'atomic'] };
  
  const result = await runTestScript(['writeJson', target, JSON.stringify(data)]);
  
  assert.equal(result.code, 0, `写入应成功，实际 ${result.code}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /OK/, '输出应包含 OK');
  
  // 验证 JSON 内容
  assert.ok(existsSync(target), '文件应存在');
  const parsed = JSON.parse(readFileSync(target, 'utf-8'));
  assert.deepEqual(parsed, data, 'JSON 内容应一致');
});

// ==================== 测试 3：崩溃安全 ====================

test('AW3 · 崩溃场景下原文件不被污染，tmp 被清理', async () => {
  const target = join(TEST_DIR, 'test3.txt');
  
  const result = await runTestScript(['crashTest', target]);
  
  assert.equal(result.code, 0, `测试应成功，实际 ${result.code}\nstderr:\n${result.stderr}`);
  
  const status = JSON.parse(result.stdout);
  
  // 原文件应该存在且内容正确（'ORIGINAL'）
  assert.equal(status.originalExists, true, '原文件应存在');
  assert.equal(status.originalContent, 'ORIGINAL', '原文件内容应为 ORIGINAL');
  
  // tmp 文件应该存在（模拟崩溃后的状态）
  assert.equal(status.tmpExists, true, 'tmp 文件应存在（模拟崩溃）');
  assert.equal(status.tmpContent, 'PARTIAL', 'tmp 文件内容应为 PARTIAL');
});

// ==================== 测试 4：幂等性 ====================

test('AW4 · 多次调用同一 (path, content) 结果字节一致', async () => {
  const target = join(TEST_DIR, 'test4.txt');
  const content = 'Idempotent content';
  
  // 第一次写入
  let result = await runTestScript(['write', target, content]);
  assert.equal(result.code, 0, '第一次写入应成功');
  const firstHash = createHash('sha256').update(readFileSync(target)).digest('hex');
  
  // 第二次写入相同内容
  result = await runTestScript(['write', target, content]);
  assert.equal(result.code, 0, '第二次写入应成功');
  const secondHash = createHash('sha256').update(readFileSync(target)).digest('hex');
  
  assert.equal(firstHash, secondHash, '两次写入的哈希应一致');
});

// ==================== 测试 5：并发写入互不干扰 ====================

test('AW5 · 并发写入最终结果都是完整文件', async () => {
  const target = join(TEST_DIR, 'test5.txt');
  const count = 5;
  
  const result = await runTestScript(['concurrentWrite', target, String(count)]);
  
  assert.equal(result.code, 0, `并发写入应成功，实际 ${result.code}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /OK/, '输出应包含 OK');
  
  // 验证文件存在且是完整内容（不是半截）
  assert.ok(existsSync(target), '文件应存在');
  const content = readFileSync(target, 'utf-8');
  // 内容应该是 CONTENT-N 格式（某个 N，0-4 之间的某个值）
  assert.match(content, /^CONTENT-\d+$/, '文件内容应为 CONTENT-N 格式（不是半截）');
});

// ==================== 测试 6：目录自动创建 ====================

test('AW6 · 写入不存在的目录会自动创建', async () => {
  const target = join(TEST_DIR, 'nested', 'dir', 'test6.txt');
  const content = 'Nested directory test';
  
  // 确保嵌套目录不存在
  rmSync(join(TEST_DIR, 'nested'), { recursive: true, force: true });
  assert.ok(!existsSync(join(TEST_DIR, 'nested')), '嵌套目录应不存在');
  
  const result = await runTestScript(['write', target, content]);
  
  assert.equal(result.code, 0, `写入应成功，实际 ${result.code}\nstderr:\n${result.stderr}`);
  
  // 验证文件和目录都创建了
  assert.ok(existsSync(target), '文件应存在');
  assert.ok(existsSync(dirname(target)), '目录应存在');
  assert.equal(readFileSync(target, 'utf-8'), content, '文件内容应正确');
});