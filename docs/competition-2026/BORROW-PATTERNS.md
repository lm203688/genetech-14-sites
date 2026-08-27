# 借鉴模式清单（2026-08-24，赛道一 30 项目对标后沉淀）

> 来源：goai_2026 赛道一「新智基座」Top 30 项目对标分析。
> 目的：把行业母题沉淀为本项目可复用的命名/流程/能力清单。

---

## 七大高频母题（30 个项目里反复出现）

| # | 母题 | 代表项目 | 本项目现状 | 紧迫度 |
|---|------|----------|----------|--------|
| 1 | **多 Agent 团队**（显式命名） | RepoMesh, DevOrbit, 2origin, MergePilot, TotalEye, Multi-Agent Collab Runtime | ⚠️ 隐式在 pipeline/scheduler | 🔴 必改 |
| 2 | **串行 PR 闭环** | MergePilot, DevOrbit, FastSlow Dev | ❌ 并行多管线 | 🔴 必改 |
| 3 | **Guard 矩阵** | LabOps Guard, RevGuard, CyberGuard, OpsKeeper, SceneGuard, FinFlux | ⚠️ 散在 api-guard/license/看门狗 | 🟡 整合 |
| 4 | **Time Machine** | AsoulAI ChronosFix | ❌ 无回放/重算 | 🟢 长期 |
| 5 | **受控演化**（准入/降级/淘汰） | FinFlux, OrgRebase, SceneGuard | ⚠️ 有数据飞轮但无显式策略 | 🟡 包装 |
| 6 | **企业垂直落地** | MedAssist-Agent, RevGuard, 刃知, FinFlux, 振场 | ❌ 主要服务科研 + 内容站 | 🟢 新场景 |
| 7 | **可信交付** | CodeNotary, 2origin, LabOps Guard | ⚠️ 历史 secret 泄漏 | 🔴 必补 |

---

## 即时借鉴项（已落到 4 份新文档）

- [AGENTS.md](./AGENTS.md) — 6 个 Agent 角色定义（覆盖母题 1）
- [GUARD-MATRIX.md](./GUARD-MATRIX.md) — 4 个 Guard 整合方案（覆盖母题 3）
- [DEMO-SCRIPT.md](./DEMO-SCRIPT.md) — 60-90 秒全链路录屏脚本（覆盖母题 2 + 产品体验）
- 本文档 = 母题 5/6/7 的检查清单

---

## 母题 5「受控演化」：策略待补

参考 FinFlux / OrgRebase / SceneGuard 的命名，本项目需补三份策略：

| 策略 | 内容 | 当前文件 | 状态 |
|------|------|----------|------|
| `docs/evolution-policy.md` | 准入：哪些数据源/Agent 可被加入 | 无 | ❌ 待建 |
| `docs/deprecation-policy.md` | 降级/淘汰：低质源/失效 Agent 怎么退场 | 无 | ❌ 待建 |
| `docs/audit-policy.md` | 留痕：每个 action 写一行 JSONL | 部分（CI 失败才留） | ⚠️ 扩 |

---

## 母题 6「企业垂直」：候选方向

参考 MedAssist-Agent / FinFlux / 振场 / RevGuard 的命名，建议首批试 3 个垂直：

1. **AI4Science 周报** — 给生物制药 R&D 团队，订阅式交付
2. **政策/产业情报** — 给券商研究所，自动周报
3. **跨境/出海情报** — 给外贸企业，地缘+关税+舆情

每一个垂直都跑通「问 → 6 Agent 协作 → 答案 + 引用 + audit log」全链路。

---

## 母题 7「可信交付」：必须立即做

- [ ] 历史已泄漏 secret 全部轮换：`ghp_/cfut_/hupijiao/CORE_API_KEY/github_pat_*`
- [ ] 公开仓历史重写（注意：HEAD fb0ae25 注释「混合回退」与「核心引擎闭源」决策冲突，需用户先拍板）
- [ ] api-guard 升级为「审计型」而非「速率限制型」
