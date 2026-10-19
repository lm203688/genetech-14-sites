#!/usr/bin/env node
/**
 * ro-crate-export.mjs — RO-Crate 科学数据包导出
 *
 * 对应愿景报告跃迁 4：机器可验证治理
 * 目标：生成符合 RO-Crate 规范的科研数据包，支持第三方独立验证
 *
 * 依赖：纯 Node 标准库，零外部依赖
 *
 * 用法：
 *   node tools/ro-crate-export.mjs --site ai4science --limit 100 --out ./ro-crate-output
 *   node tools/ro-crate-export.mjs --all --limit 50 --out ./ro-crate-all
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
const limitArg = argv.includes('--limit') ? parseInt(argv[argv.indexOf('--limit') + 1]) : 100;
const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : './ro-crate-output';

const ALL_SITES = [
  'agent-ecosystem', 'agritech', 'ai-safety', 'ai4science', 'alien-minerals',
  'biocomputing', 'biomed-ai', 'bionic-ai', 'brain-science', 'carbon-neutral',
  'deep-sea-tech', 'digital-twin', 'edge-ai', 'embodied-ai', 'exo-science',
  'genetech-tools', 'life-science', 'low-altitude', 'neuromorphic', 'new-energy',
  'nuclear-energy', 'privacy-computing', 'quantum-computing', 'quantum-materials',
  'robot-parts', 'sat-6g', 'semiconductor', 'spatial-computing', 'synbio-manufacturing',
  'tcm-tools'
];

console.log('=== RO-Crate Export ===');

// 1. 加载实体数据
const sites = allArg ? ALL_SITES : (siteArg ? [siteArg] : ['ai4science']);
let allEntities = [];

for (const site of sites) {
  const realPath = path.join(root, site, 'website', 'api', 'entities.json');
  const gzPath = path.join(root, '.workbuddy', 'probe', `site-${site}.json.gz`);
  let data = null;
  if (fs.existsSync(realPath)) {
    data = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
  } else if (fs.existsSync(gzPath)) {
    // gzip fallback (would need zlib)
    console.log(`⚠ ${site}: only gz available, skipping`);
    continue;
  }
  if (data) {
    const ents = (Array.isArray(data) ? data : (data.entities || [])).slice(0, limitArg);
    ents.forEach(e => { if (!e._site) e._site = site; allEntities.push(e); });
    console.log(`✓ ${site}: ${ents.length} entities loaded`);
  }
}

console.log(`\nTotal entities: ${allEntities.length}`);

// 2. 生成 RO-Crate 结构
const crate = {
  '@context': 'https://w3id.org/ro/crate/1.1/context',
  '@type': ['Dataset', 'CreativeWork'],
  '@id': './',
  'datePublished': new Date().toISOString(),
  'publisher': {
    '@id': 'https://github.com/lm203688/genetech-14-sites',
    '@type': 'Organization',
    'name': 'GeneTech Knowledge Engine'
  },
  'hasPart': allEntities.map(e => entityToCrateEntry(e)),
  'mentions': sites.map(s => ({
    '@id': `https://lm203688.github.io/genetech-14-sites/${s}`,
    '@type': 'Dataset',
    'name': `${s} Knowledge Base`
  })),
  'about': {
    '@id': 'https://lm203688.github.io/genetech-14-sites',
    '@type': 'CreativeWork',
    'name': 'GeneTech 30-Site Knowledge Engine',
    'description': 'Open, verifiable, cross-domain scientific knowledge engine'
  }
};

function entityToCrateEntry(entity) {
  const entry = {
    '@context': 'https://w3id.org/ro/crate/1.1/context',
    '@type': 'CreativeWork',
    '@id': entity.url || `#entity-${entity.id}`,
    'identifier': entity.id,
    'name': entity.name || entity.title,
    'datePublished': entity.publishedDate || entity.date,
    'sameAs': entity.doi ? `https://doi.org/${entity.doi}` : undefined,
    'about': entity.name
  };

  if (entity.abstract) {
    entry.description = entity.abstract;
  }
  if (entity.tags) {
    entry.keywords = entity.tags;
  }
  if (entity.authors) {
    entry.author = entity.authors.map(a => ({
      '@type': 'Person',
      'name': a
    }));
  }
  if (entity.impactFactor) {
    entry['citationImpactFactor'] = entity.impactFactor;
  }
  if (entity.citationCount) {
    entry['citationCount'] = entity.citationCount;
  }
  if (entity._site) {
    entry['isPartOf'] = {
      '@id': `https://lm203688.github.io/genetech-14-sites/${entity._site}`,
      '@type': 'Dataset'
    };
  }
  if (entity.quality_tier) {
    entry['qualityTier'] = entity.quality_tier;
  }

  // 清理 undefined 字段
  return Object.fromEntries(
    Object.entries(entry).filter(([_, v]) => v !== undefined)
  );
}

// 3. 生成内容寻址哈希
const crateJson = JSON.stringify(crate, null, 2);
const sha256 = crypto.createHash('sha256').update(crateJson).digest('hex');
const manifest = {
  '@context': 'https://w3id.org/ro/crate/1.1/context',
  '@type': 'Dataset',
  '@id': './',
  'sha256': sha256,
  'entityCount': allEntities.length,
  'siteCount': sites.length,
  'exportedAt': new Date().toISOString(),
  'generator': 'GeneTech RO-Crate Export v1.0'
};

// 4. 写入输出目录
const outDir = path.resolve(root, outArg);
fs.mkdirSync(outDir, { recursive: true });

// 写入 RO-Crate.json
fs.writeFileSync(path.join(outDir, 'ro-crate.json'), crateJson);
// 写入 manifest
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

// 写入每个实体的独立文件（可选，大数据集用）
if (allEntities.length <= 50) {
  for (const entity of allEntities) {
    const id = entity.id || entity.name?.replace(/\s+/g, '-').toLowerCase() || 'unknown';
    const site = entity._site || 'unknown';
    const siteDir = path.join(outDir, site);
    fs.mkdirSync(siteDir, { recursive: true });
    fs.writeFileSync(
      path.join(siteDir, `${id}.json`),
      JSON.stringify(entityToCrateEntry(entity), null, 2)
    );
  }
}

console.log(`\n✓ RO-Crate exported to: ${outDir}`);
console.log(`  ro-crate.json: ${fs.statSync(path.join(outDir, 'ro-crate.json')).size} bytes`);
console.log(`  manifest.json: ${fs.statSync(path.join(outDir, 'manifest.json')).size} bytes`);
console.log(`  SHA-256: ${sha256}`);
console.log(`  Entities: ${allEntities.length}`);
console.log(`  Sites: ${sites.length}`);
