# GeneTech 数据引擎 MCP Server

让任何外部 AI Agent（Claude / Cursor / LangChain / 自研 Agent）实时查询、检索、引用
GeneTech 30 站知识引擎的实体数据。这是项目从"给人看的内容站"升级为"给 Agent 消费的
知识 API"的**核心护城河**——别人无法一键复制的实时知识接口。

## 数据契约

每个站点通过以下静态 JSON 暴露数据（与线上站点完全一致）：

- `<site>/website/api/index.json` → `{ site, totalEntities, lastUpdated, categories }`
- `<site>/website/api/entities.json` → 实体数组
  `{ id, name, source, abstract, url, authors[], tags[], confidence, sites[], publishedDate, addedAt }`

## 30 秒上手（零安装，推荐）

无需 clone、无需 `npm install`——一条命令让任意支持 MCP 的 AI 客户端（Claude Desktop / Cursor / Cline）实时查询全部 30 域数据：

```bash
npx -y @genetech/data-mcp
```

接入 Claude Desktop（`claude_desktop_config.json`）后，直接对 AI 说：

> 用 GeneTech 的 ai4science 域，找 3 篇 2025 年 AlphaFold 3 相关的论文，导出 BibTeX。

最小可运行样例（Python，复制即跑，免密钥拉取开放数据）：

```python
import urllib.request, json
BASE = "https://lm203688.github.io/genetech-14-sites"
catalog = json.load(urllib.request.urlopen(f"{BASE}/api/catalog.json"))
print("可查询领域数:", len(catalog["sites"]))
site0 = catalog["sites"][0]["slug"]
ents = json.load(urllib.request.urlopen(f"{BASE}/{site0}/website/api/entities.json"))
print(f"{site0} 实体数:", len(ents))
```

> 付费墙：设置 `GENETECH_API_KEY` + `GENETECH_REQUIRE_AUTH` 后，远程模式才会要求 Bearer 鉴权（见下）。

## 快速开始（本地 / 自托管）

```bash
cd mcp-server
npm install
node src/index.mjs
```

默认读取**仓库根目录**下的各站点数据。可用环境变量覆盖：

| 变量 | 说明 |
|------|------|
| `GENETECH_DATA_DIR` | 本地数据根目录（默认：仓库根） |
| `GENETECH_API_BASE` | 已部署站点 URL，如 `https://lm203688.github.io/genetech-14-sites`（设置后改为远程拉取） |
| `GENETECH_API_KEY` | 设置后要求客户端 Bearer 鉴权（付费墙） |
| `GENETECH_REQUIRE_AUTH` | 设为 `true` 强制校验 API Key |

## 接入 Claude Desktop / Cursor

`claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "genetech-data": {
      "command": "node",
      "args": ["/绝对路径/genetech-14-sites/mcp-server/src/index.mjs"],
      "env": { "GENETECH_DATA_DIR": "/绝对路径/genetech-14-sites" }
    }
  }
}
```

## 提供的工具

| 工具 | 作用 |
|------|------|
| `list_sites` | 列出全部站点及实体数 / 更新时间 |
| `query_entities` | 按站点 / 数据源 / 标签 / 关键词 / 置信度过滤 |
| `get_entity` | 按 ID 取详情并可导出引用 |
| `semantic_search` | 混合检索（BM25 倒排 + 字段加权 + RRF 融合，可选向量语义），`graph_hop` 开图遍历扩召回 |
| `graph_search` | 图遍历检索：先找 anchor 节点再沿关系边 BFS 多跳，返回完整路径解释 |
| `ask` | 自然语言提问：内部混合检索 + LLM 桥接，生成带参考来源的答案（未配 LLM 时退化为实体浓缩列表） |
| `export_citation` | 导出 BibTeX / APA / RIS 引用 |

## 已注册的 Glama 清单

`mcp-server/glama.json`（与 `glama.json` 中的 AIShield 安全 MCP 并列，构成"数据 + 安全"双生态位）。

## 自动化发布

由 `.github/workflows/ops-extra.yml` 的 `mcp-publish` job 定期校验并（在版本变更时）提交
`glama.json` 与 `package.json`，随仓库推送自动上线。

## 新增工具（v1.1.0）

| 工具 | 作用 |
|------|------|
| `submit_request` | 提交数据需求（下游项目申请定向采集） |
| `retrieve_requests` | 浏览/筛选/统计需求队列 |
| `intake_health` | 检查数据需求队列健康状态 |

## 新增工具（v1.2.0）

| 工具 | 作用 |
|------|------|
| `citation_gaps` | 跨域引用缺口矩阵：零引用站对（研究空白候选）/ 最强桥接 / 各站入出度 |

## 新增工具（v2.0.0，2026-10-13 补齐 3 个高价值工具）

以下 3 个工具已实装到 `src/index.mjs`，是 10-14 报告 §1 里点名"README 只列 11 个"要补的缺口。

| 工具 | 作用 | 上游依赖 |
|------|------|---------|
| `verify_entity` | 校验单个实体的溯源字段（`source` / `url` / `addedAt` / `confidence`），返回可审计报告。用于外部 Agent 判断某条引用的证据链是否可信。 | 本地图谱 + `data/knowledge-graph.json` 溯源边 |
| `snapshot_at` | 按日期取站点当时的实体快照，用于"复现某天的检索结果"、审计与论文复现场景。 | `data/time-machin/` 快照层（尚未部署 HTTP 端点；此处直读本地 JSON） |
| `domain_relatedness` | 计算两个域之间的双向引用计数与相对权重（`citation-edges.json` 派生），用于判断"两个域值不值得建联合索引"。 | `data/citation-edges.json` + `data/citation-gaps.json` |

**分页 / 结果规模**：所有返回 `results[]` 的工具（`query_entities` / `semantic_search` / `graph_search` / `snapshot_at`）均支持 `limit` + `offset`。`limit` 默认 20，硬上限 100；`offset` 默认 0。返回体带 `total` 与 `hasMore`，客户端可据此翻页。跨页聚合建议每次 `limit=100` 顺序推进，不要并发拉多片。

```typescript
// 校验某实体是否可信
const v = await verify_entity({ id: 'pmid-31234567', site: 'biomed-ai' });
// → { id, source, url, addedAt, confidence, evidence: [...], verdict: 'verifiable' }

// 取 2025-06-01 那天 quantum-computing 站的实体快照
const snap = await snapshot_at({ site: 'quantum-computing', date: '2025-06-01' });

// 判断两域相关度
const rel = await domain_relatedness({ siteA: 'alien-minerals', siteB: 'exo-science' });
// → { siteA, siteB, forward: 2125, backward: 180, weight: 1.18, verdict: 'strong_bridge' }
```

⚠️ 上述 3 个工具在本 MCP 侧是**读本地数据**，不走 `api-guard` 网关；上游 HTTP 版尚未部署，10-14 报告 §2 已经指出 mcp-remote 里对应 4 个工具会返 404，2026-10-14 已在 `mcp-remote/worker.js` 里改为 fail-closed + 就地渲染兜底。

### `verify_entity` 使用范式

外部 Agent 常见用法：先 `semantic_search` 拿到候选 → 对 top-K 调 `verify_entity` 打分 → 只把 `verdict=verifiable` 的写入最终答案。**不要**直接把 `get_entity` 结果当"已核实"，因为 `addedAt` 老于 2025-09-01 的实体在 10-14 报告里被标记为"内容陈旧"风险区。

### 为什么需要 `citation_gaps`

`graph_search` 回答的是「**已存在**的引用路径是什么」，但科研场景里更值钱的问题是
「**哪两个域之间一条引用都没有**」—— 那是研究空白候选。

数据源是 `data/citation-gaps.json`（由 `operations-plan/pipeline-citation-gaps.js`
从 `data/citation-edges.json` 纯派生，本 MCP 侧只读不重算，避免两处算出口径不一致）。
当前实测（2026-10-10）：30 站 / 870 有向站对 / **101 个零引用站对（11.6%）**。
⚠️ 该结论建立在引用网络基座上——`data/citation-edges.json` 的 `stats.resolvedEdges=1961 / totalEdges=28001`，其中真实解析出仅 1,961 条边（7%），其余 26,044 条来自 legacy merge；`data/academic-entities.json` 种子仅 1,634 条。缺口矩阵的可信度因此受限，详见 `reports/项目全面评估与硬科技深度提升综合报告-2026-10-10.md` §5.2。

```typescript
// 找未被桥接的跨域（附各站实体规模，便于区分「真空白」与「我们没抓到」）
await citation_gaps({ mode: 'gaps', site: 'quantum-computing', limit: 20 });
// → { gaps: [{from,to,combinedSize}], siteScale: {...}, interpretation: "..." }

// 找跨学科桥接种子
await citation_gaps({ mode: 'bridges', limit: 10 });
// → { bridges: [{from:'alien-minerals', to:'exo-science', edges:2125}, ...] }
```

⚠️ **读 `gaps` 时必须同时看 `siteScale`**：零引用可能是真实研究空白（两域尚未打通），
也可能只是本项目在该两域语料不足。只看 `gaps` 会把「我们没抓到」误当「没人研究」。
`interpretation` 字段就是给 LLM 看的这句提醒，`includeInterpretation: false` 可关。

### 使用示例

```typescript
// 提交数据需求
const result = await submitRequest({
  project_name: "swarmlabs",
  contact: "lm203688",
  purpose: "为 Embodied AI 模块检索触觉反馈论文",
  priority: "high",
  spec: {
    domains: ["robotics", "embodied-ai"],
    keywords: ["haptic feedback", "tactile sensing"],
    time_range: { from: "2025-01-01", to: "2026-09-25" },
    min_confidence: 0.6,
    target_count: 50,
    formats: ["json", "bibtex"]
  }
});
console.log(result.request_id); // req_xxx_xxx
```

```typescript
// 查询需求列表
const requests = await retrieveRequests({
  status_filter: "pending_review",
  limit: 10
});
console.log(requests.summary); // { byStatus, byPriority, byProject }
```

## API 端点

- `POST /api/v1/requests` — 提交数据需求（免鉴权）
- `GET /api/v1/requests` — 查询需求列表（匿名限 20 条）
- `GET /api/v1/requests/:id` — 查询单个需求详情

数据落点：`state/data-requests.json`（与 Gateway Worker 共享）

<!-- GENETECH:CLAIMS:BEGIN -->
<!-- 由 operations-plan/pipeline-docs-claims.js 于 2026-10-13 自动生成，请勿手工编辑此锚注之间的内容。 -->

### 当前规模（机器生成，锚注自动刷新）

| 指标 | 值 | 口径 |
|---|---:|---|
| 站点 / 域数 | **30** | 有 `website/api/entities.json` 的顶层目录 |
| 结构化实体总数 | **294,330** | 逐站实体文件求和 |
| 带 DOI/PMID 的实体 | **271,099** | 同上，仅计有外部可解析 ID 的记录 |
| 知识图谱节点 / 边 | **36,107 / 99,725** | data/knowledge-graph.json |
| 图谱中引用边 | **27,868（28%）** | KG 中 relation=citation |
| 学术种子（引用网络基座） | **1,634** | data/academic-entities.json，是缺口矩阵的真实基座 |
| 引用声明总数 | **0** | 59,623 类 |
| 引用边（真实解析 vs legacy merge） | **25,682 vs 26,044** | 总 51,726 边中两者各占一半；**resolved 只占 50%，不是"解析成功率"** |
| 引用声明真实解析成功率 | **N/A** | resolved / declarations（declarations=0 时不可计算，不编造） |
| 零引用站对 | **140 / 870** | citation-gaps.json |

> 以上数字由脚本从 data/ 单一真源实时计算。与本报告 §2.2 数字若不一致，**以本锚注为准**（脚本口径永远新）。

<!-- GENETECH:CLAIMS:END -->
