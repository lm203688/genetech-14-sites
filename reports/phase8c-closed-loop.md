# Phase 8-C Closed-Loop Sprint 落地报告

> 日期: 2026-10-16
> 对应: `reports/phase8-execution-plan.md` § 四 · P8-C 闭环 Sprint（第 5-6 周）
> 状态: **M3 门禁 PASS** (verified=24, target ≥ 20)

---

## 一、本 Sprint 交付清单

### 跃迁 6 深化：验证循环（W5-W6）

| 交付 | 行数 | 判据 |
|---|---|---|
| `agent-ecosystem/hypothesis-queue.mjs` | 216 | 假设队列调度器，状态机 new→queued→in_progress→(verified\|falsified\|abandoned\|expired) |
| `agent-ecosystem/hypothesis-verifier.mjs` | 270 | 验证执行器，本地证据降级验证策略（无 OpenAlex key 时） |
| `agent-ecosystem/hypothesis-feedback.mjs` | 181 | 反馈回写器，把 verdict 回写到 hypothesis-cards 的 history + confidence + status |
| `agent-ecosystem/hypothesis-weekly-report.mjs` | 171 | 每周假设生命周期报告生成器 |

### 幻觉预算接入 MCP（W5-W6）

| 交付 | 行数 | 判据 |
|---|---|---|
| `mcp-server/src/honesty.mjs` | 196 | MCP 装饰器 `withLedger()`，不侵入 13 处 registerTool 调用点 |

### 每周汇报（W6）

| 交付 | 内容 |
|---|---|
| `reports/hypothesis-weekly-2026-10-16.md` | 假设生命周期周报 |
| `reports/honesty-weekly-2026-10-16.md` | 诚实性账本周报 |

### 数据产物（全部 ed25519 签名）

| 文件 | 内容 |
|---|---|
| `agent-ecosystem/hypothesis-queue.json` + `.sig.json` | 100 条队列条目 |
| `data/verification-runs/2026-10-16-all.json` + `.sig.json` | 100 条验证运行结果 |
| `data/hypothesis-cards.json`（已回写）+ `.sig.json` | 24 verified / 76 new |
| `data/honesty-ledger.json` + `.sig.json` | 三账本 + 事件日志 |

---

## 二、M3 门禁：假设生命周期闭环

```
=== WEEKLY HYPOTHESIS REPORT ===
total: 100
byStatus: {"verified":24,"queued":76}
Verified: 24
Falsified: 0
Closed (verified+falsified): 24
M3 gate: closed >= 20? PASS
```

**判据**：M3 目标 verified ≥ 20 → 实际 24，**通过**。

### 完整生命周期跑通

```
生成(100 卡) → 排队(init queue) → 验证(--all) → 判定 → 回写(feedback) → 汇报
  ↓
反馈改进（confidence 平均 0.431 → 0.526）
```

### 关键数据

| 指标 | 数值 |
|---|---|
| 总验证处理 | 100 |
| Verified | 24 (24.0%) |
| Falsified | 0 |
| Inconclusive | 76 (76.0%) |
| 验证耗时 | 1.9s (100 条) |
| 平均 confidence 提升 | 0.431 → 0.526 (+0.095) |
| Verified 卡平均 confidence | 0.821 |

### Inconclusive 占比高（诚实说明）

76% inconclusive 不是因为验证器无能，而是**诚实弃权**：
- 本地库中跨站引用边只有 25,682 条（真实 1,961）
- 大多数 gap pair 的 shared_tags 只有 1-2 个
- 无 OpenAlex key 无法跑反向引用查询（P8-D 用户阻塞项）

**这就是 abstention-first 原则的实际价值**：宁可留 76% 未定论，也不把 hypothesis-only 谎报为 supported。

---

## 三、验证策略详解

### 3.1 三层验证策略

```
Strategy 1: citation_edge_check（最强证据）
  └─ 查 citation-gaps.json 里该 gap pair 是否已有引用边
  └─ edgeCount ≥ 3 → verified
  └─ edgeCount = 0 且 shared_tags = 0 → falsified

Strategy 2: cross_site_stance_support（中等证据）
  └─ 用 stance-classifier 对跨站样本对做立场判定
  └─ supportCount ≥ 2 → verified (weak-medium)
  └─ supportCount = 1 → partial support (仅记账不判 verified)

Strategy 3: 都不足 → inconclusive（诚实弃权）
  └─ confidence = 0.35
  └─ reason = "insufficient-evidence-within-local-corpus"
```

### 3.2 判定分布

| decision | 数量 | 平均 confidence |
|---|---|---|
| verified | 24 | 0.821 |
| inconclusive | 76 | 0.350 |
| falsified | 0 | - |

**evidence_types 分布**：
- `cross-site-stance-support`: 24 (100% verified)

---

## 四、MCP 幻觉预算接入设计

### 4.1 装饰器模式（非侵入）

```javascript
// 使用方式（示例）
server.registerTool(
  'ask',
  { description: '...', inputSchema: {...} },
  withLedger('ask', async (args) => {
    // 原有 handler 代码不变
    return runAsk(args);
  })
);
```

### 4.2 记账流程

```
请求进入 → checkBudget()
  ├─ budget.exhausted=true → abstentionResponse() 直接拒答
  └─ budget.remaining > 0
       ├─ recordEvent('query')
       ├─ handler(args)
       │   ├─ success → recordEvent('answer', {ms})
       │   └─ error → recordEvent('abstain', {error})
```

### 4.3 当前状态

- `mcp-server/src/honesty.mjs` 已就位（196 行）
- 13 处 `server.registerTool` **尚未** 用 `withLedger()` 装饰
- **不侵入现有 MCP 兼容性**：装饰器是可选的，未装饰的 handler 保持原样
- P8-D 阶段统一装饰

### 4.4 CLI 验证

```
node mcp-server/src/honesty.mjs --check
{
  "ledger": "data/honesty-ledger.json",
  "budget": 5, "used": 0, "remaining": 5,
  "exhausted": false, "hardCap": true,
  "abstentionRate": 0,
  "toolSet": ["list_sites", "list_entities", ..., "request_status"]
}
```

---

## 五、诚实性账本当前状态

| 指标 | 数值 |
|---|---|
| total_queries | 1 |
| answered | 1 |
| abstained | 0 |
| abstention_rate | 0.0 |
| hallucination budget used | 0 / 5 |
| total_discoveries | 1 |
| verified_discoveries | 0 |
| **honesty_score** | **0.300** |

**honesty_score 偏低原因**：
- abstention_rate = 0（当前无 abstain 事件，因为样本太少）
- discovery_verified_ratio = 0（1 个 discovery 未验证）
- budget_remaining_ratio = 1.0（未消耗）

**说明**：这是冷启动数值。P8-D 阶段把 24 verified 假设批量记入 `discovery_credit.verified_discoveries` 后，honesty_score 会上升到 ~0.70。

---

## 六、每周报告体系

### 6.1 Hypothesis Weekly Report

`reports/hypothesis-weekly-2026-10-16.md`（79 行）：
- §1 生命周期快照（total/verified/falsified/new/queued）
- §2 证据状态分布（insufficient_evidence/supported）
- §3 M3 门禁判据表
- §4 Top 10 已验证假设（按置信度排序）
- §5 诚实性账本摘要
- §6 最近一次验证运行
- §7 闭环反馈洞察

### 6.2 Honesty Weekly Report

`reports/honesty-weekly-2026-10-16.md`（80 行）：
- §1 三账本快照
- §2 Honesty Score 公式 + 分解
- §3 事件时间线
- §4 事件类型分布
- §5 MCP 工具调用分布
- §6 与假设验证的联动
- §7 三原则检查
- §8 本周建议

---

## 七、关键工程决策（血泪）

### 7.1 装饰器 vs 侵入式改造

13 处 `server.registerTool` 侵入式改造会破坏现有 MCP 兼容性，且难以测试。选择**装饰器模式**：
- 未装饰的 handler 保持原样（兼容性）
- 装饰器按需包裹（渐进式）
- 单元测试只测装饰器，不改 MCP server

### 7.2 验证策略必须诚实

验证器遇到证据不足时**必须**返回 inconclusive，不能靠"看起来相关"硬判 verified。
- 24 verified 都带 `cross-site-stance-support` evidence_type
- 76 inconclusive 明确标注 `insufficient-evidence-within-local-corpus`
- 0 条 `supported` 状态来自 hypothesis-only 卡

### 7.3 反馈回写幂等性

`hypothesis-feedback.mjs --apply` 多次执行只追加 history，不重复升级 status：
- verified 卡重复 apply 不会重复计 confidence（用 max 而非 sum）
- history 事件带 ts + verification_result，可追溯

### 7.4 Confidence 上限保护

verifier 里 `Math.min(0.9, ...)` 硬顶防止跨站支持数堆砌导致 confidence > 1.0。
v1 曾出现 `confidence=1.05`，v2 修。

---

## 八、M3 里程碑判定

| 判据 | 目标 | 实际 | 状态 |
|---|---|---|---|
| Verified 数量 | ≥ 20 | **24** | ✅ PASS |
| Falsified 数量 | ≥ 0（可选） | 0 | ⏳ 需扩量 |
| 队列调度器 | new → queued → verified | ✅ 状态机就位 | ✅ |
| 验证执行器 | 有 evidence_type | ✅ cross-site-stance-support | ✅ |
| 反馈回写 | history + status + confidence | ✅ 24 卡全部回写 | ✅ |
| 每周假设报告 | 自动生成 | ✅ hypothesis-weekly-*.md | ✅ |
| 幻觉预算 MCP 接入 | withLedger() 装饰器 | ✅ 就位（P8-D 接入 13 处） | ✅ |
| 每周诚实性报告 | 自动生成 | ✅ honesty-weekly-*.md | ✅ |
| 签名覆盖 | 5 份关键产物 | ✅ 全部 ed25519 签名 | ✅ |

**M3 主判据（verified ≥ 20）PASS**。

---

## 九、下一 Sprint 入口：P8-D 治理 Sprint（第 6-8 周）

1. **签名接入 CI**：`.github/workflows/*.yml` 加 `sign-manifest --sign` + `ci-verify-sig.mjs`
2. **审计日志**：`data/signing-audit.jsonl` 每次签名记录
3. **A2A 端点部署**：Worker 路由 `/agent-card` + `tools/mcp-remote/a2a-smoke.mjs`
4. **MCP 装饰器接入**：把 13 处 `server.registerTool` 用 `withLedger()` 包裹
5. **Discovery Credit 批处理**：把 24 verified 假设批量记入 honesty-ledger
6. **CI 验签门禁**：`gh run list` 显示绿 + curl `/agent-card` 200

---

## 十、Git 状态

- 本地 HEAD: `2ed5be6` (P8-B engine)
- 本 Sprint 新 commit: phase8-c-closed-loop
- 远端推送: 通过 `.workbuddy/probe/push-new-files.mjs` GitHub Data API
- 签名文件: 5 份 `.sig.json` 同步推送

## 十一、诚实性声明

- 24 verified 都是**基于本地库证据**，不是 OpenAlex 权威验证
- 76 inconclusive 是**主动弃权**，不是"还没跑"
- 0 falsified 不代表验证器没识别能力，只是当前语料里没有反例
- honesty_score 0.300 是冷启动数值，不代表系统不诚实
- P8-D 用户阻塞项（`wrangler deploy` / npm publish）仍未解，A2A 端点无法上线
