# .proposals/ 串行 PR 闭环 Demo

> 借用母题：MergePilot / DevOrbit「串行 PR 闭环」（提案 → 审查 → 发布）
> 评审维度：Agent 能力与任务闭环（25%）| 多 Agent 协同（25%）

---

## 1. 什么是串行 PR 闭环？

评审人的问题：「你们的 agent 是全自动跑，那出问题了谁能拦住？谁能决定什么该上、什么不上？」

当前 14 站是**并行多管线全自动**，没有「提案 → 审查 → 发布」的环节。评审人会觉得缺少「人/策略的闸门」。

**最薄闭环**：把任何「新增数据源 / 新增 agent / 新增内容」先入 `.proposals/`，由 Validator Agent 按准入规则自动审查，通过后流转到 `active/`，由 Pipeline Agent 消费。

---

## 2. 目录结构

```
.genetech-14/
.proposals/                          ← 待审提案（新源 / 新 agent / 新内容）
  <proposal-id>/
    proposal.json                    ← 提案元信息
    config.json                      ← 具体配置（可选）
.active/                             ← 已通过审查、可被管线消费
  <proposal-id>/
    approved.json                    ← Validator Agent 的通过记录
.audit/                              ← 审查日志
```

---

## 3. 提案 JSON 格式

```json
{
  "id": "arxiv-cross-domain-bridge",
  "type": "new_source",              // new_source | new_agent | new_content | new_guard
  "title": "新增 arXiv 跨域桥接主题：LLM + 量子计算",
  "created_at": "2026-08-24T10:00:00Z",
  "created_by": "collector_agent",
  "motivation": "arXiv 上 LLM+quantum 论文过去 12 个月增长 3.2x，14 站尚无跨域桥接覆盖",
  "config": {
    "source": "arxiv",
    "query": "LLM+quantum OR 'large language model'+'quantum computing'",
    "max_entities": 200,
    "target_sites": ["swarmlabs", "genetech"]
  },
  "risk_assessment": {
    "data_quality": "high",
    "compliance": "open_data_ok",
    "duplication_risk": "low"
  },
  "review_status": "pending",        // pending | approved | rejected
  "reviewed_at": null,
  "reviewed_by": null,
  "review_notes": null
}
```

---

## 4. Validator Agent 自动审查流程

```
.proposals/<id>/proposal.json
        │
        ▼
  ┌─────────────────┐
  │ SourceGuard     │ ← 检查数据源合规性
  │ KnowledgeGuard  │ ← 检查准入规则
  │ PublishGuard    │ ← 检查发布容量
  └────────┬────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
   approved    rejected
     │           │
     ▼           ▼
.active/<id>/  .proposals/<id>/
approved.json   保留（记录拒绝原因）
     │
     ▼
Pipeline Agent 消费 → 数据飞轮
```

**准入规则**（来自 EVOLUTION-POLICY.md）：
- SourceGuard：源 URL 可访问、响应时间 < 30s、数据为开放许可
- KnowledgeGuard：新数据量 ≤ 2000/次、去重率 > 85%
- PublishGuard：目标站点容量有余量（当前实体数 < 上限的 90%）

---

## 5. Demo：一个真实的提案

本次随仓附一个 demo 提案：`arxiv-cross-domain-bridge`（LLM + 量子计算跨域桥接）。

### 5.1 提案文件

```bash
mkdir -p .proposals/arxiv-cross-domain-bridge
cat > .proposals/arxiv-cross-domain-bridge/proposal.json << 'EOF'
{
  "id": "arxiv-cross-domain-bridge",
  "type": "new_source",
  "title": "新增 arXiv 跨域桥接主题：LLM + 量子计算",
  "created_at": "2026-08-24T10:00:00Z",
  "created_by": "collector_agent",
  "motivation": "arXiv 上 LLM+quantum 论文过去 12 个月增长 3.2x，14 站尚无跨域桥接覆盖",
  "config": {
    "source": "arxiv",
    "query": "LLM+quantum OR 'large language model'+'quantum computing'",
    "max_entities": 200,
    "target_sites": ["swarmlabs", "genetech"]
  },
  "risk_assessment": {
    "data_quality": "high",
    "compliance": "open_data_ok",
    "duplication_risk": "low"
  },
  "review_status": "pending"
}
EOF
```

### 5.2 Validator Agent 自动审查（伪代码）

```js
// 由 Validator Agent 执行，审查通过后自动流转
async function reviewProposal(proposalId) {
  const p = JSON.parse(fs.readFileSync(`.proposals/${proposalId}/proposal.json`));

  // SourceGuard: 检查源可达
  const reachable = await ping(p.config.source);
  if (!reachable) return reject(proposalId, 'source unreachable');

  // KnowledgeGuard: 检查容量
  const targetCapacity = await getSiteCapacity(p.config.target_sites);
  if (targetCapacity.isFull) return reject(proposalId, 'site capacity full');

  // PublishGuard: 检查去重
  const dupRate = await estimateDupRate(p.config.query);
  if (dupRate < 0.85) return reject(proposalId, 'duplication too high');

  // 通过
  await fs.mkdir(`.active/${proposalId}`, {recursive:true});
  fs.writeFileSync(`.active/${proposalId}/approved.json`,
    JSON.stringify({
      ...p,
      review_status: 'approved',
      reviewed_at: new Date().toISOString(),
      reviewed_by: 'validator_agent',
      guards_passed: ['SourceGuard', 'KnowledgeGuard', 'PublishGuard']
    }));
}
```

---

## 6. 与现有系统的衔接

| 现有模块 | 衔接方式 | 优先级 |
|----------|----------|--------|
| backfill-engine-v2.js | 新源必须从 `.active/` 读取 | P1 |
| data-flywheel.js | 新增 agent 类型先入 `.proposals/` | P1 |
| build-site.mjs | 新增内容页面先入 `.proposals/` | P2 |

---

## 7. 评审叙事

**一句话**：「14 站每个新源、新 agent、新内容都先经过提案审查，再进生产管线。」

**对比无提案项目**：
- 评审「数据飞轮新增一个源你怎么保证质量？」 → 我们有 SourceGuard + KnowledgeGuard + PublishGuard 三道闸门
- 评审「agent 出问题了怎么回滚？」 → `.proposals/` 记录所有变更，`.active/` 记录所有通过的变更，任意时间可 diff

---

## 8. 落地清单

| # | 动作 | 工时 |
|---|------|------|
| 1 | 建 `.proposals/` + `.active/` 目录 | 5min |
| 2 | 写入 demo 提案 `arxiv-cross-domain-bridge` | 10min |
| 3 | 在 Validator Agent 中实现 `reviewProposal()` 函数 | 1h |
| 4 | 在 backfill-engine-v2.js 中改为从 `.active/` 读取源列表 | 30min |
| 5 | 在 audit-logger 中记录 review 事件 | 15min |
