# 多 Agent 编排决策手册

> 综合来源：OpenAI Agents API（platform.openai.com）+ OpenAI Responses Multi-agent（developers.openai.com）+ ElizaOS Runtime + SoL-Pi auto-research loop
> 应用：SwarmLabs MCP 编排、GeneTech 14站 pipeline、aishield 版本门禁扫描

---

## 一、三种编排模式（OpenAI 官方）

### 1.1 Handoff —— 专家接手

```
用户 → Triage Agent → Billing Agent（接手）
                              │
                              ↓
                          回复用户
```

- **谁拥有最终答复**：目标 agent（Billing Agent）
- **什么时候用**：triage → specialist 分流场景
- **实现**：`Agent({ handoffs: [billingAgent, refundAgent] })`
- **本项目的对应**：`pipeline-intelligence.js` 遇到技术动态 → 交接给 tech 分析 agent

### 1.2 Agent as Tool —— 专家当函数

```
用户 → Main Agent
         │
         ├─ 调用 summarize_agent（拿结果，控制权不转移）
         ├─ 调用 translate_agent（拿结果，控制权不转移）
         └─ 组装最终回复（主 agent 拥有）
```

- **谁拥有最终答复**：主 agent
- **什么时候用**：主 agent 是编辑/协调者，专家只是"查一下"
- **实现**：`agent.asTool({ toolName, toolDescription })`
- **本项目的对应**：`pipeline-abstract-backfill.js` 里的每个 EPMC→OA 抓取是"子调用"，主 pipeline 保留所有结果的所有权

### 1.3 Subagent Fanout —— 并行分派

```
用户 → Root Agent (/root)
              │
              ├─ /root/researcher（并行）
              ├─ /root/reviewer（并行）
              └─ /root/tester（并行）
              │
              ↓
        Root 汇总
```

- **谁拥有最终答复**：root agent
- **`max_concurrent_subagents`**：默认 3，推荐不超过 3
- **什么时候用**：任务可并行分解且各分支独立
- **本项目的对应**：`pipeline-intelligence.js` 可 fanout 3 个竞品并行扫

---

## 二、决策树（怎么选）

```
新任务需要多 agent？
   │
   ├─ 只需要一个 agent？                    → 别拆，就一个 agent
   │
   ├─ 需要"分流后接手"？（triage 场景）    → Handoff
   │
   ├─ 主 agent 需要"借助手干活"？（编辑）  → Agent as Tool
   │
   └─ 多个任务可并行、互不依赖？            → Subagent Fanout（≤3 并发）
```

**OpenAI 原话**：「Start with one agent whenever you can. Add specialists only when they materially improve capability isolation, policy isolation, prompt clarity, or trace legibility.」

**本项目翻译**：拆 agent 前，先问：拆了之后 prompt 更清晰？policy 更隔离？trace 更好查？三个都不满足就**别拆**。

---

## 三、SwarmLabs 现有 pipeline 的升级路径

| 现有 pipeline | 当前形态 | 建议升级 |
|---|---|---|
| `pipeline-intelligence.js`（竞品监控） | 单 agent 串行扫 5 个竞品 | **Fanout** 3 并发 + 每竞品一个 subagent |
| `pipeline-abstract-backfill.js`（摘要回填） | 单 agent + cursor | 保持 Agent as Tool（cursor 归主） |
| `pipeline-cite-check.js`（引文核验） | 单 agent 并行 curl（CITE_CONCURRENCY=8） | 已经是 fanout 模式，保持 |
| `pipeline-tech-adoption.js`（技术采纳） | 单 agent 评估 + PoC | 评估 L1/L2 保持单 agent；L3+ 用 Agent as Tool 分派验证 |
| `pipeline-geo-promotion.js`（GEO 推广） | 单 agent 生成 + 发布 | **Handoff**：生成阶段 → 发布 agent 接手 |
| MCP server 多工具协作 | 各工具独立 | 加 `orchestration_mode` 参数，暴露 handoff/as_tool/fanout 三选一 |

---

## 四、关键工程细节（可直接抄到我们的代码）

### 4.1 并发上限

```javascript
// 所有 fanout 场景
const MAX_CONCURRENT_SUBAGENTS = 3;
```

超过 3 收益递减，且失败爆炸半径大。

### 4.2 WebSocket vs HTTP

- **WebSocket** 推荐给 tool-heavy / 长任务：function output 可以边到边回
- **HTTP** 每轮所有活跃 agent 结束后才返回
- 我们所有 pipeline 默认 HTTP（简单），只有 `pipeline-geo-promotion.js`（生成 + 发布 + 反馈循环）值得升 WebSocket

### 4.3 Background 模式

超过 HTTP 超时（默认 10 分钟）的任务，必须开 `background: true`：
- `pipeline-abstract-backfill.js` 每日批 cap=2500，超过 10 分钟 → **必须开**
- `pipeline-cite-check.js` 49 文件并发 8 curl，通常 < 5 分钟，不用
- `pipeline-data-accumulation.js` 全量回填 975MB → 必须开

### 4.4 Guardrails（并行安全网）

```javascript
// 参考 OpenAI Agents SDK 结构
const inputGuardrails = [
  { name: 'topic_filter', threshold: 'block_if_off_topic' },
  { name: 'pii_detector', threshold: 'block_if_pii' },
];
const outputGuardrails = [
  { name: 'hallucination_check', threshold: 'tripwire' },
  { name: 'format_validator', threshold: 'retry_on_invalid' },
];
```

本项目的对应：
- cite-checker 就是 input guardrail（跑之前验 DOI）
- STRICT_CITE 就是 output guardrail（跑之后 tripwire）
- 可以再加 `format_validator`：报告输出必须符合 `UPDATE_DISCIPLINE.md` 的 patch-never-regenerate 契约

### 4.5 Agent 作为 Tool 的坑（OpenAI 官方踩过的）

1. **异步工具必须加 async**——不加 Runner 内部会报 coroutine 错误
2. **子 agent 无共享上下文**：调研 agent 不知道写手 agent 写了什么——这是刻意设计，靠主 agent 中转
3. **子 agent 每次启动都是新 LLM 请求**：一个主 agent + 2 子 agent 一次完整流程约 3000-5000 tokens

---

## 五、ElizaOS 的补充：Provider / Evaluator / Action 三件套

ElizaOS 把 agent 内部拆成：

```
Action    = 可执行动作（发消息、发币、生图）
Provider  = 构造 LLM 上下文（返回 {values, data, text}）
Evaluator = 对话后学习（提取事实、更新记忆）
```

**我们该借鉴的**：

- `Provider` 的返回结构 `{values, data, text}`——text 给 LLM，data 给程序，values 给模板变量。这个三段式比我们现在 cursor.json 的散乱状态好。
- `Evaluator` 概念——每次 pipeline 跑完应该有一个 evaluator 提取"这次学到了什么"，写回 state。我们现在缺这层。

**落地建议**：新建 `operations-plan/providers/` 目录，每个 provider 一份 `{get(): {values, data, text}}` mjs 文件。

---

## 六、SoL-Pi 的补充：Auto-Research Loop

SoL-Pi 不是一种编排模式，而是一种**元编排**——让 AI 提出 harness 改进方向，跑验证，留幸存者。

**流程**：
1. 提 152 个候选方向
2. 每个方向跑一次独立 loop
3. 幸存者合并进 harness
4. 只留 4 个（1/40 通过率）

**我们该做的**：每两周跑一次「小 SoL-Pi」——让便宜 agent（SenseNova Flash）提 10-20 个 pipeline 改进方向，跑验证，留 1-3 个。

---

## 七、OpenMausBot 的补充：Driver SPI

每 provider 一文件、注册一行——加 provider 不改核心。

**OpenMausBot 具体做法**：
```
server/drivers/
  ├── claude.mjs      # Claude Code CLI
  ├── codex.mjs       # OpenAI Codex CLI
  ├── grok.mjs        # Grok CLI
  └── registry.mjs    # 一行注册
```

`server/contracts.ts` 定义 Driver 接口，每个 driver 实现它。加新 provider = 一文件 + 一行注册。

**本项目的对应**：`agent-registry.json` 里的 agent 列表可以升级到 SPI：
```
operations-plan/agents/
  ├── intelligence.mjs
  ├── tech-adoption.mjs
  ├── abstract-backfill.mjs
  ├── cite-check.mjs
  └── registry.mjs
```

---

## 八、Karpathy nanochat 的补充：report.md 卡片

一次训练跑完自动生成 Markdown 报告卡，游戏化指标。

**本项目的改造**：所有 `report-*.json` 都补 `report-*.md`：

```markdown
# pipeline-abstract-backfill · 2026-09-16

🎯 目标 30k → ✅ 完成 39,226 (131%)
🚀 本轮产量 +1,675
📊 抽样质量 10/10 high
🔋 剩余缺口 102,999 (27.8%)
```

`docs/competition-2026/TECH-DEEP-DIVE.md` 也可以加一张游戏化卡片。

---

## 九、Godogen 的补充：视觉 QA 环

独立 Gemini Flash agent 只看截图，防止代码 agent 自证清白。

**本项目的改造**：新增 `pipeline-site-visual-qa.js`：
1. Playwright 截图 15 个代表页
2. SenseNova U1 视觉模型比对"应有布局"
3. 抓：布局崩坏 / 图片丢失 / 导航断链 / z-fighting

这是 cite-checker（内容正确性）和 site-health-check（端点健康）之外的第三层。

---

## 十、参考

- OpenAI Agents API 官方：https://openai.com/index/introducing-the-agents-api/
- OpenAI 多 agent 指南：https://developers.openai.com/api/docs/guides/responses-multi-agent
- OpenAI 编排模式：https://platform.openai.com/docs/guides/agents/orchestration
- Agents SDK 实战：https://blog.csdn.net/baidu_32885171/article/details/159758225
- ElizaOS Runtime：https://deepwiki.com/elizaOS/docs
- SoL-Pi：https://nvlabs.github.io/SoL-Pi/
- OpenMausBot：https://github.com/milind-soni/OpenMausBot
- Karpathy nanochat：https://github.com/karpathy/nanochat
- Godogen：https://github.com/htdt/godogen
