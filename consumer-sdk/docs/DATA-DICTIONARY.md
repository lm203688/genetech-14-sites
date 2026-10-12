# 数据字典（Data Dictionary）

本文件是消费方与内部管线之间的字段契约。管线改了字段含义，必须同步改这里——
否则样本包、SDK、API 文档三者会各自说一套。

## 记录级字段

| 字段 | 类型 | 必填 | 含义 | 备注 |
|---|---|---|---|---|
| `id` | string | ✅ | 本方检索句柄 | `doi:<DOI>` / `pmid:<PMID>` / `oa:<id>` / `arxiv:<id>` / `epmc:<id>`。**不是外部可解析标识**，引用时请同时给 DOI/PMID |
| `name` | string | ✅ | 标题 | 部分上游（arXiv）会带 LaTeX 标记，如 `\emph{...}`，消费方需容忍 |
| `source` | string | ✅ | 上游来源 | 枚举见下。provenance 的合规责任在上游授权上，不在本方 |
| `abstract` | string \| null | ❌ | 摘要 | 样本包里超 500 字符会截断，原长在 `abstract_chars`。**全量与全文走 API** |
| `url` | string | 推荐 | 记录规范 URL | 覆盖率实测 100% |
| `authors` | string \| string[] \| null | ❌ | 作者 | 上游格式不统一，可能已是字符串也可能是数组 |
| `tags` | string[] \| null | ❌ | 领域标签 | 由标签管线产出，覆盖率约 64% |
| `confidence` | number | ✅ | 派生质量分 | 见下方专节。**不是 source 的复制品** |
| `sites` | string[] | ✅ | 所属域 | 30 域之一或多个。跨站记录会出现在多个域的 entities.json 里 |
| `site` | string | 仅样本包 | 本条被抽样的所属域 | 样本包专用标记，API 记录里没有这个字段 |
| `publishedDate` | string \| null | ❌ | 上游发布日期 | 可能缺失 |
| `addedAt` | string | ✅ | 入库时间 | 本方元数据 |
| `quality_tier` | string | ✅ | 粗分档 | 由 confidence 派生 |
| `tagSource` | string \| null | ❌ | 标签来源管线 | 调试用 |
| `tagConfidence` | number \| null | ❌ | 标签置信度 | 调试用 |
| `tagGap12` | boolean \| null | ❌ | 12 标签缺口标记 | 调试用 |
| `abstract_chars` | number | 仅样本包 | 截断前摘要长度 | 仅在被截断时出现 |
| `abstract_truncated` | boolean | 仅样本包 | 是否被截断 | 仅在被截断时出现 |

## `source` 枚举

样本包实测分布（10,020 条，2026-10-08）：

| source | 条数 | 说明 |
|---|---:|---|
| `crossref` | 3,501 | Crossref 元数据 |
| `openalex` | 1,405 | OpenAlex |
| `datacite` | 1,324 | DataCite |
| `europepmc` | 1,286 | Europe PMC |
| `pubmed` | 1,264 | PubMed |
| `preprints` | 669 | 预印本平台 |
| `arxiv` | 549 | arXiv |
| `semanticscholar` | 22 | Semantic Scholar |

## `confidence` 专节（重要，读之前请先看这个）

`confidence` **不是**"这条记录有多可信"的通用分，也**不是** `source` 的复制品——
虽然它在历史上确实退化成过 `source` 的 one-hot 编码（信息量为零）。

当前口径（2026-10-08 重构后）：

```
confidence = f(上游权威度, 摘要完整度, 域相关度, 新鲜度, 被引强度)
```

三个使用约束：

1. **必须带 `source` 一起用。** 脱离 source 的 confidence 没有解释力。
2. **不要拿它做硬过滤。** 它是相对排序量，不是绝对阈值量。
3. **2026-10-08 之前的历史值不可信** —— 那是 source 的 one-hot 编码。

## `quality_tier` 派生关系

由 `confidence` 粗分档。用于快速分流（比如先跑高质量子集），不做精确判断。

## 站点与相对路径

30 个域各有自己的数据入口，路径形如：

```
<站>/website/api/index.json      # 站点索引（总量、lastUpdated）
<站>/website/api/entities.json   # 实体记录
```

这些是 **GitHub Pages 相对路径**，走 `https://data.swarmlabs.tools` 前缀。

⚠️ **30 个站点子域从未配置 DNS。** `https://quantum-computing.swarmlabs.tools`
这类地址不存在，不要拼。`api.` / `data.` / `license.` 三个子域是真实存在的平台域。

## 样本包

| 文件 | 内容 |
|---|---|
| `consumer-sdk/samples/sample-10k.jsonl` | 10,020 条，30 域各约 334 条，约 8 MB |
| `consumer-sdk/samples/sample-10k.manifest.json` | 生成时间、seed、来源分布、字段完整率 |

生成脚本：`operations-plan/pipeline-sample-pack.js`，固定 seed=20261008，可逐字节复现。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-08 | 首版。与样本包 sample-10k.jsonl 同时交付 |
