# GeneTech Data API — 消费者接入指南

> 面向把本 API 接进 RAG / Agent / 内容管线的工程方。
> 规范以 [`openapi.yaml`](../openapi.yaml) 为准（逐端点 curl 实测，2026-10-02）。
> 对外展示一律英文，本文件为中文内部版。

## 0. 这个 API 是什么，不是什么

**是什么**：30 个前沿科技站点、300,000 条结构化科研实体的**只读数据出口**。
每条实体都带可追溯来源（`id` / `url` / `source` / `publishedDate` / `confidence`），
可直接作为 RAG 的 grounding 片段。

**不是什么**：

- 不是推理/训练服务——不做 embedding、不做微调、不做合规判定。
- 不是通用搜索——只暴露 9 个既定端点，没有开放 SQL/表达式。
- 不是实时数据源——数据由每日定时流水线构建（OpenAlex / Crossref / GitHub / HuggingFace / arXiv 等 11 个开放源）。

**按域读数据的正确姿势**：`/v1/domains/{slug}` 拿单站索引，
`/v1/entities` 拿聚合目录。要某站全量实体，走 `<slug>/website/api/entities.json`
（经 `/v1/*` 同源代理，按 IP 限流）。

## 1. 三档鉴权

| 档位 | 凭证 | 端点 | 限流 |
|---|---|---|---|
| Free | 无 | `/health`、`/v1/oss/registry`、`/v1/entities`、`/v1/domains/*` | 按 IP，默认 60 次/分钟，429 带 `Retry-After` |
| Pro | `Authorization: Bearer gtk_...` | `/v1/search/semantic`、`/api/pro/*` | 更高配额 + 语义检索、跨域导出 |
| Intel | header `X-GeneTech-Key`（`ckn_` 消费者 / `admin_` 管理） | `/v1/intel/*` | 按 key |

```bash
# Free：直接读
curl https://api.swarmlabs.tools/v1/oss/registry

# Pro：语义检索（必须 POST）
curl -X POST https://api.swarmlabs.tools/v1/search/semantic \
  -H 'Authorization: Bearer gtk_xxx' \
  -H 'Content-Type: application/json' \
  -d '{"q":"photosynthesis quantum efficiency","limit":10}'

# 限定站点
curl -X POST https://api.swarmlabs.tools/v1/search/semantic \
  -H 'Authorization: Bearer gtk_xxx' -H 'Content-Type: application/json' \
  -d '{"q":"federated learning","sites":["biomed-ai","ai-safety"],"limit":5}'
```

## 2. 错误约定

统一 `{error, message}`：

| code | 含义 | 处理建议 |
|---|---|---|
| 200 | 成功 | — |
| 401 | 缺 `Authorization` | 加 header |
| 403 | key 格式错 / 签名失败 / 过期 / 站点未授权 | 换 key 或换 `site` 参数 |
| 404 | 端点或数据集不存在 | **注意 `/v1/academic/*` 三端点当前实测 404**（数据集未生成），勿依赖 |
| 405 | 方法不允许（`/v1/search/semantic` 仅 POST） | 改方法 |
| 429 | 免费层限流 | 尊重 `Retry-After`，或升 Pro |
| 502 | 上游不可达 | 重试 + 退避 |

## 3. 接进 Agent 的两条实用建议

1. **先 Free 后 Pro**：Free 端点已能拿到全量实体索引与 OSS 注册表。只有需要
   「跨站语义召回」时才上 Pro——语义索引覆盖率受 Worker 内存限制（见下），
   长期方案是把检索迁到向量库，短期别指望它对 30 万实体 100% 召回。
2. **用 `confidence` 做阈值**：实体带 `confidence` 字段（0-1），RAG 侧建议
   `min_confidence ≥ 0.5` 再入上下文，否则噪声摘要会稀释检索质量。

## 4. 已知边界（诚实披露，别踩）

- **语义检索覆盖不全**：`/v1/search/semantic` 索引受 Cloudflare Worker 128MB 内存
  约束，单文件索引只能装下语料的一部分（重建后约 6%，即 18,000 / 300,000）。
  全量（149MB）在 Workers 上是架构级不可行的，需要分片 + 外部索引服务。
  若你的用例要求全召回，请走 Free 端点直接读 `entities.json`，不要用 `semantic`。
- **数据时效**：每 4 小时重建一次聚合目录；学术数据集按日更新。
- **引用关系**：知识图谱的 71,857 条边目前 100% 是标签共现/跨站桥接，
  **引用关系边正在建设**（`operations-plan/pipeline-openalex-citation.js`，
  语料含 276,683 个合法 DOI）。需要引用图的消费者请走 `gtk_` Pro 通道或联系运营。
- **`/v1/academic/*` 三端点 404**：上游 `data/academic-entities.json` 等尚未生成，
  规范里保留定义，落地后无需改调用方。

## 5. 环境与承诺

- 基址：`https://api.swarmlabs.tools`（Worker 侧），
  数据同源：`https://data.swarmlabs.tools`（GitHub Pages 直出）。
- 消费者文档与定价页：`docs/consumer-onboarding.md`、`_site/pricing.html`。
- 申请 Intel key：POST `/v1/intel/apply`（免鉴权）。
