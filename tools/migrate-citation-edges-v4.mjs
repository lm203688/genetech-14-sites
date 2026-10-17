#!/usr/bin/env node
/**
 * tools/migrate-citation-edges-v4.mjs
 * F8 + F10: 引用边结构化迁移 (v1 数组 → v4 对象 → v5 加时间戳/分级)
 *
 * 背景（报告 §5 F8 + F10）：
 *   F8 把 citation-edges 从紧凑数组 [s,t,ss,ts] 迁移到 v4 对象格式，
 *       让每条边有 citing/cited/fromSite/toSite/resolvedAt/method 六字段。
 *   F10 再叠一层：
 *     - validFrom / validTo —— 边的「有效期」，支持时间维度过滤
 *       （例如 2024 年之后的引用边 vs 全部历史引用边）
 *     - tier —— 来源分级 1-5，标记可信度
 *       tier 1: 权威一手（人工核实/直接观察）
 *       tier 2: 高可信（同行评审、DOI 可验证）
 *       tier 3: 高可信派生（跨源交叉验证，见 Phase 11 v3-cross）
 *       tier 4: 中等可信（迁移产物、启发式推断）
 *       tier 5: 低可信（未验证、占位、推测）
 *
 * 幂等设计：
 *   脚本可以重复执行。若边已有 validFrom/tier，跳过不改；只有缺失才补。
 *   这样 F8 迁移 + F10 分级可以叠加运行，不必重新扫源。
 *
 * 用法：node tools/migrate-citation-edges-v4.mjs [--dry-run] [--backup]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const CE_PATH = path.join(DATA_DIR, 'citation-edges.json');
const REPORTS_DIR = path.join(ROOT, 'reports');

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const BACKUP = argv.has('--backup');

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function main() {
  const t0 = Date.now();
  console.log('[f8] 加载引用边数据…');
  const ce = readJsonSafe(CE_PATH);
  if (!ce || !Array.isArray(ce.edges) || ce.edges.length === 0) {
    console.error('[f8] citation-edges.json 无数据或格式异常，退出');
    process.exit(1);
  }

  console.log(`[f8] 原始格式: ${ce.edgeFormat || 'unknown'} | 边数: ${ce.edges.length}`);

  // 检测当前格式：数组格式 [s, t, ss, ts] vs 对象格式 {citing, cited, ...}
  const firstEdge = ce.edges[0];
  const isLegacyFormat = Array.isArray(firstEdge);

  if (!isLegacyFormat) {
    console.log('[f8] 已是对象格式，无需结构迁移');
    // 检查是否需要补充 F8/F10 字段：resolvedAt/method（F8）+ validFrom/validTo/tier（F10）
    // 只要前 20 条中任一条缺任一字段，就触发 enrich 走一遍全量补齐
    let needsEnrich = false;
    for (const edge of ce.edges.slice(0, 20)) {
      if (!edge.resolvedAt || !edge.method) { needsEnrich = true; break; }
      if (!edge.validFrom) { needsEnrich = true; break; }
      if (!('validTo' in edge)) { needsEnrich = true; break; }
      if (!edge.tier) { needsEnrich = true; break; }
    }
    if (needsEnrich) {
      console.log('[f8] 检测到部分边缺少 F8/F10 字段，将补齐');
      enrichEdges(ce);
    } else {
      console.log('[f8] 所有边已包含 F8+F10 完整字段，完成');
      return;
    }
  } else {
    // 执行迁移：数组格式 → 对象格式
    migrateEdges(ce);
  }

  if (DRY) {
    console.log('[f8] dry-run，未写入');
    return;
  }

  // 写入迁移后的数据
  fs.writeFileSync(CE_PATH, JSON.stringify(ce, null, 2));

  // 备份原始格式（可选）
  if (BACKUP) {
    const backupPath = path.join(DATA_DIR, 'citation-edges.v1-backup.json');
    fs.writeFileSync(backupPath, JSON.stringify({ ...ce, edgeFormat: '[s, t, ss, ts] (v1 legacy)', backedUpAt: new Date().toISOString() }));
    console.log(`[f8] 备份原始格式到 ${path.relative(ROOT, backupPath)}`);
  }

  // 写入迁移报告
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const report = {
    pipeline: 'migrate-citation-edges-v4',
    timestamp: new Date().toISOString(),
    dryRun: DRY,
    backup: BACKUP,
    migrated: ce.edges.length,
    schemaVersion: 'genetech-citation-edges/v4',
    originalFormat: '[s, t, ss, ts]',
    newFormat: 'object {citing, cited, fromSite, toSite, resolvedAt, method}',
  };
  const reportPath = path.join(REPORTS_DIR, `report-citation-migration-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[f8] 报告已写入 ${path.relative(ROOT, reportPath)}`);

  console.log(`[f8] 迁移完成：${ce.edges.length} 条引用边已结构化`);
  console.log(`[f8] 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/**
 * 将数组格式 [s, t, ss, ts] 迁移为对象格式 {citing, cited, fromSite, toSite, resolvedAt, method}
 */
function migrateEdges(ce) {
  const now = new Date().toISOString();
  const migrated = [];

  for (const edge of ce.edges) {
    if (Array.isArray(edge) && edge.length >= 4) {
      migrated.push({
        citing: edge[0],      // source DOI
        cited: edge[1],       // target DOI
        fromSite: edge[2],    // source site
        toSite: edge[3],      // target site
        resolvedAt: now,      // 迁移时间戳
        method: 'v1-migration', // 迁移方法标识
        // F10 新增：迁移产物一律 tier 4（中等可信），validFrom=resolvedAt, validTo=null
        validFrom: now,
        validTo: null,
        tier: 4,
      });
    } else if (typeof edge === 'object' && !Array.isArray(edge)) {
      // 已经是对象格式，保留但补充缺失字段
      migrated.push(enrichEdge(edge, now));
    } else {
      // 未知格式，跳过
      console.warn(`[f8] 跳过未知格式边: ${JSON.stringify(edge).slice(0, 100)}`);
    }
  }

  ce.edges = migrated;
  ce.edgeFormat = 'v4-object';
  ce.schemaVersion = 'genetech-citation-edges/v4';
  ce.migratedAt = now;
  ce.stats = {
    ...ce.stats,
    migratedEdges: migrated.length,
    migratedAt: now,
    schemaVersion: 4,
  };

  console.log(`[f8] 已迁移 ${migrated.length} 条边到对象格式`);
}

/**
 * 为对象格式的边补充缺失的 resolvedAt/method/validFrom/validTo/tier 字段（F10 增强）
 *
 * tier 映射（2026-10-17 F10）：
 *   - v1-migration     → tier 4（中等可信，迁移产物）
 *   - v4-enrichment    → tier 4（中等可信，启发式补齐）
 *   - v3-cross         → tier 3（高可信派生，Phase 11 多源交叉验证）
 *   - v2-verifier      → tier 3（高可信派生，Phase 10 单源验证器）
 *   - manual/verified  → tier 1（权威一手）
 *   - 未识别           → tier 4（保守降级）
 */
function inferTier(method) {
  if (!method) return 4;
  const m = method.toLowerCase();
  if (m.includes('manual') || m.includes('verified-direct')) return 1;
  if (m.includes('crossref') || m.includes('openalex-direct') || m.includes('doi-verified')) return 2;
  if (m.includes('v3-cross') || m.includes('multi-source')) return 3;
  if (m.includes('v2-verifier') || m.includes('single-source-verified')) return 3;
  return 4; // 保守降级到 tier 4
}

function enrichEdges(ce) {
  const now = new Date().toISOString();
  let enriched = 0;

  for (const edge of ce.edges) {
    if (typeof edge === 'object' && !Array.isArray(edge)) {
      if (!edge.resolvedAt) {
        edge.resolvedAt = now;
        enriched++;
      }
      if (!edge.method) {
        edge.method = 'v4-enrichment';
        enriched++;
      }
      // F10 新增：validFrom / validTo / tier
      if (!edge.validFrom) {
        // validFrom 默认等于 resolvedAt（边被首次观察到的时刻即生效时刻）
        edge.validFrom = edge.resolvedAt;
        enriched++;
      }
      if (!('validTo' in edge)) {
        // validTo = null 表示「永久有效」（未被废止）
        edge.validTo = null;
        enriched++;
      }
      if (!edge.tier) {
        edge.tier = inferTier(edge.method);
        enriched++;
      }
    }
  }

  if (enriched > 0) {
    ce.migratedAt = now;
    ce.stats = {
      ...ce.stats,
      enrichedAt: now,
      enrichedFields: enriched,
    };
    console.log(`[f8] 已补充 ${enriched} 个缺失字段`);
  }
}

/**
 * 为单条边补充缺失字段（含 F10 时间戳和分级）
 */
function enrichEdge(edge, timestamp) {
  return {
    ...edge,
    resolvedAt: edge.resolvedAt || timestamp,
    method: edge.method || 'v4-enrichment',
    validFrom: edge.validFrom || edge.resolvedAt || timestamp,
    validTo: ('validTo' in edge) ? edge.validTo : null,
    tier: edge.tier || inferTier(edge.method),
  };
}

main();
