# Harness 效率约定（基于 NVIDIA SoL-Pi）

> 来源：NVIDIA NVLabs SoL-Pi（<https://github.com/NVlabs/SoL-Pi>，MIT，2026-09 开源）
> 应用：本项目所有长跑 pipeline + `.workbuddy/tools/` 脚本 + `scripts/gh_push.py` 推送链路
> 状态：v0.1 团队约定稿

---

## 一、SoL-Pi 的核心洞察

同一个模型，放进不同 harness，效率能差一大截。NVIDIA 用**自动研究循环**（AI 研究 AI）跑了 535 个可执行环境、152 个候选方向，只留下 4 个能真正生效的机制：

| 机制 | 原理 | 效果 |
|---|---|---|
| **Action Fusion** | 编辑文件后把 test/run 合并到同一 tool call | 每轮推理直接省一整次 |
| **Online Context Compact** | 在子任务完成点决定是否压缩，不是等窗口满 | 上下文压缩从"救火"变"决策" |
| **Observation Pack** | 大 tool 结果归档到磁盘，context 里只留 handle + 摘要 | 长文件不再反复携带 |
| **Evidence-Preserving Reducer** | 便宜模型压日志，但每条引用逐条对原文核验 | 压 log 不再 lossy |

实测：vs stock Pi 省 45-49% token，vs Codex/Claude Code harness 省 35-64% token，成本降 50-54%，任务得分保留 ~94%。

**关键数字**：152 个方向 → 4 个存活（**1/40 通过率**）。这个数字最有说服力——说明"AI 研究 AI"不是所有方向都能活。

---

## 二、本项目具体落地

### 2.1 Action Fusion

**原则**：编辑操作后不要另起一轮 tool call 跑测试/验证，把验证合并进同一个动作。

```javascript
// ❌ 反模式：改完文件、等模型推理、再跑测试
await writeFile(filePath, newContent);
const result = await bash(`node --check ${filePath}`);

// ✅ Action Fusion：直接在同一 bash 调用里做 edit + check
await bash(`python -c "..." > ${filePath} && node --check ${filePath}`);
```

**本项目对应**：
- `push.mjs commit` 已经把「读工作区 → API 上传 → 建 commit」合成一次调用，别在 workflow 里再拆两步
- `abstract-backfill.js` 的每日批：EPMC→OA 抓取 + 写入 state 可以在同一 worker 里做，不用先抓完再统一写

### 2.2 Online Context Compact

**原则**：长 pipeline 每完成一个阶段，主动 `summarize + 丢弃中间产物`。不是等 context 快满才压。

```javascript
// ❌ 反模式：整条 pipeline 一个 context 到底
const allResults = [];
for (const item of 5000_items) {
  const r = await fetchAndProcess(item);
  allResults.push(r);  // 越攒越多
}
return allResults;

// ✅ 每 100 条做一次压缩
const summary = { total: 0, success: 0, miss: [] };
for (let i = 0; i < items.length; i++) {
  const r = await fetchAndProcess(items[i]);
  if (r.ok) summary.success++;
  else summary.miss.push(items[i].id);
  if (i % 100 === 0) {
    summary.lastBatchDigest = summarize(items.slice(i-99, i));
    // 中间产物丢弃，只留 summary
  }
}
return summary;
```

**本项目对应**：
- `pipeline-abstract-backfill.js` 每日 2500 cap 已经做了，但没做「阶段间压缩」——建议每 500 条压缩一次 cursor 状态
- `pipeline-cite-check.js` 49 文件 / 143 引文的扫描结果可以直接返回 summary + miss list，不返回全量 log

### 2.3 Observation Pack

**原则**：大 tool 输出（>1KB）不整块塞回 context，而是：
1. 完整结果写磁盘
2. Context 里只留 `handle + 摘要 + 页取路径`
3. 需要时按 handle 页取

```javascript
// ❌ 反模式：抓下来的整个 log 塞回 context
const log = await runLongJob();  // 10KB
return { log, summary };

// ✅ Observation Pack
const handle = await writeLogToDisk(log);  // state/logs/YYYY-MM-DD/job-123.log
return {
  handle: `state/logs/2026-09-16/job-123.log`,
  summary: summarize(log),  // 200 字摘要
  stats: { lines: log.split('\n').length, exitCode: 0 },
  // 需要时用 Read 工具按 handle 页取
};
```

**本项目对应**：
- `cite-checker` 现在返回每个 DOI 的完整 curl 响应 → 改成 `handle + status + http_code + summary`，原响应写 `state/logs/cite-check/YYYY-MM-DD/{doi}.log`
- `abstract-backfill.js` 的 miss 台账：只留 miss 摘要，完整失败响应写磁盘

### 2.4 Evidence-Preserving Reducer

**原则**：便宜模型压日志，但**每条引用必须逐条对原文核验**。这是 SoL-Pi 最有辨识度的机制。

```javascript
// ❌ 反模式：便宜模型直接总结长 log
const summary = await flashModel.summarize(longLog);

// ✅ Evidence-Preserving Reducer
const summary = await flashModel.summarizeWithCitations(longLog);
for (const citation of summary.citations) {
  const original = extractLine(longLog, citation.lineNumber);
  if (!original.includes(citation.quotedText)) {
    throw new Error(`Citation hallucination at line ${citation.lineNumber}`);
  }
}
```

**本项目对应**：
- 用 SenseNova Flash 压 `pipeline-*.js` 的运行日志时，凡是引用的数字（实体数、缺口、抽样合格率）必须回原始 log 逐条核对
- 报告生成前跑一次 `verifyCitations(report, rawLogs)` 门禁

---

## 三、约定汇总（团队规则）

1. **编辑 + 验证合并**：改完文件后，别另起一轮 tool call 跑测试。合并到一个 bash 调用里。
2. **阶段间压缩**：任何 >500 项的循环，每 100 项做 summarize + 丢弃中间产物。
3. **大结果归档**：任何 tool 输出 >1KB，写磁盘 + 返回 handle + 摘要，context 里不塞原文。
4. **引用核验**：所有被下游消费的"总结"里的数字/引文，必须回原文逐条校验，不通过则 fail-fast。
5. **通过率意识**：任何"AI 提改进方向"的循环，预期 5-10% 存活率。低于这个数说明方向太散，高于这个数说明门禁太松。

---

## 四、成本节制的量化预期

以本项目 `pipeline-abstract-backfill.js` 每日 2500 cap 为例：

| 优化项 | 预期节省 |
|---|---|
| Action Fusion（合并 EPMC→OA 抓+写） | -15% token |
| Online Compact（每 500 条压缩） | -10% token |
| Observation Pack（miss 归档） | -8% token |
| Evidence-Preserving Reducer（miss 摘要+核验） | -3% token（同时提升安全性） |
| **合计** | **-30~36% token**（对齐 SoL-Pi 报告的 45-49% 的下沿） |

---

## 五、落地清单

| # | 事项 | 位置 | 预计工时 |
|---|---|---|---|
| 1 | 本文档定稿 | ✅ `docs/harness-efficiency-conventions.md` | — |
| 2 | `pipeline-abstract-backfill.js` 阶段间压缩 | 代码 | 1 小时 |
| 3 | `cite-checker.mjs` 输出改 Observation Pack | 代码 | 1 小时 |
| 4 | `.workbuddy/tools/harness-budget.mjs`（token 消耗对比） | 工具 | 3 小时 |
| 5 | `.workbuddy/tools/verify-citations.mjs`（引用核验门禁） | 工具 | 2 小时 |

---

## 六、参考

- SoL-Pi GitHub：<https://github.com/NVlabs/SoL-Pi>（原 nvlabs.github.io/SoL-Pi/ 页面 404，改指 GitHub 仓库）
- 综述 1：https://bayesiansapien.github.io/cere-bro/agentic-systems/2026-09-11-sol-pi-harness-auto-research
- 综述 2：https://agihunt.info/en/e/1a08d0ca498af04ef82cb3d2c45
