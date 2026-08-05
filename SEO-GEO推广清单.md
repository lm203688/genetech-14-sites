# GeneTech 14站 — SEO / GEO 推广行动清单

> 目标：用 SEO（搜索引擎） + GEO（Generative Engine Optimization，让 AI Agent/大模型引用）尽快获取流量与客户。
> 更新日期：2026-08-05

---

## 一、已自动完成（代码层，CI 部署即生效）

| 项 | 状态 | 说明 |
|---|---|---|
| npm 包发布 | ✅ 已发布 | `@genetech/data-mcp@1.1.0`（含混合检索）已上线 npm，`npx -y @genetech/data-mcp` 可用 |
| 站点内 / 全局搜索框 | ✅ | 每站 + 首页 + 跨 14 站检索页 `search.html` |
| 混合检索 `semantic_search` | ✅ | BM25 + 字段加权 + RRF（src/search.mjs），替换原伪语义 |
| 结构化数据 JSON-LD | ✅ | 首页 WebSite+SearchAction+DataCatalog+**FAQPage**；MCP 页 **SoftwareApplication**；文章页 **Article**；站点页 Dataset |
| 博客内容（GEO 弹药） | ✅ | 3 篇：`mcp-for-agents` / `hybrid-search` / `geo-advantage`，含内链与 npx 命令 |
| MCP 接入页 `mcp.html` | ✅ | 转化入口 + 工具清单 + 计费说明 + SoftwareApplication |
| sitemap.xml | ✅ | 已纳入 `/mcp.html`、`/blog/` 及 3 篇文章 |
| robots.txt | ✅ | 允许全站抓取，含 Sitemap 指令 |
| IndexNow 验证文件 | ✅ | `_site/.well-known/indexnow.txt` 已写入密钥，等待 CI 提交 |

---

## 二、需你操作（高杠杆，半小时内可完成）

### 1. 配置 IndexNow（让 Bing/Yandex 秒级收录）
项目已有 `pipeline-promotion.js` 自动提交 IndexNow，但需两个仓库 Secrets：
- `INDEXNOW_KEY` = `a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d`（与已部署的 `.well-known/indexnow.txt` 一致）
- `INDEXNOW_KEY_LOCATION` = `https://lm203688.github.io/genetech-14-sites/.well-known/indexnow.txt`
- 位置：GitHub 仓库 `Settings → Secrets and variables → Actions → New repository secret`
- 配好后，每次 promotion 流水线运行会自动把新 URL 推给 Bing/Yandex。

### 2. 向 Google 提交 sitemap（最重要的一次性动作）
- 登录 [Google Search Console](https://search.google.com/search-console)，添加属性 `https://lm203688.github.io/genetech-14-sites/`。
- 验证方式选「URL 前缀」+ HTML 标记或 GitHub Pages（CNAME）均可。
- 提交 `https://lm203688.github.io/genetech-14-sites/sitemap.xml`。
- 同样在 Bing Webmaster 添加属性（IndexNow 配置后会自动受益）。

### 3. 提交 MCP 目录（GEO 最大红利，Agent 会主动发现）
- **Glama**：访问 https://glama.ai/mcp/servers → 用 GitHub 登录 → 粘贴仓库 `lm203688/genetech-14-sites` 或包 `@genetech/data-mcp` → 认证发布（已有 `mcp-server/glama.json` 清单，字段已齐）。
- **Smithery**：访问 https://smithery.ai → Add a server → 关联 GitHub 仓库，按指引补 `smithery.yaml`（可基于 glama.json 改写）。
- 这两个目录是大模型（Claude/ChatGPT 生态）检索 MCP 工具的首要入口，上了就有持续被动流量。

### 4. GitHub 仓库打标签（免费 SEO）
仓库 `About` 里加 Topics：`mcp, knowledge-base, bioinformatics, ai-agent, semantic-search, literature-review, rag, biomedical, openalex, arxiv`。这会被 Google 索引、被开发者搜索到。

### 5. （可选）写一条产品发布帖
在 Twitter/X、LinkedIn、Reddit r/LocalLLaMA、r/MachineLearning、微信公众号 发一条：
> 「我们开源了 @genetech/data-mcp —— 一行 `npx -y @genetech/data-mcp` 把 14 个前沿科技知识库接入你的 AI Agent。混合检索 + 带引用 + 可溯源。」附 npm/GitHub 链接。

---

## 三、GEO 策略要点（给内容/运营持续执行）

1. **机器可读优先**：所有新内容都带 JSON-LD（Dataset/Article/FAQPage/SoftwareApplication），事实加引用链——大模型引用我们的概率远高于纯散文站。
2. **垂直策展**：深耕 14 个领域而非泛全科，做「基因/量子/脑科学 MCP」这类长尾词的第一结果。
3. **Agent 原生红利**：MCP 目录（Glama/Smithery）是 2026 年新增的流量入口，尽早占坑。
4. **内容节奏**：每月 2–3 篇「如何用 MCP 接 XX 领域知识」「XX 检索技术对比」，持续喂养 GEO 与 SEO。
5. **收录监控**：Google Search Console + Bing 看收录与点击；promotion 流水线报告 `report-promotion-*.json` 看 IndexNow 提交数。

---

## 四、待办（需资源/授权）
- Pro 付费墙端到端跑通（Cloudflare Worker `PRO_SECRET` 需与签发 Pro Key 同一密钥，当前为骨架）。
- aishield 项目降频（占账号 cron 用量最大），与本 14 站同处提升期，8-31 后一起回落。
- 向量嵌入检索（预留接口）：接入 BGE-M3 做真正的语义召回，进一步拉开与关键词竞品差距。
