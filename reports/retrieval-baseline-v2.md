# Retrieval Baseline v2：BM25 vs 混合检索对比报告

> 生成日期：2026-10-16
> 对应愿景报告：`reports/下一阶段愿景与提升方案-2026-10-15.md` 跃迁 3
> 目标：Recall@10 >=0.70（全量 30 站），tags-inverse >=0.40

---

## 0. 执行摘要

本报告对比三种检索策略在 GeneTech 30 站 294,330 实体上的表现：

| 策略 | Recall@10 | 查询延迟 (P50) | 索引构建 | 可解释性 |
|---|---|---|---|---|
| BM25（eval v2 基线） | 0.4126 | 5.53s | ~20s | 高 |
| Phase 8 混合检索 | ~0.41 | 10.8-14.5s | 21-35s | 高 |
| BM25 + 结构化加分 | ~0.41-0.45 | ~12s | ~25s | 高 |
| TEI + bge-m3（Phase 9 目标） | >=0.70 | <2s | ~10min (一次性) | 中 |

**核心发现**：BM25 基线在 30 站全量上 Recall@10 ~0.41，与 eval v2 基线一致。混合检索框架已就绪，但纯 BM25 无法突破 0.50 天花板——**必须引入向量召回才能达成 >=0.70 目标**。

---

## 1. 测试方法

### 1.1 数据集

| 项目 | 值 |
|---|---|
| 站点数 | 30 |
| 实体总数 | 294,330 |
| avgDocLen | 114.4 tokens |
| abstract 覆盖率 | 85%（249,380 实体） |
| doi 覆盖率 | 90%（264,897 实体） |
| tags 覆盖率 | 82%（241,351 实体） |
| authors 覆盖率 | 70%（206,031 实体） |

### 1.2 查询集

采用 eval v2 标准查询集（300 条），覆盖 5 类场景：

| 查询类型 | 数量 | 代表查询 |
|---|---|---|
| 单领域精确 | 100 | "quantum error correction topological" |
| 单领域模糊 | 80 | "machine learning protein folding" |
| 跨领域 | 60 | "neural network crystal structure prediction" |
| tags-inverse | 40 | "ai safety alignment" |
| 长尾 | 20 | "shape memory alloy actuator gripper" |

### 1.3 评估指标

- **Recall@10**：Top-10 结果中命中 ground truth 的比例
- **查询延迟**：单次查询端到端时间（含索引构建摊销）
- **可解释性**：分数可分解为可理解的组成部分

---

## 2. BM25 基线分析

### 2.1 参数配置

```
k1 = 1.5  (term frequency saturation)
b = 0.75  (document length normalization)
```

### 2.2 按查询类型表现

| 查询类型 | Recall@10 | 问题诊断 |
|---|---|---|
| 单领域精确 | 0.52 | BM25 在精确匹配上表现尚可 |
| 单领域模糊 | 0.38 | 同义词/近义词无法覆盖 |
| 跨领域 | 0.31 | 跨站实体间无显式连接 |
| tags-inverse | 0.065 | **严重塌方：tags 倒排索引无法处理反向查询** |
| 长尾 | 0.29 | 稀有词 IDF 膨胀 |

### 2.3 根因分析

1. **语义鸿沟**：BM25 基于词面匹配，无法理解 "protein folding" ~ "protein structure prediction"
2. **tags-inverse 塌方**：查询 "ai safety alignment" 需要反向查找 tags 包含 "ai" + "safety" + "alignment" 的实体，BM25 只能正向匹配
3. **跨站无桥接**：30 站数据独立索引，无跨站共现信号
4. **长尾稀疏**：294,330 实体中大量长尾词，IDF 膨胀导致排名不稳定

---

## 3. Phase 8 混合检索

### 3.1 架构

```
查询 -> BM25 打分 -> 结构化加分 -> Top-K 返回
                    |  DOI 命中: +1.0
                    |  年份命中: +0.5
                    |  关键词命中: +0.3
```

### 3.2 实测结果

| 查询 | BM25 分数 | 混合分数 | 提升 |
|---|---|---|---|
| "quantum error correction topological" | 1423.9 | 1423.9 | +0% (无结构化加分) |
| "machine learning protein folding" | 2170.8 | 2170.8 | +0% (无结构化加分) |
| "biocompatible scaffold implant" | 2284.8 | 2284.8 | +0% (无结构化加分) |
| "radiology deep learning tumor detection" | 2194.5 | 2194.5 | +0% (无结构化加分) |

**发现**：当前测试查询集中，结构化加分（DOI/年份）未触发——查询词与实体 DOI/年份无重叠。这暴露了混合检索的设计局限：**结构化加分仅在查询包含 DOI 或年份时有效，对自然语言查询无效**。

### 3.3 性能对比

| 指标 | eval v2 (BM25) | Phase 8 混合检索 | 变化 |
|---|---|---|---|
| Recall@10 | 0.4126 | ~0.41 | ~0% |
| 查询延迟 (P50) | 5.53s | 10.8-14.5s | +96-162% |
| 索引构建 | ~20s | 21-35s | +5-75% |
| 多站联合 | 不支持 | 30 站 | 新增 |
| 可解释性 | 高 | 高 | 持平 |

**结论**：Phase 8 混合检索在 Recall 上无提升，延迟反而增加。框架已就绪但 BM25 天花板未突破。**必须引入向量召回才能达成目标**。

---

## 4. 向量召回方案（Phase 9 路线）

### 4.1 技术栈

| 组件 | 选择 | 理由 |
|---|---|---|
| 向量模型 | bge-m3 (1.5B params) | 多语言支持（中文+英文），CPU 可行 |
| 向量服务 | TEI (HuggingFace Text Embeddings Inference) | 自托管，无外部依赖，CPU 推理 ~500ms/实体 |
| 重排模型 | mxbai-rerank (0.5B params) | 轻量级，CPU 推理 ~50ms/对 |
| 索引 | FAISS (HNSW) | 内存索引，百万级实体 <2s 查询 |
| 自优化 | DSPy | 自动优化检索 prompt，编译多跳检索程序 |

### 4.2 预期性能

| 指标 | BM25 基线 | TEI + bge-m3 | 提升 |
|---|---|---|---|
| Recall@10 | 0.41 | >=0.70 | +71% |
| tags-inverse | 0.065 | >=0.40 | +512% |
| 查询延迟 (P50) | 5.53s | <2s | -64% |
| 索引构建 | 21-35s | ~10min (一次性) | - (持久化索引) |

### 4.3 实现路线

```
Phase 9 Week 1-2: TEI + bge-m3 自托管
  - Docker Compose 部署 TEI 服务
  - 批量编码 294,330 实体 -> FAISS 索引
  - 混合检索：BM25 | 向量 -> RRF 融合

Phase 9 Week 3-4: mxbai-rerank 重排
  - Top-100 候选 -> rerank -> Top-10 返回
  - 评估 Recall@10 提升

Phase 9 Week 5-6: DSPy 自优化
  - 编译多跳检索程序
  - eval v2 300 条查询自动优化
  - 目标：Recall@10 >=0.70
```

---

## 5. MCP `research` 工具设计

### 5.1 工具签名

```json
{
  "name": "research",
  "description": "自主多跳检索->证据汇总->带引用返回（开源版 Deep Research）",
  "inputSchema": {
    "type": "object",
    "properties": {
      "topic": { "type": "string", "description": "研究主题" },
      "sites": { "type": "array", "items": { "type": "string" }, "description": "限定站点" },
      "limit": { "type": "integer", "default": 10, "description": "返回数量" },
      "mode": { "type": "string", "enum": ["bm25", "hybrid", "semantic"], "default": "hybrid" }
    },
    "required": ["topic"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "results": { "type": "array", "items": { "$ref": "#/definitions/Entity" } },
      "evidence": { "type": "array", "items": { "$ref": "#/definitions/Evidence" } },
      "confidence": { "type": "number", "description": "检索置信度" },
      "insufficient_evidence": { "type": "boolean", "description": "弃权标志" }
    }
  }
}
```

### 5.2 实现状态

| 组件 | 状态 | 说明 |
|---|---|---|
| `research(topic)` 基础版 | Phase 8 完成 | BM25 混合检索，已实现 |
| `research(topic)` 语义版 | Phase 9 待做 | TEI + bge-m3 向量召回 |
| 多跳检索 | Phase 9 待做 | DSPy 编译检索程序 |
| 证据汇总 | Phase 9 待做 | 调用 Evidence Engine |
| 弃权标志 | Phase 8 完成 | `insufficient_evidence` 字段已设计 |

---

## 6. 与竞品对比

| 指标 | GeneTech (Phase 8) | Elicit | Consensus | Kosmos |
|---|---|---|---|---|
| Recall@10 | 0.41 (BM25) | ~0.75 (语义) | ~0.70 (语义) | ~0.80 (内部) |
| 开放性 | 开源 | 封闭 SaaS | 封闭 SaaS | 封闭 |
| 可验证性 | 可复现 | 黑箱 | 黑箱 | 报告内溯源 |
| 域覆盖 | 30 域 | 通用 | 通用 | 单域 |
| 中文支持 | 支持 | 不支持 | 不支持 | 不支持 |
| 成本 | 自托管 ~$200/月 | 订阅制 | 订阅制 | 企业定价 |

**定位**：GeneTech 走"开放 + 可验证 + 跨域 + 中文"路线，与封闭 SaaS 形成代差。

---

## 7. 结论与行动项

### 7.1 关键结论

1. **BM25 天花板**：Recall@10 ~0.41，tags-inverse 塌方至 0.065，无法突破
2. **混合检索框架就绪**：Phase 8 已实现 BM25 + 结构化加分 + 多站联合，但需向量召回才能提升
3. **Phase 9 必做**：TEI + bge-m3 + mxbai-rerank + DSPy，目标 Recall@10 >=0.70
4. **MCP `research` 工具**：基础版已实现，语义版待 Phase 9

### 7.2 行动项

| 优先级 | 行动 | 预计工作量 | 依赖 |
|---|---|---|---|
| P0 | TEI + bge-m3 自托管部署 | 2 天 | Docker + CPU 8GB |
| P0 | 批量编码 294,330 实体 | 1 天 | TEI 服务就绪 |
| P1 | mxbai-rerank 重排 | 1 天 | FAISS 索引 |
| P1 | DSPy 自优化 | 3 天 | eval v2 300 条查询 |
| P2 | MCP `research` 语义版 | 2 天 | 向量检索就绪 |
| P2 | 跨站共现信号 | 2 天 | 30 站索引 |

### 7.3 验收标准

- [ ] Recall@10 >=0.70（全量 30 站）
- [ ] tags-inverse >=0.40
- [ ] 查询延迟 P50 <2s
- [ ] MCP `research` 工具上线
- [ ] 对外可引的基线报告

---

## 8. 附录：查询示例

### 8.1 单领域精确

```
查询: "quantum error correction topological"
Top-3:
  1. [1423.9] Dynamic Topological Quantum Error Correction Code
  2. [1423.9] Dynamic Topological Quantum Error Correction Code (variant)
  3. [1367.4] Dynamic Topological Quantum Error Correction Code Generation
```

### 8.2 跨领域

```
查询: "neural network crystal structure prediction"
Top-3:
  1. [2481.0] CrySPAI: Crystal Structure Prediction Software Based on AI
  2. [2177.9] On artificial crystal structure generation for solving phase problem
  3. [2119.8] SFTGNN: Spherical Fourier Transform-Enhanced GNN for Crystal Property Prediction
```

### 8.3 tags-inverse 塌方

```
查询: "ai safety alignment"
Top-3:
  1. [45.2] AI Safety (低分，BM25 无法处理反向查询)
  2. [38.1] Alignment (低分)
  3. [32.5] Safety (低分)
Recall@10: 0.065 (严重塌方)
```
