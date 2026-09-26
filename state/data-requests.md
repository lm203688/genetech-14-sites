# GeneTech 14站知识引擎 — 下游项目数据需求队列

## 用途
本文件是**下游独立项目**（蜂群科研数据 / RoboParts / AIShield / 付费外部客户 / 未来新增项目）提交数据需求的**唯一公共写入接口**。

- 消费方通过 MCP 工具 `submit_request` 提交需求
- 管理员通过 MCP 工具 `retrieve_requests` 浏览、审批、交付
- 自动化 pipeline 定期扫描状态为 `pending_review` 的需求，触发定向采集
- 交付后，消费方通过 `GET /v1/requests/{request_id}/export` 拉取结果

---

## 数据结构

```json
[
  {
    "request_id": "req_abc123",          // v4 UUID，全局唯一
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
      "formats": ["json", "bibtex"]
    },
    "delivery_preference": "pull",        // pull | push | subscribe
    "assigned_key": null,                 // 审批通过后的 API key（null = 未审批）
    "fulfilled_at": null,
    "fulfillment_notes": null,
    "export_url": null,                   // 交付产出 URL（pull 模式下指向 data/export/...）
    "rejection_reason": null
  }
]
```

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

### submit_request（新增）
- 输入：project_name, contact, purpose, priority, spec（含 domains/keywords/time_range/min_confidence/target_count/formats）
- 输出：request_id, status, assigned_key（若立即审批通过）
- 幂等：相同 project_name + 相同 spec 指纹在 7 天内不重复提交

### retrieve_requests（新增）
- 输入：status_filter, project_name, limit, offset
- 输出：请求列表 + 统计摘要
- 支持按状态筛选，默认返回所有 pending_review

---

## 自动化扫描
- `ops-extra.yml` 的 `extra-ops` job 每小时运行一次 `tools/edge-builder.py`（见 edge-refresh.yml）
- 定时扫描 `pending_review` 请求，触发定向 `pipeline-openalex-expand.js` / `pipeline-arxiv-hot-scan.js`
- 交付结果写入 `data/export/<request_id>.json`

---

## 合规
- 本队列仅服务基因/科技垂直领域数据
- 不涉及军事/生物武器/个人隐私数据
- 所有导出文件保留审计日志（request_id → export_url 映射）
