#!/usr/bin/env node
/**
 * 自动推广闭环（GEO / SEO）—— pipeline-geo-promotion.js
 *
 * 设计原则：完全自动化、零人工参与。所有获客动作由机器自跑，无需任何外部账号或密钥。
 * 每次运行（默认每日，随 ops-extra 12:30 UTC 跑）会：
 *   1. 按新增实体自动生成 GEO 博客文章（Markdown）→ 进 content/blog/ → 触发 pages-deploy 自动部署
 *   2. 通过 IndexNow 把站点/文章 URL 推给 Bing / Yandex（key 取自仓库内置 state/indexnow-key.txt，零账号）
 *   3. 主动向 Google / Bing 提交 sitemap（免密钥 ping 端点，永远可用）
 *   4. 自动设置 GitHub Topics（用内置 GITHUB_TOKEN，零额外密钥）
 *   5. 可选：自动发布到 dev.to（需 Secret DEV_TO_API_KEY——唯一需要用户账号的渠道，缺则优雅跳过）
 *   6. 自动更新「🚀 GEO 自动推广状态」GitHub Issue，闭环自报告
 *
 * 所有外部调用均优雅降级：缺密钥/接口异常仅记录，不阻断整体流程。
 *
 * 用法：node pipeline-geo-promotion.js [--dry-run]
 * 环境变量：SITE_BASE_URL, INDEXNOW_KEY(可选覆盖), DEV_TO_API_KEY(可选), GITHUB_TOKEN, GITHUB_REPOSITORY
 */

const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'reports');
const CONTENT_BLOG_DIR = path.join(PROJECT_ROOT, 'content', 'blog');

const SITE_BASE_URL =
  process.env.SITE_BASE_URL || 'https://lm203688.github.io/genetech-14-sites';
// IndexNow 密钥：优先用 CI 注入的 INDEXNOW_KEY；否则读取仓库内置稳定 key（state/indexnow-key.txt，
// 已随仓库提交，零外部账号），从而 IndexNow 提交完全自治，不需要任何 Bing 账号或 Secret。
function loadIndexNowKey() {
  if (process.env.INDEXNOW_KEY) return process.env.INDEXNOW_KEY;
  try {
    const kp = path.join(PROJECT_ROOT, 'state', 'indexnow-key.txt');
    if (fss.existsSync(kp)) {
      const k = fss.readFileSync(kp, 'utf8').trim();
      if (k) return k;
    }
  } catch {}
  return '';
}
const INDEXNOW_KEY = loadIndexNowKey();
const DEV_TO_API_KEY = process.env.DEV_TO_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || 'lm203688/genetech-14-sites';

const SITE_LABELS = {
  'agent-ecosystem': 'AI Agent 生态',
  'alien-minerals': '地外矿物',
  biocomputing: '生物计算',
  'bionic-ai': '仿生智能',
  'brain-science': '脑科学',
  'deep-sea-tech': '深海科技',
  'exo-science': '地外科学',
  'genetech-tools': '基因技术工具',
  'life-science': '生命科学',
  'new-energy': '新能源',
  'nuclear-energy': '核能',
  'quantum-computing': '量子计算',
  'robot-parts': '机器人零部件',
  'tcm-tools': '中医药工具',
};

function getToday() {
  return new Date().toISOString().slice(0, 10);
}
function getTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
async function readJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}
async function writeJson(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf8');
}
function httpReq(urlStr, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          'User-Agent': 'genetech-geo-bot',
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
        timeout: 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}
function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
/** 清洗摘要：去除源数据自带的 JATS/HTML 标签与实体编码，避免渲染出 <jats:p> 等噪音 */
function cleanAbstract(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ==================== 1. 收集新增实体 ====================
async function collectAllEntities() {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(PROJECT_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const entPath = path.join(PROJECT_ROOT, e.name, 'website', 'api', 'entities.json');
    const idxPath = path.join(PROJECT_ROOT, e.name, 'website', 'api', 'index.json');
    if (!fss.existsSync(entPath)) continue;
    let entities = await readJson(entPath);
    let index = await readJson(idxPath);
    if (!Array.isArray(entities)) continue;
    for (const ent of entities) {
      out.push({
        site: e.name,
        label: SITE_LABELS[e.name] || e.name,
        name: ent.name || ent.title || '(未命名)',
        url: ent.url || '',
        abstract: typeof ent.abstract === 'string' ? ent.abstract : '',
        source: ent.source || '',
        confidence: typeof ent.confidence === 'number' ? ent.confidence : null,
        addedAt: ent.addedAt || '',
      });
    }
  }
  return out;
}

// ==================== 2. 生成 GEO 文章 ====================
async function maybeGeneratePost(allEntities, state, dryRun) {
  const lastAddedAt = state.lastAddedAt || '';
  const newOnes =
    lastAddedAt
      ? allEntities.filter((e) => e.addedAt && e.addedAt > lastAddedAt)
      : allEntities.slice();
  const today = getToday();
  const daysSincePost = state.lastPostDate
    ? Math.floor((Date.now() - new Date(state.lastPostDate).getTime()) / 86400000)
    : 999;

  const shouldGen = newOnes.length >= 6 || (daysSincePost >= 5 && newOnes.length >= 1);
  if (!shouldGen) {
    return {
      generated: false,
      reason: `新增实体 ${newOnes.length} 条，距上次发文 ${daysSincePost} 天，未达生成阈值（≥6 条或 ≥5 天）`,
      cursor: lastAddedAt,
    };
  }

  // 取最新新增，每站最多 3 条，总计 10 条
  const sorted = [...newOnes].sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  const perSite = {};
  const picked = [];
  for (const e of sorted) {
    perSite[e.site] = (perSite[e.site] || 0) + 1;
    if (perSite[e.site] <= 3 && picked.length < 10) picked.push(e);
  }

  const bySite = {};
  for (const e of picked) (bySite[e.site] = bySite[e.site] || []).push(e);
  const siteList = Object.keys(bySite);

  const lines = [];
  lines.push(
    `本文由 GeneTech 自动化流水线基于最新入库的科研实体生成，覆盖：${siteList
      .map((s) => SITE_LABELS[s] || s)
      .join('、')}。所有条目均带原始来源链接，可被 AI Agent 直接引用。`,
  );
  lines.push('');
  for (const site of siteList) {
    lines.push(`## ${SITE_LABELS[site] || site}`);
    for (const e of bySite[site]) {
      const conf = e.confidence != null ? ` · 置信度 ${e.confidence.toFixed(2)}` : '';
      const src = e.source ? ` · 来源 ${e.source}` : '';
      const absRaw = cleanAbstract(e.abstract);
      const abs = absRaw ? ` — ${absRaw.slice(0, 120)}${absRaw.length > 120 ? '…' : ''}` : '';
      const link = e.url ? `[${e.name}](${e.url})` : e.name;
      lines.push(`- **${link}**${src}${conf}${abs}`);
    }
    lines.push('');
  }
  lines.push('## 如何接入这些知识');
  lines.push('');
  lines.push('通过一行命令把 14 个前沿科技领域的结构化知识接入你的 AI Agent：');
  lines.push('');
  lines.push('```');
  lines.push('npx -y @genetech/data-mcp');
  lines.push('```');
  lines.push('');
  lines.push(
    `或在 [全局搜索](${SITE_BASE_URL}/search.html) 中直接检索，或浏览 [14 个知识领域](${SITE_BASE_URL}/)。`,
  );

  const title = `GeneTech 前沿速览（${today}）：${siteList
    .slice(0, 3)
    .map((s) => SITE_LABELS[s] || s)
    .join('、')} 等 ${picked.length} 条新增实体`;
  const desc = `GeneTech 自动化生成的 GEO 速览：汇总 ${picked.length} 条最新科研实体，覆盖 ${siteList.length} 个前沿科技领域，全部带可溯源链接。`;
  const keywords = ['GeneTech', '前沿科技', '知识引擎', 'GEO', ...siteList.slice(0, 4)].join(', ');

  const md = `---\ntitle: ${title}\ndesc: ${desc}\ndate: ${today}\nkeywords: ${keywords}\n---\n\n${lines.join('\n')}\n`;

  const slug = `geo-roundup-${today}`;
  const filePath = path.join(CONTENT_BLOG_DIR, `${slug}.md`);

  // 推进游标到全量实体最新 addedAt，避免下次重复
  const maxAdded = allEntities.reduce(
    (m, e) => (e.addedAt && e.addedAt > m ? e.addedAt : m),
    lastAddedAt,
  );

  if (!dryRun) {
    await fs.mkdir(CONTENT_BLOG_DIR, { recursive: true });
    await fs.writeFile(filePath, md, 'utf8');
  }

  return {
    generated: true,
    slug,
    title,
    filePath: `content/blog/${slug}.md`,
    entityCount: picked.length,
    siteCount: siteList.length,
    cursor: maxAdded,
    newCount: newOnes.length,
  };
}

// ==================== 3. IndexNow 提交 ====================
async function submitIndexNow(urls, dryRun) {
  if (!INDEXNOW_KEY) {
    return { submitted: 0, skipped: true, reason: '内置 key 缺失（state/indexnow-key.txt）' };
  }
  const host = new URL(SITE_BASE_URL).hostname;
  const payload = {
    host,
    key: INDEXNOW_KEY,
    keyLocation: `https://${host}/.well-known/indexnow.txt`,
    urlList: Array.from(urls).slice(0, 10000),
  };
  if (dryRun) return { submitted: payload.urlList.length, dryRun: true };
  try {
    const res = await httpReq('https://api.indexnow.org/IndexNow', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return { submitted: payload.urlList.length, statusCode: res.statusCode };
  } catch (e) {
    return { submitted: 0, error: e.message };
  }
}

// ==================== 4. 搜索引擎 sitemap ping（无需密钥）====================
async function pingSearchEngines(dryRun) {
  const sitemap = `${SITE_BASE_URL}/sitemap.xml`;
  const targets = [
    `https://www.google.com/ping?sitemap=${encodeURIComponent(sitemap)}`,
    `https://www.bing.com/ping?sitemap=${encodeURIComponent(sitemap)}`,
  ];
  const results = [];
  for (const t of targets) {
    const name = new URL(t).hostname;
    if (dryRun) {
      results.push({ engine: name, dryRun: true });
      continue;
    }
    try {
      const res = await httpReq(t);
      results.push({ engine: name, statusCode: res.statusCode });
    } catch (e) {
      results.push({ engine: name, error: e.message });
    }
  }
  return results;
}

// ==================== 5. GitHub Topics（直接调 REST API, 用内置 GITHUB_TOKEN）====================
async function setGitHubTopics(dryRun) {
  if (!GITHUB_TOKEN) return { ok: false, skipped: true, reason: '无 GITHUB_TOKEN' };
  const topics = [
    'genetics',
    'bioinformatics',
    'knowledge-base',
    'mcp',
    'rag',
    'biomedical',
    'semantic-search',
    'quantum-computing',
    'ai-agents',
    'open-data',
  ];
  if (dryRun) return { ok: true, dryRun: true, topics };
  try {
    const res = await httpReq(`https://api.github.com/repos/${GITHUB_REPOSITORY}/topics`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
      body: JSON.stringify({ names: topics }),
    });
    return { ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ==================== 6. dev.to 自动发布（可选）====================
async function publishDevTo(post, dryRun) {
  if (!DEV_TO_API_KEY) return { ok: false, skipped: true, reason: '未配置 DEV_TO_API_KEY（一次性设置即自动发文）' };
  if (!post || !post.generated) return { ok: false, skipped: true, reason: '本次未生成新文章' };
  if (dryRun) return { ok: true, dryRun: true, title: post.title };
  try {
    const today = getToday();
    const body = `# ${post.title}\n\n> 本文由 GeneTech 自动化知识引擎生成。\n\n（完整内容见站点：${SITE_BASE_URL}/blog/${post.slug}.html）\n`;
    const res = await httpReq('https://dev.to/api/articles', {
      method: 'POST',
      headers: { 'api-key': DEV_TO_API_KEY },
      body: JSON.stringify({
        article: {
          title: post.title,
          body_markdown: body,
          published: true,
          tags: ['ai', 'knowledgegraph', 'mcp', 'opensource'].slice(0, 4),
          canonical_url: `${SITE_BASE_URL}/blog/${post.slug}.html`,
          description: `GeneTech 前沿科技速览，自动化生成的 GEO 内容（${today}）。`,
        },
      }),
    });
    return { ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ==================== 7. 更新状态 Issue（直接调 REST API, 用内置 GITHUB_TOKEN）====================
async function updateStatusIssue(report, dryRun) {
  if (!GITHUB_TOKEN) return { ok: false, skipped: true, reason: '无 GITHUB_TOKEN' };
  if (dryRun) return { ok: true, dryRun: true };
  const body = `## 🚀 GEO 自动推广状态（${getToday()}）

本 Issue 由 \`pipeline-geo-promotion.js\` 每次运行自动更新，无需人工查看日志。

| 动作 | 状态 |
| --- | --- |
| 生成 GEO 文章 | ${report.geoPost.generated ? `✅ ${report.geoPost.entityCount} 条实体 → ${report.geoPost.filePath}` : `⏸️ ${report.geoPost.reason || '未达阈值'}`} |
| IndexNow 提交 | ${report.indexNow.skipped ? '⏸️ ' + (report.indexNow.reason || '跳过') : (report.indexNow.statusCode === 422 ? `⚠️ 422（github.io 共享域名限制，需在 Bing Webmaster 验证站点后生效；非阻断）` : `✅ ${report.indexNow.submitted} 个 URL (HTTP ${report.indexNow.statusCode})`)} |
| 搜索引擎 ping | ${report.pings.map((p) => `${p.engine}:${p.statusCode || p.error || 'dry'}`).join(' / ')} |
| GitHub Topics | ${report.topics.ok ? '✅ 已设置' : '⏸️ ' + (report.topics.reason || report.topics.error || ('HTTP ' + report.topics.statusCode) || '跳过')} |
| dev.to 发布 | ${report.devto.skipped ? '⏸️ ' + (report.devto.reason || '跳过') : report.devto.ok ? '✅ 已发布' : '❌ ' + (report.devto.error || '失败')} |

**站点根地址**：${SITE_BASE_URL}
**MCP 接入**：\`npx -y @genetech/data-mcp\`
**自动化程度**：GEO 文章 / IndexNow(Bing,Yandex) / Google,Bing sitemap ping / GitHub Topics 均已零密钥自驱；Glama、Smithery 因仓库含 glama.json、smithery.yaml 会被自动发现索引。
**仅 dev.to 发文需要你的账号**：在仓库 Secrets 配置 \`DEV_TO_API_KEY\`（dev.to 登录后生成）即自动开启；不配则自动跳过，不影响其余闭环。

> 自动生成，最后更新 ${new Date().toISOString()}
`;
  const headers = { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' };
  try {
    const list = await httpReq(
      `https://api.github.com/repos/${GITHUB_REPOSITORY}/issues?labels=geo-promo&state=open&per_page=1`,
      { headers },
    );
    const arr = JSON.parse(list.body || '[]');
    if (Array.isArray(arr) && arr.length && arr[0].number) {
      await httpReq(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${arr[0].number}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ body }),
      });
    } else {
      await httpReq(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: '🚀 GEO 自动推广状态', body, labels: ['geo-promo'] }),
      });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message).slice(0, 200) };
  }
}

// ==================== 主流程 ====================
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[GEO-Promo] ${dryRun ? 'DRY-RUN' : 'PROD'} 启动 ${new Date().toISOString()}`);

  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const statePath = path.join(STATE_DIR, 'geo-promotion-state.json');
  const state = (await readJson(statePath)) || {};

  const allEntities = await collectAllEntities();
  console.log(`[GEO-Promo] 收集到 ${allEntities.length} 条实体`);

  // 1. 生成文章
  const geoPost = await maybeGeneratePost(allEntities, state, dryRun);
  if (geoPost.generated) {
    console.log(`[GEO-Promo] 生成文章: ${geoPost.filePath} (${geoPost.entityCount} 条)`);
    state.lastAddedAt = geoPost.cursor;
    state.lastPostDate = getToday();
    state.lastPostSlug = geoPost.slug;
  } else {
    console.log(`[GEO-Promo] 未生成文章: ${geoPost.reason}`);
  }

  // 2. IndexNow（所有站点 + 博客 + rss）
  const siteSlugs = [...new Set(allEntities.map((e) => e.site))];
  const urls = new Set([
    `${SITE_BASE_URL}/`,
    `${SITE_BASE_URL}/search.html`,
    `${SITE_BASE_URL}/mcp.html`,
    `${SITE_BASE_URL}/blog/`,
    `${SITE_BASE_URL}/rss.xml`,
    ...siteSlugs.map((s) => `${SITE_BASE_URL}/${s}/`),
    ...(geoPost.generated ? [`${SITE_BASE_URL}/blog/${geoPost.slug}.html`] : []),
  ]);
  const indexNow = await submitIndexNow(urls, dryRun);

  // 3. 搜索引擎 ping
  const pings = await pingSearchEngines(dryRun);

  // 4. GitHub Topics
  const topics = await setGitHubTopics(dryRun);

  // 5. dev.to 发布
  const devto = await publishDevTo(geoPost, dryRun);

  // 6. 状态 Issue
  const issue = await updateStatusIssue(
    { geoPost, indexNow, pings, topics, devto },
    dryRun,
  );

  const report = {
    pipeline: 'geo-promotion',
    timestamp: new Date().toISOString(),
    dryRun,
    siteBaseUrl: SITE_BASE_URL,
    summary: {
      entityCount: allEntities.length,
      geoPostGenerated: geoPost.generated,
      indexNowSubmitted: indexNow.submitted || 0,
      searchEnginePings: pings.length,
      gitHubTopicsSet: !!topics.ok,
      devtoPublished: !!devto.ok,
    },
    geoPost,
    indexNow,
    pings,
    topics,
    devto,
    issue,
  };

  const reportPath = path.join(REPORTS_DIR, `report-geo-promotion-${getTimestamp()}.json`);
  if (!dryRun) {
    await writeJson(reportPath, report);
    if (geoPost.generated && geoPost.cursor) await writeJson(statePath, state);
  }
  console.log(`[GEO-Promo] 报告: ${reportPath}`);
  console.log(`[GEO-Promo] 完成. 生成文章=${geoPost.generated} IndexNow=${indexNow.submitted || 0} Topics=${!!topics.ok} dev.to=${!!devto.ok}`);
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
