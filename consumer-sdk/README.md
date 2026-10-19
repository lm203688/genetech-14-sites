# GeneTech Consumer SDK

零依赖、单文件、可直接拷贝到任何项目。定位是「数据层最小接入面」，不是通用 HTTP 客户端。

## 安装

Python：

```bash
curl -O https://raw.githubusercontent.com/lm203688/genetech-14-sites/master/consumer-sdk/python/gentech.py
# 直接 import 即可（零依赖）
```

TypeScript：

```bash
curl -O https://raw.githubusercontent.com/lm203688/genetech-14-sites/master/consumer-sdk/typescript/gentech.ts
```

不需要 npm/pip 安装。

## 使用

### Python

```python
from gentech import GeneTech

g = GeneTech(api_key="gt_xxx")  # 没有 key 也能用公开端点（有限流）

# 1. 探活
g.health()

# 2. 查 30 域总量
domains = g.domains()  # 返回 {"totalSites": 30, "totalEntities": N, "sites": [...]}
for site in domains["sites"]:
    print(site["site"], site["totalEntities"])

# 3. 按语义搜索实体（需要 key；未配置时会抛 KeyRequired）
res = g.search_semantic(query="CRISPR", site="biomed-ai", top_k=5)
for e in res["results"]:
    print(e["id"], e.get("name"))

# 4. 拉引用边
edges = g.citation_edges()

# 5. 拉引用缺口矩阵
gaps = g.citation_gaps()

# 6. 本地样本包（不需要 key、不需要联网）
g = GeneTech()  # 无 key
for row in g.iter_sample_pack():
    print(row)
```

CLI（Python 版）：

```bash
python gentech.py health
python gentech.py domains
python gentech.py registry
python gentech.py sample --limit 5
python gentech.py citation-edges
python gentech.py citation-gaps
python gentech.py attribution
```

> 注意：CLI 命令名是 `citation-edges` / `citation-gaps`（带连字符），不是 `edges` / `gaps`。

### TypeScript

```typescript
import { GeneTech } from "./gentech";

const g = new GeneTech({ apiKey: "gt_xxx" });

await g.health();

const domains = await g.domains();
for (const site of domains.sites) console.log(site.site, site.totalEntities);

// searchSemantic 返回 POST 响应体（不是迭代器），需要手动读 results[]
const res = await g.searchSemantic({ query: "CRISPR", site: "biomed-ai", topK: 5 });
for (const e of res.results) console.log(e.id, e.name);
```

> `domains()` 返回的是 Promise，需要 `await` 之后按 `response.sites` 读取，不是迭代器。

## 端点

| 端点 | 认证 | 说明 |
|---|---|---|
| `GET /health` | 无 | 探活 |
| `GET /v1/domains` | 无 | 30 域列表 + lastUpdated |
| `GET /v1/oss/registry` | 无 | 开源项目注册表 |
| `GET /v1/entities` 或 `GET /v1/entities/<site>` | 可选 | 全量或按站实体 |
| `POST /v1/search/semantic` | 必需 | 语义搜索（body: `{query, topK, sites?}`） |
| `GET /v1/citation/edges` | 可选 | 跨站引用边 |
| `GET /v1/citation/gaps` | 可选 | 引用缺口矩阵 |
| `POST /v1/intel/demand` | 必需 | 提交数据需求 |
| `GET /v1/intel/health` | 无 | 队列健康 |

API 默认 `https://api.swarmlabs.tools`，可通过 `base_url` / `baseUrl` 覆盖。

## 方法清单

Python `GeneTech` 与 TypeScript `GeneTech` 完全对齐：

| 方法 | 端点 | 需 key |
|---|---|---|
| `health()` / `health()` | `GET /health` | 否 |
| `domains()` / `domains()` | `GET /v1/domains` | 否 |
| `registry()` / `registry()` | `GET /v1/oss/registry` | 否 |
| `citation_edges()` / `citationEdges()` | `GET /v1/citation/edges` | 否 |
| `citation_gaps()` / `citationGaps()` | `GET /v1/citation/gaps` | 否 |
| `entities(site?)` / `entities(site?)` | `GET /v1/entities[/<site>]` | 否 |
| `search_semantic(...)` / `searchSemantic(...)` | `POST /v1/search/semantic` | 是 |
| `iter_sample_pack(path?)` / `iterSamplePack(path?)` | 本地 JSONL | 否 |
| `load_sample_pack(path?)` / `loadSamplePack(path?)` | 本地 JSONL | 否 |
| `attribution_note(when?)` / `GeneTech.attributionNote(when?)` | 静态字符串 | 否 |

TypeScript 是 camelCase，Python 是 snake_case。

## 免费样本包

`consumer-sdk/samples/sample-10k.jsonl` — 10,000 条实体 JSONL 文件，覆盖 30 域。用途：

- 首次接入时无需 API key 就能试跑 SDK
- 本地做离线数据探索
- CI 里的 mock 数据

元数据在 `sample-10k.manifest.json`（生成时间 / 覆盖域 / 字段清单）。

## 数据契约

字段定义见 `docs/DATA-DICTIONARY.md`，溯源见 `docs/LINEAGE.md`。

## 定价

| 层级 | 价格 | 限额 |
|---|---|---|
| Free | ¥0 | 60 req/min（公开端点） |
| Pro | ¥39.9/月 | 600 req/min + SLA |
| 终身 | ¥199 | 永久 unlimited |

支付链接：https://license.swarmlabs.tools

## License

MIT — 商用无需授权费，商业授权请联系 sales@swarmlabs.tools。
