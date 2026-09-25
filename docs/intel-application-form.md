# GeneTech Intel API · 消费方接入申请

> 版本：1.0.0-sprint1 | 上线日期：2026-09-21
> 面向：SwarmLabs / RoboParts / HealthLens / 其他任意需要情报收集的项目

---

## 一、你需要什么

如果你符合以下任意一条，就可以申请接入：

- 需要一个稳定的**科研论文 / 代码库 / 生物医学 / 前沿科技**情报源
- 需要**按领域或关键词**周期性扫描数据，而不是自己去爬
- 需要在多个消费项目之间**共享同一份数据基础设施**
- 需要一个**独立计费、可吊销、可审计**的 API key

---

## 二、申请流程（5 步，共 5 分钟）

```
┌─────────────────────────────────────────────────────┐
│ 1. 提交申请     POST /v1/intel/apply        免鉴权  │
│ 2. 拿到 ID      返回 csm_xxxxxxxxxxxxx       30 秒  │
│ 3. 通知管理员   把 JSON 发给厉兴（GitHub issue）    │
│ 4. 派 Key       POST /v1/intel/consumer/create      │
│ 5. 用 Key 拉数  Authorization: Bearer ckn_...       │
└─────────────────────────────────────────────────────┘
```

### 步骤 1：提交申请

**免鉴权，直接调用**：

```bash
curl -X POST https://api.swarmlabs.tools/v1/intel/apply \
  -H "Content-Type: application/json" \
  -d '{
    "project_name": "swarmlabs",
    "contact": "lexing@swarmlabs.tools",
    "purpose": "每日获取 embodied-ai / quantum-computing 领域新论文，用于科研 Agent 上下文生成",
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
| `project_name` | string | 项目标识（英文短横线形式，如 `swarmlabs` / `roboparts` / `healthlens`） |
| `contact` | string | 联系人邮箱或 GitHub 用户名 |
| `purpose` | string | 一句话说明用途（用于审批和审计） |
| `priority` | `high`/`medium`/`low` | 紧急度，高优先级走 Pro 档 |
| `delivery_preference` | `pull`/`push`/`subscribe` | 首选交付模式（当前只支持 `pull`，其他 Sprint 2/3 上线） |
| `planned_usage` | object | 预计用量，用于分档 |

**返回**：

```json
{
  "application_id": "csm_02989781cbf0",
  "status": "pending_review",
  "persisted": true,
  "_note": "申请已入库，等待管理员派 Key"
}
```

---

### 步骤 2：把申请 JSON 发给管理员

**发给谁**：GitHub user `lm203688`（可通过 GitHub issue、email、或者直接发这个 JSON 让我用）。

**要发什么**：
- `application_id`（从申请返回里拿）
- 申请提交的完整 JSON body
- 可选：期望的档位（Free / Pro / Enterprise）

**期望响应**：管理员在 24 小时内返回 `consumer_key`。

---

### 步骤 3：管理员派 Key

管理员执行（消费方不需要参与）：

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
  "consumer_key": "ckn_eyJjaWQiOi...<hmac_signature>",
  "tier": "pro",
  "rate_per_min": 120,
  "expires_at": "2027-03-20T04:17:16.333Z",
  "persisted": true
}
```

**⚠️ Key 一次性返回**：`consumer_key` 只在创建时返回一次，不存明文。丢失了只能重新申请。

---

### 步骤 4：验真 Key

拿到 key 之后先验一下：

```bash
curl -X GET https://api.swarmlabs.tools/v1/intel/verify \
  -H "Authorization: Bearer ckn_eyJjaWQiOi..."
```

**返回**：

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

`valid: false` 说明 key 错了，回到步骤 2 找管理员。

---

### 步骤 5：拉数据

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

**返回**（200）：

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
  "results": [
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
  "created_at": "2026-09-21T04:17:16.935Z"
}
```

---

## 三、档位说明

| 档位 | 有效期 | 每 Key 限额 | 用途 |
|------|--------|-------------|------|
| **Free** | 30 天 | 30 req/min | 试用、验证集成 |
| **Pro**（默认） | 180 天 | 120 req/min | 常规运营、内部项目 |
| **Enterprise** | 365 天 | 600 req/min | 生产部署、大规模消费 |

> 所有档位当前**免收费用**（内测期）。未来商业化会参考 Scite 信用模型和 Pro ¥39.9 / 终身 ¥199 定价档。

---

## 四、Query 参数参考

### 站点 slug（30 站可选）

```
embodied-ai | bionic-ai | quantum-computing | tcm-diagnosis | aerospace
ai-safety | agritech | spatial-computing | neuromorphic | robot-parts
biotech | pharma | neuroscience | wearable-med | materials-science
genomics | proteomics | climate-tech | energy-tech | cybersecurity
smart-manufacturing | logistics | fintech | edtech | metaverse
xr-extended-reality | autonomous-vehicles | 6g-communications | quantum-sensing
```

（完整列表见 `GET https://data.swarmlabs.tools/api/catalog.json`）

### 来源过滤

```
arxiv | pubmed | github | huggingface | pwc | nature | cell
```

### 时间窗口

`1d` / `7d` / `14d` / `30d` / `90d` / `180d` / `365d`

---

## 五、错误码

| HTTP | 含义 | 处理 |
|------|------|------|
| 400 | 参数缺失或格式错 | 检查必填字段 |
| 401 | 未提供 key | 加上 `Authorization: Bearer ckn_...` |
| 403 | key 签名错 / 过期 | 用 `/v1/intel/verify` 确认 key 状态 |
| 405 | 方法不允许 | 用正确的 method（GET / POST） |
| 404 | 端点或需求不存在 | 检查 URL 拼写 |
| 429 | 超出每 Key 限额 | 稍后重试 |
| 500 | 服务端错误 | 报告给管理员 |

---

## 六、FAQ

**Q：我需要申请吗？**
任何项目都可以，无论规模。Free 档够用就好，之后可升级到 Pro。

**Q：Key 泄露了怎么办？**
告诉管理员 `cid` + 泄露情况，会立即吊销并签发新 key（旧 key 立刻失效）。

**Q：可以多个项目共用一个 key 吗？**
可以但**不建议**——key 有 per-consumer 配额和审计记录，共用会导致用量互相打架。每个项目独立申请更清晰。

**Q：订阅模式什么时候上线？**
Sprint 2 上线 push（webhook 回调），Sprint 3 上线 subscribe（每日 diff 推送）。

**Q：数据源可以指定新加吗？**
可以。在 `purpose` 里说明需要的新源，管理员评估后加入 `pipeline-*.js`。当前外部源覆盖 arXiv / PubMed / GitHub / HuggingFace / PWC。

---

## 七、快速开始模板

复制粘贴到项目里：

```python
import json, urllib.request

CKN = "ckn_你的key_here"

def fetch_intel(keywords, sites=None, time_window="30d"):
    payload = {
        "consumer": "your-project",
        "query": {"keywords": keywords, "time_window": time_window, "max_entities": 200},
        "delivery": {"mode": "pull"},
    }
    if sites: payload["query"]["sites"] = sites
    req = urllib.request.Request(
        "https://api.swarmlabs.tools/v1/intel/demand",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {CKN}", "Content-Type": "application/json"},
        method="POST",
    )
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

results = fetch_intel(["exoskeleton", "soft robotics"])
for r in results.get("results", [])[:5]:
    print(f"[{r['site']}] {r['name'][:60]}...  score={r['score']}")
```

---

## 八、联系

- 申请入口：**`POST https://api.swarmlabs.tools/v1/intel/apply`**（免鉴权，直接调用）
- 审批：**[GitHub issue](https://github.com/lm203688/genetech-14-sites/issues)**（标签 `intel-application`）
- 技术文档：**`docs/intel-consumer-onboarding.md`**（本仓库）
- API 文档：**`openapi.yaml`**（v1 完整 schema）
