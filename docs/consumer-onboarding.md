# 14站知识引擎 · 消费者上手指南

> 面向下游项目（小模型 KB / 蜂群科研数据 / 机器人项目 / 付费客户）的接入说明。
> 完整规范见 [`../openapi.yaml`](../openapi.yaml)；战略定位见 [`strategy-infrastructure.md`](strategy-infrastructure.md)。

## 三档 API Key

| 档位 | Key 前缀 | 速率 | 数据范围 | 价格 |
|---|---|---|---|---|
| Free | 无 key | 60 req/min | 元数据（`/v1/domains` `/v1/entities` 聚合视图 `/v1/oss/registry` `/health`） | 免费 |
| Partner | `slb_` | 120 req/min | 全量实体 + 领域读 | 与运营方协商 |
| Pro | `gtk_` | 600 req/min | 全字段 + `/v1/search/semantic` 语义搜索 + 引用导出 | ¥39.9 / 年 或 ¥199 终身 |

## 端点

- **生产主端点**（海外可用）：`https://api.swarmlabs.tools`
- **Worker 兜底**（海外可用）：`https://genetech-api-guard.61960005.workers.dev`
- **Partner 独立网关**：`https://swarm-labs-gateway.61960005.workers.dev`

## Quick Start

### Free tier — 浏览领域

```bash
curl -s https://api.swarmlabs.tools/v1/domains | jq '.sites[] | {site, label, totalEntities}'
```

### Free tier — 查看开源项目注册表

```bash
curl -s https://api.swarmlabs.tools/v1/oss/registry | jq '.projects[:5]'
```

### Pro tier — 语义搜索

```bash
curl -s -X POST https://api.swarmlabs.tools/v1/search/semantic \
  -H "Authorization: Bearer gtk_..." \
  -H "Content-Type: application/json" \
  -d '{"query": "reinforcement learning safety", "limit": 10, "sites": ["ai-safety"]}' \
  | jq '.results[] | {name, site, score, snippet: .snippet[0:80]}'
```

### Partner tier — 全量数据拉取

```bash
# 用 swarm-labs-gateway 的 slb_ key
curl -s -H "Authorization: Bearer slb_..." \
  https://swarm-labs-gateway.61960005.workers.dev/v1/entities
```

## 数据源与更新

- **上游**：arXiv / Semantic Scholar / Crossref / EuropePMC / Papers with Code / GitHub / HuggingFace
- **30 个子站**：`agent-ecosystem` `agritech` `ai-safety` `ai4science` `alien-minerals` `biocomputing` `biomed-ai` `bionic-ai` `brain-science` `carbon-neutral` `deep-sea-tech` `digital-twin` `edge-ai` `embodied-ai` `exo-science` `genetech-tools` `life-science` `low-altitude` `neuromorphic` `new-energy` `nuclear-energy` `privacy-computing` `quantum-computing` `quantum-materials` `robot-parts` `sat-6g` `semiconductor` `spatial-computing` `synbio-manufacturing` `tcm-tools`
- **更新频率**：知识实体每日累积（每小时批处理），搜索索引每日重建，OSS 注册表每日扫描
- **数据新鲜度**：`/v1/domains` 返回的 `lastUpdated` 字段为各站最新构建时间；`/v1/search/semantic` 返回的 `meta.indexGeneratedAt` 为搜索索引构建时间

## 错误码

| HTTP | error 字段 | 说明 |
|---|---|---|
| 400 | `bad_request` | 参数错误（如 query 太短） |
| 401 | `unauthorized` | 缺少 Authorization |
| 403 | `forbidden` | Key 校验失败（invalid_format / bad_signature / expired） |
| 405 | `method_not_allowed` | 方法不支持（如 `/v1/search/semantic` 用 GET） |
| 429 | `rate_limited` | 限流，`Retry-After` 头指示重试间隔 |
| 503 | `index_unavailable` / `llm_not_configured` / `upstream_unreachable` | 服务暂不可用 |

## 独立性承诺

14站只承担**信息收集与结构化**，不承接：

- ❌ 模型训练 / 推理
- ❌ 商业数据加工 / 合规
- ❌ 消费者项目鉴权（各消费者走各自独立 key 前缀，HMAC 密钥不共享）

## 联系

- 项目仓库：`lm203688/genetech-14-sites`（MIT）
- 战略文档：`docs/strategy-infrastructure.md`
- 部署状态：见 `_site/api/catalog.json` 的 `generatedAt`
