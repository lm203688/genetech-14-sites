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
for d in g.domains():
    print(d["domain"], d["total"])

# 3. 按关键词搜索实体
for e in g.search("CRISPR", site="biomed-ai", limit=5):
    print(e["id"], e["title"])

# 4. 拉引用边
for edge in g.citation_edges():
    print(edge["from"], "->", edge["to"], edge["site_pair"])

# 5. 拉引用缺口矩阵
gaps = g.citation_gaps()

# 6. 本地样本包（不需要 key、不需要联网）
g = GeneTech()  # 无 key
for row in g.iter_sample_pack():
    print(row)
```

CLI：

```bash
python gentech.py health
python gentech.py domains
python gentech.py sample --limit 5
python gentech.py edges --site=biomed-ai
```

### TypeScript

```typescript
import { GeneTech } from "./gentech";

const g = new GeneTech({ apiKey: "gt_xxx" });

await g.health();
for (const d of await g.domains()) console.log(d);
for (const e of await g.search("CRISPR", { site: "biomed-ai" })) console.log(e);
```

## 端点

| 端点 | 认证 | 说明 |
|---|---|---|
| `GET /health` | 无 | 探活 |
| `GET /v1/domains` | 无 | 30 域列表 + lastUpdated |
| `GET /v1/entities?query=&site=` | 可选 | 关键词检索 |
| `GET /v1/citation/edges?site=` | 可选 | 跨站引用边 |
| `GET /v1/citation/gaps` | 可选 | 引用缺口矩阵 |
| `POST /v1/intel/request` | 必需 | 提交数据需求 |
| `GET /v1/intel/health` | 无 | 队列健康 |

API 默认 `https://api.swarmlabs.tools`，可通过 `base_url` 覆盖。

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
