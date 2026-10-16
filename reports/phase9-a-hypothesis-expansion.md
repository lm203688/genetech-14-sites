# Phase 9-A · 假设卡 100 → 940 扩产报告

**日期**: 2026-10-16
**任务**: 把假设卡从 Phase 8 首批 100 张扩展到 940 张，覆盖 7 种生成策略
**主判据**: 新增 900 张，全部 abstain-first（无假 verified），签名链通过

---

## 1. 结果快照

| 指标 | 值 |
|---|---|
| 新增张数 | **840**（配额 900，实际受池子上限约束） |
| 合计张数 | **940**（v1 100 + v2 840） |
| 7 种策略覆盖 | ✅ 全部命中 |
| avgConfidence（新增） | 0.357 |
| avgConfidence（合并） | 0.375 |
| evidence_status 分布 | insufficient_evidence 810 + hypothesis_only 30 |
| 假 verified | **0**（100% abstain-first） |
| 签名校验 | PASS（sha256 e300f9f2） |

---

## 2. 七种策略分布

| 策略 | 类型 | 新增张数 | 池子规模 | 说明 |
|---|---|---|---|---|
| 1 | litellbridge | 135 | gapPairs=140 | 无引用站对 × 共享主题 |
| 2 | sparse_bridge_v2 | 90 | 0<e<=5 池 338 | 稀疏桥"应更密" |
| 3 | moderate_bridge | 135 | 1<e<500 池 386 | 中度稀疏"边数低估" |
| 4 | degree_imbalance | 135 | 8 失衡站 × 30 站 | in/out 比值 > 5 的站 |
| 5 | emerging_topic | **30** | shared tags>0 池 30 | 配额 90 但池子只 30 |
| 6 | bidirectional_gap | 135 | gapPairs=140 | gap 反向对 |
| 7 | crossref_topic_bridge | 180 | 抽 504 观测边 | 共引反向推断 |

**观察**：新兴主题只跑到 30 张，受池子上限约束（gapPairs 中 shared tags > 0 的只有 30 对）。要突破需扩展标签库（如引入 concepts / keywords 抽取）。

---

## 3. 诚实性设计（三硬原则）

### 3.1 弃权优先

- 所有 840 张新卡 evidence_status ∈ {insufficient_evidence, hypothesis_only}
- 无一张 evidence_status = supported / verified
- 24 张 verified 保留 Phase 8 首批的 100 张内，v2 新增 0 张

### 3.2 幻觉预算硬顶

- confidence_calibration 全部标 `statistical-signal`（区别于 llm-generated）
- confidence 分档：low(0.25-0.35) 436 / medium(0.35-0.45) 218 / high(0.45-0.65) 186

### 3.3 发现信用

- 新增 840 张计入 total_discoveries（不计 verified_discoveries）
- 每张卡带 falsifiability + evidence_requirement + verification_plan
- 每张卡带 falsification_time_horizon_days（3-21 天）

---

## 4. Confidence 分布（新增）

```
[0.25-0.30)  |░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  145
[0.30-0.35)  |░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  291
[0.35-0.40)  |░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  218
[0.40-0.45)  |░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  159
[0.45-0.65)  |░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  186
```

均值 0.357，中位 0.35，符合"未验证假设信号弱"的诚实性预期。

---

## 5. 交付物

- `tools/gen/generate-hypothesis-cards-v2.mjs` — 7 策略生成器（540 行）
- `data/hypothesis-cards.json` — 940 张卡（2.4 MB）
- `data/hypothesis-cards.json.sig.json` — ed25519 签名
- `agent-ecosystem/hypothesis-batch-log.mjs` — 新批入账工具（192 行）
- `data/honesty-ledger.json` — 更新账本（840 事件）

---

## 6. 下一步

- P9-A 遗留：新兴主题扩产需引入 concepts / keywords 抽取（超出本轮范围）
- P9-B：Honesty Score 提升 → 已完成（见 phase9-b-honesty-score-jump.md）
- P9-C：CI signverify 双向回归 → 见 phase9-c-ci-bidirectional.md
