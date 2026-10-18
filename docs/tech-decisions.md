# 技术决策记录（ADR 汇总）

> 日期：2026-10-17
> 范围：Phase 13 收官的 3 项关键技术决策
> 状态：全部 Accepted

---

## T1 · KG 双时间戳 + tier 分级

**背景**：
Phase 12 之前，KG 边只有单一 `addedAt` 时间戳，无法区分「首次发现」与「最近观测」，
也无法表达"某边在离线环境优雅降级时静默失效"的风险。

**决策**：
1. 每条边带 `firstSeenAt` + `lastSeenAt`（双时间戳）
2. 每条边带 `tier` 字段（3 = 核心 / 4 = 次要）
3. `data/knowledge-graph.json` v5 强制启用（`dualTimestamp: true, tierEnabled: true`）

**实测分布**（`data/knowledge-graph.json`）：
- tier 3：70,113 条
- tier 4：28,682 条
- 总和 98,795 条 = edges 总数（无未分级边）

**理由**：
- 双时间戳支持"边被移除后仍可追溯其存在窗口"
- tier 分级支持下游按重要性裁剪，避免"全部数据一样大"造成的检索噪声
- 生产环境降级可识别：某边 `lastSeenAt` 长期不更新即告警

**风险与权衡**：
- 存储成本增加 ~15%（每边多 3 个字段）
- 迁移成本：旧边默认 tier=3、`lastSeenAt` 回填 `firstSeenAt`
- 未做：边的"失效时间戳"（`lastUnseenAt`）留待 Phase 14

**代码锚点**：
- `scripts/build-knowledge-graph.mjs`：边生成逻辑
- `data/knowledge-graph.schema.json`：schema 强制约束
- `tests/time-machine.test.mjs`：tier 分布总和断言

---

## T2 · Citation edges 结构化

**背景**：
Phase 11 之前，引用边以 4 元数组 `[doi, doi, siteA, siteB]` 存储，可读性差、
无法表达"这条引用是从什么来源解析出来的"，且无法支持后续的引用溯源审计。

**决策**：
将 `data/citation-edges.json` v2 升级为结构化对象：

```json
{
  "citing": "doi:10.xxxx/yyy",
  "cited": "doi:10.zzzz/aaa",
  "fromSite": "biomed-ai",
  "toSite": "agritech",
  "resolvedAt": "2026-10-16T08:15:00.000Z",
  "method": "openalex"
}
```

字段说明：
- `citing`：引用者 DOI（规范化为 `doi:10.xxx/yyy` 形式）
- `cited`：被引者 DOI
- `fromSite` / `toSite`：双方所属站点（GeneTech 30 站 slug）
- `resolvedAt`：解析出该引用的时间戳（UTC ISO 8601）
- `method`：解析方法（`openalex` / `crossref` / `europe-pmc`）

**实测**：
- `data/citation-edges.json` v2：25,682 条结构化引用边
- 占 KG edges 26%（`citationEdgeShare: 0.26`）
- 4 类 method 全覆盖

**理由**：
- `method` 字段支持"该引用是从 OpenAlex 解析还是 Crossref 解析"的可溯性审计
- `resolvedAt` 支持引用边时间序列分析（哪一批引用是哪天补进来的）
- 结构化对象比 4 元组在 JSON Schema 校验下更严格

**风险与权衡**：
- 存储体积从 4 元组（~50 bytes/边）增到结构化对象（~180 bytes/边），+260%
- 25,682 条 → 增量约 4.5MB（可接受）
- 已删除旧格式 `data/citation-edges.v1-backup.json` 保留 30 天供回滚

**代码锚点**：
- `data/schemas/citation-edge.schema.json`：schema 约束
- `data/citation-edges.json`：实际数据
- `data/knowledge-graph.json`：KG v5 `citationEdges: 25682` 字段
- `reports/claim-id-remap-audit-2026-10-17.md`：Claim ID 重映射审计

---

## T3 · ID 规范化 + identity-map 别名表

**背景**：
30 站原始数据里同一 DOI 出现 15,013 次（跨站重复），且不同源的 DOI 前缀写法不一致
（`10.1038/s41586-023-00001-0` vs `10.1038%2Fs41586-023-00001-0` vs `doi:10.1038/s41586-023-00001-0`）。
若不规范化，KG 会出现大量重复节点。

**决策**：
1. 建立 canonical ID 规范：`genetech:<namespace>:<native-id>`
2. 生成 `data/identity-map.json` 别名表，记录"原生 ID → canonical ID"映射
3. 所有下游模块（KG 构建、引用边、search-index）必须走 canonical ID

**实测**：
- `data/identity-map.json`：108.1 MB（最大单文件，git 排除）
- 跨源去重唯一 DOI = 255,392（`data/metrics.json:uniqueDoi`）；带 DOI/PMID 实体（30 站覆盖）= 271,099。注：旧文档把 identity-map 全部条目数 276,769 误标为"唯一 DOI"，已纠正（276,769 实为 canonical 条目总数，含大量无 DOI 的 arxiv/oa 条目）。
- `lib/identity-map.cjs` 提供 `canonicalize(rawId) -> canonicalId`

**理由**：
- 单点权威：所有下游模块只认 canonical ID，杜绝多处各自解析
- 别名表离线可查：任何 DOI 输入都能查到对应的 canonical ID
- 支持别名追溯：如"OpenAlex 用这个 DOI、Crossref 用那个 DOI，其实是同一篇"

**风险与权衡**：
- 单文件 108MB 加载慢（冷启动 ~2s）→ 后续应分片为按 namespace 索引
- 别名表生成依赖上游 DOI 抽取器，抽取器错就全错
- 未做：反向映射（canonical → 所有别名）需 Phase 14 补

**代码锚点**：
- `lib/identity-map.cjs`：核心库
- `data/identity-map.json`：数据文件
- `tests/identity-map.test.mjs`：断言
- `tests/invariants.test.mjs`：INV2 同站 ID 唯一

---

## 后续待决策

| ID | 主题 | 触发条件 |
|---|---|---|
| T4 | 分片策略（Parquet vs SQLite vs DuckDB） | Phase 14 查询层接入 |
| T5 | KG stub 率压降方案 | KG stub 58% → 目标 30% 以下 |
| T6 | OpenAlex 预算耗尽后的多源 fallback 优先级 | G9 阻塞解除后 |
| T7 | time-machine 是否引入 CRDT 支持离线合并 | 分布式写入场景出现时 |

---

## 决策原则

所有技术决策遵循：
1. **可溯性优先**：每个决策保留 `resolvedAt/method` 供后续审计
2. **诚实口径**：不隐藏已知缺陷（KG stub 58% 明示）
3. **门禁覆盖**：每个决策必须有对应测试或 schema 断言
4. **可回滚**：旧格式保留 30 天供回滚
