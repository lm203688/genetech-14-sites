# 归因规范（Attribution Policy）

引用本知识库的内容时，请按下列方式标注。这不是礼节的请求，而是**数据授权条款的一部分**——
见 [`enterprise-data-license-kit.md`](enterprise-data-license-kit.md) 的授权范围一节。

## 一句话要求

如果你用了本知识库的实体、引用边或缺口数据，请注明**数据提供方**与**取数时间**，
并**不要把 DOI 之外的上游源当成本方声明**。

## 规范写法

```
数据源：GeneTech Knowledge Engine (api.swarmlabs.tools)，取数时间 2026-10-08，
本条目原始来源 Crossref / Europe PMC / PubMed（见 source 字段）。
```

英文等价：

```
Data source: GeneTech Knowledge Engine (api.swarmlabs.tools), retrieved 2026-10-08.
Original upstream: Crossref / Europe PMC / PubMed (see the `source` field).
```

## 三条硬约束

**1. 上游来源必须可追溯，但不能被本方"包办"。**

每条实体带 `source` 字段（`crossref` / `openalex` / `europepmc` / `pubmed` /
`datacite` / `arxiv` / `preprints` / `semanticscholar`）。
引用时请把 `source` 一并带上——因为**获取方式的合规责任在上游授权上，不在本方**。
2026 年 Anthropic 作者和解案（终审 $15 亿，约 $3,000/本）确立的判例把责任锚在
"获取方式"而非"训练行为"上，所以 provenance 是采购刚需，不是装饰。

**2. 不要把本方的加工说成上游的原始数据。**

本方做的是跨源归一、跨域桥接、缺口发现。引用时请区分：

- **原始记录** → 归上游（Crossref / PubMed / arXiv …）
- **本方的加工层** → 归 GeneTech Knowledge Engine

把 30 域结构、引用边、缺口矩阵说成"Crossref 提供的"是错误归因，会损害溯源能力。

**3. 单条引用请带 DOI，不要只带本方 id。**

本方实体 id（形如 `doi:10.xxxx`、`pmid:12345`、`oa:xxxx`）是**本方的检索句柄**，
不是外部可解析标识。请同时给 DOI/PMID，让第三方能独立复核——
这正是本知识库的立身之本（每条都能被第三方独立复核），
也意味着引用方有责任保留这条可复核路径。

## 机器可读索引

根目录 [`ai.txt`](../ai.txt) 面向 AI 系统，说明本方可以怎么被引用、
哪些内容可以进入下游训练/检索、以及应带上哪些字段。

## 与其他文件的分工

| 文件 | 回答什么 |
|---|---|
| 本文 | 引用时**必须注明什么** |
| [`consumer-onboarding.md`](consumer-onboarding.md) | 怎么**接上** |
| [`enterprise-data-license-kit.md`](enterprise-data-license-kit.md) | **授权范围**与切片报价 |
| [`../openapi.yaml`](../openapi.yaml) | 端点契约 |
| [`../ai.txt`](../ai.txt) | 给 AI 系统的机器可读说明 |

## 版本

- v1 · 2026-10-08 · 首版。落地 F6/D5：此前无对外归因规范页，
  `llms.txt` / JSON-LD 的归因要求也无处声明。
