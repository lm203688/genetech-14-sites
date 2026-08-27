# 竞赛备战文档索引 — competition-2026

> 用途：GoAI 2026 赛道一「新智基座」评审材料索引
> 维护：docs/competition-2026/

---

## 📁 文件清单

| 文件 | 用途 | 优先级 |
|------|------|--------|
| `README.md`（仓库根） | 多智能体平台定位 + Agent/Guard 概览 | P0 |
| `BORROW-PATTERNS.md` | 赛道一 7 大母题对标分析 | P0 |
| `AGENTS.md` | 6 个 Agent 角色定义 + 协作流程图 | P0 |
| `GUARD-MATRIX.md` | 4 个 Guard 整合方案 | P0 |
| `PROPOSALS.md` | 串行 PR 闭环设计 + demo | P0/P1 |
| `DEMO-SCRIPT.md` | 60-90 秒全链路录屏脚本 | P1 |
| `demo-walkthrough.html` | 交互式 Demo 走查（自运行动画） | P1 |
| `EVOLUTION-POLICY.md` | 受控演化：准入/降级/淘汰 | P1 |
| `TIME-MACHINE.md` | 时间机器溯源设计 | P1 |
| `AUDIT-LOG.md` | 审计日志规范 + 参考实现 | P1 |
| `REVIEWER-ONEPAGER.html` | 评审一页纸（浏览器/打印） | P1 |
| `../tools/audit-logger.mjs` | 审计日志 opt-in 实现 | P1 |
| `.proposals/arxiv-cross-domain-bridge/` | 真实提案 demo | P1 |
| `.active/arxiv-cross-domain-bridge/` | 已通过的审查 demo | P1 |

---

## 🎯 评审维度覆盖矩阵

| 评审维度 | 覆盖文档 |
|----------|----------|
| 场景价值与行业可复制性 | README.md, BORROW-PATTERNS.md, REVIEWER-ONEPAGER.html |
| 多 Agent 协同与自主闭环 | AGENTS.md, PROPOSALS.md |
| Skill 工程体系与生态复用 | AGENTS.md（Agent 角色复用） |
| 工程落地与运行验证 | README.md, EVOLUTION-POLICY.md |
| 安全/合规 | GUARD-MATRIX.md, AUDIT-LOG.md |
| Agent 能力与任务闭环 | AGENTS.md, PROPOSALS.md, demo-walkthrough.html |
| 产品体验与 Demo 完成度 | DEMO-SCRIPT.md, demo-walkthrough.html |
| 技术实现深度与工程可复现性 | EVOLUTION-POLICY.md, TIME-MACHINE.md, AUDIT-LOG.md |
| 技术性能（算法维度） | AGENTS.md（6 Agent 并行）, REVIEWER-ONEPAGER.html |
| 科学意义 | TIME-MACHINE.md, AGENTS.md（跨域桥接） |
| 方法创新性 | AGENTS.md, GUARD-MATRIX.md, PROPOSALS.md |
| 问题定义与环境设计质量 | REVIEWER-ONEPAGER.html |
| 探索过程与研究信号 | AUDIT-LOG.md, TIME-MACHINE.md |
| 可检查性与可延续性 | AUDIT-LOG.md, EVOLUTION-POLICY.md |

---

## 🚀 快速导航

### 给评审人看
1. `README.md`（根目录）→ 项目定位
2. `REVIEWER-ONEPAGER.html` → 一页概览
3. `demo-walkthrough.html` → 交互式全链路
4. `AGENTS.md` → Agent 架构
5. `GUARD-MATRIX.md` → 安全架构

### 给开发团队看
1. `PROPOSALS.md` → 闭环工作流
2. `EVOLUTION-POLICY.md` → 数据生命周期
3. `AUDIT-LOG.md` + `../tools/audit-logger.mjs` → 审计工具
4. `TIME-MACHINE.md` → 溯源设计
5. `DEMO-SCRIPT.md` → 录屏指南

---

## 📋 落地状态总览

| 优先级 | 文档 | 状态 |
|--------|------|------|
| P0 | README.md（多 Agent 定位） | ✅ 已上线 |
| P0 | AGENTS.md（6 Agent 角色） | ✅ 已上线 |
| P0 | GUARD-MATRIX.md（4 Guard 整合） | ✅ 已上线 |
| P0 | PROPOSALS.md（PR 闭环 demo） | ✅ demo 就绪 |
| P0 | BORROW-PATTERNS.md（母题对标） | ✅ 已上线 |
| P1 | EVOLUTION-POLICY.md（受控演化） | ✅ 已上线 |
| P1 | TIME-MACHINE.md（时间机器） | ✅ 已上线 |
| P1 | AUDIT-LOG.md + audit-logger.mjs | ✅ 参考实现就绪 |
| P1 | REVIEWER-ONEPAGER.html（评审一页纸） | ✅ 已上线 |
| P1 | demo-walkthrough.html（交互式 Demo） | ✅ 已上线 |
| P1 | DEMO-SCRIPT.md（录屏脚本） | ✅ 已上线 |
| P2 | 全链路 60-90 秒录屏 | ⏳ 待拍摄 |
| P2 | 企业级 demo（1 个付费客户） | ⏳ 待客户 |

---

## 🔗 与主线代码的衔接

| 文档 | 代码入口 | 接入优先级 |
|------|----------|-----------|
| AGENTS.md | `operations-plan/data-flywheel.js` | P1 |
| GUARD-MATRIX.md | `api-guard/` + `unified-license/` + WatchDog | P2 |
| PROPOSALS.md | `operations-plan/backfill-engine-v2.js` | P1 |
| AUDIT-LOG.md | `tools/audit-logger.mjs` | P1 |
| TIME-MACHINE.md | `mcp-server/` + `operations-plan/` | P2 |
