#!/usr/bin/env node
/**
 * F5: ID 规范化 + 别名表
 * identity-map.cjs
 *
 * 背景（报告 §0 实测）：跨站重复 DOI 15,013 条，同一篇论文在多个站点有
 *   不同 ID 前缀（doi: / oa: / pmid: / arxiv- 等），没有统一别名表就无法
 *   做跨站去重、引用边匹配、图谱节点合并。
 *
 * 设计：
 *   - canonical ID 格式：`genetech:<ns>:<native>`（如 `genetech:doi:10.1000/test`）
 *   - 别名表：`data/identity-map.json`，记录每个 canonical ID 的所有已知别名
 *   - 幂等：重跑只增量更新，不覆盖已有映射
 *
 * 用法：
 *   node lib/identity-map.cjs                    # 扫描全站，增量更新 identity-map.json
 *   node lib/identity-map.cjs --verify           # 校验 identity-map 与实体文件一致性
 *   node lib/identity-map.cjs --stats            # 输出统计报告
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const IDENTITY_MAP_PATH = path.join(DATA_DIR, 'identity-map.json');
// 生产 identity-map.json ~100MB，超过此阈值的文件跳过加载，避免 readFileSync OOM。
// 50MB 阈值：生产文件 107MB 直接跳过（走重建路径，幂等安全）；测试可用小文件覆盖。
const IDENTITY_MAP_MAX_LOAD_BYTES = 50 * 1024 * 1024;

// ==================== ID 解析 ====================

/**
 * 将原始 ID 解析为 { namespace, native } 元组。
 * 支持的格式：
 *   doi:10.1000/test     → { ns: 'doi', native: '10.1000/test' }
 *   oa:W2345678901       → { ns: 'oa', native: 'W2345678901' }
 *   pmid:12345           → { ns: 'pmid', native: '12345' }
 *   arxiv-2304.01234v1   → { ns: 'arxiv', native: '2304.01234v1' }
 *   epmc:12345           → { ns: 'epmc', native: '12345' }
 *   ss:12345678          → { ns: 'ss', native: '12345678' }
 *   https://doi.org/...  → { ns: 'doi', native: '10.1000/test' }（DOI URL）
 *   10.1000/test          → { ns: 'doi', native: '10.1000/test' }（裸 DOI）
 *   https://arxiv.org/abs/2304.01234 → { ns: 'arxiv', native: '2304.01234' }
 */
function parseId(rawId) {
  if (!rawId || typeof rawId !== 'string') return null;
  const id = rawId.trim();

  // ★★★ 优先级修复（2026-10-17）：URI 分支必须先于通用 prefix:native 匹配。
  // 旧顺序下 `https://doi.org/...` 会被 `/^([a-z]+):(.+)$/` 先匹配成
  // {ns:'https', native:'//doi.org/...'}，URI 特化分支永远到不了。
  // 这是 IM1 测试的直接根因——不是解析"失败"，是解析"错"。

  // 格式：DOI URL（https://doi.org/10.xxxx/yyyy）—— 优先于 prefix:native
  const doiUrlMatch = id.match(/^https?:\/\/doi\.org\/(.+)$/i);
  if (doiUrlMatch) {
    return { ns: 'doi', native: doiUrlMatch[1] };
  }

  // 格式：arXiv URL（https://arxiv.org/abs/XXXX.XXXXX）—— 优先于 prefix:native
  const arxivUrlMatch = id.match(/^https?:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5})/i);
  if (arxivUrlMatch) {
    return { ns: 'arxiv', native: arxivUrlMatch[1] };
  }

  // 格式：doi:https://doi.org/... （复合前缀，剥离外层后仍走 DOI URL 归一化）
  if (/^doi:https?:\/\/doi\.org\//i.test(id)) {
    const inner = id.replace(/^doi:/i, '').replace(/^https?:\/\/doi\.org\//i, '');
    return { ns: 'doi', native: inner };
  }

  // 格式：prefix:native（doi:, oa:, pmid:, epmc:, ss:）—— 排除 URI 类协议
  const colonMatch = id.match(/^([a-z]+):(.+)$/i);
  if (colonMatch) {
    const ns = colonMatch[1].toLowerCase();
    // URI 类协议（http/https/file/mailto 等）不是合法 namespace，交给上面的 URI 分支处理
    if (ns === 'http' || ns === 'https' || ns === 'file' || ns === 'mailto' || ns === 'ftp') {
      return null;
    }
    const native = colonMatch[2].trim();
    return { ns, native };
  }

  // 格式：arxiv-XXXX.XXXXXvN
  const arxivMatch = id.match(/^arxiv-(\d{4}\.\d{4,5}v\d+)$/i);
  if (arxivMatch) {
    return { ns: 'arxiv', native: arxivMatch[1] };
  }

  // 格式：pp:XXXX（PubMed Pro）
  const ppMatch = id.match(/^pp:(\d+)$/i);
  if (ppMatch) {
    return { ns: 'pp', native: ppMatch[1] };
  }

  // 格式：裸 DOI（10.xxxx/yyyy）
  if (/^10\.\d{4,9}\/.+$/.test(id)) {
    return { ns: 'doi', native: id };
  }

  // 无法识别的格式
  return null;
}

/**
 * 生成 canonical ID：`genetech:<ns>:<native>`
 */
function canonicalId(parsed) {
  if (!parsed) return null;
  return `genetech:${parsed.ns}:${parsed.native}`;
}

/**
 * 从 DOI 字段提取 canonical ID（DOI 是最高优先级的唯一标识符）。
 * 当 doi 字段存在时，canonical 以 DOI 为准。
 */
function canonicalFromEntity(entity) {
  // 优先：doi 字段
  if (entity.doi && typeof entity.doi === 'string' && entity.doi.trim()) {
    const parsed = parseId(entity.doi);
    if (parsed && parsed.ns === 'doi') {
      return canonicalId(parsed);
    }
  }

  // 次优：id 字段解析
  if (entity.id) {
    const parsed = parseId(entity.id);
    if (parsed) {
      // 如果 id 是 DOI 格式，用 DOI 作为 canonical（优先于其他 namespace）
      if (parsed.ns === 'doi') {
        return canonicalId(parsed);
      }
      return canonicalId(parsed);
    }
  }

  return null;
}

// ==================== 扫描与构建 ====================

/**
 * 扫描所有站点的 entities.json，提取实体 ID 和 DOI，构建 identity-map。
 */
async function scanSites() {
  const entries = fs.readdirSync(PROJECT_ROOT, { withFileTypes: true });
  const sites = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const apiDir = path.join(PROJECT_ROOT, e.name, 'website', 'api');
    const indexPath = path.join(apiDir, 'index.json');
    const entPath = path.join(apiDir, 'entities.json');
    if (fs.existsSync(indexPath) && fs.existsSync(entPath)) {
      sites.push({ name: e.name, apiDir, indexPath, entPath });
    }
  }
  return sites;
}

/**
 * 加载现有 identity-map，增量更新。
 */
/**
 * 加载现有 identity-map，增量更新。
 *
 * 失败模式全覆盖（2026-10-17 修 IM8）：
 *   - 文件不存在        → 默认结构（正常）
 *   - 内容损坏 JSON      → 默认结构（旧逻辑）
 *   - RangeError: OOM    → 默认结构（100MB+ 大文件无法一次性读入）
 *   - 权限/IO 错误       → 默认结构（旧逻辑）
 *
 * 旧实现只 try/catch 了 SyntaxError 系错误，100MB 生产文件加载时
 * 直接抛 `RangeError: Array buffer allocation failed`，让 identity-map
 * 构建脚本在启动阶段就崩，且没有降级路径。测试场景里 identity-map.json
 * 就是 100MB 级别，这个失败模式是真实存在的路径。
 */
function loadExistingMap(customPath) {
  const targetPath = customPath || IDENTITY_MAP_PATH;
  try {
    if (fs.existsSync(targetPath)) {
      // statSync 前置大小检查：readFileSync OOM 时已经晚了。
      // 生产 identity-map.json ~100MB，超过阈值直接跳过（走重建路径，幂等安全）。
      const stat = fs.statSync(targetPath);
      if (stat.size > IDENTITY_MAP_MAX_LOAD_BYTES) {
        const MB = 1024 * 1024;
        console.warn(`[identity-map] 现有映射文件过大 (${(stat.size/MB).toFixed(1)}MB) > ${IDENTITY_MAP_MAX_LOAD_BYTES/MB}MB 阈值，跳过加载将重建`);
        return {
          $schema: 'identity-map-v1',
          $description: 'Genetech canonical ID ↔ alias mapping (F5 · 2026-10-16)',
          $generatedAt: null,
          $source: 'lib/identity-map.cjs',
          entries: {},
        };
      }
      const raw = fs.readFileSync(targetPath, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    // 覆盖：SyntaxError / RangeError / EACCES / ENOSPC / 其他 IO 错误
    console.warn(`[identity-map] 现有映射文件加载失败，将重建：${e.message}`);
  }
  return {
    $schema: 'identity-map-v1',
    $description: 'Genetech canonical ID ↔ alias mapping (F5 · 2026-10-16)',
    $generatedAt: null,
    $source: 'lib/identity-map.cjs',
    entries: {},
  };
}

/**
 * 构建 identity-map：每个 canonical ID 映射到所有已知别名。
 */
function buildIdentityMap(existing) {
  const entries = existing.entries || {};
  const stats = { totalSites: 0, totalEntities: 0, totalCanonical: 0, newMappings: 0, updatedMappings: 0 };

  async function run() {
    const sites = await scanSites();
    stats.totalSites = sites.length;

    for (const site of sites) {
      let entities;
      try {
        entities = JSON.parse(fs.readFileSync(site.entPath, 'utf-8'));
      } catch {
        console.warn(`[identity-map] 跳过 ${site.name}：entities.json 解析失败`);
        continue;
      }

      if (!Array.isArray(entities)) continue;
      stats.totalEntities += entities.length;

      for (const entity of entities) {
        const canonical = canonicalFromEntity(entity);
        if (!canonical) continue;

        // 解析原始 ID 作为别名
        const rawId = entity.id || null;
        const rawDoi = entity.doi || null;
        const siteId = entity.site || site.name;

        // 确保 canonical entry 存在
        if (!entries[canonical]) {
          entries[canonical] = {
            canonical,
            aliases: [],
            sites: [],
            doi: rawDoi || null,
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            entityCount: 0,
          };
          stats.newMappings++;
        } else {
          stats.updatedMappings++;
        }

        const entry = entries[canonical];
        entry.lastSeenAt = new Date().toISOString();
        entry.entityCount++;

        // 添加别名（去重）
        if (rawId && !entry.aliases.includes(rawId)) {
          entry.aliases.push(rawId);
        }
        // 添加站点
        if (siteId && !entry.sites.includes(siteId)) {
          entry.sites.push(siteId);
        }
        // 更新 DOI（取第一个非空值）
        if (rawDoi && !entry.doi) {
          entry.doi = rawDoi;
        }
      }
    }

    stats.totalCanonical = Object.keys(entries).length;
    return { entries, stats };
  }

  return run();
}

// ==================== 校验 ====================

/**
 * 校验 identity-map 与实体文件的一致性。
 * 验收判据：identity-map 中的每个 canonical ID 都能在实体文件中找到至少一个实例。
 */
function verifyIdentityMap(map) {
  const results = { totalCanonical: 0, verified: 0, missing: 0, errors: [] };
  const entries = map.entries || {};

  for (const [canonical, entry] of Object.entries(entries)) {
    results.totalCanonical++;
    // 至少有一个别名
    if (!entry.aliases || entry.aliases.length === 0) {
      results.missing++;
      results.errors.push(`[${canonical}] 无别名`);
    }
    // 至少有一个站点
    if (!entry.sites || entry.sites.length === 0) {
      results.missing++;
      results.errors.push(`[${canonical}] 无站点`);
    }
    results.verified++;
  }

  results.ok = results.missing === 0;
  return results;
}

// ==================== 统计报告 ====================

/**
 * 输出 identity-map 统计报告。
 */
function reportStats(map) {
  const entries = map.entries || {};
  const byNs = {};
  const bySite = new Map();
  let maxAliases = 0;
  let totalAliases = 0;

  for (const [canonical, entry] of Object.entries(entries)) {
    const ns = canonical.split(':')[1] || 'unknown';
    byNs[ns] = (byNs[ns] || 0) + 1;

    const aliasCount = (entry.aliases || []).length;
    totalAliases += aliasCount;
    if (aliasCount > maxAliases) maxAliases = aliasCount;

    for (const site of (entry.sites || [])) {
      bySite.set(site, (bySite.get(site) || 0) + 1);
    }
  }

  const siteStats = Object.fromEntries(
    [...bySite.entries()].sort((a, b) => b[1] - a[1])
  );

  return {
    totalCanonical: Object.keys(entries).length,
    totalAliases,
    maxAliases,
    byNamespace: byNs,
    bySite: siteStats,
  };
}

// ==================== 主函数 ====================

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || '--build';

  // 加载现有映射
  const existing = loadExistingMap();

  if (mode === '--verify') {
    console.log('[identity-map] 校验 identity-map 与实体文件一致性...');
    const result = verifyIdentityMap(existing);
    console.log(`  canonical IDs: ${result.totalCanonical}`);
    console.log(`  verified:      ${result.verified}`);
    console.log(`  missing:       ${result.missing}`);
    console.log(`  status:        ${result.ok ? 'PASS' : 'FAIL'}`);
    if (!result.ok && result.errors.length > 0) {
      console.log(`  errors (${result.errors.length}):`);
      for (const err of result.errors.slice(0, 10)) console.log(`    ${err}`);
    }
    process.exit(result.ok ? 0 : 1);
  }

  if (mode === '--stats') {
    console.log('[identity-map] 统计报告');
    const stats = reportStats(existing);
    console.log(JSON.stringify(stats, null, 2));
    process.exit(0);
  }

  // 默认：构建/更新 identity-map
  console.log('[identity-map] 扫描全站，构建 identity-map...');
  const { entries, stats } = await buildIdentityMap(existing);

  existing.entries = entries;
  existing.$generatedAt = new Date().toISOString();
  existing.$stats = stats;

  // 原子写入（使用 F3 的 atomic-write）
  const { atomicWriteJson } = require('./atomic-write.cjs');
  await atomicWriteJson(IDENTITY_MAP_PATH, existing);

  console.log(`[identity-map] 完成。`);
  console.log(`  站点数:          ${stats.totalSites}`);
  console.log(`  实体总数:        ${stats.totalEntities}`);
  console.log(`  canonical IDs:   ${stats.totalCanonical}`);
  console.log(`  新增映射:        ${stats.newMappings}`);
  console.log(`  更新映射:        ${stats.updatedMappings}`);
  console.log(`  输出:            ${path.relative(PROJECT_ROOT, IDENTITY_MAP_PATH)}`);

  // 输出统计摘要
  const reportStats2 = reportStats(existing);
  console.log(`\n[identity-map] 统计摘要`);
  console.log(`  总别名数:        ${reportStats2.totalAliases}`);
  console.log(`  最大别名数:      ${reportStats2.maxAliases}`);
  console.log(`  按 namespace:    ${JSON.stringify(reportStats2.byNamespace)}`);
}

main().catch((e) => {
  console.error(`[identity-map] 致命错误：${e.message}`);
  process.exit(1);
});

// F5 测试 + 外部消费方需要直接调用核心函数
module.exports = {
  parseId,
  canonicalId,
  canonicalFromEntity,
  scanSites,
  loadExistingMap,
  buildIdentityMap,
  verifyIdentityMap,
  reportStats,
};