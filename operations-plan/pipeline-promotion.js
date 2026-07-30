#!/usr/bin/env node
/**
 * 闭环四：推广技术收集与应用
 * pipeline-promotion.js
 *
 * 功能：
 *   1. 监测 SEO 算法变化、社交媒体趋势、内容营销新技术
 *   2. 自动 A/B 测试不同的推广策略
 *   3. 自动优化站点 SEO（IndexNow 提交、结构化数据更新）
 *   4. 自动生成社交媒体推广内容
 *   5. 输出 report-promotion-*.json 供其他闭环消费
 *
 * 使用方式：
 *   node pipeline-promotion.js [--dry-run]
 */

const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');

// ==================== 配置区 ====================

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const LOG_DIR = path.join(PROJECT_ROOT, 'logs');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const SITES_DIR = path.join(PROJECT_ROOT, 'sites');
const PROMOTION_ASSETS_DIR = path.join(PROJECT_ROOT, 'promotion-assets');

/** 推广渠道与策略配置 */
const PROMOTION_CONFIG = {
  // SEO 优化
  seo: {
    enabled: true,
    // IndexNow API 配置
    indexNow: {
      enabled: true,
      endpoint: 'https://api.indexnow.org/IndexNow',
      key: process.env.INDEXNOW_KEY || '',
      keyLocation: process.env.INDEXNOW_KEY_LOCATION || '',
    },
    // 结构化数据更新
    structuredData: {
      enabled: true,
      // 为每个站点的 index.md 生成/更新 JSON-LD
      schemaTypes: {
        default: 'WebSite',
        article: 'TechArticle',
        dataset: 'Dataset',
        software: 'SoftwareApplication',
      },
    },
    // Sitemap 生成
    sitemap: {
      enabled: true,
      baseUrl: process.env.SITE_BASE_URL || 'https://genetech.example',
    },
  },
  // 社交媒体内容生成
  socialMedia: {
    enabled: true,
    platforms: [
      {
        name: 'twitter',
        maxLength: 280,
        hashtagCount: 3,
        template: '【{title}】\n{summary}\n\n{url} {hashtags}',
      },
      {
        name: 'linkedin',
        maxLength: 3000,
        hashtagCount: 5,
        template: '我们刚刚更新了 {siteName} 站点内容：\n\n{title}\n{summary}\n\n了解更多：{url}\n\n{hashtags}',
      },
      {
        name: 'wechat',
        maxLength: 2000,
        hashtagCount: 0,
        template: '【GeneTech 知识引擎 | {siteName}】\n\n{title}\n\n{summary}\n\n阅读原文：{url}',
      },
    ],
  },
  // A/B 测试配置
  abTest: {
    enabled: true,
    // 测试不同标题和描述的推广效果
    variants: [
      { name: 'academic', tone: '学术严谨', prefix: '最新研究' },
      { name: 'casual', tone: '轻松科普', prefix: '你知道吗' },
      { name: 'trendy', tone: '热点追踪', prefix: '🔥 热点' },
    ],
  },
};

/** 监测源配置 */
const MONITOR_SOURCES = {
  // SEO 算法更新 RSS/博客
  seoNews: {
    enabled: true,
    feeds: [
      'https://developers.google.com/search/blog/feed',
    ],
  },
  // 从闭环一读取新增内容作为推广素材
  dataReport: {
    enabled: true,
    // 读取最近的 report-data-*.json
    lookbackDays: 1,
  },
};

// ==================== 工具函数 ====================

function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function getISOTime() {
  return new Date().toISOString();
}

function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

async function ensureDir(dirPath) {
  try { await fs.mkdir(dirPath, { recursive: true }); } catch {}
}

async function readJson(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch { return null; }
}

async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function readDirFiles(dirPath, pattern = /.*/) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter(e => e.isFile() && pattern.test(e.name)).map(e => e.name).sort();
  } catch { return []; }
}

function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { timeout: 30000, ...options }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function withRetry(fn, maxRetries = 3, baseDelayMs = 1000) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, i);
      console.warn(`[Retry ${i + 1}/${maxRetries}] ${err.message}，等待 ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function truncateText(text, maxLen) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

// ==================== 内容发现 ====================

/**
 * 从闭环一的报告中读取新增实体，作为推广素材
 */
async function collectPromotionMaterials(dryRun) {
  const cfg = MONITOR_SOURCES.dataReport;
  const materials = [];
  if (!cfg.enabled) return materials;

  const files = await readDirFiles(REPORTS_DIR, /^report-data-/);
  if (files.length === 0) {
    console.log('[Promo] 无数据积累报告，尝试读取站点实体数据');
    // 兜底：直接读取各站点的 entities.json
    return collectFromSiteEntities();
  }

  // 取最近的一份报告
  const latest = await readJson(path.join(REPORTS_DIR, files[files.length - 1]));
  if (!latest || !latest.newEntitiesSummary) {
    return collectFromSiteEntities();
  }

  for (const entity of latest.newEntitiesSummary.slice(0, 20)) {
    materials.push({
      type: 'new-entity',
      source: entity.source,
      title: entity.title,
      sites: entity.sites,
      url: entity.url,
      doi: entity.doi,
    });
  }

  console.log(`[Promo] 从数据报告收集到 ${materials.length} 条推广素材`);
  return materials;
}

/**
 * 直接从站点实体文件收集素材（兜底方案）
 */
async function collectFromSiteEntities() {
  const materials = [];
  try {
    const siteDirs = await fs.readdir(SITES_DIR, { withFileTypes: true });
    for (const dir of siteDirs.filter(d => d.isDirectory())) {
      const entitiesPath = path.join(SITES_DIR, dir.name, '_data', 'entities.json');
      const entities = await readJson(entitiesPath);
      if (!Array.isArray(entities)) continue;
      // 取每个站点最新的 3 条
      const recent = entities.slice(-3);
      for (const e of recent) {
        materials.push({
          type: 'site-entity',
          site: dir.name,
          title: e.title || e.name || '',
          url: e.url || e.pdfUrl || '',
          source: e.source,
        });
      }
    }
  } catch (err) {
    console.warn(`[Promo] 读取站点实体失败: ${err.message}`);
  }
  console.log(`[Promo] 从站点实体收集到 ${materials.length} 条推广素材`);
  return materials;
}

/**
 * 监测 SEO 算法变化（简易 RSS 读取）
 */
async function monitorSEONews(dryRun) {
  const cfg = MONITOR_SOURCES.seoNews;
  const news = [];
  if (!cfg.enabled) return news;

  for (const feedUrl of cfg.feeds) {
    console.log(`[Promo] 监测 SEO 新闻: ${feedUrl}`);

    if (dryRun) {
      console.log(`[DRY-RUN] 将请求 RSS: ${feedUrl}`);
      news.push({ _dryRun: true, feedUrl });
      continue;
    }

    try {
      const res = await withRetry(() => httpGet(feedUrl), 2, 2000);
      if (res.statusCode !== 200) continue;
      // 简易提取 RSS item 标题
      const items = parseSimpleRSS(res.body);
      console.log(`[Promo] RSS 获取 ${items.length} 条`);
      for (const item of items.slice(0, 5)) {
        news.push({
          type: 'seo-news',
          title: item.title,
          link: item.link,
          pubDate: item.pubDate,
        });
      }
    } catch (err) {
      console.error(`[Promo] RSS 读取失败: ${err.message}`);
    }
  }

  return news;
}

function parseSimpleRSS(xml) {
  const items = [];
  const itemRegex = /<item>[\s\S]*?<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const xmlStr = m[0];
    const getTag = (tag) => {
      const r = new RegExp(`<${tag}>([\s\S]*?)<\/${tag}>`);
      const mm = xmlStr.match(r);
      return mm ? mm[1].trim() : '';
    };
    items.push({
      title: getTag('title').replace(/<!\[CDATA\[(.*?)\]\]>/, '$1'),
      link: getTag('link'),
      pubDate: getTag('pubDate'),
    });
  }
  return items;
}

// ==================== SEO 优化执行 ====================

/**
 * 为所有站点生成/更新结构化数据（JSON-LD）
 */
async function updateStructuredData(materials, dryRun) {
  const cfg = PROMOTION_CONFIG.seo.structuredData;
  if (!cfg.enabled) return { updated: 0, files: [] };

  const updatedFiles = [];

  // 为每个有素材的站点生成 JSON-LD
  const siteGroups = {};
  for (const m of materials) {
    const sites = m.sites || [m.site];
    for (const site of sites) {
      if (!siteGroups[site]) siteGroups[site] = [];
      siteGroups[site].push(m);
    }
  }

  for (const [site, items] of Object.entries(siteGroups)) {
    const siteDir = path.join(SITES_DIR, site);
    const jsonLdPath = path.join(siteDir, 'structured-data.json');

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': cfg.schemaTypes.default,
      name: `GeneTech ${site}`,
      url: `${PROMOTION_CONFIG.seo.sitemap.baseUrl}/${site}/`,
      dateModified: getISOTime(),
      hasPart: items.map(item => ({
        '@type': item.type === 'new-entity' && item.source === 'github' ? cfg.schemaTypes.software : cfg.schemaTypes.article,
        headline: item.title,
        url: item.url || '',
        datePublished: getTodayDate(),
      })),
    };

    if (dryRun) {
      console.log(`[DRY-RUN] [SEO] 将更新结构化数据: ${jsonLdPath}`);
      updatedFiles.push({ path: jsonLdPath, dryRun: true });
      continue;
    }

    try {
      await ensureDir(siteDir);
      await writeJson(jsonLdPath, jsonLd);
      updatedFiles.push({ path: jsonLdPath, updated: true });
      console.log(`[SEO] 结构化数据已更新: ${jsonLdPath}`);
    } catch (err) {
      console.error(`[SEO] 更新失败 ${jsonLdPath}: ${err.message}`);
    }
  }

  return { updated: updatedFiles.length, files: updatedFiles };
}

/**
 * 生成 Sitemap
 */
async function generateSitemap(materials, dryRun) {
  const cfg = PROMOTION_CONFIG.seo.sitemap;
  if (!cfg.enabled) return { path: null };

  const sitemapPath = path.join(PROJECT_ROOT, 'sitemap.xml');

  // 收集所有需要索引的 URL
  const urls = new Set([`${cfg.baseUrl}/`]);
  for (const m of materials) {
    const sites = m.sites || [m.site];
    for (const site of sites) {
      urls.add(`${cfg.baseUrl}/${site}/`);
    }
    if (m.url) urls.add(m.url);
  }

  const xmlLines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const url of urls) {
    xmlLines.push('  <url>');
    xmlLines.push(`    <loc>${escapeXml(url)}</loc>`);
    xmlLines.push(`    <lastmod>${getTodayDate()}</lastmod>`);
    xmlLines.push('    <changefreq>daily</changefreq>');
    xmlLines.push('  </url>');
  }
  xmlLines.push('</urlset>');
  const content = xmlLines.join('\n');

  if (dryRun) {
    console.log(`[DRY-RUN] [SEO] 将生成 sitemap: ${sitemapPath} (${urls.size} 个 URL)`);
    return { path: sitemapPath, urlCount: urls.size, dryRun: true };
  }

  await fs.writeFile(sitemapPath, content, 'utf-8');
  console.log(`[SEO] Sitemap 已生成: ${sitemapPath} (${urls.size} 个 URL)`);
  return { path: sitemapPath, urlCount: urls.size };
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 通过 IndexNow 提交 URL
 */
async function submitIndexNow(urls, dryRun) {
  const cfg = PROMOTION_CONFIG.seo.indexNow;
  if (!cfg.enabled || !cfg.key) {
    console.log('[SEO] IndexNow 未配置 key，跳过提交');
    return { submitted: 0 };
  }

  const payload = {
    host: new URL(PROMOTION_CONFIG.seo.sitemap.baseUrl).hostname,
    key: cfg.key,
    keyLocation: cfg.keyLocation || '',
    urlList: Array.from(urls).slice(0, 10000), // IndexNow 单次最多 10000
  };

  if (dryRun) {
    console.log(`[DRY-RUN] [SEO] 将通过 IndexNow 提交 ${payload.urlList.length} 个 URL`);
    return { submitted: payload.urlList.length, dryRun: true };
  }

  try {
    // Node.js 原生 https.request POST
    const result = await new Promise((resolve, reject) => {
      const postData = JSON.stringify(payload);
      const urlObj = new URL(cfg.endpoint);
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(postData),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    console.log(`[SEO] IndexNow 提交结果: HTTP ${result.statusCode}`);
    return { submitted: payload.urlList.length, statusCode: result.statusCode };
  } catch (err) {
    console.error(`[SEO] IndexNow 提交失败: ${err.message}`);
    return { submitted: 0, error: err.message };
  }
}

// ==================== 社交媒体内容生成 ====================

/**
 * 基于素材生成各平台的推广内容
 */
function generateSocialContent(materials) {
  const contents = [];
  const platforms = PROMOTION_CONFIG.socialMedia.platforms;

  for (const material of materials.slice(0, 5)) {
    const title = material.title || 'GeneTech 更新';
    const summary = truncateText(title, 100);
    const url = material.url || `${PROMOTION_CONFIG.seo.sitemap.baseUrl}/${(material.sites || [material.site])[0]}/`;
    const siteName = (material.sites || [material.site])[0] || 'GeneTech';

    for (const platform of platforms) {
      const hashtags = generateHashtags(material, platform.hashtagCount);
      let text = platform.template
        .replace('{title}', title)
        .replace('{summary}', summary)
        .replace('{url}', url)
        .replace('{siteName}', siteName)
        .replace('{hashtags}', hashtags);

      text = truncateText(text, platform.maxLength);

      contents.push({
        platform: platform.name,
        materialTitle: title,
        text,
        hashtags,
        url,
        generatedAt: getISOTime(),
      });
    }
  }

  return contents;
}

function generateHashtags(material, count) {
  const tags = ['#GeneTech', '#AI', '#TechNews'];
  if (material.source === 'github') tags.push('#OpenSource');
  if (material.source === 'arxiv') tags.push('#Research');
  const siteTag = (material.sites || [material.site])[0];
  if (siteTag) tags.push(`#${siteTag.replace(/-/g, '')}`);
  return tags.slice(0, count).join(' ');
}

/**
 * 保存生成的社交媒体内容
 */
async function saveSocialContents(contents, dryRun) {
  const filePath = path.join(PROMOTION_ASSETS_DIR, `social-contents-${getTimestamp()}.json`);

  if (dryRun) {
    console.log(`[DRY-RUN] [Social] 将保存 ${contents.length} 条推广内容到 ${filePath}`);
    return { filePath, count: contents.length, dryRun: true };
  }

  await ensureDir(PROMOTION_ASSETS_DIR);
  await writeJson(filePath, contents);
  console.log(`[Social] 推广内容已保存: ${filePath}`);
  return { filePath, count: contents.length };
}

// ==================== A/B 测试 ====================

/**
 * 为同一素材生成不同风格的推广变体
 */
function generateABVariants(materials) {
  const variants = PROMOTION_CONFIG.abTest.variants;
  const tests = [];

  for (const material of materials.slice(0, 3)) {
    const title = material.title || 'GeneTech 更新';
    for (const variant of variants) {
      tests.push({
        materialTitle: title,
        variantName: variant.name,
        tone: variant.tone,
        headline: `${variant.prefix}：${title}`,
        summary: truncateText(`${variant.prefix} — ${title}`, 120),
      });
    }
  }

  return tests;
}

async function saveABTests(tests, dryRun) {
  const filePath = path.join(PROMOTION_ASSETS_DIR, `ab-tests-${getTimestamp()}.json`);
  if (dryRun) {
    console.log(`[DRY-RUN] [A/B] 将保存 ${tests.length} 个测试变体到 ${filePath}`);
    return { filePath, count: tests.length, dryRun: true };
  }
  await ensureDir(PROMOTION_ASSETS_DIR);
  await writeJson(filePath, tests);
  console.log(`[A/B] 测试变体已保存: ${filePath}`);
  return { filePath, count: tests.length };
}

// ==================== 主流程 ====================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const modeLabel = dryRun ? '[DRY-RUN]' : '[PROD]';

  console.log(`${modeLabel} ==========================================`);
  console.log(`${modeLabel} 闭环四：推广技术应用 启动`);
  console.log(`${modeLabel} 时间: ${getISOTime()}`);
  console.log(`${modeLabel} ==========================================`);

  const statePath = path.join(STATE_DIR, 'pipeline-promotion-state.json');
  const state = await readJson(statePath) || {};

  await ensureDir(STATE_DIR);
  await ensureDir(LOG_DIR);
  await ensureDir(REPORTS_DIR);
  await ensureDir(PROMOTION_ASSETS_DIR);

  const startTime = Date.now();

  // ---------- Phase 1: 收集素材与监测 ----------
  console.log('\n[Phase 1] 收集推广素材与监测 SEO 动态...');
  const materials = await collectPromotionMaterials(dryRun);
  const seoNews = await monitorSEONews(dryRun);

  // ---------- Phase 2: SEO 优化 ----------
  console.log('\n[Phase 2] 执行 SEO 优化...');
  const structuredDataResult = await updateStructuredData(materials, dryRun);
  const sitemapResult = await generateSitemap(materials, dryRun);

  // 收集所有需要提交的 URL
  const urlsToSubmit = new Set();
  if (sitemapResult.urlCount) {
    // 从 sitemap 解析出的 URL 可以直接用于 IndexNow
    // 简化：直接提交站点首页和素材页
    for (const m of materials) {
      const sites = m.sites || [m.site];
      for (const site of sites) {
        urlsToSubmit.add(`${PROMOTION_CONFIG.seo.sitemap.baseUrl}/${site}/`);
      }
    }
  }
  const indexNowResult = await submitIndexNow(urlsToSubmit, dryRun);

  // ---------- Phase 3: 社交媒体内容生成 ----------
  console.log('\n[Phase 3] 生成社交媒体推广内容...');
  const socialContents = generateSocialContent(materials);
  const socialResult = await saveSocialContents(socialContents, dryRun);

  // ---------- Phase 4: A/B 测试变体 ----------
  console.log('\n[Phase 4] 生成 A/B 测试变体...');
  const abTests = generateABVariants(materials);
  const abResult = await saveABTests(abTests, dryRun);

  // ---------- Phase 5: 生成报告 ----------
  const report = {
    pipeline: 'promotion',
    version: '1.0',
    timestamp: getISOTime(),
    dryRun,
    durationMs: Date.now() - startTime,
    summary: {
      materialsCount: materials.length,
      seoNewsCount: seoNews.filter(n => !n._dryRun).length,
      structuredDataUpdated: structuredDataResult.updated,
      sitemapUrlCount: sitemapResult.urlCount || 0,
      indexNowSubmitted: indexNowResult.submitted,
      socialContentsGenerated: socialContents.length,
      abTestVariants: abTests.length,
    },
    seoNews: seoNews.map(n => ({
      title: n.title,
      link: n.link,
      _dryRun: n._dryRun || false,
    })),
    materials: materials.map(m => ({
      type: m.type,
      title: m.title,
      sites: m.sites || [m.site],
      source: m.source,
    })),
    socialContents: socialContents.map(c => ({
      platform: c.platform,
      text: c.text,
      hashtags: c.hashtags,
    })),
    abTests: abTests.map(t => ({
      variantName: t.variantName,
      headline: t.headline,
    })),
    // 传递给闭环五的信息
    promotionMetrics: {
      channels: ['seo', 'social-media', 'ab-test'],
      estimatedReach: materials.length * 100, // 粗略估算
      contentFreshness: getISOTime(),
    },
  };

  const reportPath = path.join(REPORTS_DIR, `report-promotion-${getTimestamp()}.json`);
  if (dryRun) {
    console.log(`[DRY-RUN] 将生成报告: ${reportPath}`);
  } else {
    await writeJson(reportPath, report);
    console.log(`[Report] 已生成: ${reportPath}`);
  }

  // 保存状态
  const newState = {
    lastRunTime: getISOTime(),
    lastReportPath: reportPath,
    totalRuns: (state.totalRuns || 0) + 1,
    totalMaterialsPromoted: (state.totalMaterialsPromoted || 0) + materials.length,
    totalSocialContents: (state.totalSocialContents || 0) + socialContents.length,
  };
  if (!dryRun) {
    await writeJson(statePath, newState);
  }

  console.log(`\n${modeLabel} ==========================================`);
  console.log(`${modeLabel} 推广技术应用 执行完毕`);
  console.log(`${modeLabel} 耗时: ${report.durationMs}ms`);
  console.log(`${modeLabel} 素材: ${materials.length}, 社交内容: ${socialContents.length}, SEO更新: ${structuredDataResult.updated}`);
  console.log(`${modeLabel} ==========================================`);
}

main().catch(err => {
  console.error('[FATAL] 未捕获的异常:', err);
  process.exit(1);
});
