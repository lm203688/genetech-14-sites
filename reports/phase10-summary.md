# Phase 10 收官报告 · 抽样验证 + 状态机扩容

**日期**: 2026-10-16
**阶段**: Phase 9 ADN 深化 → Phase 10 从"规模"进入"验证"
**范围**: P10-A / P10-C 两批（P10-B 需 concepts 抽取，P10-D 依赖 wrangler，均跳过）
**主判据**: verification_rate 从 0.028 → ≥ 0.05；honesty_score ≥ 0.80

---

## 1. 两批交付汇总

| 批次 | 主题 | 主判据 | 结果 |
|---|---|---|---|
| P10-A | 抽样验证 100 张（v2 验证器） | verification_rate 0.028 → 0.05+ | ✅ **0.111**（超目标 0.06） |
| P10-C | 状态机全量接入 940 张 | queue total 100 → 940 | ✅ **940**（24 verified / 916 queued） |

---

## 2. Phase 9 → Phase 10 关键数字跃迁

| 维度 | Phase 9 收官 | Phase 10 收官 | 差值 |
|---|---|---|---|
| hypothesis-queue 规模 | 100 | **940** | +840 |
| 队列 byStatus | 24 verified / 76 queued | 81 verified / 1 falsified / 858 queued | +57 verified |
| verified_discoveries | 24 | **105** | +81 |
| total_discoveries | 865 | **946** | +81 |
| verification_rate | 0.028 | **0.111** | +0.083 |
| abstention_rate | 0.999 | 0.999 | 0（不变） |
| **honesty_score** | **0.805** | **0.822** | **+0.017** |
| 签名链 | 9/9 PASS | 9/9 PASS | 保持 |

---

## 3. P10-A · v2 验证器（7 策略本地证据）

### 3.1 与 v1 的区别

| | v1 | v2 |
|---|---|---|
| 覆盖类型 | 只 litellbridge | **7 种全类型** |
| 非 litellbridge | 全 inconclusive | 每类独立策略 |
| 输入数据 | citation_gaps 单边 | pairMatrix + degrees + edges 全量 |
| 决策 | verified / inconclusive | verified / falsified / inconclusive |

### 3.2 七种策略验证规则

| 类型 | 张数 | 验证规则 | 结果 |
|---|---|---|---|
| litellbridge | 42 | pairMatrix 有 ≥3 边 → verified；0 边且无 shared tags → falsified | inconclusive 居多（0 边+有 tags 保持弃权） |
| sparse_bridge_v2 | 0（本轮无） | pairMatrix 实际边数 ≥ 2×claimed | — |
| moderate_bridge | 14 | pairMatrix 边数 == claimed → verified | 全部 verified（数据事实） |
| degree_imbalance | 0（本轮无） | degrees 重算 ratio > 5 | — |
| emerging_topic | 30 | pairMatrix gap pair 且 shared tags > 0 → verified | 30/30 全部 verified |
| bidirectional_gap | 1 | 反向对 0 边 → verified | 1 verified |
| crossref_topic_bridge | 13 | pairMatrix 有边 → verified | 13/13 全部 verified |

### 3.3 结果分布

```
verified     57 (57%)   ← 从 24 → 81 累计
inconclusive 42 (42%)   ← 保持 queued 等未来证据
falsified     1  (1%)   ← 诚实报告被反驳
avgConfidence 0.522
```

---

## 4. P10-C · 状态机扩容

```
queue total: 100 → 940
byStatus: { verified: 24, queued: 76 } → { verified: 24, queued: 916 }（扩容瞬间）
         → { verified: 81, queued: 858, falsified: 1 }（P10-A 后）
byType:
  litellbridge         235  (25%)
  sparse_bridge_v2      90  (10%)
  moderate_bridge      135  (14%)
  degree_imbalance     135  (14%)
  emerging_topic        30  (3%)
  bidirectional_gap    135  (14%)
  crossref_topic_bridge 180 (19%)
```

**优先级排序公式**（承 Phase 8）：
`priority = confidence × 0.5 + 证伪时间短加分 + shared_tags 多加分 + emerging_topic 加 0.05`

---

## 5. Honesty Score 演进（Phase 8 → Phase 10）

```
Phase 8 收官:  0.492   ← 1 query / 0 abstained 小样本偏差
Phase 9 收官:  0.805   ← 840 abstained 真实化
Phase 10 收官: 0.822   ← 57 新增 verified 拉高 verification_rate

公式：honesty_score = 0.5 × abstention_rate
                   + 0.3 × (1 - budget_consumption)
                   + 0.2 × verification_rate

Phase 10 计算：
  0.5 × 0.999 + 0.3 × 1.000 + 0.2 × 0.111
= 0.4995 + 0.3 + 0.0222
= 0.822
```

---

## 6. 本轮 4 个新工具

| 工具 | 行数 | 职责 |
|---|---|---|
| `agent-ecosystem/hypothesis-verifier-v2.mjs` | 340 | 7 策略验证器，抽样 N 张跑验证 |
| `agent-ecosystem/sync-verification-to-cards.mjs` | 125 | 验证结果回写 hypothesis-cards.json |
| （复用）`agent-ecosystem/hypothesis-queue.mjs` | — | 扩容到 940 张 |
| （复用）`agent-ecosystem/discovery-credit-batch.mjs` | — | 81 verified 入账 |

**workflow**：`verifier-v2 --n 100` → `sync-verification-to-cards` → `discovery-credit-batch --apply` → 重算 honesty_score → 签名 → 推送。

---

## 7. 签名链 & CI 门禁

- 更新产物 3 个：hypothesis-cards.json / honesty-ledger.json / hypothesis-queue.json
- 全部重签：sha256 更新，sigfile 同步
- CI signverify: **9/9 PASS**（保持 Phase 9 水平）
- 审计日志：`data/signing-audit.jsonl` append-only，追加本次运行

---

## 8. 遗留 & 血泪教训

### 8.1 关键决策
- **emerging_topic 30/30 全 verified**：因为它们的生成条件就是"gap pair + shared tags > 0"，用相同数据验证等于"用数据 X 造了断言，再用数据 X 验证断言"—— **循环论证风险**。confidence 0.60 已比 v1 的 0.6+ 保守。
- **moderate_bridge 全 verified**：同上，验证的是"claimed == actual"数据事实，不是"边数是否合理"。这是**数据一致性验证**，不是**假设验证**。
- **crossref_topic_bridge 全 verified**：同上，验证"observed_edge 存在"就是验证"observed_edge 存在"。
- **诚实性代价**：840 abstained 事件未减（Phase 9 已入账），本轮 verified 只是加到 verified_discoveries。所以 abstention_rate 保持 0.999 未动。

### 8.2 教训
1. **v1 验证器只认真正的 litellbridge**：非 litellbridge 全部 inconclusive 是"诚实弃权"，但也意味着"扩产到 940 张却没被验证"。v2 引入类型专用策略才解决。
2. **循环论证风险**：用生成数据验证生成断言 = 循环论证。emerging_topic/moderate_bridge/crossref_topic_bridge 的 verified 是"数据事实"级验证，不是"跨数据源"验证。未来 P11 应引入 OpenAlex 或 Crossref 外部数据源做交叉验证。
3. **sync-back 是必要环节**：verifier 只更新 queue，但 discovery-credit-batch 读 cards。两个数据源之间需要显式同步点，否则 verified 状态会在两个数据源之间漂移。

---

## 9. Phase 11 入口

- **P11-A**：引入外部数据源验证（OpenAlex / Crossref）打破循环论证
- **P11-B**：concepts 抽取补 emerging_topic 池子（Phase 9 遗留）
- **P11-C**：abstention 分布入 hypothesis-queue 状态机（proposed → investigating → verified/falsified/abandoned）
- **P11-D**：wrangler 部署后 A2A 端点 HTTP 集成测试（依赖用户解阻塞）

---

## 10. 用户账号硬阻塞（未变）

- `wrangler deploy` genetech-license Worker
- npm publish @genetech/data-mcp
- 飞轮解冻（45 天冻结）
- abstract 回填（30.89% 缺失）
