'use strict';
/**
 * lib/atomic-write.cjs — 原子写盘原语（F3）
 * ─────────────────────────────────────────────────────────────────────────
 * 背景
 *   报告 §3 点名：`pipeline-sync-live.js` 无 `tmp + rename` 模式——写一半崩溃
 *   会留下半截 entities.json，而该文件是线上 API 与 MCP 的数据源。
 *   本模块提供原子写核心原语，把"任意时刻读到的都是完整文件"从约定
 *   变成机制。
 *
 * 协议（POSIX/Windows 都适用）
 *   1. 在同目录写 `<target>.tmp.<pid>.<random>` —— 同目录保证同一文件系统，
 *      rename 才是原子的；跨目录 rename 在某些系统会退化成 copy+unlink。
 *   2. fsync tmp 文件 —— 确保数据落盘（防止 rename 后 tmp 未刷盘导致读空）。
 *   3. rename tmp → target —— 目录项原子替换，任何时刻读 target 都是完整文件。
 *   4. fsync 目录（可选）—— 确保 rename 元数据落盘。
 *   5. 任一步失败，tmp 会被清理；target 永远不被半写状态污染。
 *
 * 用法
 *   const { atomicWrite, atomicWriteJson } = require('../../lib/atomic-write.cjs');
 *   await atomicWrite('data/foo.json', 'hello');
 *   await atomicWriteJson('data/foo.json', { a: 1 });
 *
 * 幂等保证
 *   atomicWrite 无副作用：多次调用同一 (path, content) 结果字节一致；
 *   并发调用互不干扰（每个 tmp 名唯一）；崩溃不留半截 target。
 */

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { dirname, join } = require('node:path');
const { randomBytes } = require('node:crypto');

async function atomicWrite(target, content, opts = {}) {
  const { atomic = true, skipDirSync = false, buffer } = opts;
  const dir = dirname(target);
  fsSync.mkdirSync(dir, { recursive: true });

  if (!atomic) {
    if (buffer) await fs.writeFile(target, buffer);
    else await fs.writeFile(target, content, 'utf-8');
    return;
  }

  // target 已经是完整路径（可能绝对），直接追加 .tmp 后缀即可。
  // 不要用 join(dir, target)——Windows 上会把绝对 target 再拼一次前缀（血泪）。
  const tmpPath = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;

  try {
    const handle = await fs.open(tmpPath, 'w', 0o644);
    try {
      if (buffer) await handle.writeFile(buffer);
      else await handle.writeFile(content, 'utf-8');
      try { await handle.sync(); } catch { /* Windows 上 fsync 对某些 fd 失败，忽略 */ }
    } finally {
      await handle.close();
    }

    await fs.rename(tmpPath, target);

    if (!skipDirSync) {
      try {
        const dirHandle = await fs.open(dir, 'r');
        try { await dirHandle.sync(); } catch { /* 忽略 */ }
        finally { await dirHandle.close(); }
      } catch { /* 忽略 */ }
    }
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch { /* 忽略 */ }
    throw err;
  }
}

async function atomicWriteJson(target, data, opts = {}) {
  const { pretty = 2, trailingNewline = true } = opts;
  const space = pretty > 0 ? pretty : undefined;
  const json = JSON.stringify(data, null, space);
  const content = trailingNewline ? json + '\n' : json;
  await atomicWrite(target, content, { atomic: opts.atomic, skipDirSync: opts.skipDirSync });
}

function atomicWriteSync(target, content, opts = {}) {
  const { atomic = true, skipDirSync = false } = opts;
  const dir = dirname(target);
  fsSync.mkdirSync(dir, { recursive: true });

  if (!atomic) {
    fsSync.writeFileSync(target, content, 'utf-8');
    return;
  }

  const tmpPath = `${target}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    const fd = fsSync.openSync(tmpPath, 'w', 0o644);
    try {
      fsSync.writeSync(fd, content, 'utf-8');
      try { fsSync.fsyncSync(fd); } catch { /* 忽略 */ }
    } finally {
      fsSync.closeSync(fd);
    }
    fsSync.renameSync(tmpPath, target);
    if (!skipDirSync) {
      try {
        const dirFd = fsSync.openSync(dir, 'r');
        try { fsSync.fsyncSync(dirFd); } catch { /* 忽略 */ }
        fsSync.closeSync(dirFd);
      } catch { /* 忽略 */ }
    }
  } catch (err) {
    try { fsSync.unlinkSync(tmpPath); } catch { /* 忽略 */ }
    throw err;
  }
}

module.exports = { atomicWrite, atomicWriteJson, atomicWriteSync };
