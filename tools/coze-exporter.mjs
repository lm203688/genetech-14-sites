#!/usr/bin/env node
/**
 * Coze 知识库导出器（GeneTech 14站知识引擎）
 *
 * 用途：把 22 个站点的结构化科研实体 + 跨域洞察，转换成 Coze 知识库可直接
 *      ingest 的中文 markdown 深度解读包。这是"给 Coze C 端用户做科技深度解读
 *      知识库"变现路径的核心生产工具。
 *
 * 设计要点：
 *  - 零外部依赖（仅 node 内置 fs/path），可在 CI 或本地直接跑。
 *  - 每站一个文档（避免单文件过大），外加「跨域桥接报告」「Bot 提示词」
 *    「定价」「导入指南」共 5 类支撑文档。
 *  - 实体按置信度 TopN 精选 + 近期新增，摘要截断，控制在 Coze 友好体积。
 *  - 幂等可重跑：每次覆盖写出。
 *
 * 用法：
 *  node tools/coze-exporter.mjs            # 生成到 content/coze/
 *  node tools/coze-exporter.mjs --limit=80 # 每站精选实体数（默认 100）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'content', 'coze');

function getArg(name, def) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.split('=')[1] : def;
}
const TOP_N = Math.max(10, parseInt(getArg('limit', '100'), 10) || 100);

function loadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function trunc(s, n) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

// ---- 载入数据 ----
const catalog = loadJSON(path.join(ROOT, '_site', 'api', 'catalog.json'))
  || loadJSON(path.join(ROOT, 'data', 'catalog.json'));
const insights = loadJSON(path.join(ROOT, '_site', 'api', 'insights.json'));

if (!catalog || !catalog.sites || !catalog.sites.length) {
  console.error('[coze-exporter] 找不到 _site/api/catalog.json，请先跑 build-site.mjs');
  process.exit(1);
}

const sites = catalog.sites.map((s) => ({
  slug: s.site,
  label: s.label,
  total: s.totalEntities,
  updated: s.lastUpdated,
  entitiesPath: path.join(ROOT, s.site, 'website', 'api', 'entities.json'),
}));

const rising = (insights?.trends?.risingTopics || []).slice();
const emerging = (insights?.trends?.emergingTopics || []);
const coAuthors = (insights?.coAuthors || []);

// 跨域桥接 = risingTopics 按覆盖站点数排序（这是当前数据里最可靠的"跨站"信号）
const bridges = rising
  .filter((t) => (t.siteCount || 0) >= 3)
  .sort((a, b) => (b.siteCount || 0) - (a.siteCount || 0))
  .slice(0, 25);

// ---- 写单站文档 ----
function renderSite(site) {
  const ents = loadJSON(site.entitiesPath) || [];
  if (!Array.isArray(ents) || !ents.length) {
    return `# ${site.label}\n\n> 暂无实体数据。\n`;
  }
  // 按置信度精选
  const ranked = [...ents].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const top = ranked.slice(0, TOP_N);
  // 近期新增
  const recent = [...ents]
    .filter((e) => e.publishedDate)
    .sort((a, b) => String(b.publishedDate).localeCompare(String(a.publishedDate)))
    .slice(0, 15);
  // 标签聚合
  const tagCount = {};
  for (const e of ents) for (const t of (e.tags || [])) tagCount[t] = (tagCount[t] || 0) + 1;
  const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 25).map((x) => x[0]);

  const blocks = [];
  blocks.push(`# ${site.label} — 科技深度解读知识包`);
  blocks.push('');
  blocks.push(`> 来源：GeneTech 14站知识引擎 · 结构化实体 ${ents.length} 条 · 更新 ${new Date(site.updated || Date.now()).toISOString().slice(0, 10)}`);
  blocks.push('> 本包由公开学术元数据（OpenAlex / arXiv / PubMed / Crossref 等）自动结构化生成，供 AI 知识库检索使用。');
  blocks.push('');
  blocks.push('## 领域关键标签');
  blocks.push('');
  blocks.push(topTags.map((t) => `\`${t}\``).join('、') || '（无）');
  blocks.push('');
  blocks.push(`## 核心论文与技术（按置信度 Top ${top.length}）`);
  blocks.push('');
  for (const e of top) {
    const yr = (e.publishedDate || '').slice(0, 4) || '—';
    const authors = (e.authors || []).slice(0, 4).join('、') || '—';
    blocks.push(`### ${e.name}`);
    blocks.push(`- 置信度：${(e.confidence || 0).toFixed(2)} ｜ 来源：${e.source || '—'} ｜ 年份：${yr} ｜ 作者：${authors}`);
    if (e.url) blocks.push(`- 链接：${e.url}`);
    if (e.abstract) blocks.push(`- 摘要：${trunc(e.abstract, 280)}`);
    if (e.tags && e.tags.length) blocks.push(`- 标签：${e.tags.slice(0, 8).join('、')}`);
    blocks.push('');
  }
  if (recent.length) {
    blocks.push('## 近期新增（最新 15 条）');
    blocks.push('');
    for (const e of recent) {
      const yr = (e.publishedDate || '').slice(0, 4) || '—';
      blocks.push(`- **${e.name}**（${yr}，${e.source || '—'}）${e.url ? ` — ${e.url}` : ''}`);
    }
    blocks.push('');
  }
  blocks.push('---');
  blocks.push('');
  blocks.push('> 需要完整 47,000+ 条跨 22 个站点的结构化数据与 API 接入？见 `bridging-report.md` 与 Bot 提示词中的升级指引（license.genetech.tools）。');
  return blocks.join('\n');
}

// ---- 跨域桥接报告 ----
function renderBridging() {
  const blocks = [];
  blocks.push('# 跨域桥接报告 — GeneTech 14站知识引擎');
  blocks.push('');
  blocks.push('> 本报告的独有价值：揭示**同时跨越多个学科站点**的技术主题。普通科普 Bot 只做单领域摘要，');
  blocks.push('> 而这里能看到"一项技术如何在 AI、量子、生物、能源之间流动"，这是深度解读的差异化视角。');
  blocks.push('');
  if (bridges.length) {
    blocks.push(`## 跨 ≥3 个站点的前沿主题（Top ${bridges.length}）`);
    blocks.push('');
    for (const t of bridges) {
      const sc = t.siteCounts || {};
      const topSites = Object.entries(sc).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([k, v]) => `${k}(${v})`).join('、');
      blocks.push(`### ${t.topic}`);
      blocks.push(`- 覆盖站点数：${t.siteCount} ｜ 相关文献：${t.docCount}`);
      blocks.push(`- 主要分布：${topSites}`);
      blocks.push('');
    }
  } else {
    blocks.push('_当前数据集跨域桥接信号较弱（多为单领域主题），随数据回填增长会自动丰富。_');
    blocks.push('');
  }
  if (emerging.length) {
    blocks.push('## 新兴主题（研究空白 / 早期信号）');
    blocks.push('');
    for (const t of emerging.slice(0, 15)) {
      blocks.push(`- **${t.topic || t.name}** — 文献 ${t.docCount || t.total || '?'} 篇，覆盖 ${t.siteCount || (t.sites || []).length || '?'} 个站点`);
    }
    blocks.push('');
  }
  return blocks.join('\n');
}

// ---- Bot 提示词 ----
function renderBotPrompt() {
  return `# Coze Bot 系统提示词（科技深度解读助手）

你是一个**严谨的科技深度解读助手**，基于「GeneTech 14站知识引擎」知识库回答用户关于前沿科技的问题。
知识库覆盖 22 个学科站点：AI Agent 生态、AI4Science、量子计算、脑科学、合成生物、半导体、新能源、核能、
具身智能、空间计算、6G 卫星互联网、隐私计算、低空经济、中医药工具等，总计 47,000+ 条结构化科研实体。

## 行为准则
1. **用中文回答**，面向科研爱好者、产品经理、技术决策者，专业但不晦涩。
2. **引用来源**：每条关键结论尽量附上知识库中的实体名称与出处（链接若有）。
3. **跨域视角**：当用户问题涉及交叉领域时，主动指出该技术在多个学科中的关联（参考「跨域桥接报告」）。
4. **诚实边界**：知识库未覆盖的内容，明确说"暂无数据"，不要编造；可建议用户去原始论文/官方渠道核实。
5. **不谈政治、不提供医疗诊断、不生成违法内容**。

## 升级引导（自然植入，不硬广）
- 免费版：基于知识库的基础问答。
- 当用户需要**完整数据集、API 接入、批量引用导出、跨域趋势分析**时，引导其前往
  **https://license.genetech.tools** 获取 Pro（¥39.9）或 终身版（¥199）许可证。
- 话术示例："如果你想把这套跨学科数据接入自己的 Agent 或做系统级分析，可以看下 license.genetech.tools，
  有 MCP 接口和批量导出。"

## 知识库使用
- 优先检索与问题最相关的站点文档（如问量子优先看 quantum-computing.md）。
- 涉及趋势/跨域，参考 bridging-report.md。
`;
}

// ---- 定价 ----
function renderPricing() {
  return `# 变现与定价方案（Coze 深度解读 Bot）

## 三层闭环
| 层级 | 载体 | 价格 | 内容 |
|---|---|---|---|
| 免费 | Coze Bot | ¥0 | 知识库基础问答、单篇解读 |
| Pro | license.genetech.tools | **¥39.9** | 完整 47k 实体 API、MCP 接入、批量引用导出、跨域趋势 |
| 终身 | license.genetech.tools | **¥199** | 上述全部 + 未来更新永久权 |

## Bot 内引导策略
1. 免费回答后，对"深入研究/接 API/批量"类诉求，自然插入升级链接。
2. Coze 商店可同时上架**技能包**（一次性 19–99 元）作为被动收入。
3. B 端定制（科研/投研知识库）单列报价 5k–5w/项目，不在 Bot 内自动成交。

## 支付
- 微信 / 支付宝 通过虎皮椒（Hupijiao）网关，回调已部署在 license.genetech.tools。
- 许可证由 unified-license Worker 自动签发。
`;
}

// ---- 导入指南 ----
function renderGuide() {
  return `# Coze 知识库导入与变现指南（逐步）

## 一、准备知识包
本目录下的文件即为知识包：
- \`00-INDEX.md\` — 总览
- \`<站点slug>.md\` × 22 — 各站深度解读文档
- \`bridging-report.md\` — 跨域桥接报告（差异化卖点）
- \`bot-prompt.md\` — 直接复制为 Bot 系统提示词
- \`pricing.md\` — 定价与引导策略

## 二、创建知识库
1. 打开 🔗 https://www.coze.cn （国内）或 https://www.coze.com
2. 左侧「知识库」→「创建知识库」→ 命名「GeneTech 科技深度解读」
3. 「本地文档」上传：选中本目录全部 \`.md\` 文件 → 分段默认 → 完成

## 三、创建 Bot
1. 「Bot 商店」→「创建 Bot」→ 命名「GeneTech 科技深度解读助手」
2. 「人设与回复逻辑」粘贴 \`bot-prompt.md\` 全文
3. 「知识」→ 绑定刚才的知识库，开关「知识库回复」
4. 预览调试几条问题（如"量子计算最新进展？""AI 和合成生物有什么交叉？"）

## 四、变现开通
1. 🔗 https://www.coze.cn/store （扣子商店）→ 发布 Bot / 技能
2. 开启「付费订阅」或上架「技能包」（参考 pricing.md 档位）
3. 深度版 CTA 指向 🔗 https://license.genetech.tools （Pro ¥39.9 / 终身 ¥199，虎皮椒支付已就绪）

## 五、注意事项
- 知识库为公开学术元数据，无版权风险；可定期重跑 \`tools/coze-exporter.mjs\` 更新。
- 不要在任何地方粘贴 API Key / 源码；升级链接只放 license 端点。
`;
}

// ---- 总览 ----
function renderIndex() {
  const lines = [];
  lines.push('# GeneTech 14站 · Coze 知识包总览');
  lines.push('');
  lines.push(`> 生成时间：${new Date().toISOString()}`);
  lines.push(`> 站点数：${sites.length} ｜ 实体总数：${catalog.totalEntities?.toLocaleString() || '?'} ｜ 精选每站：${TOP_N}`);
  lines.push('');
  lines.push('## 文件清单');
  lines.push('');
  lines.push('- `00-INDEX.md` — 本文件');
  lines.push('- `bridging-report.md` — 跨域桥接报告（差异化卖点）');
  lines.push('- `bot-prompt.md` — 直接复制为 Coze Bot 系统提示词');
  lines.push('- `pricing.md` — 定价与升级引导');
  lines.push('- `coze-import-guide.md` — 逐步导入与变现指南');
  lines.push('- `<slug>.md` — 各站深度解读文档：');
  for (const s of sites) lines.push(`  - \`${s.slug}.md\` — ${s.label}（${s.total} 条）`);
  lines.push('');
  lines.push('## 如何用于变现');
  lines.push('');
  lines.push('详见 `coze-import-guide.md`。核心：Coze 免费 Bot 引流 → license.genetech.tools 收 Pro/终身费。');
  return lines.join('\n');
}

// ---- 执行 ----
ensureDir(OUT);
fs.writeFileSync(path.join(OUT, '00-INDEX.md'), renderIndex());
fs.writeFileSync(path.join(OUT, 'bridging-report.md'), renderBridging());
fs.writeFileSync(path.join(OUT, 'bot-prompt.md'), renderBotPrompt());
fs.writeFileSync(path.join(OUT, 'pricing.md'), renderPricing());
fs.writeFileSync(path.join(OUT, 'coze-import-guide.md'), renderGuide());

let totalEnt = 0;
for (const s of sites) {
  const md = renderSite(s);
  fs.writeFileSync(path.join(OUT, `${s.slug}.md`), md);
  totalEnt += s.total || 0;
}

console.log(`[coze-exporter] 已生成 ${sites.length} 个站点文档 + 5 个支撑文档 → ${OUT}`);
console.log(`[coze-exporter] 跨域桥接主题：${bridges.length} 个（≥3 站）｜ 新兴主题：${emerging.length} 个`);
console.log(`[coze-exporter] 实体总计：${totalEnt.toLocaleString()}`);
process.exit(0);
