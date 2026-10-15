#!/usr/bin/env node
/**
 * build-parquet.mjs — 把 30 站 entities.json 转成 Parquet 列式格式
 *
 * 目标：
 *   - 518MB JSON → ~50-100MB Parquet（列式压缩 + 类型编码）
 *   - DuckDB 可直接查询 Parquet（无后端依赖）
 *   - 支持跨站 UNION ALL 查询
 *
 * 依赖：
 *   - @duckdb/node-bindings（npm install @duckdb/node-bindings）
 *   - duckdb（npm install duckdb）
 *
 * 用法：
 *   node tools/build-parquet.mjs                     # 全部 30 站
 *   node tools/build-parquet.mjs neuromorphic        # 单站
 *   node tools/build-parquet.mjs --chunk 5000        # 分块写入
 *   node tools/build-parquet.mjs --out data/parquet  # 输出目录
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const targetSite = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
const outDirArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'data/parquet';
const chunkArg = argv.includes('--chunk') ? parseInt(argv[argv.indexOf('--chunk') + 1], 10) : 5000;
const outDir = path.join(root, outDirArg);
fs.mkdirSync(outDir, { recursive: true });

// 30 站列表
const sites = ['agent-ecosystem', 'agritech', 'ai-safety', 'ai4science', 'alien-minerals',
  'biocomputing', 'biomed-ai', 'bionic-ai', 'brain-science', 'carbon-neutral',
  'deep-sea-tech', 'digital-twin', 'edge-ai', 'embodied-ai', 'exo-science',
  'genetech-tools', 'life-science', 'low-altitude', 'neuromorphic', 'new-energy',
  'nuclear-energy', 'privacy-computing', 'quantum-computing', 'quantum-materials',
  'robot-parts', 'sat-6g', 'semiconductor', 'spatial-computing', 'synbio-manufacturing',
  'tcm-tools'];

const targets = targetSite ? [targetSite] : sites;

// 生成 SQL 写入脚本（DuckDB CLI 风格）
function buildSQL(site, entities) {
  const tmpFile = path.join(root, outDirArg, `_${site}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(entities));
  const tmpPath = tmpFile.replace(/\\/g, '/').replace(/^.*?([A-Za-z]:)/, '$1/').replace(/^.*?([A-Za-z]:\/)/, '$1/');
  const outParquet = path.join(outDir, `${site}.parquet`).replace(/\\/g, '/');

  // DuckDB SQL：从 JSON 读取 → 写 Parquet
  // 字段映射：id,name,source,abstract,url,authors,tags,confidence,sites,publishedDate,doi,addedAt,updatedAt,quality_tier
  return `
-- ${site}: ${entities.length} 实体
CREATE TABLE IF NOT EXISTS entities_${site} AS
SELECT
  id,
  name,
  source,
  COALESCE(abstract, '') AS abstract,
  url,
  COALESCE(json_array_to_text_array(authors, ','), '') AS authors,
  COALESCE(json_array_to_text_array(tags, ','), '') AS tags,
  COALESCE(confidence, 0.5) AS confidence,
  COALESCE(json_array_to_text_array(sites, ','), '') AS sites,
  COALESCE(publishedDate, '') AS publishedDate,
  COALESCE(doi, '') AS doi,
  COALESCE(addedAt, '') AS addedAt,
  COALESCE(updatedAt, '') AS updatedAt,
  COALESCE(quality_tier, '') AS quality_tier
FROM read_json_auto('${tmpPath.replace(/'/g, "''")}');

COPY entities_${site} TO '${outParquet.replace(/'/g, "''")}' (FORMAT PARQUET, COMPRESSION ZSTD);

DROP TABLE entities_${site};
`;
}

// 合并所有站到单一 Parquet（可选）
function buildCombinedSQL(allSites) {
  // 构建 glob pattern：/path/to/out/*.parquet
  const globPattern = path.join(outDir, '*.parquet').replace(/\\/g, '/');
  const outParquet = path.join(outDir, 'all.parquet').replace(/\\/g, '/');
  return [
    `-- 合并全部 ${allSites.length} 站到单一 Parquet`,
    `CREATE TABLE all_entities AS`,
    `SELECT * FROM read_parquet('${globPattern.replace(/'/g, "''")}');`,
    ``,
    `COPY all_entities TO '${outParquet.replace(/'/g, "''")}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
    ``,
    `DROP TABLE all_entities;`
  ].join('\n');
}

console.log('=== build-parquet.mjs ===');
console.log(`输出目录: ${outDir}`);
console.log(`目标站点: ${targets.length} 站`);
console.log(`分块大小: ${chunkArg}`);
console.log('');

let totalEntities = 0;
let totalSrcBytes = 0;
let totalOutBytes = 0;
const results = [];

for (const site of targets) {
  const srcFile = path.join(root, site, 'website', 'api', 'entities.json');
  if (!fs.existsSync(srcFile)) {
    console.log(`⏭  ${site}: 无 entities.json，跳过`);
    continue;
  }

  const srcBytes = fs.statSync(srcFile).size;
  totalSrcBytes += srcBytes;
  totalEntities += 0; // 稍后统计

  console.log(`→ ${site}: 处理中...`);

  const entities = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
  const ents = Array.isArray(entities) ? entities : (entities.entities || []);
  totalEntities += ents.length;

  // 写 SQL
  const sql = buildSQL(site, ents);
  const sqlFile = path.join(outDir, `_${site}.sql`);
  fs.writeFileSync(sqlFile, sql);

  // 尝试执行 DuckDB（如果可用）
  const duckdbBin = ['duckdb', 'duckdb.exe'].find(b => {
    try {
      const r = spawnSync(b, ['--version'], { encoding: 'utf-8', shell: process.platform === 'win32' });
      return r.status === 0;
    } catch { return false; }
  });

  if (duckdbBin) {
    const dbFile = path.join(outDir, '_tmp.duckdb').replace(/\\/g, '/');
    const r = spawnSync(duckdbBin, [dbFile, '-c', sql], { encoding: 'utf-8', shell: process.platform === 'win32' });
    if (r.status === 0) {
      const outParquet = path.join(outDir, `${site}.parquet`);
      if (fs.existsSync(outParquet)) {
        const outBytes = fs.statSync(outParquet).size;
        totalOutBytes += outBytes;
        const ratio = ((srcBytes - outBytes) / srcBytes * 100).toFixed(1);
        results.push({ site, ents: ents.length, srcMB: (srcBytes/1024/1024).toFixed(1), outMB: (outBytes/1024/1024).toFixed(1), ratio });
        console.log(`   ✅ ${ents.length} 实体 → ${(outBytes/1024/1024).toFixed(1)}MB (${ratio}% 压缩)`);
      } else {
        console.log(`   ⚠ SQL 执行成功但 Parquet 未生成`);
      }
      // 清理临时文件
      const tmpJson = path.join(outDir, `_${site}.json`);
      if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);
    } else {
      console.log(`   ❌ DuckDB 执行失败: ${r.stderr?.slice(0, 200)}`);
    }
  } else {
    console.log(`   ⏸ DuckDB 未安装，仅生成 SQL 脚本`);
  }
}

// 合并站（可选）
if (!targetSite && targets.length > 1) {
  console.log('');
  console.log('→ 合并全部站到 all.parquet...');
  const combinedSQL = buildCombinedSQL(targets);
  const combinedSQLFile = path.join(outDir, '_combined.sql');
  fs.writeFileSync(combinedSQLFile, combinedSQL);
}

console.log('');
console.log('=== 总账 ===');
if (results.length > 0) {
  console.log(`  站点数: ${results.length}`);
  console.log(`  实体总数: ${totalEntities}`);
  console.log(`  JSON 合计: ${(totalSrcBytes/1024/1024).toFixed(1)} MB`);
  console.log(`  Parquet 合计: ${(totalOutBytes/1024/1024).toFixed(1)} MB`);
  console.log(`  压缩率: ${((1 - totalOutBytes/totalSrcBytes) * 100).toFixed(1)}%`);
  console.log('');
  console.log('  明细:');
  for (const r of results) {
    console.log(`    ${r.site}: ${r.ents} 实体, ${r.srcMB}MB → ${r.outMB}MB (${r.ratio}% 压缩)`);
  }
} else {
  console.log('  DuckDB 未安装，无法实测。请安装：');
  console.log('    Windows: choco install duckdb  或  下载 https://duckdb.org/docs/stable/installation');
  console.log('    macOS: brew install duckdb');
  console.log('    Linux: apt install duckdb');
  console.log('');
  console.log(`  已生成 ${results.length} 个 SQL 脚本在 ${outDir}`);
  console.log('  手动执行: duckdb ' + path.join(outDir, '_tmp.duckdb') + ' < ' + path.join(outDir, '_<site>.sql'));
}
