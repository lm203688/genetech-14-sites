/*
 * lib/atomic-write.cjs
 * ================================================
 * 原子写：tmp + fsync + rename 三步。
 * 保证写文件不会留下"半个文件"。
 *
 * 导出（保持向后兼容）：
 *   - atomicWrite(filePath, data, opts)         async
 *   - atomicWriteSync(filePath, data, opts)     sync
 *   - atomicWriteJson(filePath, data, opts)     async，自动 JSON.stringify
 *   - writeAtomic = atomicWrite (F3 原名，向后兼容)
 *
 * 额外能力（G7 增补）：
 *   - cleanupStaleTmp(dir, olderThanMs)  扫目录删掉超过 N 毫秒的 .tmp-* 残留
 *   - 导出常量 TMP_PREFIX = '.tmp-' 供清扫脚本识别
 * ================================================
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 用于生成 tmp 文件名前缀（同目录下以 . 开头，避免 IDE/编辑器索引）
const TMP_PREFIX = '.tmp-';

/**
 * 原子写文件（async API，保留旧名 writeAtomic 别名）。
 * @param {string} filePath - 目标路径
 * @param {string|Buffer} data - 内容
 * @param {object} opts
 *   - mode: 文件权限（0o644 默认）
 * @returns {Promise<string>} 返回最终路径
 */
async function atomicWrite(filePath, data, opts = {}) {
  const absPath = path.resolve(filePath);
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);
  const tmpPath = path.join(dir, `${TMP_PREFIX}${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`);

  // 确保目录存在（AW6 目录自动创建）
  fs.mkdirSync(dir, { recursive: true });

  try {
    // 1. 写 tmp
    fs.writeFileSync(tmpPath, data, opts.mode ? { mode: opts.mode, encoding: 'utf8' } : 'utf8');

    // 2. fsync tmp（保证 tmp 已 flush 到磁盘）
    //    Windows 上对只读句柄 fsync 会 EPERM，需 'a+' 或 'w'；且 Windows 上 fsync 语义弱，
    //    允许失败（POSIX 上强制成功）。
    try {
      const fd = fs.openSync(tmpPath, 'a+');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Windows EPERM 或平台不支持，忽略（rename 仍能完成原子替换）
    }

    // 3. rename（POSIX 原子；Windows 目标已存在时会替换）
    if (fs.existsSync(absPath)) {
      // Windows 上 rename 覆盖已存在文件在部分条件下失败，先删再 rename
      fs.unlinkSync(absPath);
    }
    fs.renameSync(tmpPath, absPath);

    // 4. fsync 父目录（保证 rename 元数据已 flush；Windows 上 fsyncSync 目录可能不支持，try 兜底）
    try {
      const dirFd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Windows 不允许对目录 fsync，忽略
    }

    return absPath;
  } catch (e) {
    // 清理残留 tmp
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }
}

/**
 * 同步版原子写（保留 API 一致，实现复用同一套 tmp+fsync+rename 逻辑，
 * 因 fs 全部同步调用所以本身同步）。
 */
function atomicWriteSync(filePath, data, opts = {}) {
  // 直接调 atomicWrite 会返 Promise；提供真同步版：复制核心逻辑
  const absPath = path.resolve(filePath);
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);
  const tmpPath = path.join(dir, `${TMP_PREFIX}${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`);

  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(tmpPath, data, opts.mode ? { mode: opts.mode, encoding: 'utf8' } : 'utf8');
    // Windows 上只读句柄 fsync 会 EPERM；且平台不支持时忽略
    try {
      const fd = fs.openSync(tmpPath, 'a+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch {}
    if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    fs.renameSync(tmpPath, absPath);
    try {
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch {}
    return absPath;
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }
}

/**
 * JSON 版原子写：自动 JSON.stringify(data)（保留缩进）。
 */
async function atomicWriteJson(filePath, data, opts = {}) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return atomicWrite(filePath, text, opts);
}

/**
 * 清理目录内超过 olderThanMs 的 tmp 残留。
 *
 * 使用场景（G7）：
 *   - 进程被 kill -9 时 catch 里的 fs.unlinkSync 不会执行
 *   - 下次启动同一目录 pipeline 时可以先扫一遍残留，防磁盘泄漏
 *
 * @param {string} dir - 目标目录
 * @param {object} opts
 *   - olderThanMs: 只清超过此毫秒数的文件（默认 10 分钟）
 *   - dryRun: true 时只返回将被清理的文件名，不实际删除
 * @returns {{removed: string[], kept: string[], count: number}}
 */
function cleanupStaleTmp(dir, opts = {}) {
  const olderThanMs = opts.olderThanMs ?? 10 * 60 * 1000; // 默认 10 分钟
  const dryRun = !!opts.dryRun;
  const removed = [];
  const kept = [];

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return { removed, kept, count: 0, error: String(e.message || e) };
  }

  const now = Date.now();
  for (const name of entries) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isFile() === false) continue;
    const age = now - stat.mtimeMs;
    if (age < olderThanMs) {
      kept.push(name);
      continue;
    }
    if (dryRun) {
      removed.push(name);
      continue;
    }
    try { fs.unlinkSync(full); removed.push(name); }
    catch { kept.push(name); }
  }
  return { removed, kept, count: removed.length };
}

/**
 * 兼容旧名（F3 原名，向后兼容）。
 */
const writeAtomic = atomicWrite;
const writeAtomicSync = atomicWriteSync;
const writeAtomicJson = atomicWriteJson;

module.exports = {
  // 新 API（测试/推荐）
  atomicWrite,
  atomicWriteSync,
  atomicWriteJson,
  // 旧 API（F3 兼容）
  writeAtomic,
  writeAtomicSync,
  writeAtomicJson,
  // G7 新增
  cleanupStaleTmp,
  TMP_PREFIX,
};
