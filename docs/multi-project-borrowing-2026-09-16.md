# 多项目借鉴扫描 · 2026-09-16

> 扫描范围：Karpathy / Qwen UI Agent / Theseus Labs RSI / Ponytail / Eliza / SoL-Pi / HeYClicky / OpenMausBot / OpenAI Agents API / Godogen / LingBot-World 2.0 / 及 4 项模糊项（TeamAI / IndieHackerTools / Inkos / AliQoderWake）
>
> 方法：WebSearch + WebFetch 逐项目一手信息；对齐到本项目当前主线（Tech Radar 闭环 / SwarmLabs MCP 编排 / GeneTech 14站 GEO / aishield 版本门禁）；只采纳能落到具体文件/代码/prompt 的东西，纯概念不入表。
>
> 已做过、不再重复：HeYClicky → `point-guide.js`（已上线）、HyperResearch → `cite-checker` + `UPDATE_DISCIPLINE.md`（已上线）。

---

## 一、总表（按 ROI 排序）

| # | 项目 | 一句话价值 | 对本项目 ROI | 采纳形态 | 优先级 |
|---|---|---|---|---|---|
| 1 | **Theseus Labs RSI** L1-L5 | 递归自我改进的五级自主性框架，L1→L5 每级有人工/智能体分工 | **极高**：Tech Radar 五态机缺一层「自主性维度」，可直接升维；同时是 goai_2026 可信执行方向的核心叙事 | 文档 + Schema 扩展 | **P0** |
| 2 | **OpenAI Agents API** | Handoffs vs Agents-as-tools vs Subagent fanout 三种模式；MCP 一等公民 | **高**：SwarmLabs MCP 多 Agent 编排缺决策树；直接给 goai_2026 用 | 设计手册 | **P0** |
| 3 | **SoL-Pi (NVIDIA)** | 4 个 harness 效率机制（Action Fusion / Online Compact / Observation Pack / Evidence-Preserving Reducer），token -45~49% | **高**：直接映射到本项目所有长跑 pipeline 的 token 经济学 | 运维约定 + 工具 | **P0** |
| 4 | **Ponytail** | YAGNI 七阶梯；14+ 编码 agent 可插 | **中高**：直接装到本机 agent，减少我们做脚本时的过度工程 | 装一个 skill | **P1** |
| 5 | **Karpathy nanochat** | 全自动训练 pipeline + report.md 报告卡 + 游戏化指标 | **中**：`report.md` 卡片模式可搬到我们所有 pipeline 报告输出 | 借鉴输出格式 | **P1** |
| 6 | **ElizaOS** | Character/Provider/Evaluator/Action 四件套 + BM25 记忆 | **中**：SwarmLabs agent 记忆架构参考 | 设计参考 | **P2** |
| 7 | **Godogen** | 视觉 QA 环：独立 Gemini Flash agent 只看截图，防止代码 agent 自证清白 | **中**：SwarmLabs site 部署后可加截图回看环 | 借鉴 loop | **P1** |
| 8 | **Qwen3-VL Computer Use Agent** | 视觉定位 UI 元素、跨应用编排 | **中低**：目前 heyclicky 已覆盖轻量场景；重场景再评估 | 备选 | **P3** |
| 9 | **OpenMausBot** | Driver SPI（每 provider 一文件）+ fan-in event bus + routines/webhook | **中低**：SwarmLabs agent-registry 可借鉴 driver SPI 结构 | 结构参考 | **P2** |
| 10 | LingBot-World 2.0 | 具身世界模型，1 小时无衰减 720p/60fps | **无直接用途**（我们不搞具身） | 归档 | — |
| 11 | TeamAI / IndieHackerTools / Inkos / AliQoderWake | 搜索信号模糊，无清晰开源代码库或 API 契约 | **无** | 跳过 | — |

---

## 二、P0 采纳：Theseus Labs RSI 的 L1-L5 框架

### 2.1 原始框架（arXiv 2609.11873，这些实验室 + SJTU，2026-09 首发）

| 级别 | 名字 | 人类投入 | 智能体闭环 | 本项目对应 |
|---|---|---|---|---|
| L1 | 执行自主 | 设计任务、环境、更新策略 | 执行、更新 | 现在 `pipeline-tech-adoption.js` 就是 L1 |
| L2 | 策略自主 | 设计任务、环境 | 执行、**设计更新策略**、更新 | 智能体自己写 pipeline，人审一次 |
| L3 | 经验获取自主 | 设计环境 | 规划经验获取、执行、设计策略、更新 | 智能体自己抓新数据源 |
| L4 | 环境适应自主 | 只设边界 | 规划经验、**与环境交互**、设计策略、更新 | 智能体上线后自适应（如 CF 端点漂移自动切换） |
| L5 | 递归继承自主 | 只设边界 | **改进改进系统**、设计经验、与环境交互、设计策略、更新 | 智能体自己写新 pipeline |

原报告还给了 HCI（Headroom-Closed Index）指标来量化「离人类天花板还剩多远」——软件工程 HCI 约 60.4（空间最大），前沿数学 86.4（空间最小）。这个「空间大 → RSI 杠杆大」的逻辑，可以直接写进 goai_2026 申报材料。

### 2.2 应用到 SwarmLabs Tech Radar

现在的 Tech Radar 有四个阶段（signal → candidate → promote → effect）和一个五态板，但没有回答「**这个候选的自主权该多大**」——这是 L1-L5 补上的关键维度。

```
                    ┌──────────────────────────────────────────┐
                    │   Tech Radar 候选的自主权决策树         │
                    │                                          │
   signal ──▶  ┌─ L1 执行：候选由智能体直接跑 PoC，人只看结果   │
               │                                              │
               ├─ L2 策略：候选涉及新增 pipeline 步骤，        │
               │         智能体出设计，人审批后跑               │
               │                                              │
               ├─ L3 经验：候选涉及新数据源或新抓取源，        │
               │         智能体规划采集，人只设白名单            │
               │                                              │
               ├─ L4 环境：候选可能影响生产端点/流量/支付，    │
               │         智能体灰度 + 自动回滚，人设边界         │
               │                                              │
               └─ L5 递归：候选涉及改进 Tech Radar 本身，     │
                        必须人二次审批 + 独立 reviewer 复核     │
```

### 2.3 落到代码：Schema 扩展

给 `pipeline-tech-adoption.js` 的候选 JSON 加两个字段：

```jsonc
{
  "candidate": "...",
  "autonomyLevel": "L2",                    // L1 | L2 | L3 | L4 | L5
  "autonomyRationale": "新增 pipeline 步骤，但不碰生产端点",
  "autonomyGuardrails": [
    "必须在 POC_DIR 下运行，禁止写 state/ 或 reports/",
    "运行时间上限 30 分钟",
    "失败率 > 20% 自动回滚"
  ],
  // ... 原有字段保留
}
```

L5 候选必须触发 `STRICT_AUDIT=1`（新约定，类似 `STRICT_CITE=1`）——强制人读设计稿、跑一次独立 reviewer、签字入库。

### 2.4 落地清单

- [ ] `docs/tech-radar-autonomy-l1-l5.md`（本文档 §二 展开成独立文件）
- [ ] `pipeline-tech-adoption.js` 加 `autonomyLevel` 输出字段（1 小时）
- [ ] `pipeline-intelligence.js` 加候选来源标注：竞品监控出的新方向一律先标 L1
- [ ] `ops.yml` 加环境变量 `STRICT_AUDIT`（对齐 `STRICT_CITE`）
- [ ] goai_2026 申报材料加「L1→L4 已落地、L5 有严格门禁」章节

---

## 三、P0 采纳：OpenAI Agents API 的三种编排模式

### 3.1 三种模式（OpenAI 官方指南）

| 模式 | 场景 | 谁拥有最终答复 |
|---|---|---|
| **Handoff** | 专家接手对话，比如 triage → billing | 目标 agent |
| **Agent as Tool** | 主 agent 保持控制权，把专家当函数调用 | 主 agent |
| **Subagent fanout** | 主 agent 分解成 N 个独立任务并行跑（`max_concurrent_subagents=3`） | 主 agent |

官方明确「能一个 agent 就不要拆」——拆得太多 prompt 和 trace 会变复杂。

### 3.2 映射到 SwarmLabs 现有管线

- `pipeline-abstract-backfill.js` = Agent as Tool（cursor 归主 pipeline 所有）
- `pipeline-cite-check.js` = Agent as Tool（每个 DOI 是子调用）
- `pipeline-intelligence.js` = 单 agent（目前无拆）→ **可升级到 fanout**：不同竞品并行扫
- `pipeline-tech-adoption.js` = 单 agent → **可升级到 handoff**：PoC 阶段交接给专门的验证 agent

### 3.3 关键工程细节（可直接抄）

- **`max_concurrent_subagents: 3`** 是默认值也是推荐值——我们所有 fanout 场景都别超过 3
- **WebSocket 优于 HTTP** for tool-heavy workflows：function output 可以边到边回，不用等整轮结束
- **`background: true`** 处理超过 HTTP 超时的长任务——我们的 pipeline 大多适合这个
- **Guardrails 是并行安全网**：input guardrail（跑之前）+ output guardrail（跑之后），可以 tripwire 直接 halt

### 3.4 落地清单

- [ ] `docs/multi-agent-orchestration-playbook.md`：把三种模式写成决策树
- [ ] `pipeline-intelligence.js` 拆竞品监控为 fanout（3 并发）
- [ ] SwarmLabs MCP server 加 `orchestration_mode` 参数，暴露 handoff/as_tool/fanout 三选一

---

## 四、P0 采纳：SoL-Pi 的 4 个 harness 效率机制

### 4.1 四个机制（NVIDIA NVLabs，MIT，2026-09 开源）

| 机制 | 原理 | 我们项目里的对应位置 |
|---|---|---|
| **Action Fusion** | 编辑后把 test/run 合到同一 tool call，省一轮推理 | `pipeline-*.js` 里改完文件后直接跑验证，别分两步 |
| **Online Context Compact** | 在子任务完成时决定要不要压缩，不是等窗口满才压 | 长 pipeline 每完成一个阶段就 summarize + 丢弃中间产物 |
| **Observation Pack** | 大 tool 结果归档到磁盘，context 里只留 handle + 摘要，按需页取 | cite-checker 结果 / abstract-backfill 结果 全走这个模式 |
| **Evidence-Preserving Reducer** | 便宜模型压日志，但每条引用必须逐条对原文核验 | 我们在报告生成时用 SenseNova Flash 压 log，但引用数字要回原文校验 |

实测数据：vs stock Pi 省 45-49% token，vs Codex/Claude Code harness 省 35-64% token，成本降 50-54%，任务得分保留 ~94%。**在 535 个可执行环境上跑了 152 个方向，只留 4 个**——这是最有说服力的自证。

### 4.2 我们该怎么做

**短期（本周可落）**：
- 修改 `pipeline-abstract-backfill.js`：把每次 miss 日志写入 `state/miss-ledger/` 归档，日志摘要回传而不是完整 log → 直接省 40%+ token
- `cite-checker` 报告输出改成「handle + 摘要 + 页取路径」→ 未来审计可以按需拉回完整原始 log
- `ops.yml` 里所有长跑 pipeline 在阶段间加 `context_compact: true` 标记（约定，实际压缩靠 agent 自己）

**中期（一个月）**：
- 建一个 `.workbuddy/tools/harness-budget.mjs`：跑任何 pipeline 前后对比 token 消耗，报告 top-3 冗余
- 每周一次 SoL-Pi 风格的「auto-research」：让一个便宜 agent 提 harness 改进方向，跑 5-10 个候选验证后留 1-2 个

### 4.3 落地清单

- [ ] `docs/harness-efficiency-conventions.md`：把 4 机制写成团队约定
- [ ] `pipeline-abstract-backfill.js` 归档改造（1-2 小时）
- [ ] `cite-checker.mjs` 输出改 handle + 页取（1 小时）
- [ ] `.workbuddy/tools/harness-budget.mjs`（周末做）

---

## 五、P1 采纳：Ponytail · Karpathy nanochat · Godogen

### 5.1 Ponytail（DietrichGebert，137k stars）

YAGNI 七阶梯，装到 14+ 编码 agent。**我们该做的**：`npx` 装一个到本机的 Qoder / ZCode。命令：

```bash
# 到 ~/.qoder/ 或 ~/.zcode/ 装 plugin
# 或者作为 AGENTS.md 直接写进项目
```

好处：我们写脚本时不会被 LLM 拉去写 300 行的过度封装。Ponytail 有可复现 benchmark：12 个 feature ticket 在真实 FastAPI+React 模板上 -54% 代码行、-22% token、-20% 成本、-27% 时间，安全 tier 100%。

### 5.2 Karpathy nanochat（7.9k stars）

值得抄的**不是**代码，是 `report.md` 卡片模式：一次训练跑完自动生成 Markdown 报告卡，把每个环节的指标游戏化呈现（分数、进度、达标判定）。

**我们该做的**：把 `operations-plan/reports/` 下所有 `report-*.json` 都补一个 `report-*.md` 版本，格式：

```markdown
# pipeline-abstract-backfill · 2026-09-16

🎯 目标: 30k 实体  →  ✅ 完成 39,226 (131%)
🚀 本轮产量: +1,675 实体
📊 抽样质量: 10/10 high
🔋 剩余缺口: 102,999 (~27.8%)
```

比 JSON 好读 10 倍。

### 5.3 Godogen（htdt，5.5k stars）

关键洞察：**代码 agent 有天然偏见，会自证清白**。Godogen 的解法是**另开一个只读截图的 Gemini Flash agent 做视觉 QA**——它看不到代码，只对比截图 vs 参考图，抓 z-fighting / 浮空物体 / 物理爆炸 / 网格状布局。

**我们该做的**：SwarmLabs 站部署后，加一个 `pipeline-site-visual-qa.js`——Playwright 截图 15 个代表页，交给 SenseNova U1 视觉模型比对「应有布局」，抓布局崩坏、图片丢失、导航断链。这是 cite-checker（内容正确性）和 site-health-check（端点健康）之间的第三层。

---

## 六、P2 采纳：ElizaOS · OpenMausBot

### 6.1 ElizaOS

四件套架构：**Character**（人格）/ **Provider**（LLM 上下文构造）/ **Evaluator**（对话后学习）/ **Action**（可执行动作）。

- 记忆系统：BM25 语义搜索 + 分层记忆（工作记忆 / 房间记忆 / 全局记忆）+ workingMemory LRU 清理
- Provider 的返回结构固定为 `{values, data, text}`——text 是给 LLM 读的，data 是给程序读的

**可借鉴**：SwarmLabs 现在的 agent 记忆是散在 `state/` 里各种 cursor.json。可以统一成 ElizaOS 风格：`providers/` 目录，每个 provider 一份 `{get(): {values, data, text}}`。

### 6.2 OpenMausBot

Driver SPI 设计（每 provider 一文件、注册一行）——加 provider 不需要改核心。

**可借鉴**：`agent-registry.json` 里的 agent 列表可以升级成 SPI 模式，每 agent 一个 mjs 文件。

---

## 七、P3 / 无直接采纳

### 7.1 LingBot-World 2.0（蚂蚁灵波）

具身世界模型，720p/60fps 1 小时无衰减。对我们没直接用途——除非未来做具身智能。归档即可。

### 7.2 Qwen3-VL Computer Use Agent

现在 heyclicky 覆盖的轻量指向引导已够。等 SwarmLabs 需要「让 AI 自动操作自己网站做端到端测试」时再评估接入。

### 7.3 模糊项（搜不到清晰目标）

- **TeamAI**：可能是多个同名项目，无强信号
- **IndieHackerTools**：像工具目录，非技术资产
- **Inkos**：搜索无清晰命中
- **AliQoderWake**：用户本身在用 Qoder，无需再借鉴

---

## 八、执行顺序（本周做完）

| # | 事项 | 交付物 | 预计工时 |
|---|---|---|---|
| 1 | 本文档定稿 | `docs/multi-project-borrowing-2026-09-16.md` | ✅ 本文件 |
| 2 | L1-L5 独立文档 + schema | `docs/tech-radar-autonomy-l1-l5.md` | 30 分钟 |
| 3 | 多 agent 编排决策树 | `docs/multi-agent-orchestration-playbook.md` | 30 分钟 |
| 4 | Harness 效率约定 | `docs/harness-efficiency-conventions.md` | 30 分钟 |
| 5 | `pipeline-tech-adoption.js` 加 `autonomyLevel` 字段 | 代码改动 | 1 小时 |
| 6 | cite-checker 输出改 handle + 页取 | 代码改动 | 1 小时 |
| 7 | Ponytail 装到本机 Qoder/ZCode | `~/.qoder/` 或项目 `AGENTS.md` | 15 分钟 |
| 8 | 全部推 GitHub Pages + API 复验 | 远端 HEAD 推进 | 10 分钟 |

---

## 九、未处理 / 显式跳过

- **P0 端点重绑**（license/api.swarmlabs.tools）：仍待用户在 CF Dashboard 手动重绑，本轮不动
- **HPE 博客死链**（cite-checker 唯一真死链）：待修，STRICT_CITE 因此仍不开
- **专利包提交**：申请人/发明人信息在用户账号侧，本轮不动
- **cite-checker STRICT_CITE=1 阻断**：等 HPE 死链修完再开
- **heyclicky 全站铺开**：`point-guide.js` 已上线，其余页面接入可等 P0 结束再做

---

*扫描耗时：1 轮 WebSearch × 11 项 + 1 轮项目内代码摸底。所有引用链接可回溯。*
