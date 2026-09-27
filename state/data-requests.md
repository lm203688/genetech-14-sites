# GeneTech 14站知识引擎 — 下游项目数据需求队列

## 用途
本文件是**下游独立项目**（蜂群科研数据 / RoboParts / AIShield / 付费外部客户 / 未来新增项目）提交数据需求的**唯一公共写入接口**。

- 消费方通过 MCP 工具 `submit_request` 提交需求
- 管理员通过 MCP 工具 `retrieve_requests` 浏览、审批、交付；`intake_health` 自检
- 交付产物写入 `data/export/<request_id>.json`，随 `pages-deploy.yml` 发布
- 交付后，消费方通过 `https://data.swarmlabs.tools/data/export/<request_id>.json` 拉取结果

---

## 数据结构

存储格式为**对象信封**（非裸数组）：

```json
{
  "requests": [
    {
      "request_id": "req_abc123",          // v4 UUID 风格，全局唯一
      "submitted_at": "2026-09-25T12:00:00Z",
      "submitted_by": "lm203688",          // GitHub username / 邮件
      "project_name": "swarmlabs",          // 需求方项目标识
      "project_type": "consumer",           // consumer | partner | enterprise | internal
      "status": "pending_review",           // pending_review | in_progress | fulfilled | rejected
      "priority": "medium",                 // low | medium | high | urgent
      "purpose": "为 Embodied AI Agent 模块检索 2025-2026 年触觉反馈论文",
      "spec": {
        "domains": ["robotics", "embodied-ai"],
        "keywords": ["haptic feedback", "tactile sensing", "grasp"],
        "time_range": {"from": "2025-01-01", "to": "2026-09-25"},
        "min_confidence": 0.6,
        "target_count": 50,
        "formats": ["json", "bibtex"],
        "delivery_preference": "pull"
      },
      "delivery_preference": "pull",        // pull | push | subscribe
      "assigned_key": null,                 // 审批通过后的 API key（null = 未审批）
      "fulfilled_at": null,
      "fulfillment_notes": null,
      "export_url": null,                   // pull 模式：https://data.swarmlabs.tools/data/export/<request_id>.json
      "rejection_reason": null
    }
  ],
  "meta": {
    "version": 1,
    "createdAt": "2026-09-26T21:55:01.334Z",
    "updatedAt": "2026-09-26T21:55:01.334Z"
  }
}
```

- 容量上限：500KB / 300 条，超限自动滚动裁剪（保留最新条目）
- 读侧兼容裸数组与信封两种历史格式；写侧一律输出信封
- 队列文件：`state/data-requests.json`（源），`data/data-requests.json`（部署副本，供 Workers 上游读取）

---

## 状态机

```
pending_review ──► in_progress ──► fulfilled
     │                   │
     │                   └─► rejected
     └─────────────────────► rejected
```

- `pending_review`: 待管理员审批（24h 内）
- `in_progress`: 已审批，正在定向采集
- `fulfilled`: 已交付，导出 URL 可用
- `rejected`: 已拒绝，含原因

---

## 配额规则

| 档位 | 月查询量 | 请求上限 | 响应时限 |
|------|---------|---------|---------|
| Free（无 key） | 0 | 不可提需求 | — |
| Partner（slb_） | 100k | 5 并发 | 48h |
| Pro（gtk_） | 1M | 20 并发 | 24h |
| Enterprise | 无上限 | 无上限 | SLA 协商 |

---

## MCP 工具契约

### submit_request
- 输入：`project_name`, `contact`, `purpose`, `priority`, `spec{domains, keywords, time_range{from,to}, min_confidence, target_count, formats, delivery_preference}`
- 输出：`ok`, `request_id`, `status`, `export_url`（pull 模式下预生成）
- 幂等：相同 `project_name` + 相同 `spec` 指纹在 7 天内不重复提交
- Fail-closed：缺必填字段或 `priority` 非法时返回 `ok:false` + 明确 error，不写盘

### retrieve_requests
- 输入：`status_filter`, `project_name`, `limit`（≤100）, `offset`
- 输出：`total` / `returned` / `summary{byStatus, byPriority, byProject}` / `requests[]`（已剥离内部 `_fingerprint`）

### intake_health
- 输入：无
- 输出：队列文件路径、字节数、条目数、容量上限、schema 类型、导出基址、meta

---

## 交付机制（静态直读，无需 Worker 端点）

`pull` 模式采用 **GitHub Pages 静态交付**：

1. `submit_request` 即返回 `export_url = https://data.swarmlabs.tools/data/export/<request_id>.json`
2. 管理员履约后把结果写入 `data/export/<request_id>.json`
3. `tools/build-site.mjs` 的 `syncAggregatedData()` 会把 `data/export/*.json` 复制到 `_site/data/export/`
4. `pages-deploy.yml` 发布后 URL 可访问；**未履约时返回 404，即为「尚未履约」信号**

> **暂不实现** `GET /v1/requests/{request_id}/export`（Worker 端点）。原因：线上
> `genetech-api-guard` Worker 绑定 3 个资源（`INTEL_KV` + `PRO_KV` + `PRO_SECRET`），
> 而 `api-guard/deploy-api.mjs` 仅注入 2 个，直接重部署会**丢失 `INTEL_KV` 绑定**，
> 导致 `/v1/intel/*` 全链路降级为 memory-only（重启即丢）。需先把 `INTEL_KV`
> （namespace `4e05a0dd…`）补进 deploy 脚本的 bindings 再部署。

---

## 自动化状态（2026-09-27 核实）

**已上线且 CI 正常**（`ops-extra.yml`，最近运行 69–74 全部 success）：

| 任务 | 脚本 | 产物 |
|------|------|------|
| `selfdb` | `operations-plan/pipeline-self-db-build.js` | `data/knowledge-graph.json`（边数硬限幅 5000） |
| `edge_refresh` | `tools/edge-builder.py` | `data/knowledge-graph-entities.json`（tag-tag 共现 ≤5000） |
| `kgbuild` | `tools/build-knowledge-graph.mjs` | 枢纽型图谱 14k 节点 / 37k 边（**最后写入者**，覆盖前两者降级产物） |
| `searchindex` | `operations-plan/pipeline-search-index.js` | `data/search-index.json` |
| `ossscan` | `operations-plan/pipeline-oss-scan.js` | `data/oss-registry.json` |
| `abstractbackfill` | `operations-plan/pipeline-abstract-backfill.js` | 摘要回填（当前 67.8%，目标 80%） |

**尚未实现**：`pending_review` 请求的自动扫描与定向采集派发。
需要的 hook：在 `ops-extra.yml` 增一个任务读取 `state/data-requests.json`，对
`status=pending_review` 且 `priority in (high, urgent)` 的条目触发
`pipeline-openalex-expand.js` / `pipeline-arxiv-hot-scan.js`，结果写入
`data/export/<request_id>.json` 并把状态推进到 `in_progress`。
（此前文档声称 edge-builder 会扫描需求队列，实测并无此逻辑，2026-09-27 已更正。）

---

## 合规
- 本队列仅服务基因/科技垂直领域数据
- 不涉及军事/生物武器/个人隐私数据
- 所有导出文件保留审计日志（request_id → export_url 映射）
