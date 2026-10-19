# P2 阻塞项报告 — 用户账号/权限依赖项清单

**报告日期**：2026-10-17
**报告定位**：仅输出阻塞清单，不代跑。所有下列项目需用户本人操作，AI 无法替代。
**总阻塞数**：9 项，其中 3 硬阻塞（阻塞主链路）、3 中阻塞（阻塞增强能力）、3 软阻塞（阻塞对外推广）。

---

## 一、硬阻塞（阻塞主链路，必须解决）

### G3 · Cloudflare Workers Secret 注入
- **阻塞点**：`unified-license` Worker 生产部署需要 `PAY_SECRET` 与 `WEBHOOK_SECRET`
- **AI 无法完成原因**：`wrangler secret put` 走交互式 stdin，且要求 Cloudflare OAuth 授权；AI 无法持有或代用户输入 secret
- **用户操作**：
  1. 终端 `wrangler login`（账号 61960005）
  2. `cd unified-license && wrangler deploy --env production`
  3. `wrangler secret put PAY_SECRET --env production`（交互式输入）
  4. `wrangler secret put WEBHOOK_SECRET --env production`（交互式输入）
- **依赖文档**：`unified-license/DEPLOY-NOW.md`
- **影响面**：支付 API `/v1/license/*` 在生产环境不可用

### G4 · npm Publish + Glama/Smithery 上架
- **阻塞点**：`mcp-server` 包需要 npm account + Glama API token 才能发布
- **AI 无法完成原因**：npm publish 需要 `npm login`（2FA）+ registry 写入权限；Glama 需要 marketplace API token
- **用户操作**：
  1. `npm login` + `cd mcp-server && npm publish`
  2. 在 Glama / Smithery 官方平台注册并上传 MCP 清单
- **影响面**：外部用户无法通过 `npx @genetech/mcp-server` 一键接入

### G9 · 飞轮外部数据采集回退
- **阻塞点**：OpenAlex API key / Crossref API key 缺失时，扩库通道退化为每日预算耗尽
- **AI 无法完成原因**：OpenAlex 按 IP 每日美元预算，429 后需换源；Crossref 免密钥但速率受限
- **用户操作**：
  1. 到 https://openalex.org/ 申请 API key（免费）
  2. 到 https://www.crossref.org/ 申请 API key（免费）
  3. 写入 `.workbuddy/secrets.json`
- **影响面**：新增实体速率上限从 ~1500/日 降至 ~500/日

---

## 二、中阻塞（阻塞增强能力，可选）

### G5 · Cloudflare DNS 归属
- **阻塞点**：`genetech.tools` 域名需在 Cloudflare 上创建 zone
- **AI 无法完成原因**：DNS 归属验证需域管账号或 Cloudflare 账户
- **用户操作**：Cloudflare → Add site → 添加 `genetech.tools` → 更新 NS 记录
- **影响面**：`api.genetech.tools` / `data.genetech.tools` 无法通过 CF 加速

### G6 · GSC 上架与 SEO 收录
- **阻塞点**：Google Search Console 需人工验证站点归属
- **AI 无法完成原因**：GSC 验证走 TXT/HTML 双重校验，需要用户完成 Google 账号绑定
- **用户操作**：Google Search Console → Add property → 完成验证 → 提交 sitemap
- **影响面**：30 站对外搜索引擎流量归零

### G7 · GitHub Pages 自定义域名绑定
- **阻塞点**：`data.swarmlabs.tools` 需绑定真实域名（SwarmLabs 项目，非本仓库）
- **AI 无法完成原因**：需 SwarmLabs 账号权限
- **备注**：不属于本仓库职责范围

---

## 三、软阻塞（阻塞对外推广，可推迟）

### G8 · AOCI 商业授权
- **阻塞点**：AOCI v0.1.0-rc18 是内测版，商业化需申请正式 license
- **AI 无法完成原因**：涉及商业合同
- **用户操作**：向 AOCI 团队提交商业使用申请
- **影响面**：生产环境部署受限

### G10 · 腾讯云 CDN 加速
- **阻塞点**：`data.swarmlabs.tools` 需绑定腾讯云 CDN（跨项目）
- **AI 无法完成原因**：需腾讯云账号 + CDN 计费
- **备注**：0 成本方案（GitHub Pages 免费）已可覆盖 76% DOI 需求

### G11 · 学术机构合作与 DOI 注册
- **阻塞点**：Crossref / DataCite 需机构账户注册 DOI
- **AI 无法完成原因**：机构身份验证
- **用户操作**：向已有 Crossref member 机构提交 DOI 注册申请
- **影响面**：数据资产无法获得可长期引用的 DOI

---

## 四、非用户阻塞但仍未完成的项

以下为**不依赖用户账号**、但当前会话未完成的任务，已在其他任务中覆盖：

| 任务 ID | 内容 | 状态 |
|---|---|---|
| #364 | P2 数据/卫生项汇总 | pending（等待 #377 完成后接续） |
| #365 | 4 篇对外文档 + 3 项技术决策 | pending |
| #361 | C1 六大支柱写测试 | pending |

---

## 五、优先级建议

**必须解决**（阻塞对外商业化）：
1. G3（Cloudflare Secret）— 支付无法上线
2. G4（npm + Glama）— MCP 无法对外分发
3. G9（OpenAlex/Crossref key）— 数据扩库受限

**建议解决**（阻塞生态位）：
4. G5（Cloudflare DNS）— 域名加速
5. G6（GSC 上架）— SEO 收录

**可推迟**（长期）：
6. G8（AOCI 商业授权）
7. G11（DOI 注册）

**跨项目**（不属本仓库）：
8. G7（SwarmLabs Pages 域名）
9. G10（腾讯云 CDN）

---

## 六、总结

- **9 项阻塞中**：3 硬 + 3 中 + 3 软
- **AI 可完成部分**：脚本、文档、测试、schema、报告
- **AI 无法完成部分**：OAuth、2FA、API key 申请、域管账号、机构合作、商业合同
- **建议用户优先处理**：G3 → G4 → G9（顺序影响商业化速度）
