# 检索模式对比报告

生成时间: 2026-10-22T08:26:14.764Z

- Baseline: BM25 + 字段加权 + RRF（results-baseline-3site.json）
- Hybrid: BM25 + 字段加权 + 向量语义（BGE-M3）+ RRF（results-hybrid-gated-3site.json）

## 总体指标

| 指标 | Baseline | Hybrid | Δ |
|---|---|---|---|
| Query 数 | 30 | 30 | - |
| Recall@10 | 46.22% | 46.59% | +0.37pp |
| MRR | 43.21% | 45.75% | +2.54pp |
| NDCG@10 | 41.67% | 43.55% | +1.89pp |
| 完美召回 | 12 | 12 | 0 |
| 完全未召回 | 14 | 13 | -1 |
| 延迟 P50 | 93ms | 1101ms | - |
| 延迟 P95 | 248ms | 1349ms | - |

## 按查询类型分解

| type | n | Base R@10 | Hybrid R@10 | ΔR | Base MRR | Hybrid MRR | ΔMRR |
|---|---|---|---|---|---|---|---|
| abstract-mid | 12 | 100.00% | 100.00% | 0.00pp | 84.72% | 90.28% | 5.56pp |
| cross-entity | 5 | 24.00% | 24.00% | 0.00pp | 40.00% | 41.43% | 1.43pp |
| site-topic | 2 | 0.00% | 0.00% | 0.00pp | 0.00% | 0.00% | 0.00pp |
| tags-inverse | 11 | 6.06% | 7.07% | 1.01pp | 7.24% | 7.45% | 0.21pp |

## 结论

（自动生成，具体结论请结合 Δ 列判断）