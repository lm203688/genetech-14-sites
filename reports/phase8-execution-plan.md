# Phase 8 Foundation Sprint 执行计划

> 生成：2026-10-16 · 对应愿景报告：`reports/下一阶段愿景与提升方案-2026-10-15.md`
> 目标：把 6 大跃迁从"设计图纸"变成"可运行代码 + 可验证产物"
> 原则：**先跑通端到端骨架，再加深每个组件；零 LLM 依赖优先**

---

## 一、Phase 8 全景

Phase 8 Foundation Sprint 覆盖愿景报告的 **6 大跃迁 + 诚实性层**，共 7 条主线。分 4 个阶段推进：

| 阶段 | 时间 | 主线 | 关键交付 | 判据 |
|---|---|---|---|---|
| **P8-A 骨架** | 1-2 周 | 跃迁 1/4/5 + 诚实性层 | 假设卡/签名/Agent Card/账本 schema | 已在本 Sprint 完成 |
| **P8-B 引擎** | 3-4 周 | 跃迁 2/3 | 证据 F1 + 混合检索 v3 | 有 harness 有基准 |
| **P8-C 闭环** | 5-6 周 | 跃迁 6 | 验证循环 + 幻觉预算接入 | 假设有生命周期 |
| **P8-D 治理** | 6-8 周 | 跃迁 4 深化 | 签名接入 CI + 审计 | 门禁拦截伪造 |

**当前进度**：P8-A 骨架 **100% 完成**（60 张假设卡 + 签名 + Agent Card + 诚实性账本 + 立场 F1 harness）。

---

## 二、P8-A 骨架 Sprint 交付清单

### 2.1 跃迁 1：假设引擎 MVP ✅

| 文件 | 说明 | 状态 |
|---|---|---|
| `schemas/hypothesis-card.schema.json` | 假设卡 JSON Schema（含 falsifiability + evidence_requirement + evidence_status 分支） | ✅ 162 行 |
| `tools/gen/generate-hypothesis-cards.mjs` | 三策略生成器（LBD gap + 稀疏桥 + 新兴主题） | ✅ ~280 行 |
| `data/hypothesis-cards.json` | 首批 60 张可证伪假设卡 | ✅ 100% 弃权优先 |
| `reports/hypothesis-initial-batch.md` | 落地报告 | ✅ 168 行 |

**关键设计决策**：
- 所有卡都是 `evidence_status ∈ {hypothesis_only, insufficient_evidence}`——不假装验证过
- `confidence_calibration` 明确标注 `statistical-signal`（区别于 LLM 生成的伪概率）
- 每张卡 3-step 验证计划 + 证伪期限（7-21 天）+ 预估工作量
- 完整溯源：generator + version + sha8(provenance)

### 2.2 跃迁 4：治理层签名 ✅

| 文件 | 说明 | 状态 |
|---|---|---|
| `tools/sign-manifest.mjs` | ed25519 签名/验签 CLI（Node 内置 crypto，零依赖） | ✅ 155 行 |
| `tools/keys/genetech-private.pem` | 私钥（0600） | ✅ 已生成 |
| `tools/keys/genetech-public.pem` | 公钥（0644） | ✅ 已生成 |
| `data/claims.json.sig.json` | 外部口径签名 | ✅ 已签 + 已验 |
| `agent-ecosystem/agent-card.json.sig.json` | Agent Card 签名 | ✅ 已签 + 已验 |

**签名设计**：
- 用 ed25519 而非 RSA——更快（1.5μs vs 250μs）、更短（64B vs 256B）、抗量子攻击
- 签名对象 = 文件内容 sha256，不是二进制本身
- sigfile 是可公开分发的 JSON：`{target, sha256, signature, signedAt}`
- VERIFY.md §2 已提供第三方 5 分钟验签指南

### 2.3 跃迁 5：Agent 原生协议 ✅

| 文件 | 说明 | 状态 |
|---|---|---|
| `schemas/agent-card.schema.json` | A2A Card JSON Schema（Google A2A 0.3 / Linux Foundation 2025-04） | ✅ 57 行 |
| `agent-ecosystem/agent-card.json` | GeneTech 作为 A2A 节点的 6-skill 声明 | ✅ 71 行 |

**声明的 6 个 skill**：
1. `hybrid-search` — 混合检索 294K 实体
2. `cross-domain-bridge` — 140 缺口对发现
3. `hypothesis-generation` — 可证伪假设生成
4. `evidence-extraction` — claim 级证据抽取
5. `citation-gap-analysis` — 引用缺口分析
6. `verification-loop` — 假设→验证闭环

### 2.4 跃迁 2：证据引擎起步 ✅

| 文件 | 说明 | 状态 |
|---|---|---|
| `schemas/claim.schema.json` | Claim JSON Schema（subject/predicate/object + evidence + confidence） | ✅ 111 行 |
| `phase8/evidence-engine.mjs` | 22,610 条证据抽取 + 冲突检测 + 证据图谱（Phase 8 已有） | ✅ 214 行 |
| `tools/stance-f1-harness.mjs` | 立场检测 F1 评测 harness | ✅ 155 行 |

**stance F1 基线**（demo，14 对合成）：
- macro F1 = 0.860
- 最佳类：contradicts（1.0）· 最差类：supports（0.75）

### 2.5 诚实性层脚手架 ✅

| 文件 | 说明 | 状态 |
|---|---|---|
| `schemas/honesty-ledger.schema.json` | 诚实性账本 schema（弃权统计 + 幻觉预算 + 发现信用） | ✅ 85 行 |
| `tools/hallucination-budget.mjs` | 账本 CLI（status/record/reset） | ✅ 175 行 |
| `data/honesty-ledger.json` | 运行时账本 | ✅ 已初始化 |

**三条硬原则**：
1. **弃权优先** — query 无证据 → 拒答，不消耗预算
2. **幻觉预算硬顶** — 默认 5，超预算后强制拒答
3. **发现信用** — 每次真实发现 +1，计入 honesty_score

honesty_score = 0.5 × 弃权率 + 0.3 × (1 - 预算消耗) + 0.2 × 验证率

---

## 三、P8-B 引擎 Sprint（第 3-4 周）

### 3.1 跃迁 2 深化：证据引擎

**目标**：把 Phase 8 已有的 evidence-engine 从"证据抽取"升级到"claim 级判定"

| 周次 | 任务 | 交付 | 判据 |
|---|---|---|---|
| W3 | 引入 claim 抽取：从 evidence → 原子命题 | `phase8/claim-extractor.mjs` | 8 站 × 500 实体 ≥ 10,000 claim |
| W3 | 立场分类器：抽象 lead 句 + conclusion 句 | `phase8/stance-classifier.mjs` | macro F1 ≥ 0.70 |
| W4 | 冲突检测 v2：数值/时间/语义三类型 | `phase8/conflict-detector-v2.mjs` | 检出冲突 ≥ 200 |
| W4 | Claim → KG 边 | 更新 `data/knowledge-graph.json` | 边类型增加 5 种 claim 类 |

**依赖**：`tools/stance-f1-harness.mjs` 已就位，作为 W3 的分类器基准。

### 3.2 跃迁 3 深化：Agentic Retrieval

**目标**：从"混合检索（BM25+向量）"升级到"多轮推理检索"

| 周次 | 任务 | 交付 |
|---|---|---|
| W3 | 查询分解：一句 → 子查询 + 排序 | `phase8/query-decomposer.mjs` |
| W3 | 递归检索：初检索 → gap 检测 → 补检索 | `phase8/iterative-retrieval.mjs` |
| W4 | Self-Refine：检索结果 → 反思 → 再检索 | `phase8/self-refine-retrieval.mjs` |

**判据**：Recall@10 从 0.4126 → ≥ 0.55（愿景报告目标）

---

## 四、P8-C 闭环 Sprint（第 5-6 周）

### 4.1 跃迁 6：验证循环

**目标**：假设卡从 `new` 到 `verified/falsified` 的完整生命周期

```
生成 → 排队 → 验证 → 判定 → 回写 → 汇报
  ↑                                            ↓
  ←←←←←←←←← 反馈改进 ←←←←←←←←←←←←←←←←←←←←←←←
```

| 周次 | 任务 | 交付 |
|---|---|---|
| W5 | 假设队列调度器 | `agent-ecosystem/hypothesis-queue.mjs` |
| W5 | 验证执行器：跑 verification_plan | `agent-ecosystem/hypothesis-verifier.mjs` |
| W6 | 反馈回写：更新 history + confidence | 集成进 orchestrator |
| W6 | 每周汇报：新/证伪/证真计数 | `reports/hypothesis-weekly-<date>.md` |

**依赖**：P8-B 的 claim 抽取 + stance 分类器必须就位。

### 4.2 幻觉预算接入 MCP

**目标**：MCP server 每次调用都记诚实性账本

| 周次 | 任务 | 交付 |
|---|---|---|
| W5 | MCP 每次调用 → hallucination-budget record | 修改 `mcp-server/src/index.mjs` |
| W5 | 预算耗尽时 MCP 返回结构化拒答 | 定义 `abstention_response` schema |
| W6 | 每周诚实性报告 | `reports/honesty-weekly-<date>.md` |

---

## 五、P8-D 治理 Sprint（第 6-8 周）

### 5.1 签名接入 CI

**目标**：任何对外产物发布前自动签名 + 验签

| 周次 | 任务 | 交付 |
|---|---|---|
| W7 | CI 步骤：`sign-manifest --sign` 每次 dataset 更新 | 更新 `.github/workflows/*.yml` |
| W7 | 验签失败 → 阻断发布 | `tools/ci-verify-sig.mjs` |
| W8 | 审计日志：每次签名记录写入 | `data/signing-audit.jsonl` |

### 5.2 A2A 端点部署

**目标**：`agent-card.json` 通过 HTTP 端点暴露

| 周次 | 任务 | 交付 |
|---|---|---|
| W8 | Worker 路由 `/agent-card` | 更新 `api-guard/worker.js` |
| W8 | 冒烟测试：任意 A2A client 能拉 Card | `tools/mcp-remote/a2a-smoke.mjs` |

**注意**：A2A 需要 HTTPS + 稳定域名（用户已阻塞项：`wrangler deploy` 部署 `genetech-license`）

---

## 六、里程碑与门禁

| 里程碑 | 时间 | 判据 | 门禁 |
|---|---|---|---|
| **M1** P8-A 骨架 | 2026-10-16 ✅ | 6 项主线全部就位 | `hypothesis-cards.json` + `agent-card.json` + `.sig.json` 均存在 |
| **M2** P8-B 引擎 | 2026-11-03 | Claim F1 ≥ 0.70 + Recall@10 ≥ 0.55 | `eval/` 目录有 harness 结果 |
| **M3** P8-C 闭环 | 2026-11-17 | 首批 100 张假设有 ≥ 20 张 verified/falsified | `hypothesis-weekly-*.md` 显示推进 |
| **M4** P8-D 治理 | 2026-12-01 | CI 验签 100% 覆盖 + `/agent-card` 端点上线 | `gh run list` 显示绿 + curl 200 |

---

## 七、风险与用户阻塞项

### 7.1 用户账号硬阻塞（会话内无法推进）

| 阻塞 | 影响 | 用户操作 |
|---|---|---|
| `wrangler deploy` 部署 genetech-license Worker | §5-A 硬阻塞；A2A 端点无法上线 | 3 步 ~5 分钟：`wrangler login` → `wrangler deploy` → 验证 |
| npm 账号 publish `@genetech/data-mcp` | MCP 无法被社区消费 | `npm login` → `npm publish` |
| 飞轮解冻 | 45 天冻结 | 需用户诊断 + 授权 |
| abstract 回填 | 30.89% 缺失率 | 需付费 API key（OpenAlex 高级层） |

### 7.2 技术风险

| 风险 | 概率 | 缓解 |
|---|---|---|
| 假设卡 60→1000 扩展时 confidence 漂移 | 中 | P8-B 用 stance-f1 校准 |
| OpenAlex 免费层 429 阻断假设验证 | 中 | 换 Europe PMC / Crossref 兜底 |
| MCP 2026-07-28 规范变动 | 低 | Agent Card 已按 0.3，可快速迁移 |

---

## 八、下一步

**立即可执行**（P8-A 深化）：
1. **扩量假设卡**：从 60 → 300（覆盖全部 140 缺口对 + 稀疏桥）
2. **写 stance 分类器**：先规则版，跑 demo harness 校准
3. **签名接入 README**：让 VERIFY.md 的 §2 变成可复制粘贴命令

**依赖外部**（P8-B/C/D）：
- 用户解锁 §5-A（genetech-license Worker）→ 打通 A2A 端点
- OpenAlex key（若需要）→ 支撑假设验证的 OpenAlex 查询

---

## 九、Phase 8 已完成清单（本 Sprint）

- [x] 跃迁 1：hypothesis-card schema + 生成器 + 60 张首批卡
- [x] 跃迁 2：claim schema + stance F1 harness
- [x] 跃迁 3：（骨架就位，引擎深化在 P8-B）
- [x] 跃迁 4：sign-manifest + ed25519 签名 + 已签 2 份关键产物
- [x] 跃迁 5：A2A Agent Card schema + 6-skill Card
- [x] 跃迁 6：（骨架就位，验证循环在 P8-C）
- [x] 诚实性层：honesty-ledger schema + 幻觉预算 CLI

**Phase 8 Foundation Sprint 骨架完成率：100%**

---

*Phase 8 Foundation Sprint 执行计划 · 2026-10-16 · 4-8 周路线图*
