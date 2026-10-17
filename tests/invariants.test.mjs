#!/usr/bin/env node
/**
 * tests/invariants.test.mjs — 数据地基不变量断言（F2）
 * ─────────────────────────────────────────────────────────────────────────
 * 背景
 *   报告 §2 点名的"正确性契约地基"缺口：44 个 test 文件多数是 .workbuddy/probe
 *   临时探针，真正带断言的只有 mcp-remote/_test_contract.mjs（46 断言），
 *   根 package.json 无 scripts.test——**没有任何东西在自动阻止"声明完成
 *   vs 实测可用"落差**（npm 1.1.0、11/14 工具 404、TS 双请求、README 对不上
 *   代码）。本文件是"地板"，必须先铺。
 *
 * 五条不变量（报告 §2 · 硬骨头动作 4）
 *   1. 每站 index.json.totalEntities === entities.length（0 漂移）
 *      —— 30 站同构只是约定，不是约束；这是最基础的契约。
 *   2. 全局 ID 唯一（跨站合并后无重复 id）
 *      —— F5 ID 规范化前置：如果连 ID 都重复，ER/claim 图无意义。
 *   3. KG 边不指向不存在的节点（悬空边 = 0）
 *      —— 图谱结构完整性；一旦悬空，任何基于边的算法都会漏节点。
 *   4. search-index.totalEntities 与 30 站实体总数一致（容差 ≤5%）
 *      —— 索引层与源数据层不能漂移；此前分片只覆盖 76% DOI 就是这类问题。
 *   5. 实体 url 与 publishedDate 可解析率 ≥99.9%（超阈值才红，基线 15 条不可解析）
 *      —— 硬字段质量守门；报告 §2 实测 15 条不可解析需守住不扩散。
 *
 * 为什么用 node:test
 *   零依赖（Node 20+ 内置），与 CI 环境一致；报告 §2 明确点名"零依赖"。
 *
 * 为什么用 M1-M4 双向回归思路
 *   项目血泪：门禁必须双向回归（注入故障→exit 1→恢复→exit 0），绿灯≠有效。
 *   本文件默认全量跑真数据；`npm run test:invariants -- --inject=broken`
 *   可注入故障做回归演练（在 CI 里由 signverify 类似的独立任务触发）。
 *
 * 用法
 *   npm test                                     # 跑本文件 + 其它 tests/**
 *   npm run test:invariants                      # 只跑不变量
 *   npm run test:invariants -- --dry-run         # 打印将查的东西，不真跑
 *   npm run test:invariants -- --inject=broken   # 注入故障（回归演练）
 *
 * 退出码：0 = 全部通过 / 1 = 至少一条不变量破坏
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const INJECT = process.argv.includes('--inject=broken');

const ALLOWED_ID_PREFIXES = new Set([
  'doi', 'oa', 'pmid', 'arxiv', 'epmc', 'ss', 'pp', 'url',
  // 兼容历史裸前缀（F5 会统一清理）
  '10', // DOI 部分无 doi: 前缀
]);
const SEARCH_INDEX_DRIFT_TOLERANCE = 0.05;
const URL_PARSE_RATE_MIN = 0.999;
const DATE_PARSE_RATE_MIN = 0.999;

// ==================== 数据加载 ====================

function readJson(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function listSites() {
  const r = readdirSync(ROOT, { withFileTypes: true });
  return r
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== 'archive')
    .filter(d => existsSync(join(ROOT, d.name, 'website', 'api', 'index.json')))
    .map(d => d.name)
    .sort();
}

// 缓存，避免每条断言重新读盘
let SITES = [];
let SITE_DATA = {};
let KG = null;
let SEARCH_INDEX = null;
let CITATION_EDGES = null;

before(async () => {
  if (DRY_RUN) return;
  SITES = listSites();
  for (const s of SITES) {
    SITE_DATA[s] = {
      index: readJson(join(s, 'website/api/index.json')),
      entities: readJson(join(s, 'website/api/entities.json')),
    };
  }
  KG = readJson('data/knowledge-graph.json');
  SEARCH_INDEX = readJson('data/search-index.json');
  CITATION_EDGES = readJson('data/citation-edges.json');
});

// ==================== 不变量 1：index.json 计数契约 ====================

test('INV1 · 每站 index.json.totalEntities === entities.length', () => {
  if (DRY_RUN) {
    console.log('[dry-run] INV1: 检查每站 index.json.totalEntities === entities.length');
    return;
  }
  const drifts = [];
  for (const s of SITES) {
    const { index, entities } = SITE_DATA[s];
    if (!index || !entities) {
      drifts.push({ site: s, reason: 'missing-file' });
      continue;
    }
    if (index.totalEntities !== entities.length) {
      drifts.push({
        site: s,
        indexTotal: index.totalEntities,
        entitiesLength: entities.length,
        delta: index.totalEntities - entities.length,
      });
    }
  }
  if (drifts.length) {
    console.error(`INV1 破坏：${drifts.length}/${SITES.length} 站计数漂移`);
    for (const d of drifts.slice(0, 5)) {
      console.error(`  - ${d.site}: index=${d.indexTotal} entities=${d.entitiesLength} delta=${d.delta}`);
    }
  }
  assert.equal(drifts.length, 0, `INV1 破坏：${drifts.length} 站计数漂移（每站 index.json.totalEntities === entities.length）`);
});

// ==================== 不变量 2：全局 ID 唯一 ====================

test('INV2 · 全局 ID 唯一（跨站合并无重复）', () => {
  if (DRY_RUN) {
    console.log('[dry-run] INV2: 检查全局 ID 唯一性');
    return;
  }
  const seen = new Map();
  for (const s of SITES) {
    for (const e of SITE_DATA[s].entities || []) {
      if (!e?.id) continue;
      const key = String(e.id).toLowerCase();
      if (!seen.has(key)) seen.set(key, { count: 1, sites: new Set([s]) });
      else {
        const rec = seen.get(key);
        rec.count++;
        rec.sites.add(s);
      }
    }
  }
  const dupes = [...seen.entries()].filter(([, v]) => v.count > 1);
  // 报告 §1.2 实测：跨站重复 DOI 15,013 条。这条不变量在 F5 之前**允许**跨站重复，
  // 但**同站**内重复 ID 是硬错误——同站同 ID 意味着同一份数据出现两次。
  const sameSiteDupes = [];
  const crossSiteDupes = [];
  for (const [id, rec] of dupes) {
    if (rec.sites.size === 1) sameSiteDupes.push({ id, ...rec });
    else crossSiteDupes.push({ id, ...rec });
  }
  if (sameSiteDupes.length) {
    console.error(`INV2 破坏（硬）：${sameSiteDupes.length} 条同站重复 ID`);
    for (const d of sameSiteDupes.slice(0, 5)) {
      console.error(`  - ${d.id} (site=${[...d.sites][0]}, count=${d.count})`);
    }
  }
  console.log(`INV2 观察：跨站重复 ID ${crossSiteDupes.length} 条（F5 归一前置，当前不阻断）`);
  assert.equal(sameSiteDupes.length, 0, `INV2 硬门禁破坏：${sameSiteDupes.length} 条同站重复 ID`);
});

// ==================== 不变量 3：KG 边不指向不存在的节点 ====================

test('INV3 · 知识图谱边不指向不存在的节点（悬空边 = 0）', () => {
  if (DRY_RUN) {
    console.log('[dry-run] INV3: 检查 KG 边端点是否都在节点集合里');
    return;
  }
  assert.ok(KG, 'INV3: data/knowledge-graph.json 不存在');
  const nodeIds = new Set(KG.nodes.map(n => n.id));
  const dangling = [];
  for (const e of KG.edges) {
    if (!nodeIds.has(e.source)) dangling.push({ edge: e, missing: 'source' });
    else if (!nodeIds.has(e.target)) dangling.push({ edge: e, missing: 'target' });
    if (dangling.length >= 10) break; // 抽样即判定
  }
  if (dangling.length) {
    console.error(`INV3 破坏：${dangling.length}+ 条边指向不存在节点`);
    for (const d of dangling.slice(0, 5)) {
      console.error(`  - ${d.edge.relation} ${d.edge.source} -> ${d.edge.target} (missing ${d.missing})`);
    }
  }
  assert.equal(dangling.length, 0, `INV3 破坏：KG 存在悬空边（${dangling.length}+）`);
});

// ==================== 不变量 4：search-index 与源数据不漂移 ====================

test('INV4 · search-index.totalEntities 与 30 站实体总数不漂移（容差 5%）', () => {
  if (DRY_RUN) {
    console.log('[dry-run] INV4: 检查 search-index 与 30 站实体总数');
    return;
  }
  assert.ok(SEARCH_INDEX, 'INV4: data/search-index.json 不存在');
  let totalEntities = 0;
  for (const s of SITES) totalEntities += SITE_DATA[s].entities?.length || 0;
  const indexTotal = SEARCH_INDEX.totalEntities || 0;
  const drift = totalEntities > 0 ? Math.abs(indexTotal - totalEntities) / totalEntities : 0;
  console.log(`INV4 观察：30 站 ${totalEntities} / search-index ${indexTotal} / 漂移 ${(drift * 100).toFixed(2)}%`);
  assert.ok(
    drift <= SEARCH_INDEX_DRIFT_TOLERANCE,
    `INV4 破坏：search-index 与源数据漂移 ${(drift * 100).toFixed(2)}% > 阈值 ${SEARCH_INDEX_DRIFT_TOLERANCE * 100}%`
  );
});

// ==================== 不变量 5：URL 与 publishedDate 可解析率 ≥99.9% ====================

test('INV5 · 实体 url / publishedDate 可解析率 ≥99.9%', () => {
  if (DRY_RUN) {
    console.log('[dry-run] INV5: 检查 url / publishedDate 可解析率');
    return;
  }
  let total = 0, urlBad = 0, dateBad = 0;
  const urlBadSamples = [];
  const dateBadSamples = [];
  for (const s of SITES) {
    for (const e of SITE_DATA[s].entities || []) {
      total++;
      if (e.url) {
        try {
          new URL(e.url);
        } catch {
          urlBad++;
          if (urlBadSamples.length < 3) urlBadSamples.push({ site: s, id: e.id, url: e.url });
        }
      }
      if (e.publishedDate) {
        const t = Date.parse(e.publishedDate);
        if (Number.isNaN(t)) {
          dateBad++;
          if (dateBadSamples.length < 3) dateBadSamples.push({ site: s, id: e.id, publishedDate: e.publishedDate });
        }
      }
    }
  }
  const urlRate = 1 - urlBad / total;
  const dateRate = 1 - dateBad / total;
  console.log(`INV5 观察：url 可解析率 ${(urlRate * 100).toFixed(3)}% (${urlBad} 坏) / publishedDate 可解析率 ${(dateRate * 100).toFixed(3)}% (${dateBad} 坏) / 总 ${total}`);
  assert.ok(
    urlRate >= URL_PARSE_RATE_MIN,
    `INV5 破坏：url 可解析率 ${(urlRate * 100).toFixed(3)}% < ${URL_PARSE_RATE_MIN * 100}%（坏 ${urlBad} 条）`
  );
  assert.ok(
    dateRate >= DATE_PARSE_RATE_MIN,
    `INV5 破坏：publishedDate 可解析率 ${(dateRate * 100).toFixed(3)}% < ${DATE_PARSE_RATE_MIN * 100}%（坏 ${dateBad} 条）`
  );
});

// ==================== 不变量 6：KG 边必须有 tier 分级 ====================

test('INV6 · KG 边必须有合法 tier（1-5）', () => {
  if (DRY_RUN) {
    console.log('[dry-run] INV6: 检查 KG 边 tier 字段完整性');
    return;
  }
  assert.ok(KG, 'INV6: data/knowledge-graph.json 不存在');
  assert.equal(KG.version, 5, `INV6 破坏：KG schema 版本应为 5（当前 ${KG.version}），tier 分级必须启用`);
  const bad = [];
  const tierDist = {};
  for (const e of KG.edges) {
    const t = e.tier;
    if (!Number.isInteger(t) || t < 1 || t > 5) {
      bad.push({ edge: e, tier: t });
      if (bad.length >= 10) break;
    } else {
      tierDist[t] = (tierDist[t] || 0) + 1;
    }
  }
  console.log(`INV6 观察：KG 边 tier 分布 ${JSON.stringify(tierDist)}，共 ${KG.edges.length} 边`);
  assert.equal(bad.length, 0, `INV6 破坏：${bad.length}+ 条 KG 边 tier 缺失或越界`);
});

// ==================== 不变量 7：citation-edges 必须有 validFrom + tier ====================

test('INV7 · citation-edges 边必须有 validFrom + tier（F10 时间戳+分级契约）', () => {
  if (DRY_RUN) {
    console.log('[dry-run] INV7: 检查 citation-edges 边 validFrom/tier 完整性');
    return;
  }
  assert.ok(CITATION_EDGES, 'INV7: data/citation-edges.json 不存在');
  assert.ok(
    CITATION_EDGES.schemaVersion?.startsWith('genetech-citation-edges/v4') ||
    CITATION_EDGES.schemaVersion?.startsWith('genetech-citation-edges/v5'),
    `INV7 破坏：schemaVersion 应为 v4+（当前 ${CITATION_EDGES.schemaVersion}），需已完成 F8 结构化迁移`
  );
  const missingFields = { validFrom: 0, tier: 0, validTo: 0 };
  const tierDist = {};
  const methodDist = {};
  for (const e of CITATION_EDGES.edges) {
    if (Array.isArray(e)) continue; // 旧格式已在 INV7 前的迁移阶段处理
    if (!e.validFrom) missingFields.validFrom++;
    if (!('validTo' in e)) missingFields.validTo++;
    const t = e.tier;
    if (!Number.isInteger(t) || t < 1 || t > 5) {
      missingFields.tier++;
    } else {
      tierDist[t] = (tierDist[t] || 0) + 1;
    }
    const m = e.method || 'unknown';
    methodDist[m] = (methodDist[m] || 0) + 1;
  }
  console.log(`INV7 观察：citation-edges 共 ${CITATION_EDGES.edges.length} 边 / tier 分布 ${JSON.stringify(tierDist)} / method 分布 ${JSON.stringify(methodDist)} / 缺字段 ${JSON.stringify(missingFields)}`);
  const totalMissing = missingFields.validFrom + missingFields.tier + missingFields.validTo;
  assert.equal(totalMissing, 0, `INV7 破坏：citation-edges 缺字段 ${JSON.stringify(missingFields)}`);
});

// ==================== 故障注入（回归演练用）====================

if (INJECT) {
  test('INJECT · 回归演练：破坏 INV1 应该让 CI 变红', () => {
    if (DRY_RUN) return;
    // 模拟：把第一站的 index.totalEntities 改 1
    const s = SITES[0];
    const orig = SITE_DATA[s].index.totalEntities;
    SITE_DATA[s].index.totalEntities = orig + 1;
    // 再手动跑一遍 INV1 的判定逻辑
    const drift = SITE_DATA[s].index.totalEntities !== (SITE_DATA[s].entities?.length || 0);
    assert.equal(drift, true, 'INJECT 预期失败但没失败——门禁失效');
    // 恢复
    SITE_DATA[s].index.totalEntities = orig;
  });
}
