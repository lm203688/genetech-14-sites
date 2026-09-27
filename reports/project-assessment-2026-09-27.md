# GeneTech 14 站知识引擎 — 项目现状评估与实施记录

> 生成时间：2026-09-27 · 评估方式：基于真实文件 / 远端 API / CI 运行记录核查（非凭记忆）
> 评估维度：项目完整性（数据契约 / 可复现性 / CI 健康度）+ 能力层面（知识图谱 / 数据接入 / API）
> **本版为修订版**：初版有 3 处结论因「本地克隆过期」而判断错误，已逐项更正并在第六节留档。

---

## 一、评估结论速览

| 维度 | 评级 | 关键发现 |
|------|------|----------|
| 数据护城河 | 🟢 强 | 30 站 / 30 万实体记录 / 284,073 唯一实体 / 50,065 标签种类 / 12,862 跨站实体——语料规模真实 |
| 站点级数据契约 | 🟢 健康 | 30 站 `index.json` + `entities.json` 齐备 |
| 聚合数据可复现 | 🟢 已修复 | 5 个聚合产物已落源 `data/` 纳入 git，build 期复制 + 契约守卫 |
| CI 健康度 | 🟢 健康 | `ops-extra.yml` 最近运行 69–74 全部 success；`pages-deploy.yml` 223–228 全部 success |
| 知识图谱 | 🟢 已修复并增强 | 由 98 节点 / 0 边（空壳）重建为 **14,355 节点 / 71,857 边**，含 3,000 条实体↔实体直接边 |
| 部署契约校验 | 🟢 已加固 | `pages-deploy.yml` 现对 `_site/data/*.json` 五个聚合文件做硬校验，缺失即 fail |
| 数据接入(GAP A) | 🟡 已修复 | 3 个 MCP 工具已进 server；初版发现的信封/数组格式错配会导致全链路 TypeError，已修复并通过 10 项功能测试 |
| 本地开发环境 | 🔴 严重过期 | 本地克隆落后远端 215 个文件（含全部 30 个 `entities.json`、6 个 pipeline 脚本）；11 个文件仅换行符差异 |

**一句话**：数据资产与线上 CI 扎实；最危险的隐患不是代码，而是「本地克隆严重过期」——它既让本次评估一度得出错误结论，也让直接在本机运行构建/推送成为高风险操作。已为此加了回归护栏。

---

## 二、完整性评估（Completeness）

### C1. 聚合数据产物不可复现（P0，已修复）
- `build-site.mjs` 每次 `fs.rmSync(OUT,{recursive:true})` 清空 `_site`，但**不生成** `search-index.json / oss-registry.json / knowledge-graph*.json`。
- 这些文件此前只作为历史遗留副本存在于 gitignored 的 `_site/data/`，一旦重新部署 `data.swarmlabs.tools/data/*.json` 全部 404。

**已修复**：
- 5 个聚合产物落到源 `data/` 纳入 git：`knowledge-graph.json`、`knowledge-graph-entities.json`、`search-index.json`、`oss-registry.json`、`data-requests.json`。
- `syncAggregatedData()` 构建末复制 `data/*.json` → `_site/data/`，并对关键契约文件做存在性守卫。
- 本次新增：`data/export/*.json`（数据需求交付产物）也随构建发布，`_site/data/export/`。

### C2. 知识图谱损坏 → 已重建并增强（P0）
- 修复前：`data/knowledge-graph.json` = 98 节点 / 0 边；部署副本 4075 / 50 边——无关系，是"玩具图谱"。
- 根因：旧 `pipeline-self-db-build.js` 共现逻辑被限幅 + 标签覆盖不足，且从未覆盖真实 30 万语料。

**已修复 + 本次增强**：
- `tools/build-knowledge-graph.mjs` 真实聚合全站 300,000 条实体记录 / 284,073 唯一实体。
- 产物：**14,355 节点 / 71,857 边 / 11.73MB**
  - `cross_site` 29,927 条（实体↔站枢纽，12,862 个跨站实体是桥接信号）
  - `shared_tag` 38,930 条（实体↔Top-300 标签枢纽）
  - `co_topic` **3,000 条（新增：实体↔实体直接边**，共享 ≥2 个枢纽标签的实体对，权重=共享标签数）
- 实测共现规模：按「每标签 Top-60 实体」抽样，299,274 个组合中 266,567 对共享 ≥2 标签——全量展开远超 12MB 上限，故硬限幅 3,000 条并让枢纽边优先占预算。

### C3. ~~孤儿目录~~ → 判断有误，撤回（重要更正）
- 初版把 `_site_geo/`、`consumer-sdk/` 判为"未跟踪、未完成的旁支工作流"，建议清理。
- **实测推翻**：远端存在 `consumer-sdk/intel_client.py` 等真实源码，本地只是缺失（属于下节 215 个过期文件之一）。**删除它们等于删除线上代码**，风险极高，已撤回该建议。
- `_site_geo/` 为 gitignored 构建产物（体积极大，`du -sh` 会超时），保留无碍。

### C4. 摘要回填进度（进行中）
- 当前覆盖率 67.8%，目标 80%；`pipeline-abstract-backfill.js` 已在 `ops-extra.yml` 的 `abstractbackfill` 任务中每日运行，CI 全部 success。
- 属于持续数据质量工程，非能力缺陷，无需代码改动。

### C5. 三个图谱写入者的回退风险（新发现，P0，已修复）
`knowledge-graph*.json` 有三个写入者，且顺序上后两者会把好图谱回退成玩具图谱：

| 任务 | 脚本 | 行为 |
|------|------|------|
| `selfdb` | `pipeline-self-db-build.js` | 写入 `knowledge-graph.json`，边数硬限幅 5,000 |
| `edge_refresh` | `tools/edge-builder.py` | 覆盖写 `knowledge-graph-entities.json`，tag-tag 共现 ≤5,000 |
| `kgbuild` | `tools/build-knowledge-graph.mjs` | **本次新增**，重建 14k/72k 好图谱 |

**已修复**：`ops-extra.yml` 新增 `kgbuild` 任务并置于所有生成步骤之后（最后写入者），保证好图谱不被降级；同时保留前两者作降级兜底。
**再加一道护栏**：`build-knowledge-graph.mjs` 新增回归守卫——若新图谱节点或边数低于既有图谱的 50%（旧图谱 ≥1000 节点时生效），**拒绝写入并 `exit 3`**。这防止 CI runner 拉取到不完整站点数据时，把好图谱覆盖成空壳。

### C6. 本地克隆严重过期（新发现，P0，操作风险）
- 本地 HEAD `c58817c`（基于 09-03 机器人提交），远端已到 `0cdaccf`（09-26）。
- **0 个文件仅本地有**，**215 个文件仅远端有**，**11 个文件两边不同**。
- 缺失项包括：全部 30 个 `*/website/api/entities.json`、6 个 pipeline 脚本（`pipeline-search-index.js` / `pipeline-oss-scan.js` / `pipeline-abstract-backfill.js` / `pipeline-openalex-expand.js` / `pipeline-s2-expand.v2.mjs` / `tools/edge-builder.py`）、`data/academic-entities.json`、`data/arxiv-hot.json` 等。
- 差异的 11 个文件经逐字节比对**全部为 EOL-only**（CRLF/LF），无内容漂移。
- **风险**：从过期克隆运行构建或推送，会用不完整数据产出退化产物，或把 215 个远端文件覆盖删除。

**已确认安全**：上一轮通过 API 推送的 commit `1fb8222` 经远端校验，保留了 pipeline-search-index / edge-builder / academic-entities 与 30 个实体集（839 paths），**未造成数据丢失**。

**处置**：不做破坏性对齐；后续推送前先 `probe-drift` 比对，并以远端内容为基准编辑。

---

## 三、能力评估（Capability）

| 能力 | 状态 | 说明 |
|------|------|------|
| 实体检索（关键词/语义）| ✅ | MCP `semantic_search` + API `/v1/search/semantic`（Pro key，401 by-design）|
| 引用导出（BibTeX/APA/RIS）| ✅ | MCP `export_citation` / `get_entity` |
| 自然语言问答 | ✅ | MCP `ask`（LLM 桥接，未配时退化列表）|
| 多站聚合目录 | ✅ | `/api/catalog.json`、`/api/graph.json` 等 |
| 知识图谱关系发现 | 🟢 已修复 | 14,355 节点 / 71,857 边，含实体↔实体直接边 |
| 跨域桥接发现 | 🟢 已修复 | `edge-builder.py` 补 tag-tag 共现，`kgbuild` 补实体↔标签枢纽 |
| 数据接入闭环（需求→受理）| 🟢 已修复 | 提交 / 幂等去重 / 筛选统计 / 自检 + 静态交付 URL |
| 摘要回填 | 🟡 进行中 | 67.8% → 80%，CI 每日运行 |

### C7. 数据接入 GAP A（P1，已修复）
- 事实更正：3 个 MCP 工具（`submit_request` / `retrieve_requests` / `intake_health`）**确实已注册**在 `mcp-server/src/index.mjs`，实现位于 `mcp-server/src/mcp-request.mjs`（远端 6,212B）。初版报告称"未进 server"是本地克隆缺失该文件导致的误判。
- **但存在真实缺陷**：实现把解析结果当**裸数组**调用 `.find()` / `.unshift()` / `.filter()` / `.length`，而线上队列文件是**对象信封** `{requests:[], meta:{}}`——每次调用都会抛 `TypeError`，全链路不可用。

**已修复**（`mcp-server/src/mcp-request.mjs`）：
- 读写统一走信封格式，读侧兼容裸数组与信封两种历史格式（fail-soft，文件损坏不阻断提交）；写侧一律输出信封并刷新 `meta.updatedAt`。
- 容量护栏：500KB / 300 条，超限按 200→100→50→20 分级滚动裁剪，保证写入永不因体积失败。
- **新增交付出口**：`pull` 模式提交即返回 `export_url = https://data.swarmlabs.tools/data/export/<request_id>.json`。管理员把结果写入 `data/export/<id>.json`，`build-site.mjs` 复制到 `_site/data/export/` 后由 Pages 发布。**未履约时 404 即为「尚未履约」信号**。

**10 项功能测试全部通过**：首次提交 / 7 天同指纹去重 / push 模式 `export_url` 为 null / 缺字段 fail-closed / 非法 priority fail-closed / 全量浏览 / 按状态筛选 / 按项目筛选 / 脱敏 `_fingerprint` / 自检。

### C8. Worker REST 写入端点（P1，暂缓——有绑定回退风险）
- 原计划为 `data.swarmlabs.tools` 的 `data-requests.json` 增加网关 REST 写入端点。
- **实测线上 Worker 绑定情况**：`genetech-api-guard`（账户 `8162aa3b…`）绑定 3 项——`INTEL_KV`（`4e05a0dd…`）+ `PRO_KV`（`270e48cd…`）+ `PRO_SECRET`，路由 `api.swarmlabs.tools{,/*}`。
- **风险**：`api-guard/deploy-api.mjs` 仅注入 `PRO_KV` + `PRO_SECRET`，直接重部署会**丢失 `INTEL_KV`**，导致 `/v1/intel/*` 全链路降级为 memory-only（重启即丢）。
- **处置**：改用 GitHub Pages 静态交付（见 C7），零部署风险达成同等目标。Worker 端点暂缓，待先把 `INTEL_KV` 补进部署脚本的 bindings 再实施。

---

## 四、本次已实施清单

1. `.github/workflows/ops-extra.yml` — 新增 `kgbuild` 任务（最后写入者）+ `workflow_dispatch` 选项，注释留档三写入者回退风险。
2. `.github/workflows/pages-deploy.yml` — `push.paths` 增加 `data/*.json`；契约校验扩展到 5 个 `_site/data/*.json` 聚合文件（缺失即 fail）。
3. `tools/build-knowledge-graph.mjs` — 新增 `co_topic` 实体↔实体直接边（限幅 3,000）；修 `--limit-nodes` 不生效（跨站集无条件塞入）；修 `argNum` 假零回落（`Number('0')||3000`）；`MAX_BYTES` 9→12MB 并写明真实容量依据；新增退化图谱回归护栏（`exit 3`）。
4. `tools/build-site.mjs` — `syncAggregatedData()` 增加 `data/export/*.json` 发布。
5. `mcp-server/src/mcp-request.mjs` — 重写为信封格式（兼容裸数组）、容量护栏、静态交付 `export_url`。
6. `mcp-server/src/index.mjs` — `submit_request` 描述补充 `export_url` 语义。
7. `state/data-requests.md` — 更正存储格式、交付机制、自动化状态三处不实描述。
8. `data/knowledge-graph.json` / `data/knowledge-graph-entities.json` — 重建为 14,355 节点 / 71,857 边。

---

## 五、后续建议

- **P0（需用户授权）**：对齐本地克隆到远端，消除 215 文件缺失。建议先 `git fetch` 核对后再决定 `reset --hard`，**切勿在过期克隆上直接构建或推送**。
- **P1**：修复 `api-guard/deploy-api.mjs` 的绑定清单（补 `INTEL_KV`），之后再评估 `/v1/requests/*` Worker 端点。
- **P1**：实现 `pending_review` 请求自动扫描派发（`ops-extra.yml` 加一个任务读取队列 → 触发 `pipeline-openalex-expand.js` / `pipeline-arxiv-hot-scan.js` → 写 `data/export/<id>.json` → 状态推进到 `in_progress`）。
- **P2**：继续摘要回填 67.8% → 80%（CI 已在跑）。
- **P2**：76.3%→35.3% 无标签实体仍是最大数据质量缺口；比加实体↔实体边更该做的是提升实体打标覆盖率。
- **监控**：CI 已健康（ops-extra 69–74、pages-deploy 223–228 全 success），建议保留 `probe-drift` 作为推送前必跑步骤。

---

## 六、初版结论更正留档（重要）

| 初版结论 | 实测结果 | 原因 |
|----------|----------|------|
| `_site_geo/`、`consumer-sdk/` 是孤儿目录，建议清理 | ❌ **错误**——远端有 `consumer-sdk/intel_client.py` 真实源码 | 本地克隆缺 215 文件，把"本地缺失"误判为"项目废弃" |
| `ops-extra.yml` 引用了 4 个不存在的脚本，是"静默空跑" | ❌ **错误**——6 个 pipeline 脚本远端全部存在，CI 运行 69–74 全部 success | 同上，本地缺 `pipeline-search-index.js` 等 |
| 知识图谱"实体-实体直接边"尚待评估 | ✅ 已实现 | 抽样实测 266,567 对共享 ≥2 标签，全量超限，故限幅 3,000 条落地 |
| GAP A 三工具"实际未进 server" | ❌ **错误**——工具已注册，但存在信封/数组格式错配 | 本地缺 `mcp-request.mjs`，看不到实现 |

**教训**：在过期克隆上做评估，会把"环境缺失"系统性误判为"项目缺陷"，并导出危险的清理/构建建议。评估必须先核对本地↔远端漂移。
