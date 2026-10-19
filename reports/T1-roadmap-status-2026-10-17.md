# T1 路线图执行状态表

> 日期：2026-10-17
> 定位：把「评估报告说要做」变成「做到哪了、下一步做什么、依赖哪个用户账号」的可追溯表。
> 上游：[`reports/项目全面评估与国际化竞品对标提升报告-2026-10-13.md`](项目全面评估与国际化竞品对标提升报告-2026-10-13.md) §6（T1-1 → T1-5 定义）
> 复核入口：[`reports/verify-online.md`](verify-online.md)

---

## 一、总览

| 项 | 目标 | 当前状态 | 完成度 | 下一步 | 依赖用户账号 |
|---|---|---|---:|---|---|
| **T1-1** | 跨源 ER（identity graph） | 🟡 骨架到位，样本级 | ~30% | 扩到全量 + precision 度量 | 无 |
| **T1-2** | 引用立场抽取（三分类） | 🟠 词典打分 | ~10% | 引入模型；补 span | 无 |
| **T1-3** | 向量混合检索 | 🟡 骨架（env-gated） | ~20% | 接入真 embedding + Recall 度量 | 无（本地 Ollama） |
| **T1-4** | 公开评测基准 | 🟡 量扩容完毕 | ~60% | 查询与答案不同源；multi-relevant | 无 |
| **T1-5** | 引用网络扩容 | 🟢 大幅扩容 | ~75% | 补 24% 剩余 DOI + 口径分离 | OpenAlex API key（G9） |

**整体完成度估算：约 40%**（加权平均，考虑各项对外承诺权重）。

---

## 二、逐项展开

### T1-1 · 跨源实体解析（ER）

**目标口径**（10-13 报告 §6）：
- 建 identity graph
- Precision ≥ 95%
- 跨 OpenAlex / Crossref / PubMed / Europe PMC / arXiv 的 DOI 归一

**本轮进展（Phase 13 F5）**：
- ✅ `lib/identity-map.cjs` 核心库落地
- ✅ `data/identity-map.json` 别名表生成（108 MB，276,769 唯一 DOI）
- ✅ `tests/identity-map.test.mjs` 断言覆盖
- ✅ `tests/invariants.test.mjs` INV2：同站 ID 唯一
- ✅ Canonical ID 规范：`genetech:<namespace>:<native>`

**当前实测数字**：
- 276,769 唯一 DOI（30 站合计 300,000 实体，去重率 7.6%）
- 跨站重复 DOI：15,013 条（Phase 13 §0 报告口径，已归一化）
- 反向映射（canonical → 所有别名）：**未做**

**差距**：
- Precision 度量未建立（需 ground-truth 集）
- 反向映射缺失
- Splink ER 试点（#288）已完成但未并入生产

**下一步动作**：
1. 生成反向映射（3-5 天）
2. 引入 Splink 全量跑（1-2 周）
3. 建 ground-truth 集（500-1000 对人工标注）（1-2 周）
4. Precision/Recall 度量入 CI

**依赖**：无（AI 可自主完成）

---

### T1-2 · 引用立场抽取

**目标口径**：
- 三分类：支持 / 反驳 / 提及
- F1 ≥ 0.8
- 带 span（原句片段）

**本轮进展**：
- ✅ `data/stance-entities.json` 骨架到位
- ✅ `data/stance-f1-eval.json` 评测框架（当前 macro F1 = 0.929，Phase 8 M2）
- ✅ `stance-robot-parts.json` 试点域

**当前实测数字**：
- 立场实体：仅小样本（未全库跑）
- 立场边（KG）：**0 条**（KG v5 只统计到 citation edges，未接入 stance）
- 词典打分准确率：宏观 F1 0.929（自证基准，非同源）

**差距**：
- 无模型化抽取（仍词典）
- 无 span 记录
- 未接入 KG v5

**下一步动作**：
1. 引入小模型（BERT 中文微调 / Qwen 2B 提示工程）
2. 抽 span 入 schema
3. 立场边入 KG v5（新增 `relation: "stance"`）

**依赖**：无（AI 可自主完成，走本地 Ollama / SenseNova 端点）

---

### T1-3 · 向量混合检索

**目标口径**：
- Recall@10 较 BM25 +≥30%
- 前提：T1-4 是有效基准

**本轮进展**：
- ✅ `mcp-server` 侧 hybridSearch 骨架（env-gated）
- ✅ BM25 基线跑通（30 站分片 35.39 MB gzip）
- ✅ `eval/queries.jsonl` 296 条评测
- ✅ `reports/counterfactual_trajectory.md` 反事实轨迹 API（向量邻近检索应用）

**当前实测数字**：
- BM25 基线：Recall@10 = 0.61（Phase 5 实测）
- 向量混合：**未启用**（env-gated，`HYBRID_RETRIEVAL=1` 默认关）
- 本地 embedding 端点：Ollama + SenseNova + GLM 三源就绪

**差距**：
- 未生成 embedding 索引
- 混合检索未入生产
- 混合检索与 BM25 差距未量化

**下一步动作**：
1. 生成全库 embedding 索引（~30 GB 磁盘，1-2 天跑批）
2. 接入混合检索（RRF 融合）
3. Recall@10 度量入 CI

**依赖**：无（走本地 Ollama / SenseNova；SenseNova 有免费额度）

---

### T1-4 · 公开评测基准

**目标口径**：
- 查询与答案**不同源**（打破循环基准）
- 引入 multi-relevant 评估
- 他人可复现

**本轮进展（T1-4 系列子任务已收官）**：
- ✅ #278 可复现评测 + 公开 leaderboard 骨架
- ✅ #302 Eval 集扩容（148 → 296 条）
- ✅ #303 协议版本如实化
- ✅ #304 首调延迟治理
- ✅ #305 评测基准改为非同源构造
- ✅ `eval/queries.jsonl` 296 条
- ✅ `eval/leaderboard-2026-10-12.html`

**当前实测数字**：
- 评测条数：296（非同源构造，seed=20261012）
- Leaderboard：已可复现（任何人可下载评测集独立跑）
- 基准指标：Recall@10 / MRR / Precision@K

**差距**：
- Multi-relevant 未实现（现单答案匹配）
- 未接入第三方评测集（如 MS MARCO 中文子集）
- Leaderboard 无自动更新流水线

**下一步动作**：
1. Multi-relevant 支持（0.5 天）
2. 接入 1 个第三方公开评测（1-2 天）
3. Leaderboard 自动更新（0.5 天）

**依赖**：无（AI 可自主完成）

---

### T1-5 · 引用网络扩容

**目标口径**：
- 种子 ≥ 20,000
- 边 ≥ 50,000
- 口径分离 resolved vs legacy

**本轮进展（Phase 13 F8）**：
- ✅ `data/citation-edges.json` v2 结构化（`{citing, cited, fromSite, toSite, resolvedAt, method}`）
- ✅ 4 类 method：openalex / crossref / europe-pmc / github
- ✅ 引用边 25,682 条（较 10-10 的 1,961 扩 13×）
- ✅ KG v5 引入 `citationEdges: 25682` + `citationEdgeShare: 0.26`
- ✅ `data/citation-edges.v1-backup.json` 保留 30 天

**当前实测数字**：
- 种子：1,634 学术种子（`data/academic-entities.json`）→ 距 20,000 目标还差 12×
- 引用边：25,682 真实解析 + 26,044 legacy merge = 51,726 总边
- 口径分离：**部分完成**（`resolvedEdges` vs `legacyEdges` 已分开字段，但未独立暴露）
- Parquet 30 站覆盖：76% DOI（未覆盖剩余 24%）

**差距**：
- 学术种子 1,634 → 20,000（差 12×）
- 引用边 25,682 → 50,000（差 2×）
- 24% DOI 未入 Parquet 分片
- OpenAlex 每日预算耗尽（429）

**下一步动作**：
1. OpenAlex API key（G9 硬阻塞，用户操作）
2. 换 Europe PMC 主源 + Crossref 辅源
3. Parquet 补 24% 剩余 DOI
4. 口径分离独立暴露（`/v1/citation/edges?scope=resolved`）

**依赖**：**OpenAlex API key**（G9 用户级硬阻塞）+ Crossref key（免费）

---

## 三、依赖用户账号汇总

**必须用户操作**（AI 无法替代）：

| 项 | 账号 / 操作 | 影响 T1 |
|---|---|---|
| G9 · OpenAlex key | 申请 → 写入 secrets | T1-5 直接依赖 |
| G3 · Cloudflare Secret | wrangler secret put | 阻塞 T1-3 线上暴露（本地跑不受影响） |
| G4 · npm + Glama | npm login + 上架 | 阻塞 T1-4 leaderboard 分发 |

**AI 可自主推进**（无外部依赖）：
- T1-1 反向映射 + Splink 全量
- T1-2 引入小模型 + 立场边入 KG
- T1-3 本地 embedding 生成
- T1-4 multi-relevant + 第三方评测集

---

## 四、优先行动建议

**本周可完成（AI 自主）**：
1. T1-1 反向映射（3-5 天）
2. T1-3 全库 embedding 索引生成（1-2 天）
3. T1-4 multi-relevant 支持（0.5 天）

**需用户配合后推进**：
4. T1-5 OpenAlex 扩库（等 G9）
5. T1-3 混合检索上生产（等 G3）

**长期（Phase 14+）**：
6. T1-2 立场抽取模型化
7. T1-1 Splink 全库 ER
8. T1-4 第三方公开评测接入

---

## 五、诚实口径

- 本表所有数字来自实测，非估计
- 完成度百分比为主观加权（无客观公式），仅供优先级参考
- T1-5 引用边 25,682 是"真实解析"口径，不含 26,044 legacy merge
- T1-4 评测基准虽"非同源"，但仍是自证（外部评测集未接）
- T1-3 向量检索未在生产启用，任何对外宣称"支持向量检索"都不准确

---

*本报告对应任务 #279。所有下一步动作均已排入 Phase 14 候选池。*
