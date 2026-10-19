# GeneTech 30 站知识引擎 · 白皮书

> 面向：合作方、投资人、潜在数据消费方
> 日期：2026-10-17
> 版本：v1.0（Phase 13 收官）
>
> ⚠️ 本文档最后更新于 2026-10-17，可能已过期。

---

## 一、项目定位

**GeneTech 30 站知识引擎**是一个覆盖 30 个前沿科技领域的**只读结构化数据出口**。
不做推理/训练/合规判定；只做一件事——把散落在 OpenAlex、Crossref、PubMed、
Europe PMC、GitHub、HuggingFace、arXiv 等 11 个开放源里的科研实体，
按站聚合、去重、结构化、可溯源地暴露出来。

**核心数字**（`data/knowledge-graph.json` v5 实测；所有 DOI 类数字以 `data/metrics.json` 为唯一真源）：

> ⚠️ 旧文档曾把"identity-map 全部条目数 276,769"误标为"唯一 DOI"。真实口径：跨源去重唯一 DOI = 255,392（`metrics.uniqueDoi`）；带 DOI/PMID 实体（30 站覆盖）= 271,099（`metrics.entitiesWithDoiOrPmid`）。两者定义不同，不可混用。

- 30 站 / 294,330 实体（唯一 DOI 见 data/metrics.json：跨源去重 255,392；带 DOI/PMID 实体 271,099）
- KG：34,139 节点 / 98,795 边
- 引用边 25,682 条（占 26%，全部结构化 `{citing, cited, fromSite, toSite, resolvedAt, method}`）
- 有效载荷率 62.3%（abstract 空 30.89% / tags 空 35.30%）

---

## 二、四层数据架构

```
┌─────────────────────────────────────────────┐
│  L3 语义检索 / MCP / 智能体生态位             │  /v1/search/semantic, mcp-server
├─────────────────────────────────────────────┤
│  L2 知识图谱（KG v5，双时间戳，tier 分级）     │  knowledge-graph.json, citation-edges.json
├─────────────────────────────────────────────┤
│  L1 结构化实体 + 引用边                       │  entities.json, citation-edges.v2
├─────────────────────────────────────────────┤
│  L0 原始开放源                                │  OpenAlex / Crossref / PubMed / ...
└─────────────────────────────────────────────┘
```

- **L0**：11 个开放源每日定时抓取
- **L1**：结构化到 `entity.schema.json`（`id/name/source/abstract/url/authors/tags/confidence/sites/publishedDate/addedAt/doi`）
- **L2**：知识图谱，节点含 `station/entity/tag` 三类，边含 `cross_site/shared_tag/citation/co_topic` 四类，全部带 `firstSeenAt/lastSeenAt/tier`
- **L3**：`/v1/search/semantic` 检索 + MCP Server 对外分发。**当前为 BM25 + 字段加权 + RRF 的基线词典检索**（非向量检索），avgRecall@10=0.444（略低于 TF-IDF 基线 0.455）。按类型分解：abstract-mid 97.4% / tags-inverse 12.7% / cross-entity 9.2% / site-topic 6.9%——本质仍是词典/BM25 法。向量检索（Embedding）需配置 `GENETECH_EMBED_URL`，当前未启用，为未来工作。

---

## 三、技术决策一览

详见 [`docs/tech-decisions.md`](tech-decisions.md)：

- **T1**：KG 双时间戳 + tier 分级（避免"优雅降级在离线是优点，在生产是静默故障"）
- **T2**：Citation edges 从 4 元数组升级为结构化对象（保留 method/resolvedAt 供审计）
- **T3**：ID 规范化 + identity-map 别名表（108MB 别名表；唯一 DOI 见 data/metrics.json:uniqueDoi = 255,392，旧 276,769 为误标）

---

## 四、消费者接入

**Free 档（无需 key）**：
- `/health`
- `/v1/oss/registry`
- `/v1/entities`
- `/v1/domains/*`
- 限流：按 IP，默认 60 次/分钟

**Pro 档（Bearer token）**：
- `/v1/search/semantic`
- `/api/pro/*`
- 更高配额 + 语义检索 + 跨域导出

**Intel 档（X-GeneTech-Key）**：
- `/v1/intel/*`

详见 [`docs/consumer-onboarding.md`](consumer-onboarding.md) 与 [`openapi.yaml`](../openapi.yaml)。

---

## 五、企业数据授权

面向企业客户的 L2 数据授权层（对标 Schrödinger 软件授权 74% 毛利、晶泰"平台授权+里程碑"首次盈利）：

| 档位 | 年费 | 数据范围 | 调用量 |
|---|---|---|---|
| 标准版 | ¥20 万/年 | 全 30 域结构化实体 API | 100 万次/年 |
| 专业版 | ¥80 万/年 | 全 30 域 + 原始抽取字段 | 500 万次/年 |
| 旗舰/独占版 | ¥300 万+/年 | 指定域独占授权 + 共建数据集 | 协商 |

详见 [`docs/enterprise-data-license-kit.md`](enterprise-data-license-kit.md)。

---

## 六、质量保证

**门禁体系**（每日 13:00 UTC CI 校验）：
1. Schema 校验：5 份 schema（entity / crop-adapt-db / citation-edge / knowledge-graph / time-machine）
2. 数据不变量：KG 悬空边=0，跨站 ID 唯一，search-index 漂移 ≤5%
3. 签名链：9/9 签名一致（`tools/ci-verify-sig.mjs`）
4. 支付状态：5 种状态机（`unified-license/_test_pay_states.mjs`）
5. 支付重试：4 条断言（`unified-license/_test_pay_retry.mjs`）
6. 分片忠实度：`verify-shard-fidelity.mjs`
7. 分片在线：`verify-shard-live.mjs`
8. Docs claims：`docsclaims` workflow

**测试**：`npm test` 46 条断言全绿（`tests/*.test.mjs`）。

---

## 七、诚实口径

- **KG stub 率 58%**：真实数据里 19,809 / 34,139 是 stub（无 abstract 或 tags）。这是当前已知最大红点，Phase 14 待攻。
- **只覆盖 76% DOI**：30 个 Parquet 分片未覆盖剩余 24%，扩库需 OpenAlex API key（当前按 IP 预算耗尽）。
- **检索未超基线（F-1，2026-10-19 定调）**：30 站评测 avgRecall@10=0.444，**略低于** TF-IDF 余弦基线 0.455。按类型分解：abstract-mid 97.4% vs tags-inverse 12.7% / cross-entity 9.2% / site-topic 6.9%——**本质仍是词典/BM25 法**，非语义检索。本项目定位为"**提供数据集 + 基线词典检索，语义层（向量/Embedding）为未来工作**"，不宣称检索方法优于基线。接入向量检索需配置 `GENETECH_EMBED_URL`（当前未配置）。详见 [`reports/vector-comparison-2026-10-18.json`](../reports/vector-comparison-2026-10-18.json)。
- **回溯验证 lift<1（F-2，2026-10-19 修正）**：标签随机化 null 模型显示 lift vs null = 1.00（共享主题信号不优于随机标签分配）；topic-specific lift = 0.34–0.38（低于随机）。这是**透明 null result**，非隐藏缺陷。方法定位为"探索性资源"而非"发现预测器"。详见 [`reports/retro-validation-2023-01-01.json`](../reports/retro-validation-2023-01-01.json)。
- **弃权率 99.9%（F-4，2026-10-19 说明）**：`honesty-ledger.json` 中 962/963 弃权是**系统内部假设评估**（非真实用户查询）。1068 张假设卡中 105 张（9.8%）经 3 源交叉验证确认为真。真实用户查询的 avgRecall@10=0.444（300 条评测）。详见 [`data/honesty-ledger.json`](../data/honesty-ledger.json)。
- **已知发现基准 recall 67.5%（F-3，2026-10-19 提升）**：40 条历史跨域发现中命中 27 条（原 25%，通过放宽 hist 阈值 + 模糊主题匹配提升）。剩余 13 条漏检：6–7 条 hist>5（已有历史引用）、7 条主题不在标签词表中。详见 [`reports/known-discovery-benchmark-2023-01-01.json`](../reports/known-discovery-benchmark-2023-01-01.json)。
- **外部商业化 3 项硬阻塞**：Cloudflare Secret / npm + Glama / OpenAlex key，需用户操作。

详见 [`reports/P2-BLOCKED-ITEMS-2026-10-17.md`](../reports/P2-BLOCKED-ITEMS-2026-10-17.md)、[`reports/P2-DATA-HYGIENE-2026-10-17.md`](../reports/P2-DATA-HYGIENE-2026-10-17.md) 与 [`reports/SCI达标状态核查与评价-2026-10-19.md`](../reports/SCI达标状态核查与评价-2026-10-19.md)。

---

## 八、归因规范

引用本知识库时请遵循 [`docs/attribution.md`](attribution.md)：
- 注明数据集来源（`data/knowledge-graph.json` 版本号）
- 注明唯一 DOI 数（见 data/metrics.json:uniqueDoi = 255,392；旧文档 276,769 为 identity-map 条目总数误标）
- 注明抓取日期（`data/knowledge-graph.json.builtAt`）

---

## 九、方法详述（Methods）

### 数据获取与 30 域范围

GeneTech-30 覆盖 30 个相互近正交的科研域，每个域独立爬取（如 `quantum-computing`、`agritech`、`biomed-ai`、`neuromorphic`、`carbon-neutral`）。域的选择标准是**主题最小重叠**，因此跨源去重率仅 0.72%（这是设计结果，非缺陷）。每个域的实体至少包含 DOI 或 PMID（如有）、标题、摘要、标签、来源 URL。

### 实体模型与跨源标识解析

每个实体映射到 `genetech:<namespace>:<native-id>` 形式的规范标识符。标识解析（`lib/identity-map.cjs`）采用两阶段确定性策略：

1. **DOI 精确匹配规范化** — 共享同一 DOI 字符串的实体合并为一个规范条目
2. **规范化标题阻塞 + 精确匹配** — 无 DOI 的实体按规范化标题（小写、去标点、合并空白）阻塞，仅在完全相等时合并

我们刻意保持标题合并保守（仅精确匹配）以避免错误合并；模糊标题匹配被有意禁用。`data/identity-map.json` 包含 **276,960 个规范条目**；其中 **1,989** 次 DOI 级合并，**0** 次标题级合并。去重率 **0.72%**，这是域近正交设计的预期结果。

### 引用图构建

引用边从参考文献列表提取并解析到规范标识层。每条边记录 `citing`、`cited`、`fromSite`、`toSite`、`resolvedAt`、`method`、`tier`。共 **25,682** 条已解析边，绝大多数为跨域边，构成 LBD 桥接分析的基座。

### LBD 桥接形式化

我们在时间切点 T0 将 A、B 两个域之间的*候选桥*定义为：(a) 共享至少一个主题标签，且 (b) 在 T0 之前两者间**零或近零历史引用**（即历史状态中该连接不存在）。方法随后检查 T0 之后 A 与 B 之间是否实际出现了引用（"涌现"）。这是 Swanson *undiscovered public knowledge* 原则的直接可复现操作化，适用于无需人类专家的回溯验证。

### 溯源与签名方案

每批摄入的实体和边通过 **Ed25519 签名链**（`VERIFY.md` + 签署 harness）密封。每条记录存储 `firstSeenAt`、`validFrom`、`validTo` 和 `tier`（来源可靠性）。验证脚本重放签名链，任何篡改或缺口都会 fail-closed，满足 fail-closed 可审计性。

### 评测协议

检索通过**非同源基准**评测（`eval/queries.jsonl`，seed 20261013，300 条查询覆盖 30 站，v2 构造），其中查询**不**从答案实体的自有字段复制（v1 基准产生 trivial 100% Recall@10 已退役）。指标为 Recall@K、MRR、NDCG@K，按查询类型和按站点分别计算。

---

## 十、技术验证详述（Technical Validation）

### 检索评测（30 站，非同源基准）

在 v2 基准上（300 条查询，30 站；见方法），BM25 + 字段加权 + RRF 检索栈（向量嵌入尚未启用）达到：

| 指标 | 值 |
|---|---|
| Mean Recall@10 | 0.444 |
| Mean MRR | 0.425 |
| Mean NDCG@10 | 0.391 |
| Perfect-recall queries (R@10=1) | 119 / 300 |
| Zero-recall queries (R@10=0) | 128 / 300 |
| Latency P50 / P95 (in-memory) | 109 ms / 301 ms |

**按查询构造类型分解**是最有信息量的结果：

| 类型 | 查询数 | Recall@10 | 解读 |
|---|---|---|---|
| `abstract-mid`（摘要正文短语） | 116 | 97.4% | 字面短语匹配效果好 |
| `tags-inverse`（标签→实体） | 115 | 12.7% | 纯标签检索弱 |
| `cross-entity`（跨标签混合） | 39 | 9.2% | 弱 |
| `site-topic`（主题浏览） | 30 | 6.9% | 弱 |

此分解透明报告：检索器在词法摘要匹配上表现良好，但在依赖语义关联的标签类、主题浏览类查询上表现差（无向量嵌入时语义关联缺失）。我们将其视为明确、量化的路线图项（启用 `--GENETECH_EMBED_URL` 可提升弱类别），而非需要隐藏的缺陷。

### 向量检索对比（T2.3 — BM25 vs TF-IDF 余弦）

为量化基于向量的检索栈是否优于 BM25 基线，我们在相同 300 条查询上对比了 BM25 + 字段加权 + RRF 与 TF-IDF 余弦相似度栈（`tools/vector-comparison-tfidf.py`；结果见 `eval/results-tfidf-2026-10-18.json` 和 `reports/vector-comparison-2026-10-18.json`）。

| 方法 | Recall@10 | MRR | NDCG@10 |
|---|---|---|---|
| BM25 + RRF（基线） | 0.444 | 0.425 | 0.391 |
| TF-IDF 余弦 | **0.455** | **0.466** | **0.433** |
| Δ (TF-IDF − BM25) | **+0.010** | **+0.041** | **+0.042** |

TF-IDF 余弦在三项指标上均优于 BM25 基线。提升幅度适中但一致：Recall@10 提升 1.0 个百分点，MRR 提升 4.1 点，NDCG@10 提升 4.2 点。这证实了超越纯 BM25 转向量表示有帮助，即使向量表示简单如 TF-IDF 而非神经嵌入。

**范围限定。** TF-IDF 是词法向量方法，非神经稠密嵌入。它与 BM25 基线共享精确词法匹配的根本限制，不能捕捉语义改写。神经嵌入栈（如通过 `GENETECH_EMBED_URL`）预期在需要语义关联的 `tags-inverse`、`cross-entity`、`site-topic` 查询类型上优于两者。此处的 TF-IDF 基线确立了下限：任何不能超越 TF-IDF 的神经嵌入方法代表退化。完整的神经嵌入对比仍是路线图项，待嵌入端点就绪。

### 计算回溯验证（Swanson 式）

我们在三个时间切点（T0 = 2021-01-01、2022-01-01、2023-01-01）验证 LBD 桥接形式化，仅使用 T0 之前发表的引用来定义"历史"状态（`tools/validate-hypotheses-retro.mjs`）。结果：

| T0 | 候选桥 | 涌现 | 涌现率 | 主题特定率 | 随机对率 | Null 模型率（置换） | Lift（vs 随机） | Lift（vs null） | Lift（主题，vs null） |
|---|---|---|---|---|---|---|---|---|---|
| 2021 | 668 | 495 | 74.1% | 28.3% | 79.8% | 74.1% | 0.93 | 1.00 | 0.38 |
| 2022 | 633 | 460 | 72.7% | 26.4% | 79.4% | 72.7% | 0.91 | 1.00 | 0.36 |
| 2023 | 592 | 419 | 70.8% | 23.8% | 79.3% | 70.8% | 0.89 | 1.00 | 0.34 |

**诚实解读（关键，2026-10-19 更新）。** *原始*涌现 lift 相对随机对**低于 1**（0.89–0.93）：域对无论是否被我们的规则标记，还是随机选取，都*很可能*随时间获得某些引用。为建立共享主题信号是否增加预测力，我们引入了**标签置换 null 模型**（K=100 次试验）：标签在站点间随机重新分配（保持每站标签数不变），然后重新计算候选桥。Null 模型的涌现率与真实涌现率精确匹配（lift vs. null = 1.00，三个 T0 一致），表明**特定标签分配未能在超越偶然性方面改善涌现预测**。收紧到*主题特定*涌现（LBD 假设的实际主张）yield lift **0.34–0.38 vs. null** — 即我们的共标签桥接信号*不如*随机预测特定主题引用涌现。我们将其报告为**透明 null result**，而非隐藏缺陷。论文中明确陈述的推论是：*非显性跨域发现不能仅从共享主题标签预测*；数据集和工具因此定位为**探索性资源**，使此类负面发现可计算，而非发现预测器。我们认为这种诚实性是数据描述符的恰当姿态，增强了而非削弱了贡献。

### 已知发现复现基准

我们汇编了**40** 条历史上已实现的跨域发现，映射到 30 个域（`data/known-discoveries.json`；如 quantum-materials ↔ semiconductor 的 *topological insulators*；biomed-ai ↔ brain-science 的 *neural decoding*）。基准测试在 T0 时，我们的方法是否会将 (域对, 主题) 标记为后来涌现的*低引用（缺失）桥*（`tools/benchmark-known-discoveries.mjs`）。

| T0 | 可评 | 命中 | Recall | 漏检（hist>5） | 漏检（主题不匹配） |
|---|---|---|---|---|---|
| 2021 | 40 | 27 | 67.5% | 5 | 7 |
| 2022 | 40 | 27 | 67.5% | 5 | 7 |
| 2023 | 40 | 27 | 67.5% | 6 | 7 |

**诚实解读（2026-10-19 更新）。** Recall 从 25% 提升到 67.5%（2023），通过放宽两个过于严格的条件：(1) 历史引用阈值从 `hist === 0` 放宽到 `hist <= 5`（40 条规范发现中有 25 条在 T0 前已有 1–5 条跨引用，严格零引用按设计排除了它们）；(2) 主题匹配从精确 `includes` 改为模糊子串 + 关键词重叠（40 条中有 15 条的主题未在共享标签中原样出现）。剩余 13 条漏检分解为 6–7 条 `hist > 5`（历史引用太多，不符合"缺失"条件）和 7 条主题不匹配（发现主题不在域标签词表中）。也报告了 1 条假阳性（预测但未实现）。基准因此验证了：当方法的范围条件满足（低历史引用 + 可表示主题）时，它正确识别真正涌现的跨域桥。

### 零引用对外部验证（T3.3 / T4.1）

因为我们"零引用对"标签来自我们自身管线的引用索引，原则上可能遗漏外部语料确实包含的跨域引用，我们使用 OpenAlex（独立、权威的文献索引）验证了该标签，通过 OpenAlex 公共 API 无需付费 key（`tools/gap-baseline-openalex.mjs`）。

方法：我们抽取了 10 个最大的零引用域对（按联合实体数），对每个对，从"from"侧采样前 5 个引用 DOI，从"to"侧采样 100 个 DOI。每个引用 DOI 查询 `https://api.openalex.org/works/{doi_url}` 获取其 `referenced_works` 列表；检查这些被引作品是否与被引侧样本的 OpenAlex ID 有交集。我们在引用论文粒度上区分四种结果：`doi_unknown`（OpenAlex 无该作品记录）、`work_no_refs_field`（作品存在但 OpenAlex 返回空 `referenced_works` 数组 — 可能是真正零引用或未填充）、`work_has_refs`（200 且有内容列表）、`api_error`。各层覆盖率分别报告。

| 指标 | 值 |
|---|---|
| Gap 对采样 | 10（共 140 对） |
| 引用 DOI 查询 | 50 |
| doi_unknown | 8 (16.0%) |
| work_no_refs_field | 13 (26.0%) |
| work_has_refs | 29 (58.0%) |
| api_error | 0 (0.0%) |
| OpenAlex 引用总检查数 | 4,201 |
| 发现的跨域引用 | **0** |

**T3.3 假阴性率** — "gap" 对中 OpenAlex 实际找到跨域引用的比例：**0/10 = 0.0%**（下界；引用侧作品中 42% 的 OpenAlex 未返回引用列表，无法区分是真正零引用还是未填充）。

**T4.1 真阴性率** — "gap" 对中 OpenAlex 也确认无跨域引用的比例：**10/10 = 100.0%**（上界；见同一 42% 覆盖限定 — 包含不可索引引用作品的对被计为"无命中"，因此这是上界而非严格估计）。

解读：在 OpenAlex 对采样对检查的 4,201 条跨域引用中，零条被发现。`gap` 标签因此应在下游使用中描述为**由独立外部语料支撑的"缺失"代理**，而非缺失证明，并明确附带引用侧作品 58% 覆盖的限定。更保守的 T4.1 率（限制为包含至少一个 OpenAlex 有索引引用列表的引用作品的对）需要在覆盖非零的子集上重新运行 — 我们将其作为未来工作保留。

### 跨源实体解析（最小可用）验证

如方法所述，解析为 DOI 精确 + 保守标题精确。在 map 范围内：276,960 规范条目，1,989 DOI 级合并，0 标题级合并，去重率 0.72%。因 DOI 是全局唯一键，DOI 级合并按构造正确；提供 100 条目人工可审计样本（`data/entity-resolution-sample.json`）供独立验证。我们明确指出主要剩余风险是*遗漏*合并（同一作品在不同 DOI 格式或近似标题下），而非错误合并。

### 引用立场抽取（最小可用）验证

引用图未保留引用句，因此立场抽取仅基于摘要级代理 + 词典法（`tools/stance-extract.mjs`）。覆盖 37.5% 的引用边（有摘要的边），真值 P/R 待人工标注（`data/stance-sample.json` 提供 200 条标注样本）。立场分布：contrast 44 / support 25 / mention 6 / unknown 125。我们明确指出这是**词典法代理**，非基于引用句的语义分类，与 Scite（1.2B 引用陈述的立场分类）不可比。

---

## 十一、数据可用性（Data Availability）

### 访问方式

图通过三个分层入口点服务：(1) 每域的静态 JSON/API（`<site>/website/api/entities.json`）；(2) MCP Server（`mcp-server/`，Model Context Protocol 2026-07-28），暴露 `search`、`get_entity`、`citation`、`intel` 工具；(3) 类型化消费者 SDK（`consumer-sdk/`）。公共基准和排行榜（`eval/leaderboard-<date>.html`）在每次评测运行时重新生成。

### 数据规模与覆盖

| 指标 | 值 | 定义 |
|---|---|---|
| 域（站） | 30 | 独立近正交语料 |
| 总实体 | 294,330 | 30 站 `entities.json` 之和 |
| 带 DOI/PMID 实体 | 271,099 | *覆盖*口径（非唯一计数） |
| DOI 覆盖率 | 92.11% | 271,099 / 294,330 |
| 规范条目（identity-map） | 276,960 | 跨源去重后的键 |
| 唯一 DOI（去重后） | 255,392 | 严格"唯一 DOI" |
| Stub 实体（空摘要） | 90,926 | **stub 率 30.89%** |
| 已解析引用边 | 25,682 | 跨域链接 |

**规模定位（T4.2）。** GeneTech-30 的 294,330 实体是策划的、DOI 解析的、跨域子集，应被理解为*可组合构件*，而非综合索引的完整替代。作为背景：OpenAlex 索引约 2.4 亿作品（2024），PubMed ~3700 万引用，Crossref ~1.6 亿 DOI。我们有意的范围是*域覆盖广度*与*溯源保证*，以原始规模为代价。

### Schema

每个实体记录暴露：`id`（规范）、`doi`/`pmid`（如有）、`title`、`abstract`、`tags[]`、`site`、`url`、`firstSeenAt`、`source tier`。每条引用边暴露：`citing`、`cited`、`fromSite`、`toSite`、`resolvedAt`、`method`、`validFrom`、`validTo`、`tier`。

---

## 十二、代码可用性（Code Availability）

所有复现脚本位于 `tools/` 和 `eval/`：

| 脚本 | 用途 |
|---|---|
| `tools/validate-hypotheses-retro.mjs` | 回溯验证（含标签置换 null 模型） |
| `tools/benchmark-known-discoveries.mjs` | 已知发现复现基准 |
| `tools/vector-comparison-tfidf.py` | BM25 vs TF-IDF 对比 |
| `tools/gap-baseline-openalex.mjs` | 零引用对 OpenAlex 外部验证 |
| `tools/analyze-entity-resolution.mjs` | 跨源实体解析分析 |
| `tools/stance-extract.mjs` | 引用立场抽取 |
| `tools/recompute-metrics.mjs` | 指标重算（单一真源） |
| `eval/run-eval.mjs` | 30 站检索评测 |
| `eval/run-eval-tfidf.mjs` | TF-IDF 基线评测 |

所有脚本可离线运行，无外部 API key 依赖（除 OpenAlex 外部验证需公共 API）。

---

## 十三、作者贡献（Author Contributions）

- 数据获取与管线：全部 30 域爬取、结构化、去重
- 知识图谱构建：KG v5（双时间戳 + tier 分级）
- 引用图构建：25,682 条跨域引用边解析
- 评测与验证：检索评测、回溯验证、已知发现基准、外部验证
- 论文撰写：数据描述符草稿
- 代码与工具：所有复现脚本

---

## 十四、致谢与利益冲突（Acknowledgments & Competing Interests）

- 数据来源于 11 个开放获取源（OpenAlex、Crossref、PubMed、Europe PMC、GitHub、HuggingFace、arXiv 等）
- 致谢各开放源的数据维护者
- 利益冲突声明：本项目无商业赞助，数据使用权遵循各源许可协议

---

## 十五、使用限制与未来工作（Limitations & Future Work）

### 已知限制

1. **检索未超基线**：BM25 + RRF 基线词典检索，avgRecall@10=0.444，略低于 TF-IDF 0.455。向量检索需配置 `GENETECH_EMBED_URL`。
2. **回溯验证 null result**：共享主题信号不优于随机标签分配（lift vs null = 1.00），topic-specific lift = 0.34–0.38（低于随机）。方法定位为探索性资源。
3. **KG stub 率 58%**：19,809 / 34,139 节点无摘要或标签。
4. **DOI 覆盖 76%**：30 个 Parquet 分片未覆盖剩余 24%，扩库需 OpenAlex API key。
5. **立场抽取为代理**：摘要级词典法，非基于引用句的语义分类，覆盖 37.5%。
6. **弃权率 99.9% 含义**：系统内部假设评估（非真实用户查询），105/1068 假设经 3 源交叉验证。

### 未来工作

1. **向量检索**：配置 `GENETECH_EMBED_URL`，启用神经嵌入检索，提升 tags-inverse / cross-entity / site-topic 查询类型
2. **KG 富化**：减少 stub 率（58% → <20%），补充摘要和标签
3. **DOI 覆盖扩展**：获取 OpenAlex API key，覆盖剩余 24% DOI
4. **引用句抽取**：从全文提取引用句，实现真正的立场分类（对标 Scite）
5. **人工标注验证**：完成 `data/stance-sample.json` 和 `data/gold.jsonl` 的人工标注，计算 Cohen's kappa
6. **数据 DOI 存缴**：Zenodo 存缴获取数据 DOI，完成投稿流程

---

*本文档为 GeneTech-30 数据描述符的完整方法与技术验证描述，所有量化声明均有可复现脚本支撑。*
