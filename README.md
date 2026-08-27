# GeneTech 14站 · 多智能体知识运营平台

> **参赛定位**：阿里云 GoAI 2026 初赛 · 赛道一「新智基座」（多 Agent 基础设施）
> **三个评审方向映射**：可信执行 → Guard 矩阵 + 审计日志；多 Agent 协作 → 6-Agent 运营闭环；知识累积 → 数据飞轮 + 时间机器溯源

---

## 一句话定位

GeneTech 14站是一个**多智能体知识运营平台（Multi-Agent Knowledge Operations Platform）**：用一组职责分离的智能体，把分散在学术 / 产业 / 政策多源的数据，持续转化为**可审计、可溯源、可复现**的结构化知识资产。

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

- **数据飞轮**：6 源 backfill → 47k+ 结构化实体（趋势 / 研究空白 / 跨域桥接 / 合著网络）→ 双端点 License 故障转移
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
