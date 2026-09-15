# Tech Radar · L1-L5 自主权分级

> 来源：Theseus Labs RSI 五级框架（arXiv 2609.11873，2026-09）
> 应用：SwarmLabs Tech Radar（signal → candidate → promote → effect）
> 状态：v0.1 建议稿，落地后进入 `pipeline-tech-adoption.js` 输出契约

---

## 一、为什么需要这个维度

现在的 Tech Radar 有四个阶段和一个「五态板」，但**没有回答"这个候选的自主权该多大"**。同一句"接入一个新 embedding 模型"，可以是：

- L1（改一行 env 变量、跑现有 pipeline 看效果）
- L2（写新 pipeline 步骤、加入调度器）
- L3（自己抓一批新数据来训练/评估）
- L4（灰度上线到生产端点、自动切换）
- L5（改进 Tech Radar 本身用来判定这个候选的规则）

L1 和 L5 是两种**性质完全不同**的自主权——如果不区分，要么全部走人工审批（效率低），要么全部放行（安全失控）。L1-L5 分级就是把这个模糊的"自主"具象成 5 档可判定的边界。

---

## 二、五档定义（本项目约定）

| 级别 | 名称 | 人类投入 | 智能体闭环 | SwarmLabs 典型例子 | 门禁 |
|---|---|---|---|---|---|
| **L1** | 执行自主 | 设计任务 + 环境 + 更新策略 | 执行、更新 | 改 env 变量、跑 PoC 脚本、跑现有 pipeline | 无（自动） |
| **L2** | 策略自主 | 设计任务 + 环境 | 执行 + **设计更新策略** + 更新 | 新增 pipeline 步骤、加新评估指标 | 一次人工审批（`reviewed_by` 非空） |
| **L3** | 经验获取自主 | 设计试验环境 | 规划经验获取 + 执行 + 设计策略 + 更新 | 智能体自己找新数据源 / 自己设计抓取规则 | 白名单 + 一次审批 |
| **L4** | 环境适应自主 | 只设边界（灰度比例、回滚阈值） | 规划经验 + 与环境交互 + 设计策略 + 更新 | 灰度上线到生产端点、自动回滚、自动切换 | 边界 + 灰度 + 独立回滚预案 |
| **L5** | 递归继承自主 | 只设边界 | **改进改进系统** + 其余所有 | 智能体改 Tech Radar 判定规则、写新 pipeline 骨架 | `STRICT_AUDIT=1` + 独立 reviewer + 二次审批 |

---

## 三、自主权决策树

```
新候选进入 Tech Radar
   │
   ├─ 只涉及配置文件/env 变更？              → L1
   │
   ├─ 涉及新增 pipeline 步骤但不碰生产端点？  → L2
   │
   ├─ 涉及新数据源或新抓取规则？             → L3
   │
   ├─ 涉及生产端点/流量/支付/用户可见路径？  → L4
   │
   └─ 涉及改进 Tech Radar 判定规则本身？     → L5
```

**判断规则**：从下往上判，命中最靠下的档（自主权最高），因为 L5 隐含 L1-L4 全部能力，L4 隐含 L1-L3，以此类推。

---

## 四、Schema 扩展（`pipeline-tech-adoption.js` 输出）

### 4.1 新增字段

```jsonc
{
  // === 原有字段保留 ===
  "candidate": "...",
  "score": 0.87,
  "poc_result": "...",

  // === 新增：自主权分级 ===
  "autonomyLevel": "L2",                    // L1 | L2 | L3 | L4 | L5
  "autonomyRationale": "新增 pipeline 步骤，不碰生产端点",
  "autonomyGuardrails": [
    "必须在 poc/ 下运行，禁止写 state/ 或 reports/",
    "运行时间上限 30 分钟",
    "失败率 > 20% 自动回滚到上一个通过版本"
  ],

  // === 新增：L2 及以上必填 ===
  "reviewedBy": "lm203688",                 // L2+ 必填
  "reviewedAt": "2026-09-16T07:30:00Z",
  "reviewNote": "同意 L2，因为改动局限在 pipeline-tech-adoption 内",

  // === 新增：L5 必填 ===
  "strictAudit": true,                      // L5 时 true
  "independentReviewer": "..."              // L5 时必填，与 reviewedBy 不同人
}
```

### 4.2 门禁常量

```javascript
// operations-plan/pipeline-tech-adoption.js 头部添加
const AUTONOMY_LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5'];
const AUTONOMY_GUARDRAILS = {
  L1: ['poc_only', 'no_state_write', 'timeout_30min'],
  L2: ['poc_only', 'no_state_write', 'timeout_30min', 'human_review_required'],
  L3: ['whitelist_sources_only', 'human_review_required', 'no_production_traffic'],
  L4: ['canary_release', 'auto_rollback_on_failure_rate_gt_20pct', 'boundary_enforced'],
  L5: ['strict_audit_required', 'independent_reviewer_required', 'human_double_approval']
};
const STRICT_AUDIT = process.env.STRICT_AUDIT === '1';
```

### 4.3 落地方式

`pipeline-tech-adoption.js` 在评估候选后，调用一个新的辅助函数：

```javascript
function classifyAutonomy(candidate, pocConfig) {
  if (pocConfig.modifiesRadarRules) return { level: 'L5', rationale: '改进 Tech Radar 判定规则本身' };
  if (pocConfig.touchesProductionEndpoint) return { level: 'L4', rationale: '涉及生产端点/流量' };
  if (pocConfig.needsNewDataSource) return { level: 'L3', rationale: '需要新数据源' };
  if (pocConfig.addsPipelineStep) return { level: 'L2', rationale: '新增 pipeline 步骤' };
  return { level: 'L1', rationale: '仅配置/env 变更' };
}
```

L5 候选在 `STRICT_AUDIT=1` 时会自动 fail-fast，等 `independentReviewer` 手动写入后再入库。

---

## 五、对 goai_2026 的价值

这些实验室原报告里最实用的一句：**"HCI 剩余空间越大的领域，RSI 的杠杆效应越强。"**

我们的 Tech Radar 恰好落在 **软件工程领域**，HCI ≈ 60.4（剩余空间大）。这可以直接写成 goai_2026 申报材料的一段：

> 「SwarmLabs Tech Radar 已按 Theseus Labs RSI 五级框架落地 L1-L4，L5 有 STRICT_AUDIT 双重门禁。这一分级让系统既能自动化处理低自主权候选（L1 每轮处理数百个），也能在触及改进系统本身的候选上保持人工控制——这正是 goai_2026 提出的"可信执行 / 多 Agent 协作 / 知识累积"三方向的交集。」

---

## 六、后续演进

- v0.1（本文档）：定义 + schema
- v0.2（待落）：pipeline-tech-adoption.js 加 `classifyAutonomy()` + 输出字段
- v0.3（远期）：autonomyLevel 累积的候选分布可视化，进 `command-center/aggregate-status.js` 面板
- v0.4（远期）：L5 候选自动触发一个独立的 reviewer agent（对齐 OpenAI Agents API 的 Guardrails 概念）

---

## 七、参考

- Theseus Labs RSI 原报告：https://arxiv.org/html/2609.11873v1
- 项目页：https://theseus-labs-rsi.github.io/
- 中文综述：https://3g.china.com/act/news/10000169/20260915/49743035.html
- 英文综述：https://theaiinsider.tech/2026/09/14/chinese-researchers-map-five-steps-toward-ai-that-can-improve-itself
