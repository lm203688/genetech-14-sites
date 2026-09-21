# GeneTech Intel API — 消费方对接指南

**版本**: 1.0.0-sprint1  
**上线时间**: 2026-09-21  
**端点**: `https://api.swarmlabs.tools/v1/intel/*`  
**鉴权**: Pro Key (`gtk_` 前缀)，`/v1/intel/health` 免鉴权

---

## 1. 架构概览

```
┌──────────────────────────────────────────────────────┐
│ 消费方（SwarmLabs / RoboParts / HealthLens / ...）     │
│   - 提交 DemandSpec（一份 JSON）                       │
│   - 选择交付模式（pull / push / subscribe）             │
└──────────────────────────────────────────────────────┘
                        ↓ POST /v1/intel/demand
┌──────────────────────────────────────────────────────┐
│  L1  Intake    解析 DemandSpec，生成 demand_id         │
│  L2  Analysis  匹配现有 30 站 × 13k 实体索引           │
│  L3  Collection 关键词搜索 + 打分排序                   │
│  L4  Delivery  pull（本次已上线）/ push（Sprint 2）      │
│  L5  Ops       demand 记录持久化（KV）+ consumer 索引   │
└──────────────────────────────────────────────────────┘
```

---

## 2. 数据源

| 数据源 | 覆盖 | 更新频率 |
|--------|------|----------|
| 30 站结构化实体索引 | ~13,333 高置信实体 / 30 领域 | 每日 pipeline |
| arXiv 论文 | 待接入（Sprint 2） | 每日 |
| GitHub OSS 项目 | 待接入（Sprint 2） | 每日 |
| HuggingFace 模型 | 待接入（Sprint 2） | 每周 |

**当前 Sprint 1 仅查询本地索引**。外部源扫描在 Sprint 2 上线。

---

## 3. 端点

### 3.1 `GET /v1/intel/health` — 健康检查（免鉴权）

```bash
curl https://api.swarmlabs.tools/v1/intel/health
```

```json
{
  "status": "ok",
  "service": "GeneTech Intel API",
  "version": "1.0.0-sprint1",
  "endpoints": ["/v1/intel/demand (POST)", "/v1/intel/demand/{id} (GET)"],
  "auth": "Pro Key (gtk_) required except /v1/intel/health"
}
```

### 3.2 `POST /v1/intel/demand` — 提交需求（需 Pro Key）

**请求体**（DemandSpec）：

```json
{
  "consumer": "swarmlabs",
  "priority": "high",
  "query": {
    "sites": ["embodied-ai", "biotech"],
    "keywords": ["exoskeleton", "CRISPR", "protein folding"],
    "sources": ["arxiv", "pubmed"],
    "time_window": "30d",
    "min_confidence": 0.5,
    "max_entities": 500
  },
  "delivery": {
    "mode": "pull",
    "format": "json",
    "webhook": null,
    "frequency": "daily"
  }
}
```

**字段说明**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `consumer` | string | ✅ | 消费方标识（如 `swarmlabs`, `roboparts`） |
| `priority` | string | ❌ | `high` / `medium` / `low`，默认 `medium` |
| `query.sites` | string[] | ❌ | 限定站点（30 站 slug 列表） |
| `query.keywords` | string[] | ❌ | 关键词（至少 1 个才有结果） |
| `query.sources` | string[] | ❌ | 限定来源（`arxiv`, `pubmed`, `github` 等） |
| `query.time_window` | string | ❌ | 时间窗（`30d`, `90d`, `all`），默认 `30d` |
| `query.min_confidence` | number | ❌ | 最低置信度（0.0-1.0），默认 0 |
| `query.max_entities` | number | ❌ | 最大返回数（1-5000），默认 500 |
| `delivery.mode` | string | ❌ | `pull` / `push` / `subscribe`，默认 `pull` |
| `delivery.format` | string | ❌ | `json` / `markdown` / `csv`，默认 `json` |
| `delivery.webhook` | string | ❌ | push/subscribe 模式的回调 URL |
| `delivery.frequency` | string | ❌ | `daily` / `weekly` / `once`，默认 `daily` |

**响应**：

```json
{
  "demand_id": "dm_1a0c1f69273_2ccfcf48",
  "status": "completed",
  "coverage": {
    "local": true,
    "entityCount": 13333,
    "generatedAt": "2026-09-19T05:53:56.431Z",
    "sourceSites": 30
  },
  "results": [...],
  "results_total": 2,
  "delivery_mode": "pull",
  "created_at": "2026-09-21T03:15:57.171Z",
  "_persistence": "unavailable_kv_limit",
  "_note": "KV 存储暂不可用（日写入限额），本次结果已直接返回。demand_id 无法持久化，GET 将返回 404。"
}
```

> **注意**：当 KV 持久化可用时，响应中返回 `results_preview`（前 5 条）+ `demand_id`，消费方通过 GET 拉取完整结果。当 KV 不可用时，`results` 字段直接返回完整结果（cap 200 条）。

### 3.3 `GET /v1/intel/demand/{demand_id}` — 拉取完整结果（需 Pro Key）

```bash
curl -H "Authorization: Bearer gtk_xxx" \
  https://api.swarmlabs.tools/v1/intel/demand/dm_1a0c1f69273_2ccfcf48
```

返回完整的 demand 记录（含 `results.matches` 全量数据）。

---

## 4. 交付模式

### 4.1 Pull（拉取式）— 已上线

消费方轮询 GET 端点获取增量结果。

```javascript
// 消费方伪代码
const demand = await fetch('https://api.swarmlabs.tools/v1/intel/demand', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${PRO_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    consumer: 'swarmlabs',
    query: { keywords: ['exoskeleton', 'soft robotics'], time_window: '30d' },
    delivery: { mode: 'pull' },
  }),
}).then(r => r.json());

// 保存 demand_id，后续通过 GET 拉取
await fetch(`https://api.swarmlabs.tools/v1/intel/demand/${demand.demand_id}`, {
  headers: { 'Authorization': `Bearer ${PRO_KEY}` },
}).then(r => r.json());
```

### 4.2 Push（推式）— Sprint 2

引擎完成扫描后主动 POST 到消费方 webhook。消费方需提供公网可达的回调 URL。

### 4.3 Subscribe（订阅式）— Sprint 2

消费方一次配置，引擎每日 pipeline 跑完后自动 diff 推送。

---

## 5. Pro Key 申请

Pro Key 由 GeneTech 引擎签发，格式 `gtk_<base64url>.<hexsig>`，有效期 365 天。

**申请方式**：联系 GeneTech 团队或通过 license 页面购买。

**免费配额**：每个 consumer 每月 3 次查询。  
**Pro+（¥99/月）**：无限拉取 + 3 个订阅。  
**Enterprise（议价）**：直连数据源 + 定制扫描 + 专属 KV 存储。

---

## 6. 30 站领域列表

当前可查询的 30 个领域站点：

| # | slug | 领域 |
|---|------|------|
| 1 | biotech | 生物技术 |
| 2 | climate | 气候科学 |
| 3 | quantum | 量子计算 |
| 4 | embodied-ai | 具身智能 |
| 5 | ai-safety | AI 安全 |
| 6 | agent-ecosystem | Agent 生态 |
| 7 | neuromorphic | 神经形态计算 |
| 8 | agritech | 农业科技 |
| 9 | spatial-computing | 空间计算 |
| 10 | robotics | 机器人 |
| 11 | bionics | 仿生学 |
| 12 | genomics | 基因组学 |
| 13 | materials | 材料科学 |
| 14 | energy | 能源 |
| 15 | pharma | 制药 |
| 16 | neuroscience | 神经科学 |
| 17 | ocean | 海洋科学 |
| 18 | astronomy | 天文学 |
| 19 | chemistry | 化学 |
| 20 | physics | 物理学 |
| 21 | ecology | 生态学 |
| 22 | microbiology | 微生物学 |
| 23 | biophysics | 生物物理 |
| 24 | synthetic-biology | 合成生物学 |
| 25 | nanotech | 纳米技术 |
| 26 | 3d-bioprinting | 3D 生物打印 |
| 27 | wearable-med | 可穿戴医疗 |
| 28 | bioinformatics | 生物信息学 |
| 29 | computational-bio | 计算生物学 |
| 30 | medtech | 医疗技术 |

---

## 7. 错误码

| HTTP | error | 说明 |
|------|-------|------|
| 400 | bad_request | 请求体格式错误或必填字段缺失 |
| 401 | unauthorized | 缺少 Pro Key |
| 403 | forbidden | Pro Key 无效或过期（含 `detail` 字段） |
| 404 | not_found | demand_id 不存在或已过期（30d TTL） |
| 405 | method_not_allowed | HTTP 方法不允许 |
| 500 | internal_error | 服务器内部错误（含 `stack` 字段） |
| 503 | index_unavailable | 搜索索引不可用 |

---

## 8. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0-sprint1 | 2026-09-21 | 初版：POST/GET demand，pull 模式，本地索引查询 |
| 1.1.0-sprint2 | 待上线 | push 模式，arXiv/GitHub 外部源扫描 |
| 1.2.0-sprint3 | 待上线 | subscribe 模式，消费方管理面板 |
