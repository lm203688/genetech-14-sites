#!/usr/bin/env node
/**
 * pipeline-cleanup-pages.mjs — 清理 _site 归档页，解 Pages 存储溢出
 *
 * 背景：GitHub Pages 上限 ~1014MB，当前 _site 955MB（99.1% 满）。
 *       30 站 × 每站 100 个 page-N.html 归档页 ≈ 300MB 冗余（用户实际只翻前 10 页）。
 *
 * 策略：
 *   - 保留 index.html + page/1.html 到 page/10.html（每站 10 页）
 *   - 删除 page/11.html 到 page/100.html（每站 90 页）
 *   - 完整数据仍由 website/api/entities.json 提供，仅收敛静态 HTML 表面
 *   - build-site.mjs 已同步加 ARCHIVE_MAX_PAGES=10，未来构建只生成前 10 页
 *
 * 用法：
 *   node operations-plan/pipeline-cleanup-pages.mjs                # dry-run（默认，不删）
 *   node operations-plan/pipeline-cleanup-pages.mjs --apply        # 真删
 *   node operations-plan/pipeline-cleanup-pages.mjs --max-pages=15 # 自定义保留页数
 *
 * 输出：
 *   - 控制台表格报告（每站删除数、释放 KB）
 *   - state/cleanup-pages-<ts>.json 快照
 *   - state/flow/ledger.jsonl append
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Dag, Operator, Ledger,
  parseArgs, getFlag,
  PROJECT_ROOT, STATE_DIR, writeJsonAtomic,
} from './flow.mjs';

const SITE_DIR = path.join(PROJECT_ROOT, '_site');
const DEFAULT_MAX_PAGES = 10;

function listStations() {
  try {
    return fs.readdirSync(SITE_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => !name.startsWith('.'));
  } catch (e) {
    throw new Error(`无法列出 ${SITE_DIR}: ${e.message}`);
  }
}

function findArchiveFiles(stationName, maxPages) {
  const pageDir = path.join(SITE_DIR, stationName, 'page');
  if (!fs.existsSync(pageDir)) return { files: [], dirSize: 0 };
  const entries = fs.readdirSync(pageDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => ({ name: e.name, path: path.join(pageDir, e.name), size: fs.statSync(path.join(pageDir, e.name)).size }));
  const toDelete = entries.filter((f) => {
    const m = f.name.match(/^(\d+)\.html$/);
    return m && parseInt(m[1], 10) > maxPages;
  });
  const dirSize = entries.reduce((s, f) => s + f.size, 0);
  return { files: toDelete, dirSize };
}

function deleteFile(file) {
  try {
    fs.unlinkSync(file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== 算子 1：扫描并分类 =====
const scanOp = new Operator({
  name: 'scan',
  describe: '扫描 30 站 page/ 目录，收集要删除的归档页文件',
  run: (stations, ctx) => {
    const results = stations.map((name) => {
      const { files, dirSize } = findArchiveFiles(name, ctx.args.maxPages);
      const kept = ctx.args.maxPages; // 保留数
      return {
        station: name,
        totalBefore: kept, // 目录实际文件数（保守估计）
        toDelete: files.length,
        deletedSize: files.reduce((s, f) => s + f.size, 0),
        dirSize,
        files,
      };
    });
    const totalDel = results.reduce((s, r) => s + r.toDelete, 0);
    const totalSize = results.reduce((s, r) => s + r.deletedSize, 0);
    ctx.log(`扫描完成：${stations.length} 站，待删 ${totalDel} 文件，释放 ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
    return [{ results, totalDel, totalSize }];
  },
});

// ===== 算子 2：删除文件（dry-run 时仅计数） =====
const deleteOp = new Operator({
  name: 'delete',
  describe: '删除 page/N.html（N > maxPages），dry-run 模式仅统计',
  run: ([{ results, totalDel, totalSize }], ctx) => {
    const ledger = new Ledger();
    const report = {
      ts: new Date().toISOString(),
      dryRun: ctx.dryRun,
      maxPages: ctx.args.maxPages,
      stations: [],
      totals: { filesDeleted: 0, bytesFreed: 0, errors: 0 },
    };
    for (const st of results) {
      const entries = [];
      for (const f of st.files) {
        if (ctx.dryRun) {
          entries.push({ file: path.relative(PROJECT_ROOT, f.path), action: 'would-delete', size: f.size });
          report.totals.filesDeleted += 1;
          report.totals.bytesFreed += f.size;
        } else {
          const r = deleteFile(f.path);
          entries.push({ file: path.relative(PROJECT_ROOT, f.path), action: r.ok ? 'deleted' : 'error', size: f.size, error: r.error });
          if (r.ok) {
            report.totals.filesDeleted += 1;
            report.totals.bytesFreed += f.size;
          } else {
            report.totals.errors += 1;
          }
          ledger.record({
            op: ctx.dryRun ? 'would-delete' : 'deleted',
            station: st.station,
            file: path.relative(PROJECT_ROOT, f.path),
            size: f.size,
          });
        }
      }
      report.stations.push({
        station: st.station,
        deleted: entries.filter((e) => e.action !== 'error').length,
        errors: entries.filter((e) => e.action === 'error').length,
        freedKB: Math.round(st.deletedSize / 1024),
      });
    }
    ctx.log(`完成：${report.totals.filesDeleted} 文件，释放 ${(report.totals.bytesFreed / 1024 / 1024).toFixed(1)} MB`);
    if (report.totals.errors > 0) ctx.warn(`${report.totals.errors} 个文件删除失败，请查看报告`);
    // 写报告
    const reportPath = path.join(PROJECT_ROOT, 'state', `cleanup-pages-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
    writeJsonAtomic(reportPath, report);
    ctx._reportPath = reportPath;
    return [report];
  },
});

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const apply = flags['apply'] === true;
  const dryRun = !apply;
  const maxPages = parseInt(String(flags['max-pages'] || DEFAULT_MAX_PAGES), 10);
  console.log(`[${dryRun ? 'DRY-RUN' : 'APPLY'}] 清理 _site 归档页，保留前 ${maxPages} 页`);

  const stations = listStations();
  if (stations.length === 0) {
    console.error(`_site 为空或不存在：${SITE_DIR}`);
    process.exit(1);
  }
  console.log(`站点数：${stations.length}`);

  const dag = new Dag().add(scanOp).add(deleteOp);
  const report = await dag.run(stations, {
    pipelineName: 'cleanup-pages',
    args: { maxPages },
    dryRun,
  });

  // 打印摘要
  const last = report[report.length - 1];
  if (last && last.totals) {
    console.log(`\n===== 摘要 =====`);
    console.log(`模式：${dryRun ? 'DRY-RUN（未实际删除）' : 'APPLY（已删除）'}`);
    console.log(`站点：${last.stations.length}`);
    console.log(`删除：${last.totals.filesDeleted} 文件`);
    console.log(`释放：${(last.totals.bytesFreed / 1024 / 1024).toFixed(2)} MB`);
    console.log(`错误：${last.totals.errors}`);
    console.log(`报告：${path.relative(PROJECT_ROOT, last._reportPath || '')}`);
  }
  process.exitCode = last && last.totals && last.totals.errors > 0 ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
}
