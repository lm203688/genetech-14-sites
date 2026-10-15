#!/usr/bin/env node
/**
 * fill-missing-abstract.mjs — 从 Crossref/OpenAlex 回填缺失的 abstract
 *
 * 目标：
 *   - 30.89% 实体缺失 abstract（90,926 条）
 *   - 从 Crossref API 按 DOI 批量获取 abstract
 *   - 写入 entities.json 并重新生成 Pagefind 索引
 *
 * 依赖：
 *   - 网络访问（Crossref API 免费层）
 *   - 无密钥需求
 *
 * 用法：
 *   node tools/fill-missing-abstract.mjs --site neuromorphic
 *   node tools/fill-missing-abstract.mjs --all
 *   node tools/fill-missing-abstract.mjs --dry-run  # 只统计不写入
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const siteArg = argv.includes('--site') ? argv[argv.indexOf('--site') + 1] : null;
const allArg = argv.includes('--all');

const sites = siteArg ? [siteArg] : [
  'agent-ecosystem', 'agritech', 'ai-safety', 'ai4science', 'alien-minerals',
  'biocomputing', 'biomed-ai', 'bionic-ai', 'brain-science', 'carbon-neutral',
  'deep-sea-tech', 'digital-twin', 'edge-ai', 'embodied-ai', 'exo-science',
  'genetech-tools', 'life-science', 'low-altitude', 'neuromorphic', 'new-energy',
  'nuclear-energy', 'privacy-computing', 'quantum-computing', 'quantum-materials',
  'robot-parts', 'sat-6g', 'semiconductor', 'spatial-computing', 'synbio-manufacturing',
  'tcm-tools'
];

const CROSSREF_BASE = 'https://api.crossref.org/works/';
const BATCH_SIZE = 50;
const RATE_LIMIT_DELAY = 1000; // 1 秒/批，Crossref 免费层限制

console.log('=== fill-missing-abstract.mjs ===');
console.log(`模式: ${dryRun ? 'DRY-RUN（只统计不写入）' : '写入模式'}`);
console.log(`目标站点: ${sites.length} 站`);
console.log('');

let totalEntities = 0;
let totalMissingAbstract = 0;
let totalFilled = 0;
let totalFailed = 0;

for (const site of sites) {
  const srcFile = path.join(root, site, 'website', 'api', 'entities.json');
  if (!fs.existsSync(srcFile)) {
    console.log(`⏭  ${site}: 无 entities.json，跳过`);
    continue;
  }

  const data = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
  const ents = Array.isArray(data) ? data : (data.entities || []);
  totalEntities += ents.length;

  // 找出缺失 abstract 且有 DOI 的实体
  const needFill = ents.filter(e => {
    const abstract = e.abstract || '';
    return abstract.trim() === '' && e.doi && e.doi.trim() !== '';
  });

  totalMissingAbstract += needFill.length;

  if (needFill.length === 0) {
    console.log(`✅ ${site}: ${ents.length} 实体，无缺失 abstract`);
    continue;
  }

  console.log(`→ ${site}: ${ents.length} 实体，${needFill.length} 条缺失 abstract（有 DOI）`);

  if (dryRun) {
    console.log(`   ⏸ DRY-RUN 模式，跳过回填`);
    continue;
  }

  // 批量回填
  let filled = 0;
  let failed = 0;

  for (let i = 0; i < needFill.length; i += BATCH_SIZE) {
    const batch = needFill.slice(i, i + BATCH_SIZE);
    console.log(`   批 ${Math.floor(i/BATCH_SIZE)+1}: ${batch.length} 条...`);

    for (const entity of batch) {
      try {
        const doi = entity.doi.replace(/^doi:/, '');
        const url = `${CROSSREF_BASE}${encodeURIComponent(doi)}`;
        
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'GeneTech-Abstract-Filler/1.0 (https://swarmlabs.tools)' },
          signal: AbortSignal.timeout(10000)
        });

        if (resp.ok) {
          const json = await resp.json();
          const abstract = json?.message?.abstract || '';
          
          if (abstract.trim()) {
            entity.abstract = abstract.replace(/<[^>]+>/g, '').trim();
            filled++;
          } else {
            failed++;
          }
        } else {
          failed++;
        }
      } catch (err) {
        failed++;
      }

      // 速率限制
      if (i % BATCH_SIZE === BATCH_SIZE - 1 || i === needFill.length - 1) {
        await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY));
      }
    }

    totalFilled += filled;
    totalFailed += failed;
  }

  // 写入更新后的文件
  if (filled > 0) {
    if (Array.isArray(data)) {
      fs.writeFileSync(srcFile, JSON.stringify(data, null, 2));
    } else {
      data.entities = ents;
      fs.writeFileSync(srcFile, JSON.stringify(data, null, 2));
    }
    console.log(`   ✅ ${site}: 回填 ${filled} 条，失败 ${failed} 条`);
  } else {
    console.log(`   ⚠ ${site}: 回填 0 条（可能无 abstract 或 API 限制）`);
  }
}

console.log('');
console.log('=== 总账 ===');
console.log(`总实体数: ${totalEntities}`);
console.log(`缺失 abstract（有 DOI）: ${totalMissingAbstract}`);
console.log(`已回填: ${totalFilled}`);
console.log(`失败: ${totalFailed}`);
console.log(`剩余缺失: ${totalMissingAbstract - totalFilled}`);

if (totalFilled > 0 && !dryRun) {
  console.log('');
  console.log('⚠ 请重新生成 Pagefind 索引：');
  console.log('  node tools/build-pagefind.mjs');
}
