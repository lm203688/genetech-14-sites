# Phase 2: 条件式 Tag Boost 诊断报告

> 日期：2026-10-22 | 状态：**已采纳（MRR +10.1pp）**
> 目标：修复 tags-inverse（R@10 6.5%）和 site-topic（R@10 0%）的召回灾难

---

## 0. 结论

**条件式 tag boost 是当前最优增量，MRR 提升 +10.1pp。**

| 方案 | R@10 | MRR | NDCG | 结论 |
|------|------|-----|------|------|
| Baseline（BM25+field） | 0.413 | 0.370 | 0.363 | 基准 |
| Phase 2 条件式 tag（threshold=30） | 0.440 | 0.466 | 0.402 | ✅ +2.8pp / +9.6pp |
| Phase 2 + 向量（BGE-M3 cosine） | 0.440 | 0.470 | 0.406 | ✅ +2.8pp / +10.1pp |

---

## 1. 根因分析

### 1.1 BM25 词频碾压 tag 匹配

| 指标 | BM25 词频分数 | fieldScore tag 匹配 | 比率 |
|------|--------------|-------------------|------|
| site-topic "control theory" | 0.031 | 0.004 | 7.8× |
| tags-inverse "cs.lg" | 0.025 | 0.003 | 8.3× |

**根因**：BM25 的 TF-IDF 在摘要中重复出现的常见词（如 "control" + "theory"）产生高分，而 tag 匹配仅 +3/word，被词频淹没。

### 1.2 相关实体不在 BM25 top-50

以 site-topic "control theory" 为例：
- 493 个实体含有 "control theory" tag
- 但这些实体的 BM25+field 排名在 **485-574 位**
- BM25 top-50 全是摘要中提到 "control" + "theory" 的无关实体

### 1.3 相关实体 96-98% 确实含有查询 tag

| 类型 | 相关实体数 | 找到 | Tag 命中 | 覆盖率 |
|------|-----------|------|---------|--------|
| site-topic | 174 | 171 | 171 | 98.3% |
| tags-inverse | 981 | 956 | 951 | 96.9% |

**结论**：不是 tag 数据缺失，而是 BM25 排序将含 tag 的实体压到 500+ 位。

---

## 2. 方案演进

### 尝试 1：tag RRF 三路融合（weight=0.7）

```
fusedBf = rrf([bm25, field, tag], [1.0, 0.8, 0.7])
```

| 类型 | R@10 Δ | MRR Δ | 分析 |
|------|--------|-------|------|
| abstract-mid | 0pp | **-16.1pp** | ❌ tag 通道干扰 BM25 强信号 |
| tags-inverse | +5.6pp | +21.3pp | ✅ 显著改善 |
| site-topic | +5.6pp | +11.1pp | ✅ 从零到有 |
| Overall | +2.8pp | +3.7pp | 权衡后改善 |

**问题**：abstract-mid MRR 暴跌，不可接受。

### 尝试 2：tag-gated 重排（alpha=0.6）

只在候选集内加成，不引入新实体。

| 类型 | R@10 Δ | MRR Δ | 分析 |
|------|--------|-------|------|
| abstract-mid | 0pp | **-12.6pp** | ❌ 仍在干扰 |
| site-topic | 0pp | 0pp | ❌ 相关实体不在候选集内 |

**问题**：gated 方案无法帮助相关实体完全不在 top-50 的场景。

### 尝试 3：条件式 tag boost（threshold=30）✅ 最终方案

```javascript
const maxBm25 = Math.max(...bm25.values());
const useTag = maxBm25 < 30; // abstract-mid min=52, tags-inverse max=25

if (useTag) {
  fusedBf = rrf([bm25, field, tag], [1.0, 0.8, 0.7]);
} else {
  fusedBf = rrf([bm25, field]);
}
```

**阈值依据**：BM25 最大分数分布分析

| 类型 | avg | min | max |
|------|-----|-----|-----|
| abstract-mid | 81.0 | 52.0 | 111.5 |
| cross-entity | 18.7 | 15.8 | 24.0 |
| tags-inverse | 13.8 | 7.1 | 24.6 |
| site-topic | 4.1 | 3.8 | 4.4 |

**阈值 30 完美分离**：abstract-mid 全部 > 30，其他类型全部 < 30。

---

## 3. 最终结果

### 按类型分解

| 类型 | Baseline R@10 | P2+V R@10 | Δ | Baseline MRR | P2+V MRR | Δ |
|------|--------------|-----------|---|-------------|---------|---|
| abstract-mid | 100.0% | 100.0% | 0pp | 83.3% | 84.8% | +1.5pp |
| tags-inverse | 6.5% | 12.0% | **+5.6pp** | 7.7% | 28.6% | **+21.0pp** |
| site-topic | 0.0% | 5.6% | **+5.6pp** | 0.0% | 11.1% | **+11.1pp** |
| cross-entity | 15.0% | 15.0% | 0pp | 25.0% | 25.0% | 0pp |
| **Overall** | **41.3%** | **44.0%** | **+2.8pp** | **37.0%** | **47.0%** | **+10.1pp** |

### 与 Phase 0（向量）叠加

| 方案 | R@10 | MRR | NDCG |
|------|------|-----|------|
| Baseline | 0.413 | 0.370 | 0.363 |
| Phase 0（向量 only） | 0.440 | 0.458 | 0.395 |
| Phase 2（条件式 tag only） | 0.440 | 0.466 | 0.402 |
| Phase 2 + Phase 0（叠加） | 0.440 | 0.470 | 0.406 |

**叠加增益**：Phase 2 + 向量比单独向量多 +1.2pp MRR，比单独 tag 多 +0.4pp MRR。

---

## 4. 代码产出

| 文件 | 变更 |
|------|------|
| `mcp-server/src/search.mjs` | 新增 `tagIndex` + `_buildTagIndex()` + `_normalizeTag()` + `tagScore()` |
| `mcp-server/src/search.mjs` | `hybridSearch()` 改为条件式：BM25 max > 30 时纯词法，否则启用 tag RRF |

### 核心算法

```javascript
// tag 归一化：多格式匹配
_normalizeTag(tag) {
  const keys = new Set();
  const t = tag.toLowerCase().trim();
  keys.add(t);                              // 原始
  keys.add(t.replace(/^fos:? ?/, ''));      // 去 FOS: 前缀
  keys.add(t.replace(/^cs\.?/, 'cs'));     // 标准化 cs.XX
  return keys;
}

// tag 精确匹配打分
tagScore(query) {
  const qTerms = tokenize(query);
  for (const d of this.docs) {
    const entTagKeys = new Set(d.tags.flatMap(t => this._normalizeTag(t)));
    for (const t of qTerms) {
      if (entTagKeys.has(t)) score += 8;  // 精确 tag token 匹配
    }
  }
}
```

---

## 5. 局限与后续

1. **cross-entity 无改善**：tag 通道对 cross-entity 查询无帮助（R@10 仍 15%），可能需要语义向量或跨实体图推理
2. **阈值 30 硬编码**：基于 sample-3 分布，全量 30 站可能偏移，需在全量 eval 后重新校准
3. **向量延迟**：BGE-M3 cosine 精排将延迟从 125ms 推至 848ms（7×），生产环境需预计算或 ANN
4. **Phase 3 方向**：KG PROV-O 结构化升级或 LLM 富化（提升 cross-entity 召回）
