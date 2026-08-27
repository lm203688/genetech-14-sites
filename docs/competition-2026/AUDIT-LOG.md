# 审计日志体系设计

> 借用母题：LabOps Guard / RevGuard / CodeNotary「可信交付 + 全链路审计」
> 评审维度：安全/合规（10%）| Agent 能力与任务闭环（25%）| 工程落地（20%）

---

## 1. 背景

当前状态：CI 失败才开 Issue，agent 动作（拉取/转换/发布/付费）无全链路日志。评审人会问：「如果飞轮出了问题，你能不能 5 分钟内定位是哪一步、哪个 agent、什么输入？」——当前答不上来。

本设计在 **不改现有代码** 的前提下，约定一个 JSONL 日志格式 + 一份独立参考实现，后续由 Pipeline Agent 按约定 emit。

---

## 2. 日志规范

### 2.1 文件位置

```
public repo : 不提交（.gitignore）
本地构建   : audit/YYYY-MM-DD.jsonl  （按天轮转）
线上 CI    : 通过 GITHUB_STEP_SUMMARY 输出到 Actions run 页面
```

### 2.2 单条日志结构（JSONL）

```json
{
  "ts":        "2026-08-24T10:30:00.000Z",     // 时间戳（ISO 8601, UTC）
  "run_id":    "gh_20260824-103000-abc123",     // 本次运行全局唯一 ID
  "actor":     "collector_agent",               // 谁产生的日志
  "stage":     "fetch",                         // 生命周期阶段
  "action":    "source_request",                // 具体操作
  "site":      "swarmlabs",                     // 涉及站点
  "status":    "ok|warn|error|skip",
  "latency_ms": 1240,                           // 可选：耗时
  "input": { "query": "LLM+quantum", "source": "arxiv" },  // 受控字段，不写原始全文
  "output": { "count": 23, "dedup": 4 },        // 结果摘要
  "error": null,                                // 错误消息/堆栈（error 时必填）
  "guards": [                                  // 触发了哪些 Guard 校验
    {"name":"SourceGuard","decision":"allow","reason":"rate ok"}
  ],
  "provenance": {                               // 时间机器溯源
    "source_url": "https://export.arxiv.org/api/query?id_list=...",
    "fetch_at":  "2026-08-24T10:29:58.000Z",
    "transform_version": "backfill-engine@v2"
  }
}
```

**字段约束**：
- `input` / `output` 只写结构摘要，**禁止**写完整文章正文或 API 响应原文（防泄漏 + 控体积）
- `guards` 是 Guard 矩阵落地时的钩子，即使 Guard 未全部上线，字段保留
- `provenance` 与 TIME-MACHINE.md 对齐，实体溯源用

### 2.3 日志级别（用 status 字段区分，不用文件分级别）

| status | 含义 | 聚合频率 |
|--------|------|---------|
| ok | 正常完成 | 秒级 emit |
| warn | 降级/重试/跳过 | 秒级 emit |
| error | 失败但已恢复 | 秒级 emit |
| skip | 主动跳过 | 秒级 emit |

### 2.4 生命周期阶段（stage 枚举）

```
fetch → parse → normalize → validate → enrich → bridge → publish → audit
```

---

## 3. 各 Agent 的 emit 约定

| Agent | emit 节点 | status 触发 |
|-------|----------|------------|
| CollectorAgent | 每个数据源请求 + 响应 | error = 连接失败/超时 |
| NormalizerAgent | 每条实体转换 | warn = 字段缺失 |
| ValidatorAgent | 每条实体校验 | error = 校验失败 |
| PublisherAgent | 每次发布批次 | error = 写文件失败 |
| RepairAgent | 每次修复操作 | warn = 降级修复 |
| KnowledgeGuard | 每次策略判定 | error = 触发淘汰 |

---

## 4. 聚合与查询

### 4.1 日聚合

```
audit/daily-YYYY-MM-DD.json      // 当天汇总
```

内容：
```json
{
  "date": "2026-08-24",
  "total_events": 12840,
  "by_status": {"ok": 12500, "warn": 250, "error": 70, "skip": 20},
  "by_agent": {"collector": 4000, "normalizer": 2500, ...},
  "by_stage": {"fetch": 3000, "publish": 2000, ...},
  "top_errors": [
    {"msg": "arXiv timeout", "count": 32, "actor": "collector_agent"},
    {"msg": "site missing entity", "count": 18, "actor": "validator_agent"}
  ]
}
```

### 4.2 查询命令（CI / 本地用）

```bash
# 查某 agent 的 error
jq 'select(.actor=="collector_agent" and .status=="error")' audit/2026-08-24.jsonl

# 查某 stage 的耗时分布
jq 'select(.stage=="publish") | .latency_ms' audit/2026-08-24.jsonl | sort -n | jq -s '[min, (map(.)|add/length|floor), max]'

# 查 Guard 拦截次数
jq 'select(.status=="skip") | .guards[]' audit/2026-08-24.jsonl
```

---

## 5. 参考实现

独立的 opt-in 工具：`tools/audit-logger.mjs`（不接入 CI，需 pipeline 显式 require）。

使用方式（在 pipeline 内）：

```js
import {AuditLogger} from './tools/audit-logger.mjs';

const log = new AuditLogger({actor: 'collector_agent', runId: process.env.GITHUB_RUN_ID || 'local'});

log.emit({stage:'fetch', action:'source_request', site:'swarmlabs', status:'ok', input:{query:'LLM+quantum'}});
log.emit({stage:'fetch', action:'source_request', site:'healthlens', status:'error', error:'timeout', latency_ms: 5000});
await log.flush();
```

---

## 6. 与现有系统的衔接

| 现有模块 | 接入点 | 优先级 |
|----------|--------|--------|
| operations-plan/backfill-engine-v2.js | 每个 source fetch 前后 | P1 |
| operations-plan/data-flywheel.js | 阶段间 emit | P1 |
| tools/build-site.mjs | 发布后 emit | P2 |
| unified-license/verify.js | 验证结果 emit（脱敏） | P2 |
| api-guard | 拦截事件 emit | P2 |

---

## 7. 评审叙事

**一句话**：「14 站每个 agent 的每个操作都有一条不可篡改的时间戳日志，5 分钟内可定位任何异常。」

**对比无 audit log 项目**：
- 评审「你们的 agent 失败了你知不知道？」 → 我们能给出当日 top-5 error 和触发 agent
- 评审「飞轮漂移你怎么发现的？」 → audit log 能回溯到具体 batch 和输入
- 评审「你说过你们用 Guard 矩阵，有证据吗？」 → 每条日志都有 guards 字段记录决策

---

## 8. 落地清单

| # | 动作 | 工时 |
|---|------|------|
| 1 | 创建 `audit/` 目录 + `.gitignore` 规则 | 10min |
| 2 | `tools/audit-logger.mjs` opt-in 实现 | 30min |
| 3 | backfill-engine-v2.js 接入 emit | 30min |
| 4 | CI GITHUB_STEP_SUMMARY 聚合输出 | 20min |
| 5 | docs/ 写审计看板截图（可选） | 1h |

**参考实现已提供：`../tools/audit-logger.mjs`**
