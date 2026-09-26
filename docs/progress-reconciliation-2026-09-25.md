# GeneTech 14站 · 进程核对 + 开源技术扫描（2026-09-25）

> 依据：修正后的战略目标（`docs/strategy-infrastructure.md` / `MEMORY.md`「信息收集+结构化基础设施，与其他项目独立但需接受其数据需求」）。
> 方法：核对当前文件/接口/数据实际状态 + 一手 Web 检索（OSINT MCP 生态、知识图谱、前沿数据库）。

---

## 一、进程核对：对照「修正目标」的未完成板块

修正目标三句话：**①独立仓库/key/限流桶/Worker 已做；②对外规范接口已做；③但「其他项目提出数据需求」的双向通道只建了一半。**

### 1.1 已完成（绿）
| 板块 | 状态 | 证据 |
|---|---|---|
| 实体规模 | ✅ 30 站满容 30 万 | `state/db-health-history.json` |
| 摘要完整度 | ✅ 67.8%（+993 本轮） | 本地统计 203,404/300,000 |
| 对外接口 | ✅ OpenAPI 3.1，9 端点 + MCP 5 工具 | `openapi.yaml` / `mcp-server/` |
| P0 端点 | ✅ api/license/data 三域 200 | 09-25 实测 |
| cite-check | ✅ STRICT PASS | Extra Ops 绿灯 |
| 学术数据集 | ✅ academic/pubmed/crossref 已落 `data/` | 12.6/6.12/2.83 MB |

### 1.2 未完成板块（按你点出的核心排序）

#### 🔴 GAP A — 缺「数据需求 intake」接口（你最点出的核心矛盾）
- **现状**：所有对外接口**单向只读**。`openapi.yaml` 9 端点全是 `GET` + license 校验；MCP 5 工具 `list_sites / query_entities / get_entity / semantic_search / export_citation` **全部只读**。
- **矛盾点**：战略文档白纸黑字写「需要其他项目提出数据需求」，但**没有任何机制让下游（SwarmLabs / RoboParts / aishield）提交需求**——既不能「请为 embodied-ai 补 500 条带摘要实体」，也不能「请接入某新源 / 对某域做深度采集」。
- **本质**：独立性边界做到了（独立仓库/key/限流/Worker），但**双向通道只建了一半**，"独立"≠"孤立"，缺 inbound。
- **修复方向**（AI 可直接做）：
  - 新增 `POST /v1/requests`（或 MCP `submit_data_request`）：`{requester, domain, type, spec, priority}` → 落 `state/data-requests.json` → 每日闭环消费生成 backfill 任务并回写状态。
  - 或轻量复用 GitHub Issues（`data-request` 标签）→ 自动化转任务（已有 `docs/intel-application-form.md` 引用 issue，顺手接上）。
  - 这是把「其他项目提需求」从口头变成**规范化接口**的关键一步，直接对应你的修正目标。

#### 🔴 GAP B — 知识图谱功能基本为空（结构化功能短板）
- `data/knowledge-graph.json` 仅 **0.03 MB（空壳）**；`knowledge-graph-entities.json` 0.88 MB（旧版 12 站实体图，跨域桥接有限）。
- `docs/domain-graph.html` 消费的是 `db-health-history.json`（**per-site 健康仪表盘**），名字叫"图谱"本质却是监控面板——**不是实体关系图谱**。
- 真正的「跨域桥接 / 实体关系」结构化能力缺失，而"跨域桥接"恰是战略里对抗 Elicit/Consensus 的**差异化卖点**。
- 见第三部分，用 Graphiti 模式补齐。

#### 🟡 GAP C — 语义搜索仍是 token 加权，未向量化（W3-W4 计划未落地）
- `openapi.yaml` 注释明确："当前 token-based（13k 实体）… W3-W4 计划 embedding 向量化"。路线图 W3-W4 已过（今 09-25），embedding 未落地。
- 影响：跨域语义检索质量受限，Pro 档核心卖点打折。

#### 🟡 GAP D — 学术数据集已落地但未完全接线上检索
- `data/academic-entities.json`(12.6MB)/`pubmed-entities.json`(6.12MB)/`crossref-entities.json`(2.83MB) 已存在且 `build-site.mjs` 已复制；`openapi` 定义了 `/v1/academic/{entities,pubmed,crossref}`。
- 但 `semantic_search` 的 `source` 过滤只列 `arxiv/crossref/europepmc`，**未含 openalex/pubmed**；搜索索引是否覆盖学术数据集需核对。中等优先级，接线即可。

#### 🟡 GAP E — 商业闭环剩余硬阻塞（用户侧）
| 项 | 状态 |
|---|---|
| 虎皮椒凭据注入 license Worker | P0 已解 → **可推进**（用户本机 `wrangler secret put`） |
| Glama/Smithery 认领 `@genetech/data-mcp` | 未做 |
| genetech.tools NS mismatch | 用户改 NS |
| Enterprise「时间机器重放」 | 定价页写了但未实现 |

#### 🟡 GAP F — 护城河规模 vs 目标
- 现状 30 万（满容）+ 学术数据集~2 万条；目标 1M+（2028）。满容后增量只靠学术数据集 + OSS 注册表（0.61MB/数千条）→ 离 1M 甚远，需扩源（见第三部分）。

---

## 二、Osiris 评估（你给的仓库）

**结论：与本项目（科研/技术知识引擎）契合度低，不建议作为核心集成；仅可作「按需物理世界信号」外延源，且合规风险高。**

| 维度 | Osiris 实际情况 | 与本项目关系 |
|---|---|---|
| 定位 | 实时全球情报仪表板（Palantir 替代），聚合航班/海事/CCTV/地震/火灾/新闻/制裁/加密 | 物理世界态势感知，**非学术研究情报** |
| 技术栈 | Next.js 16 + MapLibre GL(WebGL) + RECON 工具包 | 前端聚合/渲染模式可借鉴 |
| 数据源 | OpenSky/USGS/NASA/NOAA/NVD/GDACS/FIRMS/OpenSanctions/t.me 等 | 与本引擎学术源无重叠 |
| 许可 | MIT | 可自托管 |

**可借鉴点（非直接集成）**：
1. RECON 工具包（whois/dns/cve/sanctions ↔ OpenSanctions 关联）的模式 → 可作 `agent-ecosystem / ai-safety / supply-chain` 域的"真实世界信号"补充，但**安全/合规边界需谨慎**。
2. 多源聚合 + WebGL 视口感知渲染 → 参考做领域图谱可视化前端。
3. Next.js API 路由归一化 JSON 的**数据接入层模式**可借鉴。

**更对口的情报收集 MCP 见第三部分**——Osiris 在本项目里是"锦上添花且高风险"，不是"雪中送炭"。

---

## 三、开源技术扫描（结构化 / 情报收集 / 前沿数据库）

### 3.1 情报收集提效（MCP / Skill）——按契合度排序
| 工具 | 类型 | 契合度 | 用途 |
|---|---|---|---|
| **BGPT MCP** | 科研论文结构化证据检索 | 🔥 高 | 返回 methods/样本量/结果/局限/质量分 → 补"结构化功能"+ claim 核验 |
| **arxiv / Semantic Scholar / OpenAlex / PubMed MCP** | 学术源直连 | 🔥 高 | 已有 pipeline 直连；包一层 MCP 让 AI agent 直接驱动 ingestion（下游"提需求→触发采集"） |
| osint-mcp / Tradecraft MCP / omega-mcp-server | 通用 OSINT（37/31/108 工具） | 中 | 跨源关联(correlate)模式可借鉴；直接集成合规风险高 |
| Firecrawl / Crawl4AI / exa / tavily MCP | 通用网页结构化抽取 | 中 | 扩广度层 |
| OpenCTI MCP | 威胁情报图谱(STIX/TAXII) | 低-中 | 若做 ai-safety 域可参考图谱建模 |

### 3.2 结构化功能提升（知识图谱 / 实体关系）——直接补 GAP B
| 工具 | 许可/星 | 说明 | 对口度 |
|---|---|---|---|
| **Graphiti (Zep)** | MIT / 24.8K★ | 时序知识图谱：实体+关系+validity window+来源溯源，hybrid retrieval <300ms，**原生 MCP** | 🔥 直接填 `knowledge-graph.json` 空壳 |
| mem0 | Apache-2.0 / 65K★ | 向量+图记忆，生态最全，偏对话记忆 | 轻量替代 |
| Neo4j / FalkorDB / Kuzu | 商用/开源 | 图存储后端，Graphiti 可挂 | 配套 |
| Cognee | 开源 | 异构数据→图检索 pipeline，含 MCP | 可参考 |
| **Science Data Lake** (arXiv 2603.03126, 2026-03) | CC0 | 293M 论文跨 8 源统一（OpenAlex/Semantic Scholar/SciSciNet/PwC/Retraction Watch/Reliance on Science/P2P/Crossref），DuckDB+Parquet；**BGE-large embedding ontology alignment（F1=0.77）** | 🔥 正是 W3-W4 embedding 计划的现成方案 + 广度层数据源 |

### 3.3 前沿数据库（扩源，结构化且可商用）
- **已用**：arXiv / Semantic Scholar / Crossref / EuropePMC / PwC / GitHub / HF。
- **建议新增**（开放/CC0 优先）：
  - **SciSciNet**（250M，disruption/atypicality/team-size 指标）→ 强补"研究空白/趋势"洞察
  - **Retraction Watch**（69K 撤稿标记）→ 直接服务 STRICT_CITE 门禁的 retracted 检测
  - **Reliance on Science**（47.8M 专利-论文引用）→ 技术转化信号
  - **bioRxiv / medRxiv / ChemRxiv**（预印本前沿发现）
  - **OpenCitations**（引用图，做知识图谱边）
  - **CNKI 开放版 / CiNii**（中/日文覆盖，破英文偏见）
  - **Zenodo / HAL / BASE / CORE / DOAJ / SciELO**（开放仓储聚合，地理多样性）

---

## 四、执行建议（优先级）

### P0 — 核心目标缺口（AI 可直接做）
1. **建数据需求 intake 接口**：`POST /v1/requests` + `state/data-requests.json` + 闭环消费任务（对应 GAP A，你点出的核心）。
2. **用 Graphiti 模式填 `knowledge-graph.json`**：实体关系图谱，替换空壳（对应 GAP B）。

### P1 — 提效（AI 可做）
3. 接 **BGPT MCP** 做结构化证据 / claim 核验层。
4. 把 ingestion 脚本包 MCP，让下游「提需求→触发采集」闭环（与 #1 衔接）。
5. **W3-W4 embedding 向量化**：直接复用 Science Data Lake 的 BGE-large ontology alignment 方法（补 GAP C + 扩源 SciSciNet/Retraction Watch/Reliance on Science）。

### P2 — 用户/合规侧
6. 虎皮椒注入、Glama 认领、genetech.tools NS、Enterprise 时间机器。

---

## 五、一句话总结
**最大未完成板块不是方向，而是「双向通道只建了一半」：独立性做到了，但"其他项目提数据需求"没有接口（GAP A）、跨域知识图谱是空壳（GAP B）。Osiris 偏物理世界 OSINT，不建议集成核心；真正提效的是 BGPT MCP（结构化证据）+ Graphiti（知识图谱）+ Science Data Lake（embedding 扩源方案）。**
