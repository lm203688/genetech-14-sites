# GeneTech 14 站知识引擎 — 项目现状评估与实施记录

> 生成时间：2026-09-27 · 评估方式：基于真实文件/端点核查（非凭记忆）
> 评估维度：项目完整性（数据契约 / 可复现性）+ 能力层面（知识图谱 / 数据接入 / API）

---

## 一、评估结论速览

| 维度 | 评级 | 关键发现 |
|------|------|----------|
| 数据护城河 | 🟢 强 | 30 站 / 30 万实体 / 28.1% 带标签 / 12,862 跨站实体——语料规模真实 |
| API/端点 | 🟢 健康 | api.swarmlabs.tools（实体 200、语义检索 401 by-design）、license 200、data 文件 200 均正常 |
| MCP 工具 | 🟢 可用 | 已注册 6 个工具（list/query/get/semantic_search/export/ask） |
| 知识图谱 | 🔴 损坏 | 实体级图谱仅 98 节点/0 边（部署副本 4075/50 边）——实质无关系，是"玩具图谱" |
| 构建可复现 | 🔴 高风险 | `_site/data/*` 聚合产物仅存于 gitignored 的历史副本；build 每次 `rm -rf _site` 却不重新生成，重新部署即 404 |
| 数据接入(GAP A) | 🟡 半残 | `state/data-requests.json` 是空 `[]` 桩；声称的 3 个 MCP 接入工具实际未进 server |

**一句话**：底层数据资产扎实、API 与 MCP 可用，但"旗舰能力"（知识图谱）是空壳，且部署链路不可复现——这是当前最该修的两处。

---

## 二、完整性评估（Completeness）

### C1. 聚合数据产物不可复现（P0 风险）
- `build-site.mjs` 第 1848 行 `fs.rmSync(OUT,{recursive:true})` 每次清空 `_site`，但**不生成** `search-index.json / oss-registry.json / knowledge-graph*.json`。
- 这些文件此前只作为历史遗留副本存在于 gitignored 的 `_site/data/`，一旦重新部署 `data.swarmlabs.tools/data/*.json` 全部 404。
- 源 `data/` 此前仅跟踪 `knowledge-graph.json` 一个文件，三个大文件未纳入 git。

**已修复**：
- 将 5 个聚合产物落到源 `data/`（纳入 git）：`knowledge-graph.json`、`knowledge-graph-entities.json`、`search-index.json`、`oss-registry.json`、`data-requests.json`。
- `build-site.mjs` 新增 `syncAggregatedData()`：构建末把 `data/*.json` 复制到 `_site/data/`，并对关键契约文件做存在性守卫（缺失告警）。

### C2. 知识图谱实体文件损坏（P0）
- `data/knowledge-graph.json` = 98 节点 / 0 边；部署副本 `knowledge-graph-entities.json` = 4075 / 50 边。
- 根因：旧 `pipeline-self-db-build.js` 即便聚合也只产出 0 边（共现逻辑被限幅 / 标签覆盖不足），且从未覆盖真实 30 万语料。

**已修复**：
- 新建 `tools/build-knowledge-graph.mjs`，真正聚合全站：跨站桥接边（cross_site，12,862 实体→~21.8k 边）+ 主题共现边（shared_tag，连到 Top-300 标签枢纽）。
- 产物：**14,355 节点 / 37,734 边**（对比旧 98/0）。体积 7.87MB，控制在 Pages 99% 容量余量内。

### C3. 孤儿目录
- `_site_geo/`（Geo 变体静态站）、`consumer-sdk/`（空目录）为未跟踪、未完成的旁支工作流，长期残留。
- **建议（未实施）**：确认无引用后清理，或并入主站文档，避免仓库噪声。

### C4. 摘要回填不完整
- 各站摘要覆盖率参差（部分站点 <50%）。属于数据质量而非能力缺陷。
- **建议（未实施）**：继续跑摘要回填 pipeline 至 ~80% 目标。

---

## 三、能力评估（Capability）

| 能力 | 状态 | 说明 |
|------|------|------|
| 实体检索（关键词/语义）| ✅ | MCP `semantic_search` + API `/v1/search/semantic` 正常 |
| 引用导出（BibTeX/APA/RIS）| ✅ | MCP `export_citation` / `get_entity` |
| 自然语言问答 | ✅ | MCP `ask`（LLM 桥接，未配时退化列表）|
| 多站聚合目录 | ✅ | `/api/catalog.json` |
| 知识图谱关系发现 | 🔴 | 见 C2，现已重建有边图谱 |
| 数据接入闭环（需求→受理）| 🟡 | 见 C5 |
| 主题共现可视化 | ✅ | `graph.html` 消费 build 期生成的 `api/graph.json`（260 节点/4000 边，正常）|

### C5. 数据接入 GAP A 半残（P1）
- 前期报告声称已落地 `submit_request / retrieve_requests / intake_health` 三个 MCP 工具，但 `mcp-server/src/index.mjs` 实际只有 6 个检索工具，队列文件为空桩 `[]`。

**已修复**：
- 在 `mcp-server/src/index.mjs` 真实实现上述 3 个工具，落地到 `state/data-requests.json`（对象 schema，含 `requests[]` 与 `meta`）。
- fail-closed 设计：外部 agent 经 npx 拉起无仓库写权时，返回明确提示而非崩溃/静默丢请求。

---

## 四、本次已实施清单（Commit 内容）

1. `tools/build-knowledge-graph.mjs`（新增）— 真实聚合全站语料生成有边知识图谱。
2. `data/knowledge-graph.json` / `data/knowledge-graph-entities.json`（重建）— 14,355 节点 / 37,734 边。
3. `data/search-index.json` / `data/oss-registry.json` / `data/data-requests.json`（补回源）— 纳入 git，恢复可复现。
4. `tools/build-site.mjs`（修改）— 新增 `syncAggregatedData()` 复制 + 契约守卫。
5. `mcp-server/src/index.mjs`（修改）— 新增 `submit_request` / `retrieve_requests` / `intake_health` 三工具。
6. `state/data-requests.json`（重建）— 对象 schema。

---

## 五、后续建议（按优先级，待用户决策/授权）

- **P0**：把知识图谱重建接入 `ops-extra.yml` 定时任务（每日 03:00 UTC），避免再次腐化；并补充 `search-index.json` / `oss-registry.json` 的 CI 生成步骤（当前靠提交副本兜底）。
- **P1**：清理 `_site_geo/`、`consumer-sdk/` 孤儿目录；为 `data.swarmlabs.tools` 的 `data-requests.json` 增加网关 REST 写入端点（需 CF 手动部署）。
- **P2**：继续摘要回填至 ~80%；评估知识图谱是否需提供"实体-实体"直接边（当前为 实体↔站/标签 枢纽型，利于可视化与桥接发现）。
- **监控**：`pages-deploy.yml` 已对站点级 `index.json/entities.json` 做契约校验，建议把 `_site/data/*.json` 也纳入校验，防止聚合产物回归缺失。
