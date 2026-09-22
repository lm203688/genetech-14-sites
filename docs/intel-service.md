# GeneTech Intel API · 服务化情报中台

> **版本**：1.0.0-sprint1.1 | **上线**：2026-09-21 | **端点**：`https://api.swarmlabs.tools/v1/intel/*`
> **面向**：SwarmLabs / RoboParts / HealthLens / 其他任意需要情报收集的项目
> **一句话**：消费方提交一份 JSON（"我要什么"），引擎匹配 30 站 × 13k 实体索引，返回结构化结果

---

## 一、你适合接入吗

如果符合任意一条：

- 需要一个稳定的**科研论文 / 代码库 / 生物医学 / 前沿科技**情报源
- 需要**按领域或关键词**周期性扫描，而不是自己爬
- 需要在多个项目间**共享同一份数据基础设施**
- 需要一个**独立计费、可吊销、可审计**的 API key

---

## 二、架构概览

```
┌────────────────────────────────────────────────────────────┐
│  消费方（SwarmLabs / RoboParts / HealthLens / ...）          │
│   - 提交 DemandSpec（一份 JSON 描述"我要什么"）                │
│   - 选择交付模式（pull / push / subscribe）                   │
└────────────────────────────────────────────────────────────┘
                              ↓ POST /v1/intel/demand
┌────────────────────────────────────────────────────────────┐
│  L1  Intake     解析 DemandSpec，生成 demand_id               │
│  L2  Analysis   匹配现有 30 站 × 13k 高置信实体索引             │
│  L3  Collection 关键词搜索 + 打分排序（coverage × 0.7 +        │
│                 confidence × 0.3）                            │
│  L4  Delivery   pull（Sprint 1 已上线）/ push（Sprint 2）     │
│  L5  Ops        demand 记录持久化 + consumer 索引 + 审计      │
└────────────────────────────────────────────────────────────┘
```

---

## 三、接入流程（5 步，约 5 分钟）

```
① POST /v1/intel/apply          免鉴权，登记申请        → csm_xxxxxxxxxxxxx
② 把 application_id + JSON 发给管理员                    → 24 小时内
③ 管理员 POST /consumer/create  admin key 派 Key         → ckn_xxxxxxxxxxxxx
④ GET /v1/intel/verify          消费方验真 Key           → valid: true
⑤ POST /v1/intel/demand         用 ckn_ 拉数据          → 结构化结果
```

### 3.1 提交申请（免鉴权）

```bash
curl -X POST https://api.swarmlabs.tools/v1/intel/apply \
  -H "Content-Type: application/json" \
  -d '{
    "project_name": "swarmlabs",
    "contact": "lexing@swarmlabs.tools",
    "purpose": "每日获取 embodied-ai / quantum-computing 领域新论文",
    "priority": "high",
    "delivery_preference": "pull",
    "planned_usage": {
      "frequency": "daily",
      "queries_per_day": 20,
      "keywords_per_query": 5
    }
  }'
```

**必填字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `project_name` | string | 项目标识（英文短横线，如 `swarmlabs`） |
| `contact` | string | 联系人邮箱或 GitHub 用户名 |
| `purpose` | string | 一句话用途（审批和审计用） |
| `priority` | `high`/`medium`/`low` | 紧急度，高优先级走 Pro 档 |
| `delivery_preference` | `pull`/`push`/`subscribe` | 首选交付模式（当前只支持 `pull`） |
| `planned_usage` | object | 预计用量（frequency / queries_per_day / keywords_per_query） |

**返回**：

```json
{
  "application_id": "csm_02989781cbf0",
  "status": "pending_review",
  "persisted": true,
  "_note": "申请已入库，等待管理员派 Key"
}
```

### 3.2 通知管理员

把 `application_id` + 申请 JSON 发给 GitHub user `lm203688`（可通过 [GitHub issue](https://github.com/lm203688/genetech-14-sites/issues) 加标签 `intel-application`）。期望 24 小时内返回 `consumer_key`。

### 3.3 管理员派 Key（消费方不参与）

```bash
curl -X POST https://api.swarmlabs.tools/v1/intel/consumer/create \
  -H "Authorization: Bearer <admin_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "application_id": "csm_02989781cbf0",
    "project_name": "swarmlabs",
    "tier": "pro",
    "rate_per_min": 120
  }'
```

**返回**：

```json
{
  "application_id": "csm_02989781cbf0",
  "consumer_key": "ckn_eyJjaWQiOi...5ae0f820efc4fb58c73522ff2c825f0941375ce02348cca1a6930cce2932f3fe",
  "tier": "pro",
  "rate_per_min": 120,
  "expires_at": "2027-03-20T04:17:16.333Z",
  "persisted": true
}
```

> ⚠️ **Key 一次性返回**：`consumer_key` 只在创建时返回一次，不存明文。丢失只能重新申请。

### 3.4 验真 Key

```bash
curl -X GET https://api.swarmlabs.tools/v1/intel/verify \
  -H "Authorization: Bearer ckn_eyJjaWQiOi..."
```

```json
{
  "valid": true,
  "key_type": "consumer",
  "cid": "csm_02989781cbf0",
  "tier": "pro",
  "consumer_name": "swarmlabs",
  "expires_at": "2027-03-20T04:17:16.333Z",
  "rate_per_min": 120
}
```

### 3.5 拉数据

```bash
curl -X POST https://api.swarmlabs.tools/v1/intel/demand \
  -H "Authorization: Bearer ckn_eyJjaWQiOi..." \
  -H "Content-Type: application/json" \
  -d '{
    "consumer": "swarmlabs",
    "query": {
      "sites": ["embodied-ai", "robot-parts"],
      "keywords": ["exoskeleton", "soft robotics"],
      "sources": ["arxiv", "pubmed"],
      "time_window": "30d",
      "min_confidence": 0.6,
      "max_entities": 500
    },
    "delivery": { "mode": "pull" }
  }'
```

**返回（200）**：

```json
{
  "demand_id": "dm_1a0c22eb887_14d65940",
  "status": "completed",
  "coverage": {
    "local": true,
    "entityCount": 13333,
    "generatedAt": "2026-09-19T05:53:56.431Z",
    "sourceSites": 30
  },
  "results_preview": [
    {
      "id": "pmid:42496684",
      "name": "Wearable exoskeleton upper limb device based on soft actuators...",
      "site": "robot-parts",
      "source": "pubmed",
      "url": "https://pubmed.ncbi.nlm.nih.gov/42496684/",
      "snippet": "This article presents the development of a wearable exoskeleton...",
      "tags": ["soft robotics", "rehabilitation", "brain-computer interface"],
      "publishedDate": "2026 Aug 6",
      "confidence": 0.82,
      "score": 0.7127
    }
  ],
  "results_total": 10,
  "delivery_mode": "pull",
  "created_at": "2026-09-21T04:17:16.935Z",
  "_full_demand": { /* 完整 demand 对象，含全量 results.matches */ },
  "_next": {
    "fetch_full": "https://api.swarmlabs.tools/v1/intel/demand/dm_1a0c22eb887_14d65940",
    "note": "若 GET 返回 404，用 _full_demand 本地持久化"
  }
}
```

> **⚠️ 重要**：Sprint 1 存储限于单 Worker 实例 memory（`PRO_KV` 日写入限额已满）。POST 响应里的 `_full_demand` 字段包含完整结果，**消费方应自行持久化该字段**。`GET /v1/intel/demand/{id}` 在同一 Worker 实例内可查到，跨实例可能 404。Sprint 2 引入外部状态文件解决跨实例持久化。

---

## 四、DemandSpec 字段参考

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `consumer` | string | ✅ | 消费方标识（如 `swarmlabs`, `roboparts`） |
| `priority` | string | ❌ | `high` / `medium` / `low`，默认 `medium` |
| `query.sites` | string[] | ❌ | 限定站点（30 站 slug，见[第六节](#六30-站领域列表)） |
| `query.keywords` | string[] | ❌ | 关键词（至少 1 个才有结果） |
| `query.sources` | string[] | ❌ | 限定来源（`swarmlabs-30sites`, `arxiv-hot`；留空=两者都查） |
| `query.time_window` | string | ❌ | `1d`/`7d`/`14d`/`30d`/`90d`/`180d`/`365d`，默认 `30d` |
| `query.min_confidence` | number | ❌ | 最低置信度（0.0-1.0），默认 0 |
| `query.max_entities` | number | ❌ | 最大返回数（1-5000），默认 500 |
| `delivery.mode` | string | ❌ | `pull`/`push`/`subscribe`，默认 `pull` |
| `delivery.callback` | string | ❌ | push/subscribe 回调 URL（必须 HTTPS，不能指向 swarmlabs.tools） |
| `delivery.interval_min` | number | ❌ | subscribe 投递间隔（分钟，5-1440），默认 60 |

---

## 五、档位说明

| 档位 | 有效期 | 每 Key 限额 | 用途 |
|------|--------|-------------|------|
| **Free** | 30 天 | 30 req/min | 试用、验证集成 |
| **Pro**（默认） | 180 天 | 120 req/min | 常规运营、内部项目 |
| **Enterprise** | 365 天 | 600 req/min | 生产部署、大规模消费 |

> 内测期**免费**。未来参考 Scite 信用模型和 Pro ¥39.9 / 终身 ¥199 定价。

---

## 六、30 站领域列表

| # | slug | 领域 | # | slug | 领域 |
|---|------|------|---|------|------|
| 1 | biotech | 生物技术 | 16 | neuroscience | 神经科学 |
| 2 | climate | 气候科学 | 17 | ocean | 海洋科学 |
| 3 | quantum | 量子计算 | 18 | astronomy | 天文学 |
| 4 | embodied-ai | 具身智能 | 19 | chemistry | 化学 |
| 5 | ai-safety | AI 安全 | 20 | physics | 物理学 |
| 6 | agent-ecosystem | Agent 生态 | 21 | ecology | 生态学 |
| 7 | neuromorphic | 神经形态计算 | 22 | microbiology | 微生物学 |
| 8 | agritech | 农业科技 | 23 | biophysics | 生物物理 |
| 9 | spatial-computing | 空间计算 | 24 | synthetic-biology | 合成生物学 |
| 10 | robotics | 机器人 | 25 | nanotech | 纳米技术 |
| 11 | bionics | 仿生学 | 26 | 3d-bioprinting | 3D 生物打印 |
| 12 | genomics | 基因组学 | 27 | wearable-med | 可穿戴医疗 |
| 13 | materials | 材料科学 | 28 | bioinformatics | 生物信息学 |
| 14 | energy | 能源 | 29 | computational-bio | 计算生物学 |
| 15 | pharma | 制药 | 30 | medtech | 医疗技术 |

完整目录：`GET https://data.swarmlabs.tools/api/catalog.json`

### 来源过滤

`arxiv` | `pubmed` | `github` | `huggingface` | `pwc` | `nature` | `cell`

### 时间窗口

`1d` | `7d` | `14d` | `30d` | `90d` | `180d` | `365d`

---

## 七、数据源覆盖

| 数据源 | 覆盖 | 更新频率 | 状态 |
|--------|------|----------|------|
| 30 站结构化实体索引 | ~13,333 高置信实体 / 30 领域 | 每日 pipeline | ✅ Sprint 1 |
| arXiv 论文 | 前沿论文 | 每日 | 🔜 Sprint 2 |
| GitHub OSS 项目 | 代码库 | 每日 | 🔜 Sprint 2 |
| HuggingFace 模型 | 开源模型 | 每周 | 🔜 Sprint 2 |

---

## 八、交付模式

### 8.1 Pull（拉取式）— 已上线

```javascript
const demand = await fetch('https://api.swarmlabs.tools/v1/intel/demand', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${CKN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    consumer: 'swarmlabs',
    query: { keywords: ['exoskeleton', 'soft robotics'], time_window: '30d' },
    delivery: { mode: 'pull' },
  }),
}).then(r => r.json());

// 持久化 _full_demand（Sprint 1 必须，GET 跨实例会 404）
saveLocally(demand._full_demand);

// 或保存 demand_id，同实例内可查
// await fetch(`.../v1/intel/demand/${demand.demand_id}`, { headers: { 'Authorization': `Bearer ${CKN}` } });
```

### 8.2 Push（推式）— Sprint 2

引擎完成扫描后主动 POST 到消费方 webhook。消费方需提供公网可达的回调 URL。

### 8.3 Subscribe（订阅式）— Sprint 3

消费方一次配置，引擎每日 pipeline 跑完后自动 diff 推送。

---

## 九、管理端点（仅管理员）

| 端点 | 鉴权 | 用途 |
|------|------|------|
| `POST /v1/intel/consumer/create` | admin key | 从 application 派 consumer key |
| `GET /v1/intel/consumer` | admin key | 列出所有 consumer |
| `GET /v1/intel/admin/state` | admin key | 导出 memory 状态（供持久化脚本消费） |

---

## 十、错误码

| HTTP | error | 说明 |
|------|-------|------|
| 400 | `bad_request` | 请求体格式错误或必填字段缺失 |
| 401 | `unauthorized` | 缺少 Key |
| 403 | `forbidden` | Key 无效或过期（含 `detail` 字段） |
| 404 | `not_found` | demand_id 不存在或已过期（含 `_hint` 字段） |
| 405 | `method_not_allowed` | HTTP 方法不允许 |
| 429 | `rate_limited` | 超出每 Key 限额 |
| 500 | `internal_error` | 服务器内部错误 |
| 503 | `index_unavailable` | 搜索索引不可用 |

---

## 十一、快速开始模板（Python）

```python
import json, urllib.request

CKN = "ckn_你的key_here"

def fetch_intel(keywords, sites=None, time_window="30d"):
    payload = {
        "consumer": "your-project",
        "query": {"keywords": keywords, "time_window": time_window, "max_entities": 200},
        "delivery": {"mode": "pull"},
    }
    if sites:
        payload["query"]["sites"] = sites
    req = urllib.request.Request(
        "https://api.swarmlabs.tools/v1/intel/demand",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {CKN}", "Content-Type": "application/json"},
        method="POST",
    )
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

results = fetch_intel(["exoskeleton", "soft robotics"])
# 持久化 _full_demand（Sprint 1 必需）
save_locally(results.get("_full_demand"))
for r in results.get("results_preview", [])[:5]:
    print(f"[{r['site']}] {r['name'][:60]}...  score={r['score']}")
```

---

## 十二、FAQ

**Q：我需要申请吗？**
任何项目都可以，无论规模。Free 档够用，之后可升级 Pro。

**Q：Key 泄露了怎么办？**
告诉管理员 `cid` + 泄露情况，会立即吊销并签发新 key。

**Q：可以多个项目共用一个 key 吗？**
可以但**不建议**——key 有 per-consumer 配额和审计记录，共用会导致用量互相打架。每个项目独立申请更清晰。

**Q：订阅模式什么时候上线？**
Sprint 2 上线 push（webhook 回调），Sprint 3 上线 subscribe（每日 diff 推送）。

**Q：GET demand/{id} 为什么返回 404？**
Sprint 1 存储限于单 Worker 实例 memory（PRO_KV 日写入限额已满）。POST 之后 Worker 实例重启/迁移会丢失。请用 POST 响应里的 `_full_demand` 字段做本地持久化。Sprint 2 引入外部状态文件解决。

**Q：数据源可以指定新加吗？**
可以。在 `purpose` 里说明需要的新源，管理员评估后加入 `pipeline-*.js`。当前外部源覆盖 arXiv / PubMed / GitHub / HuggingFace / PWC。

---

## 十三、版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0-sprint1 | 2026-09-21 | 初版：POST/GET demand，pull 模式，本地索引查询 |
| 1.0.0-sprint1.1 | 2026-09-21 | POST 响应含 `_full_demand`，新增 admin/state 端点，memory fallback 修复 |
| 1.1.0-sprint2 | 2026-09-22 | push 模式（同步回调），KV 持久化，路由正则修复 dm_ 前缀，admin/subscriptions 端点，消费方 dashboard |
| 1.2.0-sprint3 | 2026-09-22 | subscribe 调度器（admin/deliver + GitHub Actions cron 每 30 分钟），arXiv 热榜融合到 searchEntities，consumer-sdk 新增 subscribe/push_once/verify_signature |

---

## 十四、联系

- **申请入口**：`POST https://api.swarmlabs.tools/v1/intel/apply`（免鉴权）
- **审批**：GitHub issue → https://github.com/lm203688/genetech-14-sites/issues（标签 `intel-application`）
- **API 文档**：`openapi.yaml`（v1 完整 schema）
- **技术栈**：Cloudflare Workers + PRO_KV + 本地索引 `data/search-index.json`
