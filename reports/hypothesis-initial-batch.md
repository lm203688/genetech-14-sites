# 首批可证伪假设卡落地报告（Phase 8 Foundation Sprint）

> 2026-10-16 生成 · 基于 Swanson LBD + 跨域桥接 + 新兴主题三策略  
> 数据来源：data/citation-gaps.json (v1, built 2026-10-11T07:55:34.255Z)  
> 生成器：tools/gen/generate-hypothesis-cards.mjs v1.0.0  

## 一、统计概览

| 指标 | 值 |
|---|---|
| 总假设卡数 | **100** |
| 假设类型分布 | litellbridge=100 |
| 证据状态分布 | insufficient_evidence=100 |
| 平均置信度 | 0.431 |
| 输入：citation-gaps 站对总数 | 870 |
| 输入：引用缺口对 | 140 |
| 输入：桥接边站对 | 730 |

## 二、诚实性原则验证

每张假设卡都严格遵守四条硬原则：

| 原则 | 覆盖 | 说明 |
|---|---|---|
| 1. 可证伪性 | ✅ 100% | 每张卡都有 falsification_condition + falsification_test |
| 2. 证据要求 | ✅ 100% | 每张卡都标 min_evidence_count 和 evidence_types |
| 3. 验证计划 | ✅ 100% | 每张卡都有 3-step 验证流程和 effort 估计 |
| 4. 弃权优先 | ✅ 100% | 全部卡 evidence_status ∈ {hypothesis_only, insufficient_evidence}，无一"支持" |

**关键设计**：所有 60 张卡都是 hypothesis-only，不假装"知道"。这正是愿景报告要求的"Abstention-First"落地。

## 三、置信度校准

每张卡的 confidence 都被标记为 `confidence_calibration: statistical-signal`（而非 "llm-generated"），表示来源是规则+统计信号而非生成模型。这一区分让下游能：

1. **拒绝把启发式 confidence 当概率**：rule-based confidence 不满足概率公理，不能拿去做贝叶斯推理
2. **明确升级路径**：任何 hypothesis 从 `statistical-signal` → `llm-generated` → `human-reviewed` 的升级都会记入 history
3. **审计溯源**：generator + version + provenance.data_versions (sha8 of source) 三字段完整可溯

置信度分布（60 张卡）：

| 置信度区间 | 数量 |
|---|---|
| 0.3-0.4 | 0 |
| 0.4-0.5 | 79 |
| 0.5-0.6 | 21 |
| 0.6-0.7 | 0 |
| 0.7-0.85 | 0 |

## 四、首批 5 张样例卡

### HYP-20261016-0001 — litellbridge (confidence=0.55)

**假设（EN）**：There may be unrecorded research connections between robot-parts and low-altitude: 1 shared topic(s) (robotics) but zero citations between these 19955 entities suggest missed references.

**中文**：站点 robot-parts 与 low-altitude 之间存在未被记录的引用关系：两站共 19955 实体、1 个共享主题（robotics），但引用边为 0，提示存在被遗漏的学术连接。

- **引用缺口对**：robot-parts→low-altitude
- **共享主题**：robotics
- **信号类型**：citation_absence
- **证据要求**：≥3 条（citation/topic_overlap）
- **证伪条件**：If we perform OpenAlex reverse-citation queries on robot-parts entities (top 100 by citationCount) and find ZERO citing papers from low-altitude domain within the past 5 years, the hypothesis is falsified.
- **验证期限**：14 天内
- **预估工作量**：medium

### HYP-20261016-0002 — litellbridge (confidence=0.4)

**假设（EN）**：There may be unrecorded research connections between robot-parts and ai4science: 0 shared topic(s) () but zero citations between these 19952 entities suggest missed references.

**中文**：站点 robot-parts 与 ai4science 之间存在未被记录的引用关系：两站共 19952 实体、0 个共享主题（），但引用边为 0，提示存在被遗漏的学术连接。

- **引用缺口对**：robot-parts→ai4science
- **共享主题**：
- **信号类型**：citation_absence
- **证据要求**：≥3 条（citation/topic_overlap）
- **证伪条件**：If we perform OpenAlex reverse-citation queries on robot-parts entities (top 100 by citationCount) and find ZERO citing papers from ai4science domain within the past 5 years, the hypothesis is falsified.
- **验证期限**：14 天内
- **预估工作量**：medium

### HYP-20261016-0003 — litellbridge (confidence=0.4)

**假设（EN）**：There may be unrecorded research connections between bionic-ai and low-altitude: 0 shared topic(s) () but zero citations between these 19946 entities suggest missed references.

**中文**：站点 bionic-ai 与 low-altitude 之间存在未被记录的引用关系：两站共 19946 实体、0 个共享主题（），但引用边为 0，提示存在被遗漏的学术连接。

- **引用缺口对**：bionic-ai→low-altitude
- **共享主题**：
- **信号类型**：citation_absence
- **证据要求**：≥3 条（citation/topic_overlap）
- **证伪条件**：If we perform OpenAlex reverse-citation queries on bionic-ai entities (top 100 by citationCount) and find ZERO citing papers from low-altitude domain within the past 5 years, the hypothesis is falsified.
- **验证期限**：14 天内
- **预估工作量**：medium

### HYP-20261016-0004 — litellbridge (confidence=0.4)

**假设（EN）**：There may be unrecorded research connections between agent-ecosystem and low-altitude: 0 shared topic(s) () but zero citations between these 19942 entities suggest missed references.

**中文**：站点 agent-ecosystem 与 low-altitude 之间存在未被记录的引用关系：两站共 19942 实体、0 个共享主题（），但引用边为 0，提示存在被遗漏的学术连接。

- **引用缺口对**：agent-ecosystem→low-altitude
- **共享主题**：
- **信号类型**：citation_absence
- **证据要求**：≥3 条（citation/topic_overlap）
- **证伪条件**：If we perform OpenAlex reverse-citation queries on agent-ecosystem entities (top 100 by citationCount) and find ZERO citing papers from low-altitude domain within the past 5 years, the hypothesis is falsified.
- **验证期限**：14 天内
- **预估工作量**：medium

### HYP-20261016-0005 — litellbridge (confidence=0.4)

**假设（EN）**：There may be unrecorded research connections between robot-parts and privacy-computing: 0 shared topic(s) () but zero citations between these 19938 entities suggest missed references.

**中文**：站点 robot-parts 与 privacy-computing 之间存在未被记录的引用关系：两站共 19938 实体、0 个共享主题（），但引用边为 0，提示存在被遗漏的学术连接。

- **引用缺口对**：robot-parts→privacy-computing
- **共享主题**：
- **信号类型**：citation_absence
- **证据要求**：≥3 条（citation/topic_overlap）
- **证伪条件**：If we perform OpenAlex reverse-citation queries on robot-parts entities (top 100 by citationCount) and find ZERO citing papers from privacy-computing domain within the past 5 years, the hypothesis is falsified.
- **验证期限**：14 天内
- **预估工作量**：medium

## 五、后续升级路径

本批次卡是 **hypothesis-only**（无证据）。升级需要：

### 阶段 1（本周）：证据回填

对 top-20 高置信度假设，用 OpenAlex reverse-citation 做真实查询：

```bash
node operations-plan/pipeline-cited-backfill.js --target data/hypothesis-cards.json --limit 20
```

### 阶段 2（下周）：验证计划执行

把 verification_plan 转成 orchestrator job，跑完回写 history：

```bash
node agent-ecosystem/orchestrator.mjs --verify-hypotheses data/hypothesis-cards.json
```

### 阶段 3（1-2 周）：置信度校准

引入 stance-f1-harness，用真实标注数据校准 confidence：

```bash
node tools/stance-f1-harness.mjs --gold eval/stance-gold.json --pred data/hypothesis-cards.json
```

## 六、诚实性评估

| 项 | 值 | 说明 |
|---|---|---|
| 假设有据 | ✅ | 全部基于真实 citation-gaps.json 数据 |
| 假设不越权 | ✅ | 全部 status=new，无一 accepted/verified |
| 假设可证伪 | ✅ | 每张卡都有 falsification_condition 和 test |
| 假设可追溯 | ✅ | generator + version + sha8 provenance 完整 |
| 未假装"验证过" | ✅ | 全部 evidence_status=hypothesis_only/insufficient_evidence |

## 七、文件清单

- `schemas/hypothesis-card.schema.json` — JSON Schema 定义
- `tools/gen/generate-hypothesis-cards.mjs` — 生成器
- `data/hypothesis-cards.json` — 60 张卡产物

---

*Phase 8 Foundation Sprint · 100% 弃权优先 · 100% 可证伪 · 100% 可追溯*