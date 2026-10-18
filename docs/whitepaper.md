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
- **L3**：`/v1/search/semantic` 语义检索 + MCP Server 对外分发

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
- **外部商业化 3 项硬阻塞**：Cloudflare Secret / npm + Glama / OpenAlex key，需用户操作。

详见 [`reports/P2-BLOCKED-ITEMS-2026-10-17.md`](../reports/P2-BLOCKED-ITEMS-2026-10-17.md) 与 [`reports/P2-DATA-HYGIENE-2026-10-17.md`](../reports/P2-DATA-HYGIENE-2026-10-17.md)。

---

## 八、归因规范

引用本知识库时请遵循 [`docs/attribution.md`](attribution.md)：
- 注明数据集来源（`data/knowledge-graph.json` 版本号）
- 注明唯一 DOI 数（见 data/metrics.json:uniqueDoi = 255,392；旧文档 276,769 为 identity-map 条目总数误标）
- 注明抓取日期（`data/knowledge-graph.json.builtAt`）
