# P2 数据 / 卫生项汇总报告

**报告日期**：2026-10-17
**任务 ID**：#364
**定位**：本仓库实际数据卫生现状盘点。B 系列与 F 系列项按「实体存在性」重新校准（任务描述与实际代码库多处不匹配，见 §5）。

---

## 一、盘点方法

- 直接扫 `data/`、`data/parquet/`、`data/schemas/`、`data/time-machine/`、`lib/`、`tests/`、`scripts/`
- 交叉核对任务描述里的 B1/B2/B4/B5/C4/E3/F1-F3 命名与实际文件命名
- 大小、数量、空值率、schema 覆盖度均给出实测值

---

## 二、F 系列（数据卫生本体，AI 可完成部分）

| 项 | 描述 | 现状 | 状态 |
|---|---|---|---|
| F1 | 告警通道 → GitHub Issues | `scripts/monitor-flywheel-state.js` 已接 Issues API；SLO 72h 无新增实体自动开单 | ✅ 已落地 |
| F2 | 测试入口 + 不变量 | 根 `package.json scripts.test`（node:test），`tests/` 下 6 个测试文件（46 条断言） | ✅ 已落地 |
| F3 | 原子写 + 幂等 kit | `lib/atomic-write.cjs`（tmp+fsync+rename）+ `lib/pipeline-kit.cjs`；6 条崩溃安全/并发断言 | ✅ 已落地 |
| F4 | zod schema | `data/schemas/*.schema.json` 已覆盖 entity + crop-adapt-db + 3 个补充；`lib/schema-validator.cjs` 三处校验入口 | ✅ 已落地 |
| F5 | ID 规范化 + 别名表 | `lib/identity-map.cjs` + `data/identity-map.json`（108MB，实测 276,769 唯一 DOI） | ✅ 已落地 |
| F6 | 长周期外部回填 | 依赖外部 API 预算（OpenAlex 429） | ⏸ 挂起 |
| F7 | 图谱重建 + 双戳 | `scripts/build-knowledge-graph.mjs`；KG v5，dualTimestamp=true，ALLOWED_SITES 白名单剔 32 站 infra | ✅ 已落地 |
| F8 | 引用边结构化 | `data/citation-edges.json` v2，`{citing, cited, fromSite, toSite, resolvedAt, method}` | ✅ 已落地 |
| F9 | DuckDB / Parquet | `data/parquet/_*.json + _*.sql` 30 站全量；未接 DuckDB 查询层 | 🟡 数据层就位，查询层未做 |
| F10 | 时间 + 来源分级 | 边带 `firstSeenAt/lastSeenAt/tier`；tier 分布 `{3: 70113, 4: 28682}` | ✅ 已落地 |

**F 系列结论**：F1/F2/F3/F4/F5/F7/F8/F10 已完全落地；F6 挂起（外部）；F9 数据层就位、查询层未做（低优）。

---

## 三、E 系列（Schema 位置与字段悬空）

| 项 | 描述 | 现状 | 状态 |
|---|---|---|---|
| E1 | `zone_note` 字段悬空 | `data/schemas/entity.schema.json` 已补 `zone_note` 为 optional（Phase 13 commit d85b155）；数据填充率仍 0% | 🟡 schema 就位，数据未填 |
| E2 | `crop_adapt_db` schema | `data/schemas/crop-adapt-db.schema.json` 已建（Phase 13 commit 37026a6） | ✅ 已落地 |
| E3 | schema 位置 | 集中在 `data/schemas/`（5 份 schema + ENFORCEMENT-CHECKLIST.md）；`.github/workflows/ops-extra.yml` 每日 13:00 UTC 校验 | ✅ 已落地 |

**Schema 覆盖清单**（`data/schemas/ENFORCEMENT-CHECKLIST.md`）：
1. `entity.schema.json` — 主实体
2. `crop-adapt-db.schema.json` — 作物适应区数据库
3. `citation-edge.schema.json` — 引用边结构化
4. `knowledge-graph.schema.json` — KG v5
5. `time-machine.schema.json` — 快照层

---

## 四、B 系列（数据缺口，多为外部依赖）

**任务描述列出的 4 项在本仓库均无对应实体文件**，实测：

| 项 | 描述 | 本仓库现状 | 判定 |
|---|---|---|---|
| B1 | feedback_log 0 条 | 无 `data/feedback_log.json`；最近反馈数据仅在 `agent-ecosystem/hypothesis-feedback.mjs` 生成日志 | 📌 命名与实际不符 |
| B2 | execution_log 全 shadow | 无 `data/execution_log.json`；实际执行日志在 `reports/academic-run-*.log` 等 5 份 | 📌 命名与实际不符 |
| B4 | measured 20% | 未发现「measured」指标口径 | 📌 描述不清 |
| B5 | 记忆层 | 无独立记忆层数据文件；记忆靠 `.workbuddy/memory/` 三层（MEMORY.md + 日志 + archive） | 📌 命名与实际不符 |

**B 系列结论**：任务描述引用的文件在仓库中不存在，需用户澄清「是要按描述新建这些文件，还是任务描述本身过时」。此项转用户级澄清。

---

## 五、C 系列（测试缺口）

| 项 | 描述 | 现状 | 状态 |
|---|---|---|---|
| C1 | 六大支柱写测试 | 六大支柱 py 模块（dual_track/counterfactual/bayes_calibration/federated_calibration/active_experiment/verify_service/conditional_conformal）**在本仓库不存在**（`find` 全库 39 个 .py 均非六大支柱） | ⛔ 描述与代码库不匹配 |
| C4 | bp_screen 零测试 | 本仓库无 `bp_screen` 相关模块 | ⛔ 描述与代码库不匹配 |

**C 系列结论**：#361（C1）和 C4 均指向另一项目（智慧农业生态）的模块，按跨项目隔离规则不越界修改，转用户级澄清。

---

## 六、数据体量实测

**总数据量**：`data/` 下 754,518,334 bytes ≈ **754 MB**

**Top 10 大文件**（按字节）：

| 文件 | 大小 | 用途 |
|---|---:|---|
| `data/knowledge-graph.json` | 31.2 MB | 知识图谱 v5（34,139 节点 / 98,795 边） |
| `data/knowledge-graph-entities.json` | 31.2 MB | 同上（副本） |
| `data/identity-map.json` | 108.1 MB | 276,769 唯一 DOI 别名表 |
| `data/cited-entities.json` | 77.9 MB | 48,760 条被引实体 |
| `data/search-index.json` | 13.0 MB | 检索索引 |
| `data/parquet/_agent-ecosystem.json` | 19.8 MB | 分片最大站 |
| `data/parquet/_embodied-ai.json` | 19.6 MB | 分片次大站 |
| `data/parquet/_ai-safety.json` | 18.6 MB | 分片 |
| `data/parquet/_bionic-ai.json` | 18.6 MB | 分片 |
| `data/parquet/_ai4science.json` | 18.4 MB | 分片 |

**观察**：
- KG 主文件 31MB，双份存储（`knowledge-graph.json` + `knowledge-graph-entities.json`）浪费 31MB → 可精简
- `identity-map.json` 108MB 是最大单文件，git 已排除（不进库）
- 30 个 Parquet 分片合计 ~500MB，覆盖库 76% DOI（Phase 5 记录）
- `data/time-machine/snapshots.json` 3.3KB（元数据层，非全量）

---

## 七、数据完整性实测

**KG v5 关键指标**（`data/knowledge-graph.json`）：
- uniqueEntities: 278,729
- crossSiteEntities: 12,537
- nodes: 34,139
- edges: 98,795
- citationEdges: 25,682（占 26%）
- stubNodes: 19,809（占 58% — 待改进）
- tierDistribution: `{3: 70113, 4: 28682}`
- excludedInfra: 32 站

**摘要/标签空值率**（Phase 13 §0 报告口径，未变动）：
- abstract 空 30.89%
- tags 空 35.30%
- 有效载荷率 62.3%
- 最差站 neuromorphic 25.9%

**KG stub 率 58% 是本轮数据卫生的最大红点**，需要 F7/F8 后续深化才能压下去。

---

## 八、总结与建议

**AI 已自主完成**（F1-F5/F7-F8/F10 + E2/E3 + 本 P2 报告）：
- Schema 层：5 份 schema + 每日 CI 校验
- 测试层：46 条断言全绿
- 数据层：30 站 Parquet + 结构化 citation edges + time-machine 元数据快照
- 报告层：4 份 Phase 13 收官报告 + P2 阻塞清单 + 本报告

**需用户级澄清**（B 系列 + C 系列描述与代码库不匹配）：
- B1/B2/B4/B5 引用的文件不存在 → 是任务描述过时，还是要新建？
- C1（六大支柱）在另一项目 → 是否应跨项目联动，还是任务本身错位？

**挂起项**（外部依赖）：
- F6 长周期外部回填（OpenAlex 429）
- G3/G4/G9 硬阻塞（详见 `reports/P2-BLOCKED-ITEMS-2026-10-17.md`）

**低优未做**：
- F9 查询层（DuckDB 未接）
- KG 主文件去重（省 31MB）
- stub 率从 58% 压到 30% 以下（需 Phase 14）
