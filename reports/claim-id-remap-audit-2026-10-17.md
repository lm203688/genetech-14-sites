# Claim ID Remap 审计报告（G6）

> 生成时间：2026-10-17T07:26:20.820Z
> Identity-map 生成时间：2026-10-17T02:09:31.707Z

## 摘要

| 指标 | 值 |
|---|---:|
| 总引用 | 7 |
| canonical 命中 | 0 |
| alias→canonical（可自动 remap） | 0 |
| 未映射 | 7 |
| 空值 | 0 |
| 命中率 | **0.00%** |

## 建议 remap（alias → canonical）

_无 alias 需要 remap_

## 未映射唯一 ID（共 7，仅显示前 50）

| source | raw ID |
|---|---|
| extracted-claims.claims.id | claim:arxiv-2607.29613v1:ReinforcementlearningRLposttrainin |
| extracted-claims.claims.id | claim:arxiv-2607.29622v1:Visualimitationlearningenablesrobots |
| extracted-claims.claims.id | claim:oa:W2142197234:Brainactivityrecordednoninvasivelyis |
| extracted-claims.claims.id | claim:pmid:42529842:Stimulusresponsivehydrogelshaveemerg |
| extracted-claims.claims.id | claim:oa:W2784648116:Advancesinsoftroboticsmaterialssci |
| extracted-claims.claims.id | claim:oa:W2783801667:Previousworkhasdemonstratedtheversa |
| extracted-claims.claims.id | claim:oa:W2273215869:Thepresentarticleshowsthedevelopmen |

## 建议动作

❌ 7 条 ID 未在 identity-map 中命中。可能原因：
  1. 引用了裸 DOI 但未加 `doi:` 前缀
  2. 引用了未入库的实体（identity-map 只覆盖 30 站在库实体）
  3. 引用了已被 F5 合并掉的历史 ID（需检查是否有更完整的映射表）
  建议：先跑 `pipeline-data-accumulation.js` 或 `pipeline-library-expand.js` 补齐缺口，再重跑本校验。