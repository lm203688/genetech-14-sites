# GeneTech 14 站知识引擎 · 全闭环审计与逻辑洞修复（2026-08-14）

> 目标：把项目所有「闭环任务」逐一走通，找出逻辑洞并修复；并给出线上平台引流（嫁接）方案。
> 范围：数据管线 → 站点 → 推理 → 许可证/支付 → MCP → Coze → GEO/SEO → 增长。

---

## 0. 结论速览

- 本次发现并修复 **1 个已发生的严重逻辑洞**（license 购买闭环在国内断裂，因线上 `license.html` 硬编码被墙的 `*.workers.dev`），并**标记 2 个同类待确认洞**（ask 推理闭环、api-guard 远程校验同样依赖 pending/被墙域名）。
- 统一修复方式：浏览器端（`build-site.mjs`）、服务端（`verify.js`）、站点适配（`site-adapter.js`）三处全部改为**多端点故障转移**
  `['https://license.genetech.tools' → 'https://license.swarmlabs.tools' → 'https://genetech-license.61960005.workers.dev']`，
  其中 `swarmlabs.tools`（61960005 账户 zone）**已实测国内可用** → 闭环在国内自动走可用端点。
- 三文件代码已改并 **本地提交（commit a4fdd5a）**；但**推送到 GitHub 被沙箱凭据限制卡住**（Git Credential Manager 无法无头取 token），需用户给 PAT 或手动 push 才会重建 Pages、让线上修复生效。
- 引流方案 + 可复制物料已产出（`docs/growth-strategy.md` §11、`docs/growth-materials.md`）。

---

## 1. 闭环状态矩阵

| # | 闭环 | 关键链路 | 状态 | 备注 |
|---|---|---|---|---|
| L1 | 数据→构建→发布 | data-backfill(CI 30min) → `/api/entities.json`/`index.json` → `build-site.mjs` → GitHub Pages | ✅ 通 | 数据契约对齐，CI 内置 Verify 拦截 |
| L2 | ask 推理 | `ask.html` → `api-guard` Worker → ECS ATEX 网关 `150.158.119.19:8420/v1` | 🟡 国内待路由 | 需 `api.swarmlabs.tools/* → genetech-api-guard`（见 §3-H3） |
| L3 | license 购买 | `license.html` → `unified-license` Worker → 虎皮椒 | ✅ 已修 | `swarmlabs.tools` 实测通；虎皮椒 `notify/return_url` 待配 |
| L4 | 站点侧校验 | 站点 Functions `/api/license` → `unified-license` | ✅ 已修 | `fetchCentral` 多端点；需确认各站 Functions 已部署 |
| L5 | MCP Server | `@genetech/data-mcp`（npm）stdio | ✅ 可用 | Glama 认领卡浏览器 GitHub 登录 |
| L6 | Coze bot | `content/coze/*` → Coze 商店 | 🟡 待发布 | 物料备好，端点已统一 `license.genetech.tools` |
| L7 | GEO/SEO | JSON-LD / `llms.txt` / IndexNow / 博客 | ✅ 已推 | IndexNow key 占位；GSC 待交 sitemap |
| L8 | 增长引流 | GEO + 目录 + 社媒 + Bot | 🟡 待执行 | 方案+物料齐（§11） |

---

## 2. 逐闭环审计

### L1 数据管线 → 站点构建 → 发布
- 链路：CI `pipeline-data-backfill.js`（6 源 / 单页 100 / 游标站点×检索词）→ 写 `entities.json`/`index.json` → `build-site.mjs` 生成 `_site/` → `pages-deploy.yml` 用 GITHUB_TOKEN 部署 GitHub Pages。
- 状态：**✅ 跑通**。数据契约稳定，CI 内置「Verify data contract」会拦截路径破坏。
- 洞：无。本次改动（多端点）不影响数据契约路径 `<site>/website/api/*.json`。

### L2 ask 推理闭环（⚠️ 国内可用性待路由）
- 链路：`ask.html` 前端 `fetchAny('/api/llm/chat/completions')` → `api-guard` Worker → 代理到 `LLM_BRIDGE_BASE=http://150.158.119.19:8420/v1`（ECS ATEX，OpenAI 兼容）。
- 端点故障转移已就位：`['api.genetech.tools' → 'api.swarmlabs.tools' → 'genetech-api-guard.61960005.workers.dev']`。
- **关键依赖**：`api-guard` Worker 部署名为 `genetech-api-guard`，仅获得 `*.workers.dev` 路由（国内被墙）。其国内可用前提是 **`api.swarmlabs.tools/* → genetech-api-guard` 路由已建**（与 `license.swarmlabs.tools` 同理，在 61960005 账户 Dashboard 操作）。若该路由未建，国内用户点「问 AI」会落到被墙的 workers.dev → 闭环断。
- 状态：**🟡 代码已 resilience，但需用户在 CF 补 `swarmlabs.tools` 的 api 路由**（详见 §3-H3）。ECS 网关本身独立可用。

### L3 license 购买闭环（★本次已修）
- 链路：`license.html` 下单 → `unified-license` Worker（`license.swarmlabs.tools`）→ 虎皮椒创建订单 → 回调签发 `GUX_` 许可证 → 站点兑换 `gtk_` 密钥。
- 旧洞：线上 `license.html` 硬编码 `var WORKER='https://genetech-license.61960005.workers.dev'`（国内 ERR_CONNECTION_TIMED_OUT）→ **购买闭环国内 100% 断**。
- 修复：改为 `WORKERS=[genetech.tools → swarmlabs.tools → workers.dev]` 故障转移；`swarmlabs.tools` 已实测 HTTP 200、下单+验签通过。
- 状态：**✅ 已修**（待 push 让线上生效）。剩余：虎皮椒商户后台配 `notify_url`/`return_url` 指向 `license.swarmlabs.tools`（回调闭环最后一环，用户手动）。

### L4 站点侧许可证校验（本次已修）
- 链路：各站 `functions/api/license/index.js`（即 `site-adapter.js`）→ 中央 `unified-license` 校验/兑换 → 返回 `api_key` + 缓存。
- 旧：单端点 `license.genetech.tools`（pending，不可达）。修复：`fetchCentral` 多端点故障转移。
- 状态：**✅ 已修**。⚠️ 需确认各站是否已实际部署该 Functions（部署状态未知，待用户核对）。

### L5 MCP Server
- 链路：`npx -y @genetech/data-mcp` → stdio 暴露 14 站数据；已通过冒烟测试（5 工具、BibTeX 导出正确）。
- 状态：**✅ 可用**。待办：Glama 认领卡浏览器 GitHub 登录（用户去 glama.io 用 GitHub 登录认领仓库）。

### L6 Coze bot 商店
- 链路：`content/coze/*.md`（27 个站 + 索引/指南/定价）→ Coze 导入 → 商店发布。
- 状态：**🟡 物料备好且端点已统一**。待用户：在 Coze 导入并发布（一次性）。`coze-exporter.mjs` 可批量导出。

### L7 GEO / SEO 内容层
- 链路：`build-site.mjs` 生成 JSON-LD（WebSite/SearchAction/DataCatalog/FAQPage/SoftwareApplication/Article）+ OG/Twitter + IndexNow + `llms.txt` + 博客。CI 自动部署。
- 状态：**✅ 已推**。待办：IndexNow 真实 key（当前占位）、Google Search Console 交 sitemap、目录提交。

### L8 增长 / 引流
- 见 `docs/growth-strategy.md` §11 与 `docs/growth-materials.md`。方案与物料齐，待用户执行发布。

---

## 3. 已修复 / 待修复的逻辑洞

### H1（严重，已修）— license 购买闭环国内断裂
- 原因：线上 `license.html` 硬编码 `genetech-license.61960005.workers.dev`，国内被墙。
- 修复：三处（浏览器 `build-site.mjs` / 服务端 `verify.js` / 站点 `site-adapter.js`）统一多端点故障转移，国内首可达 = `license.swarmlabs.tools`（实测可用）。
- 证据：本地构建后 `_site/license.html` 含 `WORKERS = ['https://license.genetech.tools', 'https://license.swarmlabs.tools', 'https://genetech-license.61960005.workers.dev']`；push 前线上仍 `var WORKER='…workers.dev'`（确认旧洞 live）。

### H2（中，已修代码）— api-guard 远程校验指向 pending 域名
- 原因：`deploy-independent-workers.mjs` 中 `LICENSE_VALIDATE_URL = https://license.genetech.tools/api/license/validate`（zone pending → Pro 远程校验必败）。
- 修复：改为 `https://license.swarmlabs.tools/api/license/validate`（已验证可用）。**待下次 `wrangler deploy` 生效**（沙箱无法部署）。

### H3（中，待路由）— ask 推理闭环国内可用性
- 原因：与 H1 同类，`ask.html` 故障转移末端是 `genetech-api-guard.61960005.workers.dev`（国内被墙）；`api.genetech.tools` zone 仍 pending。
- 修复（前端已做）：多端点故障转移；但**必须**在 CF Dashboard 为 `swarmlabs.tools` zone 加路由 `api.swarmlabs.tools/* → genetech-api-guard`，否则国内 `ask` 仍断。
- 动作项（用户）：Cloudflare → swarmlabs.tools → Workers Routes → 添加 `api.swarmlabs.tools/*` → `genetech-api-guard`（与已成功的 `license.swarmlabs.tools` 同一账户、同一手法）。

---

## 4. 仍待办（需用户 / 待条件）

**用户手动（关键路径）**
1. 虎皮椒商户后台配 `notify_url=https://license.swarmlabs.tools/api/hupijiao/callback` + `return_url=https://license.swarmlabs.tools/pay/success`（支付回调闭环最后一环）。
2. `swarmlabs.tools` zone 加 `api.swarmlabs.tools/* → genetech-api-guard` 路由（闭 H3）。
3. `genetech.tools` zone 仍卡 `pending/ns_mismatch`（Registrar 在未知账户）→ 改 NS 或跨账户转移 Registrar 后才可加 `license.genetech.tools`/`api.genetech.tools` 路由。
4. 重新 `wrangler deploy`（让 H2 的 `LICENSE_VALIDATE_URL` 改动生效）。
5. 推送本次提交（commit a4fdd5a）到 GitHub → 重建 Pages → 线上 `license.html` 不再指向被墙 workers.dev。

**目录 / SEO**
6. Glama / Smithery / mcp.so 认领（Glama 卡浏览器 GitHub 登录）。
7. Google Search Console 交 sitemap；IndexNow 真实 key（build-site.mjs 内为占位值）。

**安全注意**
8. `tools/deploy-independent-workers.mjs` 把虎皮椒 `HUPIJIAO_APP_ID`/`APP_SECRET` **硬编码入库**（lines 116-117）。应改为环境变量/secret 注入，避免密钥进 git 历史。当前可用，但建议尽快改。

---

## 5. 融合建议（是否需合并）

- **无需新合并**：L3/L4/L5 已天然共用 `unified-license` 中央；MCP 与站点数据同源（`catalog.json`），无需额外对接。
- **建议抽共享端点常量**：三处端点数组目前各维护一份副本（`build-site.mjs` / `verify.js` / `site-adapter.js`）。未来改一处易漏两处。建议加 `shared/endpoints.json`，由 `build-site.mjs` 注入到生成的 HTML，服务端文件 `import` 同一份，杜绝漂移。
- **ask 与 license 共用 api 网关**：两者都经 `swarmlabs.tools` zone 的 Worker，路由管理应统一（一次加 `api.*` + `license.*` 两条路由即可）。

---

## 6. 验证记录

- 本地 `node tools/build-site.mjs` → `EXIT=0`，生成 `_site/` 成功（仅「llm-bridge 未配置」提示跳过叙事生成，不影响构建）。
- `node --check tools/build-site.mjs` + 动态 `import` `verify.js` / `site-adapter.js` → 均无语法错误。
- 生成产物核对：`_site/license.html` 含 `WORKERS=[...]`；`_site/assets/ask.js` 含 `FALLBACK_ENDPOINTS=[...]`；`ask.html` 的 `<meta name="llm-api-base" content="https://api.genetech.tools">`（首端点，失败自动回落）。
- 线上（push 前）`https://lm203688.github.io/genetech-14-sites/license.html` 仍 `var WORKER='…workers.dev'`（确认旧洞仍 live，待 push 修复）。
- 沙箱无法解析 Cloudflare 边缘自定义域名（DNS 被沙箱出口拦截，非真实故障）；`swarmlabs.tools` 可用性以用户侧实测为准。
