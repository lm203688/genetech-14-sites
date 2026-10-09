# 知识图谱并入引用边 · 证据报告（2026-10-09）

> 对应 v2 报告 §6-B1「图谱并入引用边」验收判据：**引用边占比 ≥20%**
> 数据源：`data/knowledge-graph.json`
> 生成命令：`node tools/build-knowledge-graph.mjs`
> 复核入口：`node -e "const g=require('./data/knowledge-graph.json');console.log(g.edges.length, g.edges.filter(e=>e.relation==='citation').length)"`

---

## 1. 验收结果

| 指标 | 值 | 验收 |
|---|---:|---|
| 节点总数 | 36,107 | — |
| 边总数 | 99,725 | — |
| 引用边（`relation: citation`） | **27,868** | — |
| **引用边占比** | **27.94%** | ✅ 达标（≥20%） |
| 独立引用源 DOI | 11,094 | — |
| 独立被引 DOI | 12,777 | — |

## 2. 四类边的完整分布

| 边类型 | 数量 | 占比 | 语义 |
|---|---:|---:|---|
| `shared_tag` | 38,930 | 39.04% | 实体打了同一个标签（跨站或同站） |
| `cross_site` | 29,927 | 30.01% | 同一实体在多个站出现（枢纽节点） |
| `citation` | **27,868** | **27.94%** | **论文 A 引用了论文 B（真实引用方向）** |
| `co_topic` | 3,000 | 3.01% | 同一主题下共现 |

**四类边共存的意义**：`graph_search` 现在可以返回四种语义完全不同的关联，
而不是 v2 报告 §3.3 描述的"边 100% 是标签共现 / 桥接，0 条引用边"。

## 3. 引用边的字段完整性

抽样验证（引用边 100% 有源、有目标、有方向、有类型）：

```json
{
  "source": "doi:10.1007/s10458-025-09730-8",
  "target": "doi:10.1007/s12369-024-01172-8",
  "relation": "citation",
  "weight": 1
}
```

- `source` / `target`：都是 `doi:` 前缀的规范化 DOI
- `weight: 1`：本层边目前统一权重（未做引用频次加权，见 §6 后续动作）
- 边数 27,868 与 `data/citation-edges.json`（28,001 边，2026-10-05 生成）差 133 条，
  是**跨站去重**造成的（同一对 DOI 在多个站点出现，只保留一条边）。

## 4. 与 v2 报告 §3.3 的直接对照

v2 报告原文：

> `data/knowledge-graph.json`: 14,356 节点 / 71,857 边
> 边类型: shared_tag 38,930 (54.2%) | cross_site 29,927 (41.7%) | co_topic 3,000 (4.2%)
>  引用边: 0 ← 而 data/citation-edges.json 里有 28,001 条真实引用边，线上端点也已暴露

本次实测：

| 项 | v2 报告 | 本次 | 变化 |
|---|---:|---:|---:|
| 节点数 | 14,356 | **36,107** | +151.5% |
| 边总数 | 71,857 | **99,725** | +38.8% |
| 引用边 | **0** | **27,868** | +∞（从 0 到 27,868） |
| 引用边占比 | **0%** | **27.94%** | ✅ 远超验收线 20% |

节点从 14k → 36k：因为本次图谱把 `citation-edges.json` 里出现的实体作为**独立节点**加了进来
（这些实体此前只在 `citation-edges.json` 里活着，没有进 `knowledge-graph.json` 的节点表）。

## 5. 为什么这条修得动 ROI 最高

v2 报告 §3.3 判读：

> 后果：`graph_search` 工具返回的是"这两个实体打了同一个标签"，而不是"这篇引用了那篇"——
> 前者对科研用户几乎没有价值，而引用关系才是科研知识图谱的核心资产。

现在：

1. **`graph_search` 能返回真实的引用方向**：`relation=citation` 且 `source` → `target` 是引用者→被引者
2. **`MCP` 工具层可以直接过滤**：`getNeighbors(entityId, relation='citation')` 一次调用给出所有真实引用链
3. **对外口径成立**：README 中"知识图谱 36,107 节点 / 99,725 边（含 27,868 条真实引用边）"
   是可复现的事实，不再是"每条带 confidence"式的可被一眼证伪的表述

## 6. 后续动作（本轮未做，写清边界）

| 动作 | 说明 |
|---|---|
| 引用权重加权 | 当前 `weight: 1` 统一。可后续按引用频次加权（同一对被引 3 次 = 权重 3） |
| 引用方向可视化 | 现在只有边数据，还没在 UI 侧画成有向图 |
| 引用路径查询 | 目前只有 1 跳邻居查询；跨 2 跳/3 跳的引用链需要单独加索引 |

这些不在本轮 P0 范围内，本轮只做"把边并进去 + 出证据"这一件事。

## 7. 复现命令

```bash
# 重建图谱（读 30 站 entities.json + data/citation-edges.json）
node tools/build-knowledge-graph.mjs

# 验证引用边占比
node -e "
const g = require('./data/knowledge-graph.json');
const c = g.edges.filter(e => e.relation === 'citation');
console.log('total edges:', g.edges.length);
console.log('citation:', c.length, '(' + (c.length / g.edges.length * 100).toFixed(2) + '%)');
console.log('unique source DOIs:', new Set(c.map(e => e.source)).size);
console.log('unique target DOIs:', new Set(c.map(e => e.target)).size);
"
```
