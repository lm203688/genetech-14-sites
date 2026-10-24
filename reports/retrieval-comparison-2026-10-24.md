# 检索栈对比报告 — 2026-10-24 30 站全量

生成时间: 2026-10-24T05:xx:xx+08:00

## 三条基线（同期评测数据）

| 栈 | 数据源 | Query 数 | 覆盖站数 |
|---|---|---:|---:|
| **BM25 + 字段加权 + RRF** | `eval/results-2026-10-18.json` | 300 | 30 |
| **TF-IDF 余弦（词法向量）** | `eval/results-tfidf-2026-10-18.json` | 300 | 30 |
| **Hybrid: BM25 + BGE-M3 + RRF**（10-22 3 站 gate） | `eval/results-phase2-vector-3site.json` | 30 | 3 |
| **Hybrid: BM25 + BGE-M3 + RRF（Phase 2 全量）** | `eval/results-2026-10-22.json` | 300 | 30 |

## 30 站全量对比（10-18 → 10-22）

| 指标 | BM25 + RRF | TF-IDF 余弦 | **Hybrid Phase 2 (10-22)** | Δ Hybrid vs BM25 | Δ Hybrid vs TF-IDF |
|---|---:|---:|---:|---:|---:|
| Recall@10 | 0.444 | 0.455 | **0.468** | **+0.024** | **+0.013** |
| MRR | 0.425 | 0.466 | **0.481** | **+0.056** | **+0.015** |
| NDCG@10 | 0.391 | 0.433 | **0.418** | **+0.027** | **−0.015** |
| 完美召回 (R@10=1) | 119/300 | – | **119/300** | – | – |
| 完全未召回 (R@10=0) | 128/300 | – | **106/300** | **−22** | – |

## 按查询类型分解（Hybrid Phase 2, 30 站）

| type | n | R@10 | MRR | NDCG@10 | miss |
|---|---:|---:|---:|---:|---:|
| `abstract-mid` | 116 | **0.957** | 0.776 | 0.819 | 5 |
| `tags-inverse` | 115 | 0.183 | 0.331 | 0.192 | 58 |
| `cross-entity` | 39 | 0.113 | 0.279 | 0.127 | 24 |
| `site-topic` | 30 | 0.131 | 0.181 | 0.113 | 19 |

## 与 10-18 基线对比

- **总体 R@10**: 0.444 → **0.468**（+5.4%）
- **总体 MRR**: 0.425 → **0.481**（+13.2%）
- **tags-inverse**: 0.127 → 0.183（+44%，BGE-M3 语义向量对标签类查询最有帮助）
- **cross-entity**: 0.092 → 0.113（+23%）
- **site-topic**: 0.069 → 0.131（+90%，BGE-M3 对主题浏览最有帮助）
- **完全未召回**: 128 → 106（少 22 条 query 从 0 → >0）

## 结论（诚实定位）

1. **Phase 2 混合检索首次在总体 R@10 与 MRR 上超过 TF-IDF 基线**：
   - Hybrid vs TF-IDF: R@10 +0.013, MRR +0.015, NDCG@10 −0.015
   - 差异在 ±2pp 量级，需 3σ 内验证是否为噪声（30 站 seed 20261013 单次运行）
2. **NDCG@10 略低于 TF-IDF**：说明 top-10 排序质量未完全超越；可能需精排（reranker）进一步调优。
3. **弱查询类型仍未解决**：`tags-inverse` (0.183)、`cross-entity` (0.113)、`site-topic` (0.131) 均远低于 abstract-mid 的 0.957。**语义向量对这三类的帮助有限**（tags-inverse 需 tag 到实体的强索引，cross-entity 需跨域 ER）。
4. **定位**：数据集 + 基线词典检索栈**首次超过 TF-IDF 基线**，可对外宣告"混合检索栈在总体召回/MRR 上超越词法向量基线，但按类型分解仍是词典匹配主导"。
5. **不夸大**：Δ 值 1-2pp 量级，需多 seed 重复实验做统计显著性；且 NDCG@10 未超。

## 数据文件

- 主结果：`eval/results-2026-10-22.json`（generatedAt 2026-10-22T10:28:59Z，manifestSeed 20261013）
- 30 站聚合 4 类查询类型
- 基线：`eval/results-2026-10-18.json` + `eval/results-tfidf-2026-10-18.json`
- 3 站 gate：`eval/results-phase2-vector-3site.json` / `eval/results-phase2-conditional-tag-3site.json`

## 下一步

1. **多 seed 重复**：用 seed 20261013/14/15 三次运行，报均值 ± 标准差，确认是否显著
2. **精排调优**：接 BGE-Reranker-v2-m3 到 top-50 → top-10 精排，目标 NDCG@10 ≥ 0.45
3. **弱类型专项**：`tags-inverse` 建 tag 精确倒排索引；`cross-entity` 走 Phase 3 KG 图推理
