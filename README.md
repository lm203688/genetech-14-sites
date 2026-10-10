# GeneTech Knowledge Engine · 30 域科研知识引擎

> **30 个垂直科研域 · 300,000 条结构化实体 · 每条带 DOI 可独立复核**
> 线上 API：`https://api.swarmlabs.tools` · 数据分发：`https://data.swarmlabs.tools` · 规范：[`openapi.yaml`](openapi.yaml)

```bash
curl https://api.swarmlabs.tools/health
curl https://api.swarmlabs.tools/v1/oss/registry        # 30 域注册表
curl https://api.swarmlabs.tools/v1/citation/edges      # 跨域引用边
curl https://api.swarmlabs.tools/v1/citation/gaps       # 零引用域缺口矩阵
```

| 一句话定位 | 一句话价值 |
|---|---|
| 用一组职责分离的智能体，把学术/产业/政策多源数据持续转化为**可审计、可溯源、可复现**的结构化知识资产 | 别人拿到的是「一堆爬来的数据」，你拿到的是**「每一条都能被第三方独立复核」** |

> **范式锚定（2026-10-02）**：我们卖的不是「数据多少条」，而是**「这些数据能被第三方独立复核」这件事本身**。
> 每条实体都带 DOI / URL / 来源站 / `publishedDate` / `confidence`，任何一条都能引着 DOI 回到源头对上号。
> 因此本项目的验收标准从来不是「抓得更多」，而是「**每一条都能被解释、被反驳、被替换**」——
> 上游源挂了要能换源续跑，门禁红了必须阻断发布，而不是让错误数据悄悄上线。

**当前规模（实测，非宣称；每个数字都带来源，2026-10-08 复核）**

| 资产 | 规模 | 来源 / 门禁 |
|---|---|---|
| 结构化实体 | 294,330（清理前置页噪声后） | `pipeline-quality-gate.js` |
| 唯一 DOI | 276,769 | `verify-shard-fidelity.mjs` |
| 知识图谱 | 36,107 节点 / 99,725 边 | `build-knowledge-graph.mjs` |
| └ 其中引用边 | **27,868 条（占边总数 27.94%）** | 本次并入，验收判据 ≥20% |
| 跨域引用边（原始） | 28,001 | `GET /v1/citation/edges` 线上实测 |
| 零引用域缺口 | 101 / 870 有向域对 | `GET /v1/citation/gaps` 线上实测 |
| 语义检索 | 30 个 gzip 分片 / 覆盖率 100% | `verify-shard-live.mjs`（exit 2/3） |
| 扩库候选池 | 48,643 个被引DOI / 7,762 个期刊 | `pipeline-cited-gap-ranked.js` |

> **为什么每个数字都带来源**：v1/v2 两轮全量扫描的三个 P0（飞轮冻结、支付未部署、对外宣称偏离）
> 根因是同一个——**对外数字没有可复现的来源**。今后任何对外数字都必须写明"由哪个端点或哪个脚本产出"。
> 复核入口：[`reports/verify-online.md`](reports/verify-online.md)。

### 能力声明与事实边界（2026-10-10 硬锚定，勿改口径）

以下**是我们**对外常提到的三条差异化能力，但截至 2026-10-10 实测**并未真正落地**，或建立在一个非常薄的基座上。任何对外物料、评审问答、BD 提案都必须**同时**呈现这两列，不能只挑左边讲。

| 宣称的能力 | 实测状态 | 事实锚点 |
|---|---|---|
| 跨源实体解析（同一篇论文在 OpenAlex / Crossref / PubMed 的不同 ID 合并） | ❌ **未实现** | 仅站内 `dedupeKey = doi:` / `标题#作者`；跨源 ER 无产出。参见 `data/claims.json` 与 v2 报告 §5.1 |
| 引用立场抽取（"支持 / 反驳 / 提及"三分类） | ❌ **无** | 引用网络只到"引用了谁"，无"如何引用"。对照 Scite（1.2B 引用陈述）。参见 v2 报告 §4.1 |
| 向量检索（RAG 混合召回） | ❌ **无** | 目前 BM25 + 字段加权 + RRF token 匹配，无 embedding。参见 v2 报告 §4.1 |
| 引用网络基座厚度 | 🟠 **1,634 条学术种子** | `data/academic-entities.json`。引用边 28,001 中真正由引用声明解析出的**仅 1,961 条（7%）**，其余 26,044 条来自 legacy merge。参见 `data/citation-edges.json` `stats` 段 |
| 零引用站对（研究空白候选） | 🟠 **101 / 870，建立在薄网络上** | `data/citation-gaps.json`。**"零引用可能是我们没抓到"**——见 `citation_gaps` 工具返回的 `interpretation` 字段与 v2 报告 §5.2 |
| 跨源归一 | ❌ **未落地**（站内去重 0.00%） | 8 源记录几乎不重叠，无跨源归一可做。参见 v2 报告 §5.1 |
| 中文政产学融合 | ❌ **未落地** | 全部实体来自英文源，无 CNKI / 万方 / CSCD。参见 v2 报告 §5.1 |

> **判定**：本项目的"平台侧"接近完整（API / 治理 / 编排 / 可观测），"知识侧"（ER / 立场 / 向量 / 证据抽取）**尚未开工**。详见 [`reports/项目全面评估与硬科技深度提升综合报告-2026-10-10.md`](reports/项目全面评估与硬科技深度提升综合报告-2026-10-10.md) §5（技术壁垒的真相）与 §8（Tier 1 硬科技路线图）。

**可达性事实（哪些地址真的存在，别写错）**

| 地址 | 状态 |
|---|---|
| `https://api.swarmlabs.tools` | ✅ 在线（Worker） |
| `https://data.swarmlabs.tools` | ✅ 在线（GitHub Pages 直出） |
| `https://license.swarmlabs.tools` | ✅ 在线（Worker，但 `/api/hupijiao/order` 仍 404，见下） |
| `<站>.swarmlabs.tools`（30 个站点子域，如 `quantum-computing.swarmlabs.tools`） | ❌ **DNS 无记录，从未配置** |

30 个站点的**站点子域从未配置 DNS**。对外文案一律用 `api.swarmlabs.tools` / `data.swarmlabs.tools`，
**不要写 `<站>.swarmlabs.tools`**——那是 10 秒可证伪的宣称。
`operations-plan/pipeline-domain-claim-guard.js` 会在 CI 里扫出任何这类文案并让门禁变红。

站点本身通过 GitHub Pages **路径**可达（`/agent-ecosystem/website/api/index.json` 等），
见 `GET /v1/domains` 返回的 `index` / `entities` 相对路径。

> **支付状态（唯一仍在流血的 P0）**：`license.swarmlabs.tools/health` 返回
> `{"status":"ok","version":"2.0"}`，但 `/api/hupijao/order?trade_order_id=x` 返回
> `404 {"status":"not_found"}` —— 健康检查通过 ≠ 支付链路可用，这是"部署版本落后"，不是服务故障。
> 该路由 404 会让用户以为"查不到订单"从而重复下单。修复代码已在仓库并通过 CI，
> 上线需 `npx wrangler deploy`（浏览器 OAuth，无法代跑）。步骤见 `unified-license/DEPLOY-NOW.md`。

**许可**：代码 MIT（见 [`LICENSE`](LICENSE)）；数据产物版权归原出版方，商业使用需授权。

---

## 参赛定位（阿里云 GoAI 2026 · 赛道一「新智基座」）

> **三个评审方向映射**：可信执行 → Guard 矩阵 + 审计日志；多 Agent 协作 → 6-Agent 运营闭环；知识累积 → 数据飞轮 + 时间机器溯源

## 基础设施能力（2026-09-19 更新，2026-10-02 增补 MCP 门禁）

- **OpenAPI 3.1**：[`openapi.yaml`](openapi.yaml)（9 端点 + 5 schema，三档 API key）
- **消费者上手**：[`docs/consumer-onboarding.md`](docs/consumer-onboarding.md)（快速开始 / 端点 / 错误码）
- **战略定位**：[`docs/strategy-infrastructure.md`](docs/strategy-infrastructure.md)（信息收集 + 结构化基础设施）
- **语义搜索端点**：`POST /v1/search/semantic`（Pro only，13k 高置信实体 token 匹配）
- **OSS 扫描管道**：`operations-plan/pipeline-oss-scan.js`（GitHub/HF/PWC 每日快照）
- **搜索索引管道**：`operations-plan/pipeline-search-index.js`（每日构建 6.58MB 索引）
- **学术数据集管道**：`operations-plan/pipeline-academic-datasets.js`（Crossref + NCBI 免密钥，产出 3 份学术数据文件）
- **MCP 数据引擎**：`@genetech/data-mcp`（10 个工具，含 `graph_search` 图遍历检索）

> **项目身份**：本仓库 `lm203688/genetech-14-sites`；SwarmLabs / RoboParts 为独立项目，共用 CF 账号但代码/密钥/部署完全解耦。

## 正确性门禁（防「绿灯 ≠ 有效」）

2026-10-02 的摸底发现：**「构建成功」和「门禁真的拦得住」是两回事**，所以每个门禁都必须能自证有效。

| 门禁 | 位置 | 为什么必须有它 |
|------|------|----------------|
| MCP 冒烟 | `.github/workflows/ops.yml` → `mcp-gate` 作业 | 曾出现 `index.mjs` import 不存在的 `graphrag.mjs`，进程一启动就退出，对外接口实际是死的，但没有任何检查能发现 |
| 知识图谱护栏 | `ops-extra.yml` → `kgbuild` | 三个写入者 + 跨 schema 基线 = 护栏自锁，会导致「永远写不进 → 下轮读同一份旧图」的死循环 |
| 聚合产物契约 | `pages-deploy.yml` | Worker 上游依赖 `_site/data/*.json`，文件缺失会导致语义检索与注册表 404 而部署仍报成功 |
| 推送落点校验 | `.workbuddy/probe/verify-content.mjs` | 推送走 Contents API，上传 CRLF 后远端 blob sha 与 git 归一化 sha 天然不同，**只有内容级比对才算数** |

> 每个门禁都要求「注入故障 → 必须阻断 → 恢复 → 必须放行」双向回归测试；只跑一遍就打绿灯的门禁不算门禁。

## 为什么不是「又一个爬虫 / 又一个 RAG」

| 常见做法 | 我们的差异 |
|----------|-----------|
| 直接调 OpenAlex / Crossref / PubMed | 做**跨源归一 + 跨域桥接 + 中文政产学融合**，原始库给不出 |
| 用 AutoGen / CrewAI / MetaGPT 通用框架 | Agent 是**领域知识工程专用**，不是通用编排框架 |
| 知识库只追加不审计 | 全链路审计日志 + 时间机器溯源 + 受控演化策略 |
| 付费墙即安全 | Guard 矩阵（Knowledge/Source/Publish/Compliance）分层守卫 |

## 6 个 Agent 角色（详见 [`docs/competition-2026/AGENTS.md`](docs/competition-2026/AGENTS.md)）

```
Collector → Normalizer → Validator → Publisher → (Repair) ↺   +   KnowledgeGuard（常驻审计）
```

- **Collector Agent**：多源采集（OpenAlex / arXiv / Crossref / PubMed / Semantic Scholar / Europe PMC）
- **Normalizer Agent**：跨源 schema 归一、实体消歧、跨域桥接
- **Validator Agent**：质量门禁、提案审计、准入判定
- **Publisher Agent**：站点生成、License 端点、SEO 发布
- **Repair Agent**：CI 看门狗触发的数据修复与漂移回滚
- **KnowledgeGuard Agent**：常驻审计、合规、secret 扫描

## Guard 矩阵（详见 [`docs/competition-2026/GUARD-MATRIX.md`](docs/competition-2026/GUARD-MATRIX.md)）

| Guard | 职责 | 现状 |
|-------|------|------|
| KnowledgeGuard | 知识质量 / 合规 / secret 扫描 | 设计中 |
| SourceGuard | 数据源可用性 / 降级 | 看门狗已落地 |
| PublishGuard | 发布前契约校验 / License | api-guard 已落地 |
| ComplianceGuard | 合规 / 审计留存 | 设计中 |

## 闭环与知识累积

- **数据飞轮**：6 源 backfill → 300k+ 结构化实体（30 站 × 1 万/站，去重后 28.4 万，摘要完整度 66.2%）→ 双端点 License 故障转移
- **时间机器**：每个实体带 `provenance`，支持任意时间点知识重放（[`docs/competition-2026/TIME-MACHINE.md`](docs/competition-2026/TIME-MACHINE.md)）
- **受控演化**：明确的准入 / 降级 / 淘汰策略（[`docs/competition-2026/EVOLUTION-POLICY.md`](docs/competition-2026/EVOLUTION-POLICY.md)）
- **串行 PR 闭环**：新数据源 / 新 Agent / 新内容先入 `.proposals/`，由 Validator Agent 审计后流转（[`docs/competition-2026/PROPOSALS.md`](docs/competition-2026/PROPOSALS.md)）

## 借鉴了哪些开源项目（赛道扫描）

对赛道一 30 个项目扫描 → 归纳 **7 大母题**（多 Agent 团队 / 串行 PR 闭环 / Guard 矩阵 / 时间机器 / 受控演化 / 企业垂直落地 / 可信交付），已逐项映射到本项目（[`docs/competition-2026/BORROW-PATTERNS.md`](docs/competition-2026/BORROW-PATTERNS.md)）。

## 自评估（9 维度，不加权，详见各文档）

总体 ≈ **3.05 / 5**。强项：工程落地与可复现（4）、开放探索可检查性（4）。弱项：Agent 闭环显式化（2.5）、安全审计（2）、Demo 完成度（2.5）、付费企业客户（待补）。**本批交付物逐项补强弱项。**

## 本批交付物清单

| 文件 | 阶段 | 作用 |
|------|------|------|
| `README.md`（本文件） | P0 | 多智能体平台定位 |
| `docs/competition-2026/AGENTS.md` | P0 | 6 Agent 设计与协作流 |
| `docs/competition-2026/GUARD-MATRIX.md` | P0 | Guard 矩阵整合方案 |
| `docs/competition-2026/BORROW-PATTERNS.md` | P0 | 赛道 30 项目 → 7 母题 → 映射 |
| `docs/competition-2026/EVOLUTION-POLICY.md` | P1 | 受控演化（准入/降级/淘汰） |
| `docs/competition-2026/AUDIT-LOG.md` | P1 | 审计日志设计 + 参考实现 |
| `docs/competition-2026/TIME-MACHINE.md` | P1 | 时间机器 / 溯源 |
| `docs/competition-2026/PROPOSALS.md` + `.proposals/` | P0/P1 | 串行 PR 闭环 demo |
| `docs/competition-2026/REVIEWER-ONEPAGER.html` | P1 | 评审一页纸 |
| `docs/competition-2026/demo-walkthrough.html` | P1 | 交互式 Demo（录屏替代） |

## 当前真实状态（诚实标注）

- ✅ 全量上线 GitHub Pages，30 站可访问
- ✅ 数据飞轮修复完成，SEO 14/14 文章完成
- ✅ License 双端点故障转移上线（虎皮椒支付）
- ⚠️ CI 偶发 break（数据契约校验 + 看门狗）—— 已知待修
- ⚠️ 历史 secret 泄漏（`ghp_` / `cfut_` / 虎皮椒 / `CORE_API_KEY`）—— 需私有仓 + 历史清理（P2 安全项）
- 🔲 企业付费全链路 demo（P2）—— 需真实客户，模板已备

> 引擎目录（`operations-plan/`、`shared/`、`unified-license/`、`api-guard/`、`tools/build-site.mjs`）按 2026-08-21「混合回退模式」**保留入库作为 CI 公开兜底引擎**；私有仓 `genetech-14-engine` 可用时优先，不可用时回退本仓副本，确保 Secrets 未配时不致全线停摆。

<!-- GENETECH:CLAIMS:BEGIN -->
<!-- 由 operations-plan/pipeline-docs-claims.js 于 2026-10-10 自动生成，请勿手工编辑此锚注之间的内容。 -->

### 当前规模（机器生成，锚注自动刷新）

| 指标 | 值 | 口径 |
|---|---:|---|
| 站点 / 域数 | **30** | 有 `website/api/entities.json` 的顶层目录 |
| 结构化实体总数 | **294,330** | 逐站实体文件求和 |
| 带 DOI/PMID 的实体 | **271,099** | 同上，仅计有外部可解析 ID 的记录 |
| 知识图谱节点 / 边 | **36,107 / 99,725** | data/knowledge-graph.json |
| 图谱中引用边 | **27,868（28%）** | KG 中 relation=citation |
| 学术种子（引用网络基座） | **1,634** | data/academic-entities.json，是缺口矩阵的真实基座 |
| 引用声明总数 | **59,623** | 59,623 类 |
| 引用边（真实解析 + legacy merge） | **1,961 / 28,001** | resolved 7% + legacy 26,044 |
| 零引用站对 | **101 / 870** | citation-gaps.json |

> 以上数字由脚本从 data/ 单一真源实时计算。与本报告 §2.2 数字若不一致，**以本锚注为准**（脚本口径永远新）。

<!-- GENETECH:CLAIMS:END -->
