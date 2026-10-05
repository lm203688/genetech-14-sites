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

**当前规模（实测，非宣称）**

| 资产 | 规模 | 门禁 |
|---|---|---|
| 结构化实体 | 300,000（30 域 × 10,000） | 产物契约门禁 |
| 唯一 DOI | 276,769（23,231 个是重复占位） | `verify-shard-fidelity.mjs` |
| 跨域引用边 | 27,340（751 个有向域对） | 缺口矩阵 119/870 零引用（13.7%） |
| 语义检索 | 30 个 gzip 分片 / 覆盖率 100% | `verify-shard-live.mjs`（exit 2/3） |
| 扩库候选池 | 48,643 个被引DOI / 7,762 个期刊 | `pipeline-cited-gap-ranked.js` |

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

- ✅ 全量上线 GitHub Pages，14 站可访问
- ✅ 数据飞轮修复完成，SEO 14/14 文章完成
- ✅ License 双端点故障转移上线（虎皮椒支付）
- ⚠️ CI 偶发 break（数据契约校验 + 看门狗）—— 已知待修
- ⚠️ 历史 secret 泄漏（`ghp_` / `cfut_` / 虎皮椒 / `CORE_API_KEY`）—— 需私有仓 + 历史清理（P2 安全项）
- 🔲 企业付费全链路 demo（P2）—— 需真实客户，模板已备

> 引擎目录（`operations-plan/`、`shared/`、`unified-license/`、`api-guard/`、`tools/build-site.mjs`）按 2026-08-21「混合回退模式」**保留入库作为 CI 公开兜底引擎**；私有仓 `genetech-14-engine` 可用时优先，不可用时回退本仓副本，确保 Secrets 未配时不致全线停摆。
