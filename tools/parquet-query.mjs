#!/usr/bin/env node
/**
 * parquet-query.mjs — DuckDB Parquet 查询示例
 *
 * 演示如何用 DuckDB 直接查询 30 站 Parquet 文件，无需后端。
 *
 * 用法：
 *   duckdb -c ".read tools/parquet-query.sql"
 *   node tools/parquet-query.mjs "SELECT * FROM read_parquet('data/parquet/*.parquet') LIMIT 5"
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const userQuery = argv[0];

const duckdbBin = ['duckdb', 'duckdb.exe'].find(b => {
  try {
    const r = spawnSync(b, ['--version'], { encoding: 'utf-8', shell: process.platform === 'win32' });
    return r.status === 0;
  } catch { return false; }
});

if (!duckdbBin) {
  console.error('❌ DuckDB 未安装。请安装：');
  console.error('  Windows: choco install duckdb 或 下载 https://duckdb.org/docs/stable/installation');
  console.error('  macOS: brew install duckdb');
  console.error('  Linux: apt install duckdb');
  process.exit(1);
}

// 默认示例查询
const defaultQueries = [
  {
    name: '全站实体总数',
    sql: "SELECT COUNT(*) AS total FROM read_parquet('data/parquet/*.parquet');"
  },
  {
    name: '各站实体数',
    sql: "SELECT extract_filename(filename) AS site, COUNT(*) AS cnt FROM read_parquet('data/parquet/*.parquet') GROUP BY site ORDER BY cnt DESC;"
  },
  {
    name: '高置信度实体 Top 10',
    sql: "SELECT name, doi, confidence FROM read_parquet('data/parquet/*.parquet') WHERE confidence > 0.9 ORDER BY confidence DESC LIMIT 10;"
  },
  {
    name: '有 DOI 的实体数',
    sql: "SELECT COUNT(*) AS with_doi, COUNT(*) - COUNT(doi) AS without_doi FROM read_parquet('data/parquet/*.parquet') WHERE doi != '';"
  },
  {
    name: '跨站重复 DOI',
    sql: "SELECT doi, COUNT(DISTINCT extract_filename(filename)) AS sites, COUNT(*) AS occurrences FROM read_parquet('data/parquet/*.parquet') WHERE doi != '' GROUP BY doi HAVING COUNT(*) > 1 ORDER BY sites DESC LIMIT 20;"
  }
];

let sqlToRun;

if (userQuery) {
  sqlToRun = userQuery;
} else {
  // 运行所有示例查询
  console.log('=== DuckDB Parquet 查询示例 ===\n');
  for (const q of defaultQueries) {
    console.log(`--- ${q.name} ---`);
    const r = spawnSync(duckdbBin, ['-c', q.sql], { encoding: 'utf-8', shell: process.platform === 'win32' });
    if (r.status === 0) {
      console.log(r.stdout);
    } else {
      console.log(`❌ ${r.stderr?.slice(0, 200)}`);
    }
    console.log('');
  }
}

if (userQuery) {
  const r = spawnSync(duckdbBin, ['-c', userQuery], { encoding: 'utf-8', shell: process.platform === 'win32' });
  if (r.status === 0) {
    console.log(r.stdout);
  } else {
    console.error(`❌ ${r.stderr}`);
    process.exit(1);
  }
}
