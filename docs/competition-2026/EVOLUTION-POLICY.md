# 受控演化策略（Controlled Evolution Policy）

> 母题来源：FinFlux / OrgRebase / SceneGuard「受控演化（准入 / 降级 / 淘汰）」
> 对应评审维度：开放探索赛题「可检查性与可延续性（15%）」+ 工程落地「运行验证」

评审人必问："**你的数据 / Agent 是怎么死（被淘汰）的？**" 本文件给出显式规则，使演化过程可被外部检查、可被复现、可被问责。

---

## 1. 三层演化控制面

```
            ┌─────────────┐
 新实体 ──▶ │  准入 Gate   │ ──pass──▶ Active Pool
            └─────────────┘
                                    │
            ┌─────────────┐         ▼
 Active ──▶ │  降级 Demote │ ◀── drift/quality drop
            └─────────────┘
                                    │
            ┌─────────────┐         ▼
 Active ──▶ │  淘汰 Retire │ ── TTL / 低置信 / 重复
            └─────────────┘
```

## 2. 准入规则（Admission）

实体进入 `Active Pool` 必须满足：

| 规则 | 阈值 | 校验方 |
|------|------|--------|
| 来源可信度 | ≥ 2 个独立源交叉印证 | SourceGuard |
| 字段完整度 | 必填字段缺失率 < 10% | Validator Agent |
| 去重 | 与现存实体 cosine > 0.95 视为重复，合并而非新建 | Normalizer Agent |
| 合规 | 命中敏感词 / 隐私模式 → 阻断 | ComplianceGuard |
| 提案 | 属新数据源 / 新 schema → 须先过 `.proposals/` 审计 | Validator Agent |

## 3. 降级规则（Demotion）

当实体在 `Active` 状态出现以下信号，自动降级为 `Staged`（不删除，保留 provenance）：

| 信号 | 触发条件 | 动作 |
|------|----------|------|
| 来源失效 | 上游 URL 连续 3 次 4xx/5xx | 标记 `degraded:source_lost` |
| 质量漂移 | 归一后字段完整度跌破 40% | 标记 `degraded:low_quality` |
| 冲突 | 新证据与旧实体矛盾且无法消歧 | 标记 `degraded:conflict` |
| 时效 | 超过 `freshness_ttl`（默认 180 天）无更新 | 标记 `degraded:stale` |

降级实体在站点中折叠展示，不计入趋势统计主口径。

## 4. 淘汰规则（Retirement）

仅当满足**任一硬条件**才物理移除（或归档至 `retired/` 冷区）：

| 硬条件 | 说明 |
|--------|------|
| TTL 到期 | `stale` 状态持续 > 365 天且无任何引用 |
| 确证错误 | 上游正式撤稿 / 更正（retraction / erratum） |
| 重复合并 | 被更高置信实体完全吸收 |
| 合规裁决 | ComplianceGuard 终裁违规 |

淘汰动作写一条 `audit/retire.jsonl` 记录（见 `AUDIT-LOG.md`），保留 `provenance` 以便时间机器回放历史版本。

## 5. 可检查性接口（给评审人）

- `GET /api/evolution/state`：返回各 Pool 实体计数 + 最近 24h 演化事件。
- `audit/evolution-YYYY-MM-DD.jsonl`：每日演化事件流（admit/demote/retire）。
- `docs/evolution-policy.md`（即本文件）：规则本体，版本化（`policy_version: 2026.1`）。

## 6. 与 SwarmLabs 47k 实体的关系

SwarmLabs 的 47,566 条结构化科研实体（趋势 / 研究空白 / 跨域桥接 / 合著网络）直接套用本策略：
- 趋势实体 → `freshness_ttl` 90 天（快变）；
- 研究空白 / 跨域桥接 → `freshness_ttl` 365 天（慢变）；
- 合著网络 → 仅随新论文增量更新，不淘汰。
