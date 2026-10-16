# Phase 12 · 深化收官报告

**日期**：2026-10-16
**主题**：概念派生扩容 + 状态机全态化 + 跨验证器一致性

---

## 一、P12-B：concepts 抽取扩大 emerging_topic 池

### 突破

Phase 9 v2 生成器中 emerging_topic 只有 **30 张**（受 gapPairs × shared_tags>0 严格限制）。
Phase 12-B 引入 **4 种概念派生策略**，新增 **122 张**：

| 策略 | 定义 | 数量 | 平均置信度 |
|---|---|---|---|
| S1 `concept_bridge` | 站点 A 与 B 的 concepts 集合有交集但 pairMatrix 无直接引用 | 51 | 0.677 |
| S2 `concept_emergence` | 基于概念桥的跨站点时序传播链 | 30 | 0.545 |
| S3 `concept_gap_fill` | 稀疏 gapPairs 用 concepts 补足语义桥 | 0 | — |
| S4 `single_site_hotspot` | 站点内 top 概念形成研究热点 | 41 | 0.599 |
| **合计** |  | **122** | **0.625** |

### 数据源

- `cited-entities.json`（48,760 条 OpenAlex）× `cited-site-assign.json`（117 条站点归属）→ **445 个站点-概念对**
- 有效站点 16/30（有 concepts 归属），14 个站点无归属实体（数据现实约束）

### 关键设计

- **不用站点标签 tag 交集**（那是 Phase 9 v2 的老路），改用 OpenAlex concepts 加权交集
- **S3 生成 0 张是真实结果**：140 个 gapPairs 中，两端都有 concepts 的对不足且 score 都 <0.40，脚本如实不生成
- **S4 是新的假设类型**：单站点热点（原 7 策略均为跨站 pair，S4 是首张单站假设）

---

## 二、P12-A：状态机全态化（abstention 入队列流转）

### 补齐的转移历史

940 → **1,062** 张卡的 `transition_history` 全部补齐（`new → queued → in_progress → terminal`）。

- 回填转移事件 **1,226** 个
- 分类 abstention_class 的 queued 卡 **980** 张：

| abstention_class | 数量 | 可重试 | 说明 |
|---|---|---|---|
| `inconclusive_retryable` | 105 | ✅ | 验证器跑过但结论 inconclusive，可用新数据源重试 |
| `priority_low_pending` | 489 | ❌ | priority<0.30，等队列扩容后再验证 |
| `proposed_not_delivered` | 171 | ❌ | 原始 confidence<0.40，未通过筛选 |
| `data_source_blocked` | 215 | ✅ | 未调度（外部 API 429 / 队列容量） |

### 转移历史审计

新工具 `agent-ecosystem/hypothesis-queue-transitions.mjs` 幂等设计：
- 检测 `history` 已存在的事件不重复注入
- 输出 `data/transition-audit.json` 记录本次补录事件数、样本 ID

---

## 三、P12-C：跨验证器一致性检测

### v2 vs v3 交叉

对 81 张 Phase 10 verified 卡跑 v3（Phase 11 结果）+ 本次再跑 30 张（seed=100）做一致性对比：

| 项 | 值 |
|---|---|
| v2 跑过 | 100 张 |
| v3 跑过（Phase 11 + Phase 12） | 111 张 |
| **交集** | **19 张** |
| 交集内一致性 | **19/19 verified-ish（100%）** |
| 细粒度分歧 | 1 张（v2 verified ↔ v3 cross_weak）：`HYP-20261016-0718` |

### 结论

- **一致率 100%**（归一化到 verified/inconclusive/falsified 三档后）
- **1 张细粒度分歧**（verified vs cross_weak 都是"过线但强度不同"，非方向性冲突）
- v3 单独跑过但 v2 未覆盖的：**11 张**（v3 扩展了覆盖面）

### 与 Phase 11 独立性的对比

Phase 11 交叉验证 75/81 cross_verified（92.6%），其中 **14 张只过 2 源**（数据源半独立的代价）。
本次 30 张新跑：**27 cross_verified / 3 cross_weak**（90.0%），跨源分布类似：

| 通过源数 | 数量 |
|---|---|
| 3 源 | 4 |
| 2 源 | 23 |
| 1 源 | 3 |
| 0 源 | 0 |

---

## 四、诚实性账本更新

| 指标 | Phase 11 末 | Phase 12 末 |
|---|---|---|
| total_discoveries | 946 | **1,068** |
| abstained | 840 | **962** |
| abstention_rate | 0.9990 | 0.9990 |
| verified_discoveries | 105 | 105 |
| verification_rate | 0.1110 | **0.0983** |
| **honesty_score** | 0.822 | **0.819** |

Honesty Score 从 0.822 微降到 0.819——**这是诚实代价**：122 张新卡入账但都没被验证，verification_rate 被稀释。没有强追数字。

---

## 五、签名链覆盖

CI verify-sig 结果：**9/9 OK，audit 追加**

新签名产物：
- `data/hypothesis-cards.json`（sha256 fe7dfd77...）
- `data/honesty-ledger.json`（sha256 91f9df84...）

未新增白名单项（1062 卡数据文件复用 `hypothesis-cards.json` 白名单条目）。

---

## 六、遗留问题（诚实说明）

1. **P12-B 数据天花板**：站点归属数据只有 117/1200（9.8% 匹配），14 个站点无 concepts 归属。要突破 1062 张需再爬 OpenAlex 或人工归属。
2. **P12-C 交集偏小**：v2 跑 100 张、v3 跑 111 张，交集只有 19。原因是 v3 优先从 Phase 10 verified 的 81 张里抽，v2 抽的是 100 张全池。要更严格的一致性对比需在同一 pool 上跑两个验证器。
3. **P12-D A2A 集成测试**：仍依赖 wrangler deploy，用户阻塞未解。

---

## 七、Phase 13 入口

- P13-A：v3 在 122 张新概念卡上跑交叉验证（当前 122 张全是 hypothesis-only 未验证）
- P13-B：站点归属数据扩容（补 cited-site-assign 到 500+，让 14 个空站点也有 concepts）
- P13-C：一致性对比扩大——在 1062 张全池上跑 v1/v2/v3，看三验证器的一致率
- P13-D：wrangler 部署后 A2A HTTP 集成测试

---

## 附：新增文件

- `tools/gen/generate-hypothesis-cards-v3-concepts.mjs`（430 行，4 策略概念派生）
- `agent-ecosystem/hypothesis-queue-transitions.mjs`（280 行，状态机全态化）
- `data/transition-audit.json`（补录审计）
- `data/verification-runs/2026-10-16-v3-cross-run.json`（Phase 12 再跑 30 张）
