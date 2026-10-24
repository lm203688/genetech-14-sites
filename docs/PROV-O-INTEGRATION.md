# Phase 3 — KG PROV-O 结构化升级设计

**状态**：Schema 骨架已落地（`data/schemas/knowledge-graph.schema.json` + `data/schemas/citation-edges.schema.json`），全图迁移为路线图。
**版本**：v1.0（2026-10-24）
**上游**：F10（时间戳 + 来源分级 tier）已完成，本方案在其字段之上叠加 PROV-O 语义命名。

---

## 1. 目标

把 KG 从「边 = 关系标签 + 时间戳」升级到「边 = W3C PROV-O 语义三元组」，让每条边都能被通用 PROV-O 工具链（OntologyWeb / SPARQL / PROV-DM）消费。目标数字：

- 边带时态率：现 ~95%（`validFrom` 已有）→ **100%**
- 边带 agent 归因率：现 0% → **100%**
- 边可导出为 PROV-DM JSON-LD：现不可 → **可导出**
- 下游工具（如 PROV-chain、Semantica）能直接消费：现不可 → **可消费**

## 2. PROV-O 三元组与现有字段的映射

| PROV-O 类 | 现有字段 | 约定前缀 |
|---|---|---|
| `prov:Entity` | `source` / `target` / `id` | `genetech:entity:{site}:{id}` |
| `prov:Activity` | `resolvedAt` | `genetech:activity:{doi}:published` |
| `prov:Agent` | pipeline 名 | `genetech:agent:pipeline:{pipeline}` |
| `prov:wasDerivedFrom` | citation edge（citing → cited） | 直接引用 target |
| `prov:wasAssociatedWith` | `tier` + `method` | `genetech:attribution:{tier}:{method}` |
| `prov:wasGeneratedAt` | `resolvedAt` | 同 `resolvedAt` |
| `prov:hadTime` | `[validFrom, validTo]` | ISO 8601 interval |

## 3. 存储格式

在 `data/knowledge-graph.json` 与 `data/citation-edges.json` 每条边上添加可选 `prov` 对象：

```json
{
  "citing": "10.1109/abc",
  "cited": "10.5555/xyz",
  "fromSite": "agritech",
  "toSite": "deep-sea-tech",
  "resolvedAt": "2026-10-16T17:18:43.441Z",
  "method": "v1-migration",
  "validFrom": "2026-10-16T17:18:43.441Z",
  "validTo": null,
  "tier": 4,
  "prov": {
    "entity": "genetech:entity:agritech:10.1109/abc",
    "activity": "genetech:activity:10.1109/abc:published",
    "agent": "genetech:agent:pipeline:pipeline-citation-edges-refs",
    "wasDerivedFrom": "genetech:entity:deep-sea-tech:10.5555/xyz",
    "used": "genetech:entity:deep-sea-tech:10.5555/xyz",
    "wasGeneratedAt": "2026-10-16T17:18:43.441Z",
    "wasAssociatedWith": "genetech:attribution:4:v1-migration",
    "hadTime": "2026-10-16T17:18:43.441Z/.."
  }
}
```

## 4. 路线图（3-5 天工作量估算）

| 步骤 | 内容 | 时间 |
|---|---|---|
| **S1** | Schema 骨架（本 PR） | ✅ 完成 |
| S2 | `tools/generate-prov-layer.mjs`：读 citation-edges.json 生成 prov 对象 | 1 天 |
| S3 | 迁移现存 25,682 引用边（backfill 脚本，幂等） | 1 天 |
| S4 | `lib/prov-serialize.mjs`：KG → PROV-DM JSON-LD 导出器 | 0.5 天 |
| S5 | 单测：`tests/prov-layer.test.mjs`（20 条不变量） | 0.5 天 |
| S6 | CI 门禁：`verify-prov-integrity.mjs`（每条边 prov.agent 必须匹配 pipeline） | 0.5 天 |
| S7 | 集成 Semantica 或自建 PROV-Web 工具链消费端 | 1-2 天 |

## 5. 与既有字段的关系

- **保留 F10 字段**：`validFrom` / `validTo` / `tier` / `resolvedAt` / `method` 继续存在，`prov.hadTime` 与 `prov.wasAssociatedWith` 只是引用它们，不重复存储。
- **前向兼容**：`prov` 字段完全可选，旧消费者忽略即可；新消费者按 W3C 规范读。
- **无 breaking change**：schema.json 已允许多字段并存。

## 6. 消费端场景

1. **SPARQL 查询**：用 PROV-O 通用查询语法找「某实体在 2020-2022 期间的上游」
2. **可视化**：PROV-chain.js 直接渲染 activity→entity→agent 链
3. **审计**：每条边可追溯到具体 pipeline + tier，符合审计要求
4. **跨库互操作**：OpenAlex / Semantic Scholar 未来若出 PROV-O 端点，可直接 merge

## 7. 不做什么（诚实边界）

- **不引入 Neo4j / Blazegraph**：JSON 存储足够，KG 34k 节点 / 99k 边规模下 RDF 存储过重
- **不做完整 Ontology Web 可视化**：Semantica 集成留给用户预算决策
- **不重构现有边**：只做 additive 添加 `prov` 对象，旧消费端零改动

## 8. 关联资产

- Schema：`data/schemas/knowledge-graph.schema.json`（`edges.items.properties.prov`）
- Schema：`data/schemas/citation-edges.schema.json`（`items.properties.prov`）
- 已有字段：`validFrom` / `validTo` / `tier` / `resolvedAt` / `method`（F10 已完成）
- 消费端参考：[W3C PROV-O](https://www.w3.org/TR/prov-o/) / [PROV-DM](https://www.w3.org/TR/prov-dm/)
- 工具参考：[PROV-chain.js](https://github.com/ProvCity/provchain.js) / [Semantica](https://www.pronova.biz/semantica/)
