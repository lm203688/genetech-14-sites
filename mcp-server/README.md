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
<!-- 由 operations-plan/pipeline-docs-claims.js 于 2026-10-10 自动生成，请勿手工编辑此锚注之间的内容。 -->

### 当前规模（机器生成，锚注自动刷新）

| 指标 | 值 | 口径 |
|---|---:|---|
| 站点 / 域数 | **30** | 有 `website/api/entities.json` 的顶层目录 |
| 结构化实体总数 | **294,330** | 逐站实体文件求和 |
| 带 DOI/PMID 的实体 | **271,099** | 同上，仅计有外部可解析 ID 的记录 |
| 知识图谱节点 / 边 | **36,107 / 99,725** | data/knowledge-graph.json |
| 图谱中引用边 | **27,868（28%）** | KG 中 relation=citation |
| 学术种子（引用网络基座） | **1,634** | data/academic-entities.json，是缺口矩阵的真实基座 |
| 引用声明总数 | **59,623** | 59,623 类 |
| 引用边（真实解析 + legacy merge） | **1,961 / 28,001** | resolved 7% + legacy 26,044 |
| 零引用站对 | **101 / 870** | citation-gaps.json |

> 以上数字由脚本从 data/ 单一真源实时计算。与本报告 §2.2 数字若不一致，**以本锚注为准**（脚本口径永远新）。

<!-- GENETECH:CLAIMS:END -->
