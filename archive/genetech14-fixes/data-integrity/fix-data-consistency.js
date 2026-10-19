#!/usr/bin/env node
/**
 * 数据一致性修复脚本
 *
 * 解决问题：
 * 1. 同一站点在不同文件中的实体数量不一致（main.json vs compass.json vs data.js vs agent-discovery.json）
 * 2. confidence_scores.json、controversies.json、changelog.json 为空
 * 3. 实体数据缺少溯源信息（source_url、采集时间）
 *
 * 用法：
 *   node fix-data-consistency.js <site-dir>
 *   node fix-data-consistency.js agent-ecosystem
 *   node fix-data-consistency.js --all  # 处理所有站点
 */

const fs = require('fs');
const path = require('path');

// === 配置 ===
const SITES = [
  'genetech-tools', 'tcm-tools', 'agent-ecosystem', 'robot-parts',
  'quantum-computing', 'brain-science', 'nuclear-energy', 'exo-science',
  'alien-minerals', 'deep-sea-tech', 'new-energy', 'life-science',
  'biocomputing', 'bionic-ai'
];

// === 工具函数 ===
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  ✓ 已写入: ${path.basename(filePath)}`);
}

function countEntities(entitiesDir) {
  const counts = {};
  const files = fs.existsSync(entitiesDir) ? fs.readdirSync(entitiesDir).filter(f => f.endsWith('.json')) : [];

  for (const file of files) {
    const name = file.replace('.json', '');
    const data = readJson(path.join(entitiesDir, file));
    if (!data) continue;

    let count = 0;
    if (Array.isArray(data)) {
      count = data.length;
    } else if (data.entities && Array.isArray(data.entities)) {
      count = data.entities.length;
    } else if (data.stats && typeof data.stats === 'object') {
      // main.json 格式
      count = data.categories ? data.categories.reduce((sum, c) => sum + (c.entity_count || 0), 0) : 0;
    }
    counts[name] = count;
  }

  return counts;
}

// === 修复函数 ===

/**
 * 修复 1：统一 main.json 的统计数字
 */
function fixMainJson(siteDir, sitePath) {
  const mainPath = path.join(sitePath, 'knowledge-base', 'entities', 'main.json');
  if (!fs.existsSync(mainPath)) {
    console.log('  - main.json 不存在，跳过');
    return;
  }

  const main = readJson(mainPath);
  if (!main) return;

  const entitiesDir = path.join(sitePath, 'knowledge-base', 'entities');
  const realCounts = countEntities(entitiesDir);

  // 重新计算 total_entities
  const totalEntities = Object.values(realCounts).reduce((sum, n) => sum + n, 0);
  main.total_entities = totalEntities;
  main.last_updated = new Date().toISOString();

  // 更新每个 category 的 entity_count
  if (main.categories) {
    main.categories = main.categories.map(cat => ({
      ...cat,
      entity_count: realCounts[cat.id] || 0
    }));
  }

  writeJson(mainPath, main);
  console.log(`  - total_entities 修正为: ${totalEntities}`);
}

/**
 * 修复 2：重新生成 compass.json 的 entity_count
 */
function fixCompassJson(siteDir, sitePath) {
  const compassPath = path.join(sitePath, 'website', 'api', 'compass.json');
  if (!fs.existsSync(compassPath)) {
    console.log('  - compass.json 不存在，跳过');
    return;
  }

  const compass = readJson(compassPath);
  if (!compass) return;

  const entitiesDir = path.join(sitePath, 'knowledge-base', 'entities');
  const realCounts = countEntities(entitiesDir);

  if (compass.categories) {
    for (const catKey of Object.keys(compass.categories)) {
      if (compass.categories[catKey]) {
        compass.categories[catKey].entity_count = realCounts[catKey] || 0;
      }
    }
  }

  compass.last_updated = new Date().toISOString().slice(0, 10);
  writeJson(compassPath, compass);
}

/**
 * 修复 3：重新生成 agent-discovery.json
 */
function fixAgentDiscovery(siteDir, sitePath) {
  const discoveryPath = path.join(sitePath, 'website', 'agent-discovery.json');
  if (!fs.existsSync(discoveryPath)) {
    console.log('  - agent-discovery.json 不存在，跳过');
    return;
  }

  const discovery = readJson(discoveryPath);
  if (!discovery) return;

  const entitiesDir = path.join(sitePath, 'knowledge-base', 'entities');
  const realCounts = countEntities(entitiesDir);
  const totalEntities = Object.values(realCounts).reduce((sum, n) => sum + n, 0);

  discovery.total_entities = totalEntities;
  discovery.last_updated = new Date().toISOString();

  if (discovery.categories) {
    for (const catKey of Object.keys(discovery.categories)) {
      discovery.categories[catKey] = realCounts[catKey] || 0;
    }
  }

  writeJson(discoveryPath, discovery);
}

/**
 * 修复 4：初始化 confidence_scores.json
 */
function fixConfidenceScores(siteDir, sitePath) {
  const scoresPath = path.join(sitePath, 'knowledge-base', 'metadata', 'confidence_scores.json');
  const entitiesDir = path.join(sitePath, 'knowledge-base', 'entities');

  if (!fs.existsSync(entitiesDir)) return;

  const realCounts = countEntities(entitiesDir);
  const scores = {
    version: '1.1.0',
    last_updated: new Date().toISOString(),
    description: '数据可信度评分 — 基于数据来源、新鲜度、交叉验证次数自动计算',
    scoring_criteria: {
      source_authority: '来源权威性（0-40分）：官方文档 > 学术论文 > 新闻 > 博客',
      data_freshness: '数据新鲜度（0-30分）：30天内=30分，90天内=20分，180天内=10分',
      cross_validation: '交叉验证（0-30分）：被多个来源引用次数',
    },
    scores: {},
    summary: {
      total_scored: 0,
      avg_score: 0,
      high_confidence: 0,  // >= 80
      medium_confidence: 0, // 50-79
      low_confidence: 0,    // < 50
    }
  };

  // 为每个实体生成初始评分（基于现有数据）
  for (const [catName, count] of Object.entries(realCounts)) {
    const entityFile = path.join(entitiesDir, catName + '.json');
    const entityData = readJson(entityFile);
    if (!entityData || !entityData.entities) continue;

    for (const entity of entityData.entities) {
      const entityId = entity.id;
      if (!entityId) continue;

      // 基础评分逻辑
      let score = 50; // 默认中等

      // 有 source/sources 字段加分
      if (entity.sources || entity.source_url) {
        score += 15;
      }
      // 有 status 字段加分
      if (entity.status) {
        score += 5;
      }
      // 有 year/version 字段加分
      if (entity.year || entity.version) {
        score += 5;
      }
      // 有 maintainer/vendor 加分
      if (entity.maintainer || entity.vendor) {
        score += 10;
      }

      score = Math.min(score, 100);

      scores.scores[entityId] = {
        score,
        source_authority: entity.sources ? 30 : 15,
        data_freshness: 20, // 默认值，实际应根据 last_updated 计算
        cross_validation: 0,
        last_verified: new Date().toISOString(),
        notes: '初始评分，待人工审核'
      };

      scores.summary.total_scored++;
      if (score >= 80) scores.summary.high_confidence++;
      else if (score >= 50) scores.summary.medium_confidence++;
      else scores.summary.low_confidence++;
    }
  }

  // 计算平均分
  const allScores = Object.values(scores.scores).map(s => s.score);
  scores.summary.avg_score = allScores.length > 0
    ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length * 10) / 10
    : 0;

  writeJson(scoresPath, scores);
  console.log(`  - 评分实体数: ${scores.summary.total_scored}, 平均分: ${scores.summary.avg_score}`);
}

/**
 * 修复 5：初始化 changelog.json（基于文件修改时间）
 */
function fixChangelog(siteDir, sitePath) {
  const changelogPath = path.join(sitePath, 'knowledge-base', 'changelog', 'changelog.json');
  const collectionLogPath = path.join(sitePath, 'knowledge-base', 'metadata', 'collection_log.json');

  const changelog = {
    version: '1.1.0',
    last_updated: new Date().toISOString(),
    entries: []
  };

  // 读取现有的 collection_log 作为初始 changelog
  const collectionLog = readJson(collectionLogPath);
  if (collectionLog && collectionLog.runs) {
    for (const run of collectionLog.runs) {
      changelog.entries.push({
        timestamp: run.timestamp,
        type: 'data_import',
        action: run.action,
        categories: run.categories || [],
        entities_added: run.entities_added || 0,
        notes: run.notes || '',
        source: run.source || 'unknown'
      });
    }
  }

  // 添加本次修复记录
  changelog.entries.push({
    timestamp: new Date().toISOString(),
    type: 'consistency_fix',
    action: 'fix-data-consistency',
    notes: '统一各文件实体计数，初始化 confidence_scores',
    source: 'automated'
  });

  writeJson(changelogPath, changelog);
  console.log(`  - changelog 条目数: ${changelog.entries.length}`);
}

/**
 * 修复 6：为实体数据添加溯源信息
 */
function addProvenance(siteDir, sitePath) {
  const entitiesDir = path.join(sitePath, 'knowledge-base', 'entities');
  if (!fs.existsSync(entitiesDir)) return;

  const files = fs.readdirSync(entitiesDir).filter(f => f.endsWith('.json') && f !== 'main.json');
  let updatedCount = 0;

  for (const file of files) {
    const filePath = path.join(entitiesDir, file);
    const data = readJson(filePath);
    if (!data || !data.entities) continue;

    let modified = false;
    for (const entity of data.entities) {
      // 添加 _provenance 字段（如果不存在）
      if (!entity._provenance) {
        entity._provenance = {
          collected_at: data.last_updated || new Date().toISOString(),
          source: 'manual_curation + web_search',
          verified: false,
          last_verified: null,
          verifier: null
        };
        modified = true;
        updatedCount++;
      }
    }

    if (modified) {
      data.last_updated = new Date().toISOString();
      writeJson(filePath, data);
    }
  }

  console.log(`  - 添加溯源信息的实体数: ${updatedCount}`);
}

/**
 * 修复 7：生成数据一致性验证报告
 */
function generateReport(siteDir, sitePath) {
  const entitiesDir = path.join(sitePath, 'knowledge-base', 'entities');
  const realCounts = countEntities(entitiesDir);
  const totalEntities = Object.values(realCounts).reduce((sum, n) => sum + n, 0);

  const report = {
    site: siteDir,
    timestamp: new Date().toISOString(),
    total_entities: totalEntities,
    category_counts: realCounts,
    files_checked: {
      'main.json': null,
      'compass.json': null,
      'agent-discovery.json': null,
      'confidence_scores.json': null,
    },
    consistency_status: 'PASS',
    issues: []
  };

  // 检查各文件的实体计数
  const mainPath = path.join(entitiesDir, 'main.json');
  const main = readJson(mainPath);
  if (main) {
    report.files_checked['main.json'] = main.total_entities;
    if (main.total_entities !== totalEntities) {
      report.issues.push(`main.json (${main.total_entities}) != 实际总数 (${totalEntities})`);
      report.consistency_status = 'FAIL';
    }
  }

  const compassPath = path.join(sitePath, 'website', 'api', 'compass.json');
  const compass = readJson(compassPath);
  if (compass && compass.categories) {
    const compassTotal = Object.values(compass.categories).reduce(
      (sum, c) => sum + (c.entity_count || 0), 0
    );
    report.files_checked['compass.json'] = compassTotal;
    if (compassTotal !== totalEntities) {
      report.issues.push(`compass.json (${compassTotal}) != 实际总数 (${totalEntities})`);
      report.consistency_status = 'FAIL';
    }
  }

  return report;
}

// === 主流程 ===
function fixSite(siteDir, projectRoot) {
  const sitePath = path.join(projectRoot, siteDir);
  if (!fs.existsSync(sitePath)) {
    console.error(`✗ 站点目录不存在: ${sitePath}`);
    return null;
  }

  console.log(`\n处理站点: ${siteDir}`);
  console.log('─'.repeat(50));

  try {
    fixMainJson(siteDir, sitePath);
    fixCompassJson(siteDir, sitePath);
    fixAgentDiscovery(siteDir, sitePath);
    fixConfidenceScores(siteDir, sitePath);
    fixChangelog(siteDir, sitePath);
    addProvenance(siteDir, sitePath);

    const report = generateReport(siteDir, sitePath);
    console.log(`\n  一致性状态: ${report.consistency_status === 'PASS' ? '✓ 通过' : '✗ 失败'}`);
    if (report.issues.length > 0) {
      report.issues.forEach(issue => console.log(`    - ${issue}`));
    }

    return report;
  } catch (e) {
    console.error(`  ✗ 错误: ${e.message}`);
    return null;
  }
}

// === CLI 入口 ===
function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('用法: node fix-data-consistency.js <site-dir> [--project-root <path>]');
    console.log('     node fix-data-consistency.js --all [--project-root <path>]');
    console.log('');
    console.log('选项:');
    console.log('  --project-root <path>  项目根目录（默认: ../.. 相对于脚本）');
    console.log('  --all                  处理所有 14 个站点');
    process.exit(1);
  }

  let projectRoot = path.resolve(__dirname, '..', '..');
  let targetSite = null;
  let processAll = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-root') {
      projectRoot = args[i + 1];
      i++;
    } else if (args[i] === '--all') {
      processAll = true;
    } else {
      targetSite = args[i];
    }
  }

  console.log(`项目根目录: ${projectRoot}`);
  console.log(`修复时间: ${new Date().toISOString()}`);

  const sites = processAll ? SITES : [targetSite];
  const reports = [];

  for (const site of sites) {
    const report = fixSite(site, projectRoot);
    if (report) reports.push(report);
  }

  // 汇总报告
  if (reports.length > 0) {
    const reportPath = path.join(__dirname, 'consistency-report.json');
    writeJson(reportPath, {
      timestamp: new Date().toISOString(),
      sites_processed: reports.length,
      sites_passed: reports.filter(r => r.consistency_status === 'PASS').length,
      sites_failed: reports.filter(r => r.consistency_status === 'FAIL').length,
      reports
    });
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`汇总: ${reports.length} 站点处理完成`);
    console.log(`  ✓ 通过: ${reports.filter(r => r.consistency_status === 'PASS').length}`);
    console.log(`  ✗ 失败: ${reports.filter(r => r.consistency_status === 'FAIL').length}`);
    console.log(`详细报告: ${reportPath}`);
  }
}

main();
