#!/usr/bin/env node
/**
 * operations-plan/pipeline-merge-citation-edges.js
 *
 * B1「图谱并入引用边」的 CLI 落地。
 *
 *   node operations-plan/pipeline-merge-citation-edges.js                        # dry-run，link 模式
 *   node operations-plan/pipeline-merge-citation-edges.js --mode=extend          # dry-run，extend 模式（看会加多少）
 *   node operations-plan/pipeline-merge-citation-edges.js --mode=extend --write  # 真正写入
 *
 * 不可逆操作防护（与 pipeline-quality-gate.js 的 A10 约定一致）
 *   - 默认 dry-run，只看会改什么，不动盘。
 *   - --write 落盘前先在 .backups/ 建 tar 备份（*.tar.gz 已在 .gitignore）。
 *   - 同步写两个副本：data/knowledge-graph.json + data/knowledge-graph-entities.json
 *     （build-knowledge-graph.mjs 本来就写两个相同副本，不写第二个会让两者漂移）。
 *   - 不动 data/knowledge-graph-baseline.json：那是 build-knowledge-graph.mjs 的独占
 *     写入者（退化护栏基线）。本脚本只增不减，不会触发「低于基线 50%」的误杀。
 *
 * 注意：一次性 patch 不持久——下一次 kgbuild 重建会把引用边抹掉。
 * 本脚本与 tools/build-knowledge-graph.mjs 共用 tools/lib/merge-citation-edges.mjs，
 * builder 已内置合并步骤，所以重建后引用边会回来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { mergeCitationEdges } from '../tools/lib/merge-citation-edges.mjs';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const REPORTS_DIR = path.join(ROOT, 'reports');
const BACKUP_DIR = path.join(ROOT, '.backups');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const get = (prefix, fallback) => {
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const DRY = !has('--write');
const MODE = get('--mode=', 'link');
const LIMIT = Number(get('--limit-edges=', '')) || Infinity;

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`[merge] 读取失败 ${p}: ${e.message}`); process.exit(1); }
}

function backup() {
  const files = ['knowledge-graph.json', 'knowledge-graph-entities.json', 'citation-edges.json']
    .filter((f) => fs.existsSync(path.join(DATA_DIR, f)));
  if (!files.length) { console.warn('[merge] 无文件可备份'); return ''; }

  // 用 fs.copyFileSync 而不是 tar：tar 在 Git Bash 里可用，但 Node 的 spawnSync
  // 在当前沙箱下报 EBUSY 无法拉起子进程（2026-10-08 实测 status=null/EBUSY）。
  // 纯 JS 拷贝不依赖任何外部二进制，行为可预期。
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const dir = path.join(BACKUP_DIR, `kg-before-merge-citation-edges-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  let total = 0;
  for (const f of files) {
    const src = path.join(DATA_DIR, f);
    const dst = path.join(dir, f);
    fs.copyFileSync(src, dst);
    total += fs.statSync(dst).size;
  }
  console.log(`[merge] 已备份 ${files.length} 个文件 → ${path.relative(ROOT, dir)}/ (${(total / 1024 / 1024).toFixed(1)} MB)`);
  console.log('[merge] 回滚：把这目录里的文件拷回 data/ 即可（.backups/ 已在 .gitignore）');
  return dir;
}

function main() {
  const t0 = Date.now();
  console.log(`[merge] 模式=${MODE} | dry-run=${DRY} | 限幅=${Number.isFinite(LIMIT) ? LIMIT : '无'}`);

  const kg = readJson(path.join(DATA_DIR, 'knowledge-graph.json'));
  const ce = readJson(path.join(DATA_DIR, 'citation-edges.json'));

  const { graph, report } = mergeCitationEdges(kg, ce, { mode: MODE, limitEdges: LIMIT });
  const json = JSON.stringify(graph);

  console.log('');
  console.log('=== 并入前 ===');
  console.log(`  节点 ${(kg.nodes.length / 1000).toFixed(1)}k | 边 ${kg.edges.length.toLocaleString()} | 体积 ${(JSON.stringify(kg).length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  边类型分布 ${JSON.stringify((kg.edges || []).reduce((a, e) => ((a[e.relation] = (a[e.relation] || 0) + 1), a), {}))}`);
  console.log('');
  console.log('=== 并入后 ===');
  console.log(`  节点 ${graph.nodes.length.toLocaleString()} (+${report.stubNodesAdded}) | 边 ${graph.edges.length.toLocaleString()} (+${report.addedCitationEdges}) | 体积 ${(json.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  引用边占比 ${(report.citationEdgeShare * 100).toFixed(2)}%（验收判据 ≥20%）`);
  console.log('');
  console.log('=== 合并明细 ===');
  console.log(`  引用边输入       ${report.inputCitationEdges.toLocaleString()}`);
  console.log(`  实际加入         ${report.addedCitationEdges.toLocaleString()}`);
  console.log(`  覆盖率(仅link)   ${(report.resolvableOnly * 100).toFixed(2)}%`);
  console.log(`  补占位节点       ${report.stubNodesAdded.toLocaleString()}`);
  console.log(`  跳过-已存在      ${report.skippedAlreadyPresent} | 自环 ${report.skippedSelfEdge} | 畸形 ${report.skippedMalformed} | 触限 ${report.skippedLimit}`);
  console.log('');

  const bytesDelta = json.length - JSON.stringify(kg).length;
  console.log(`=== 体积影响 ===`);
  console.log(`  单文件 +${(bytesDelta / 1024 / 1024).toFixed(2)} MB | 两个副本合计 +${(bytesDelta * 2 / 1024 / 1024).toFixed(2)} MB`);

  const summary = {
    pipeline: 'merge-citation-edges',
    timestamp: new Date().toISOString(),
    dryRun: DRY,
    mode: MODE,
    limitEdges: Number.isFinite(LIMIT) ? LIMIT : null,
    ...report,
    bytesBefore: JSON.stringify(kg).length,
    bytesAfter: json.length,
    bytesDelta,
    bytesDeltaBothFiles: bytesDelta * 2,
  };

  if (DRY) {
    console.log('');
    console.log('[merge] dry-run，未写入。加 --write 落盘（会先备份）。');
  } else {
    const tarPath = backup();
    if (!tarPath) {
      console.error('[merge][ABORT] 备份失败，拒绝写入（不可逆操作必须可回滚）。');
      process.exit(2);
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'knowledge-graph.json'), json);
    fs.writeFileSync(path.join(DATA_DIR, 'knowledge-graph-entities.json'), json);
    console.log('');
    console.log('[merge] 已写入 data/knowledge-graph.json + data/knowledge-graph-entities.json');
    console.log('[merge] 未改 data/knowledge-graph-baseline.json（build-knowledge-graph.mjs 独占写入）');
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = path.join(REPORTS_DIR, `report-merge-citation-edges-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));
  console.log(`[merge] 报告 → ${path.relative(ROOT, reportPath)}`);
  console.log(`[merge] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
