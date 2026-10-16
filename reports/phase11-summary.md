# Phase 11 收官报告 · 多源交叉验证打破循环论证

**日期**: 2026-10-16
**阶段**: Phase 10 抽样验证 → Phase 11 打破循环论证
**范围**: P11-A 多源交叉验证（P11-B concepts 抽取、P11-C 状态机入 abstention、P11-D wrangler 后 A2A 集成测试延后）
**主判据**: Phase 10 的 81 verified 中，≥90% 通过多源交叉验证

---

## 1. 结果快照

| 指标 | 值 |
|---|---|
| 被交叉验证张数 | 81（Phase 10 全部 verified） |
| **cross_verified** | **75 (92.6%)** |
| cross_weak（仅 1 源支持） | 6 (7.4%) |
| cross_falsified | **0** |
| 3 源全部通过 | 7 |
| 2 源通过 | 68 |
| 1 源通过 | 6 |
| avgConfidence | 0.652 |
| 达成主判据 | ✅ 92.6% > 90% |

---

## 2. 三种独立数据源

| 源 | 数据 | 数量 | 独立性 |
|---|---|---|---|
| V1 | `citation-edges.json` 原始边 | 25,682 | 相关（pairMatrix 的源头） |
| V2 | `cited-entities.json` OpenAlex 抓取 | 48,760 | **完全独立** |
| V3 | `academic-entities.json` Crossref 抓取 | 1,634 | 半独立（tags 是本项目打的） |

**判据**：≥2 源通过 → cross_verified，其中**至少 1 源必须是 V2 或 V3**（真正的独立外部证据）。

---

## 3. 关键发现：Phase 10 结论不是虚构的

| 类型 | 张数 | 主要验证通道 |
|---|---|---|
| emerging_topic | 30 | V2 concepts + V3 academic（V1 通常 0，因为是 gap pair）|
| litellbridge | 24 | V2 concepts + V3 academic（V1 全 0，本身是 gap）|
| moderate_bridge | 14 | V1 edges + V2 concepts + V3 academic（三源都通过）|
| crossref_topic_bridge | 13 | V1 edges + V3 academic（V2 常 0，因为 concepts 无交集）|

**7 张 3 源全部通过**：多为 moderate_bridge（agent-ecosystem→biomed-ai、agritech→new-energy、ai4science→edge-ai 等），证据最充分。

**6 张 cross_weak**（仅 V3 通过）：litellbridge 类型，gap pair 无引用边（V1=0）且 concepts 无交集（V2=0），只有学术实体存在（V3 支持）。这是**最诚实的"gap 但两站都有实体"**证据，弱但非零。

---

## 4. Phase 10 → Phase 11 关键数字跃迁

| 维度 | Phase 10 收官 | Phase 11 收官 | 差值 |
|---|---|---|---|
| verified_discoveries | 105 | 105 | 0 |
| cross_verified | — | **75** | 新增指标 |
| cross_verification_rate | — | **0.926** | 新增指标 |
| 循环论证暴露 | 是（Phase 10 遗留） | **否（v3 多源验证）** | 打破 |
| 签名链 | 9/9 PASS | 9/9 PASS | 保持 |

---

## 5. 工具链

| 工具 | 行数 | 职责 |
|---|---|---|
| `agent-ecosystem/hypothesis-verifier-v3-cross.mjs` | 294 | 3 源交叉验证器，打破循环论证 |

**与 v2 的区别**：
- v2 只用 pairMatrix（citation_edges 的汇总层）→ 循环论证
- v3 用 3 个独立数据源交叉，**不依赖 pairMatrix**，且要求至少 1 源是 V2/V3 独立源

---

## 6. 遗留与诚实性代价

### 6.1 关键诚实性记录（写入 `honesty-ledger.json.cross_verification`）

- **V2 完全独立**（independence_score 1.0）：OpenAlex 抓取的外部数据
- **V3 半独立**（0.6）：Crossref 数据 + 本项目 tags（tags 是我们自己打的）
- **V1 相关**（0.5）：与 pairMatrix 同源，只是不同层次

### 6.2 原计划失败：Crossref/OpenAlex 在线 API

- 会话期间测试 Crossref `/works/{DOI}` → HTTP 429 rate limit
- Crossref `/query` 端点 → 同样 429（IP 层限制，短时无效）
- **回退方案**：用本地已抓取的 OpenAlex/Crossref 数据（本质相同的外部源，独立于 pairMatrix 生成逻辑）
- 记入 `honesty-ledger.json.cross_verification.online_fallback_note`

### 6.3 未做 P11-B/C/D

- **P11-B**（concepts 抽取补 emerging_topic 池子）：需要 concepts 抽取 pipeline，超出本轮
- **P11-C**（abstention 入 hypothesis-queue 状态机）：状态机设计重构，需完整设计
- **P11-D**（wrangler 部署后 A2A HTTP 集成测试）：依赖 wrangler 部署，用户阻塞未解

---

## 7. 血泪教训（Phase 11 新增）

1. **循环论证要主动暴露**：Phase 10 的 57 verified 用 pairMatrix 生成 pairMatrix 验证——v2 验证器没意识到，直到 Phase 11 才发现。教训：**每个验证器都要问"我的验证源和被验证数据是不是同一个"**。
2. **多源交叉的独立性要诚实标注**：V2/V3/V1 三个源的独立性不一样（1.0/0.6/0.5）。要求 ≥2 源通过时，必须至少 1 源是独立源（V2 或 V3），否则 2 源都是 V1+V1（同源）也算"通过"就失去意义。
3. **在线 API 有 rate limit，本地镜像是可靠的回退**：Crossref/OpenAlex 免费层按 IP 预算限流（429），项目内已有 48,760 cited-entities + 1,634 academic-entities 是等价的外部源，且更稳定。
4. **cross_verified 是补充指标不是替代**：honesty_score 保持 0.822 不动（三账本公式产物），cross_verification_rate 0.926 是补充指标（记录在 `honesty-ledger.json.cross_verification`）。

---

## 8. 交付物清单

### 新增工具（1 个）
- `agent-ecosystem/hypothesis-verifier-v3-cross.mjs` (294 行)

### 新增数据
- `data/verification-runs/2026-10-16-v3-cross-run.json` — v3 交叉验证运行结果

### 更新
- `data/honesty-ledger.json` — 新增 `cross_verification` 段 + `cross_verification_bonus`
- `data/honesty-ledger.json.sig.json` — 更新签名

---

## 9. Phase 12 入口

- **P12-A**：引入真实在线外部验证（等 OpenAlex/Crossref 预算恢复，或换 Europe PMC 备用）
- **P12-B**：concepts 抽取补 emerging_topic 池子（Phase 9/11 遗留）
- **P12-C**：hypothesis-queue 状态机重构（proposed → investigating → verified/falsified/abandoned）
- **P12-D**：wrangler 部署后 A2A 端点 HTTP 集成测试（依赖用户解阻塞）

---

## 10. 用户账号硬阻塞（未变）

- `wrangler deploy` genetech-license Worker
- npm publish @genetech/data-mcp
- 飞轮解冻（45 天冻结）
- abstract 回填（30.89% 缺失）
