/*
 * lib/pipeline-kit.cjs
 * ================================================
 * 通用管线工具。所有批处理脚本从这里 import，
 * 而不是自己写 while-readLine。
 * ================================================
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');

const crypto = require('crypto');
const { writeAtomic } = require('./atomic-write.cjs');

/**
 * 流式读 JSONL，一行一个对象。
 * @param {string} filePath - 输入 JSONL 路径
 * @param {function} fn - 每行调用一次 fn(obj, index)
 */
function readJsonl(filePath, fn) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      reject(new Error(`File not found: ${filePath}`));
      return;
    }
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let i = 0;
    let errors = 0;
    rl.on('line', (line) => {
      if (!line.trim()) { i++; return; }
      try {
        fn(JSON.parse(line), i++);
      } catch (e) {
        errors++;
        if (errors < 10) process.stderr.write(`  [warn] line ${i}: ${e.message}\n`);
      }
    });
    rl.on('close', () => {
      if (errors > 0) {
        process.stderr.write(`  [warn] ${errors} malformed lines skipped (of ${i})\n`);
      }
      resolve();
    });
    rl.on('error', reject);
  });
}

/**
 * 流式追加 JSONL。
 * @param {string} filePath - 输出 JSONL 路径
 * @param {Array} rows - 对象数组，一次性追加
 */
function appendJsonl(filePath, rows) {
  const lines = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  // 首次写入用 'w'，后续用 'a'；简化：总是 append
  fs.appendFileSync(filePath, lines, 'utf8');
}

/**
 * 分批处理大数据集，避免一次 load 全内存。
 * @param {string} inputPath - JSONL 输入
 * @param {function} transform - 转换函数，可返回对象/null
 * @param {object} opts
 * @returns {Promise<{input, output, transformed, dropped}>}
 */
async function processLargeDataset(inputPath, transform, opts = {}) {
  const batchWrite = !!opts.batchWrite;
  const outputPath = opts.outputPath || inputPath;
  let input = 0;
  let transformed = 0;
  let dropped = 0;
  const start = Date.now();

  // 如果 batchWrite=false 且要写文件，先把目标清空
  if (batchWrite === false && outputPath && !opts.append) {
    fs.writeFileSync(outputPath, '', 'utf8');
  }

  await readJsonl(inputPath, (obj, idx) => {
    input++;
    try {
      const result = transform(obj, idx);
      if (result === null || result === undefined) {
        dropped++;
        return;
      }
      transformed++;
      if (opts.append || batchWrite) {
        // 累积到批次
        if (!processLargeDataset._batch) processLargeDataset._batch = [];
        processLargeDataset._batch.push(result);
        if (processLargeDataset._batch.length >= 500) {
          appendJsonl(outputPath, processLargeDataset._batch);
          processLargeDataset._batch = [];
        }
      } else if (outputPath) {
        appendJsonl(outputPath, [result]);
      }
    } catch (e) {
      dropped++;
      if (dropped < 10) process.stderr.write(`  [warn] idx=${idx} ${e.message}\n`);
    }
  });

  // Flush remaining batch
  if (processLargeDataset._batch && processLargeDataset._batch.length > 0) {
    appendJsonl(outputPath, processLargeDataset._batch);
    processLargeDataset._batch = [];
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  process.stderr.write(`  [pipeline] ${input} in → ${transformed} transformed, ${dropped} dropped (${elapsed}s)\n`);
  return { input, output: input, transformed, dropped, elapsed };
}

/**
 * 生成 pipeline run 的元数据。
 * @param {string} pipelineId - 管线 id
 * @param {object} opts
 */
function makeRun(pipelineId, opts = {}) {
  const id = crypto.randomBytes(8).toString('hex');
  return {
    runId: id,
    pipeline: pipelineId,
    startedAt: new Date().toISOString(),
    args: opts.args || {},
  };
}

/**
 * 记录 run 结果到 data/pipeline-runs.jsonl
 * @param {object} run - makeRun 返回的 run 对象
 * @param {object} stats - 处理统计
 * @param {string} [outputPath] - 输出文件路径
 */
async function recordRun(run, stats = {}, outputPath) {
  const entry = {
    ...run,
    finishedAt: new Date().toISOString(),
    stats,
    output: outputPath || null,
    gitHead: (() => {
      try {
        const { execSync } = require('child_process');
        return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
      } catch { return 'unknown'; }
    })(),
  };
  const runsFile = path.resolve(__dirname, '..', 'data', 'pipeline-runs.jsonl');
  fs.appendFileSync(runsFile, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

module.exports = {
  readJsonl,
  appendJsonl,
  processLargeDataset,
  makeRun,
  recordRun,
};
