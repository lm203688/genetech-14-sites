# competition-2026 · 文档索引

<!-- docs-visibility: stubbed -->

> **本目录下的所有设计全文已归档到私有目录**，公开树仅保留占位 stub（本文件 + 每个原文件名对应的一份占位）。
> 归档位置：`.workbuddy/private-docs/competition-2026/`

## 为什么归档

这些文档属于**内部设计类**（Agent 角色协作流、Guard 矩阵实现细节、赛道借鉴分析、评审一页纸），
不适合直接出现在公开仓——它们含内部数据、评审问答、策略细节。
2026-10-08 由 `operations-plan/pipeline-docs-guard.js --fix` 一次性执行。
策略定义见 [`guards/docs-visibility.policy.json`](../../guards/docs-visibility.policy.json)（`competition-2026/` 前缀列入 `internal_patterns`）。

## 申请访问

如果**外部评审 / 合作方 / 大赛委员会**需要看这些文档的全文，走以下步骤之一：

1. **GitHub Issue 申请**（公开场景）：在 [`lm203688/genetech-14-sites`](https://github.com/lm203688/genetech-14-sites) 建 issue，模板见 issue 列表顶部，标题前缀 `[Docs-Request]`。24 小时内回复，通常直接发私有仓只读邀请。
2. **公开改写后恢复**（长期公开场景）：把内容按「公开白名单」标准改写（去掉内部数据、竞品策略、告警细节），再在 `guards/docs-visibility.policy.json` 的 `public_allowlist` 里显式放行。
3. **私有目录直读**（本项目维护者）：`.workbuddy/private-docs/competition-2026/*.md`，与公开 stub 一一对应。

## 内容清单（对应公开 stub 与私有全文）

| # | 文件 | 阶段 | 作用 | 公开 stub |
|---|------|------|------|-----------|
| 1 | `AGENTS.md` | P0 | 6 Agent 设计与协作流（Collector→Normalizer→Validator→Publisher→Repair，KnowledgeGuard 常驻） | [占位](AGENTS.md) |
| 2 | `GUARD-MATRIX.md` | P0 | Guard 矩阵整合方案（Knowledge / Source / Publish / Compliance 四层守卫） | [占位](GUARD-MATRIX.md) |
| 3 | `BORROW-PATTERNS.md` | P0 | 赛道一 30 项目 → 7 母题 → 逐项映射到本项目 | [占位](BORROW-PATTERNS.md) |
| 4 | `EVOLUTION-POLICY.md` | P1 | 受控演化（准入 / 降级 / 淘汰） | [占位](EVOLUTION-POLICY.md) |
| 5 | `AUDIT-LOG.md` | P1 | 审计日志设计 + 参考实现 | [占位](AUDIT-LOG.md) |
| 6 | `TIME-MACHINE.md` | P1 | 时间机器 / 溯源（每实体带 `provenance`，支持任意时间点重放） | [占位](TIME-MACHINE.md) |
| 7 | `PROPOSALS.md` | P0/P1 | 串行 PR 闭环（新数据源 / 新 Agent / 新内容先入 `.proposals/`，由 Validator Agent 审计） | [占位](PROPOSALS.md) |
| 8 | `ENGINEERING-MECHANISMS.md` | — | 关键工程机制说明（游标账本、幂等键、跨源归一） | [占位](ENGINEERING-MECHANISMS.md) |
| 9 | `FOUR-PERSPECTIVE-EVALUATION.md` | — | 四视角评估（工程 / 科学 / 治理 / 商业化） | [占位](FOUR-PERSPECTIVE-EVALUATION.md) |
| 10 | `TECH-DEEP-DIVE.md` | — | 技术深潜（数据飞轮、检索评测、跨域引用边构建） | [占位](TECH-DEEP-DIVE.md) |
| 11 | `DEMO-SCRIPT.md` | — | Demo 脚本 | [占位](DEMO-SCRIPT.md) |
| 12 | `REVIEWER-ONEPAGER.html` | P1 | 评审一页纸（打印友好） | [占位](REVIEWER-ONEPAGER.html) |
| 13 | `demo-walkthrough.html` | P1 | 交互式 Demo（录屏替代） | [占位](demo-walkthrough.html) |

## 相关入口

- **面向外部开发者**：[`docs/consumer-onboarding.md`](../consumer-onboarding.md)（快速开始）/ [`docs/enterprise-data-license-kit.md`](../enterprise-data-license-kit.md)（企业采购）
- **面向运营**：[`docs/ops-runbook.md`](../ops-runbook.md)
- **公开 API**：[`openapi.yaml`](../../openapi.yaml) · [`api.swarmlabs.tools/health`](https://api.swarmlabs.tools/health)
- **公开报告**：[`reports/`](../../reports/)（每轮全面提升评估都在这里）

## 与 README 的对应关系

[README.md](../../README.md) 第 6 节 "6 个 Agent 角色"、"Guard 矩阵"、"闭环与知识累积"、"借鉴了哪些开源项目"、"本批交付物清单" 均指向本索引。
如果 README 里出现新的 `docs/competition-2026/*.md` 直链而**未**转成"归档到私有目录"表述，说明有漏改——请提 PR 修复。
