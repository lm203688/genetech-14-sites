#!/usr/bin/env node
/**
 * dataset-manifest.mjs — 数据集内容寻址清单生成
 *
 * 对应愿景报告跃迁 4：机器可验证治理
 * 目标：生成 SHA-256 内容寻址清单，支持第三方独立验证数据集完整性
 *
 * 依赖：纯 Node 标准库，零外部依赖
 *
 * 用法：
 *   node tools/dataset-manifest.mjs --out ./dataset-manifest.json
 *   node tools/dataset-manifest.mjs --site ai4science
 *   node tools/dataset-manifest.mjs --all
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const siteArg = argv.includes('--site') ? argv[argv.indexOf('--site') + 1] : null;
const allArg = argv.includes('--all');
const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : './dataset-manifest.json';

const ALL_SITES = [
  'agent-ecosystem', 'agritech', 'ai-safety', 'ai4science', 'alien-minerals',
  'biocomputing', 'biomed-ai', 'bionic-ai', 'brain-science', 'carbon-neutral',
  'deep-sea-tech', 'digital-twin', 'edge-ai', 'embodied-ai', 'exo-science',
  'genetech-tools', 'life-science', 'low-altitude', 'neuromorphic', 'new-energy',
  'nuclear-energy', 'privacy-computing', 'quantum-computing', 'quantum-materials',
  'robot-parts', 'sat-6g', 'semiconductor', 'spatial-computing', 'synbio-manufacturing',
  'tcm-tools'
];

console.log('=== Dataset Manifest Generator ===');
console.log(`Mode: ${allArg ? 'all 30 sites' : (siteArg ? `site: ${siteArg}` : 'default')}`);
console.log('');

// 1. 扫描实体文件
const sites = allArg ? ALL_SITES : (siteArg ? [siteArg] : ALL_SITES);
const manifest = {
  generatedAt: new Date().toISOString(),
  generator: 'GeneTech Dataset Manifest v1.0',
  sha256Algorithm: 'SHA-256',
  totalEntities: 0,
  totalSites: 0,
  totalSize: 0,
  sites: {}
};

for (const site of sites) {
  const realPath = path.join(root, site, 'website', 'api', 'entities.json');
  if (!fs.existsSync(realPath)) continue;

  const stat = fs.statSync(realPath);
  const buffer = fs.readFileSync(realPath);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  // 解析实体数据
  const data = JSON.parse(buffer.toString());
  const entities = Array.isArray(data) ? data : (data.entities || []);

  // 字段覆盖率
  const fieldCoverage = {};
  for (const field of ['name', 'abstract', 'doi', 'tags', 'authors', 'publishedDate', 'url']) {
    const count = entities.filter(e => e[field] != null && e[field] !== '').length;
    fieldCoverage[field] = {
      count: count,
      percentage: entities.length > 0 ? (count / entities.length * 100).toFixed(1) + '%' : '0%'
    };
  }

  manifest.sites[site] = {
    path: `${site}/website/api/entities.json`,
    sha256: sha256,
    size: stat.size,
    entities: entities.length,
    fieldCoverage: fieldCoverage,
    lastModified: stat.mtime.toISOString()
  };

  manifest.totalEntities += entities.length;
  manifest.totalSize += stat.size;
  manifest.totalSites++;

  console.log(`✓ ${site}: ${entities.length} entities, ${sha256.slice(0, 16)}...`);
}

// 2. 计算整体哈希
const siteData = Object.values(manifest.sites).map(s => s.sha256).join('\n');
manifest.globalSha256 = crypto.createHash('sha256').update(siteData).digest('hex');

// 3. 写入输出
const outPath = path.resolve(root, outArg);
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));

console.log(`\n✓ Manifest written: ${outPath}`);
console.log(`  Total sites: ${manifest.totalSites}`);
console.log(`  Total entities: ${manifest.totalEntities}`);
console.log(`  Total size: ${(manifest.totalSize / 1024 / 1024).toFixed(1)} MB`);
console.log(`  Global SHA-256: ${manifest.globalSha256}`);
