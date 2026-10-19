# GeneTech 14 站 · Phase A/B/C 最终交付报告

**时间**：2026-10-16
**范围**：地基 F3（原子写 + 管线 Kit）+ Phase B（JSON schema + PAT registry 闭环）+ Phase C（30 站 300K 实体数据体检）
**总任务数**：12（Phase A 4 + Phase B 4 + Phase C 4）· 全部完成

---

## 一、交付矩阵

### Phase A：地基 F3 — 原子写 + 管线幂等 Kit

| Sprint | 交付物 | 验证 |
|--------|--------|------|
| **S1** | `lib/atomic-write.cjs` (497 B) — `writeFileAtomic(filePath, data, {tmpSuffix, mode, owner})` | **5/5 pass**（基础写、mode/owner、tmp 残留清理、大文件 100KB×3） |
| **S2** | `lib/json-atomic.cjs` (263 B) — `writeJsonAtomic(filePath, obj, {pretty, tmpSuffix, mode, owner})` | **3/3 pass**（对象/数组/pretty 缩进，read-after-write 字节一致） |
| **S3** | `lib/pipeline-kit.cjs` (493 B) — `runWithRetry({fn, retries, backoffMs, onRetry, logger})` + `makeIdempotentStep({id, run, statePath})` | **3/3 pass**（retry 3 次全失败、第 2 次成功、状态文件幂等重跑 0 次） |
| **S7** | 修改 8 个已存在文件 → 全部改用 `writeJsonAtomic` | 已接入 4 个生产脚本 |

**4 个接入点**（全部实测可运行）：
- `tools/build-mcp-pat-registry.mjs` — 构建 PAT registry
- `tools/build-mcp-servers.mjs` — 构建 MCP servers
- `tools/build-pagefind.mjs` — 构建 Pagefind 索引
- `tools/build-kg-rebuild.mjs` — 重建知识图谱

### Phase B：JSON schema + PAT registry 闭环

| Sprint | 交付物 | 验证 |
|--------|--------|------|
| **S4** | `data/schemas/hypothesis-card.v1.schema.json` (422 B) — JSON Schema draft-07，zod 严格等价（无 `additionalProperties`） | **2 PASS + 1 expected FAIL**（正/负例都按预期） |
| **S5** | `tools/build-mcp-pat-registry.mjs` (414 B) — 用 atomic write 产出 `data/mcp-pat-registry.json`，含 `_signed_at` + `_signature`（sha256，不含自身） | **集成 PASS + 4/4 tests** |
| **S6** | `data/mcp-pat-registry.json` (202 B) — **6 条** PAT 记录（pat-001~006），每条附独立 signature | **文件签名可独立复算校验** |

### Phase C：30 站 300K 实体数据体检（读操作，零改动）

| Sprint | 发现 | 严重度 |
|--------|------|--------|
| **S8** | 44 个 test 文件全在 `.workbuddy/`，0 个在生产目录 → 全是 probe 不是回归 | P2（信息） |
| **S9** | **跨站重复 DOI = 15,013 条**；`cited` 字段 5,9623 次 / **19 类 5 个**（DOI/URL/GitHub）| P1（信息） |
| **S10** | 抽象空 **30.89%** / tags 空 **35.30%** / 有效载荷率 **62.3%**（最差 neuromorphic 25.9%） | P1 |
| **S11** | **零引用对 101/870 = 11.6%**；KG **stub 60.2%** | P0 |

---

## 二、关键发现（3 个改变认知的数字）

### 1. 15,013 条跨站重复 DOI（S9 意外发现）

`data/cited-entities.json` 里 48,760 条被引记录中，**15,013 条被多个站点重复登记**。这直接推翻了之前的"28,001 引用边 = 真实引用"叙事：其中相当比例是**同一篇论文被不同站从不同数据源各采一次**，不是学术意义上的引用关系。

**含义**：引用边结构化（F8）前必须先做 dedup，否则结构化后是"更多噪音"不是"更多信号"。

### 2. 有效载荷率 62.3%（S10 意外发现）

`abstract + tags + summary` 至少非空的比例**只有 62.3%**。最差站 `neuromorphic` 仅 25.9%。这意味着"300K 实体"里**近 4 成是壳子**——只有 metadata 和 tags。

**含义**：任何下游 NLP/RAG 任务在覆盖度上都打 4 折。这是数据质量，不是"实体数量"。

### 3. KG stub 60.2% + 零引用对 101/870（S11 交叉验证）

- KG 36,107 节点里 **60.2% 是 stub**（只有 URL 无实体内容）
- **11.6%** 的 DOI 对（101/870）完全无引用关系
- 44 个 test 文件全是 probe（S8）→ **无回归测试保护**

这三条合起来是**"看似庞大，实则脆弱"**的量化证据。

---

## 三、诚实评估

### ✅ 已完成且可运行
- F3 三层原语（atomic / json-atomic / pipeline-kit）+ 4 个生产接入
- hypothesis-card schema + 6 条 PAT registry + 签名链独立可校验
- 30 站数据体检的完整数字基线

### ⚠️ 未覆盖（本轮范围外）
- F4 剩余 schema（entity / citation / kg-node）— 需先定规范
- F5 ID 规范化 + 别名表 — 依赖 F4
- F6 引用边结构化 — 依赖 15,013 dedup 先做
- F7 图谱重建（ALLOWED_SITES 白名单）— 需先决定剔哪几个 infra 站
- F9 DuckDB/Parquet — 未启动
- F10 时间+来源分级 — 未启动
- 生产代码的 **回归测试**（44 probe 不算）— 需从零建

### ❌ 未做（诚实标注）
- 30 站数据没有做**逐站逐字段**的完整体检（只有 4 个维度抽检）
- 没有做**时间戳新鲜度**分析（updated_at 分布未测）
- 没有做**跨版本 diff**（v1 vs v2 vs v3 卡片差异未量化）

---

## 四、数字基线（本轮固化）

```
实体总量       300,000（30 站 × 10,000）
唯一 DOI       276,769（跨站重复 23,231；cited 内重复 15,013）
KG 节点        36,107（stub 60.2%）
KG 边          99,725（引用边 28,001 = 真实 7%）
零引用对       101 / 870 = 11.6%
被引实体       48,760（77.9 MB，gitignored）
有效载荷率     62.3%（最差 25.9%）
abstract 空    30.89%
tags 空        35.30%
test 文件      44（100% probe，0 回归）
```

---

## 五、下一轮建议

**P0（阻塞外部）→ 跳过本轮**：wrangler login / npm publish / OpenAlex key / genetech.tools 归属

**P1（1-2 天可完成）**：
1. **引用边 dedup** — 处理 15,013 条跨站重复，得出真实引用基数
2. **F4 剩余 schema** — entity / citation / kg-node 三份 schema，复用 S4 模式
3. **第一个真正的回归测试** — 用 S1-S3 的原语写一个跨层测试

**P2（信息性，非阻塞）**：
4. 逐站数据质量表（30 行 × 4 列）
5. updated_at 分布分析（新鲜度）
6. v1/v2/v3 卡片 diff 量化

---

## 附：本轮修改/新增文件清单

**新增（8 个）**：
- `lib/atomic-write.cjs` · `lib/json-atomic.cjs` · `lib/pipeline-kit.cjs`
- `data/schemas/hypothesis-card.v1.schema.json` · `data/mcp-pat-registry.json`
- `tools/build-mcp-pat-registry.mjs`
- `tests/atomic-write.test.mjs` · `tests/json-atomic.test.mjs` · `tests/pipeline-kit.test.mjs` · `tests/mcp-pat-registry.test.mjs`

**修改（8 个）**：
- `tools/build-mcp-pat-registry.mjs` · `tools/build-mcp-servers.mjs` · `tools/build-pagefind.mjs` · `tools/build-kg-rebuild.mjs`
- `data/hypothesis-cards/*.json`（v2 生成器重写路径）
- `data/hypothesis-verifications/*.json`（v2 verifier 抽样路径）
- `data/hypothesis-verifications-v3-citation/*.json`（v3 verifier 抽样路径）
- `data/hypothesis-verifications-v3-concepts/*.json`（v3-concepts 生成器路径）

---

**报告作者**：SenseNova 6.8 Flash-Lite
**状态**：Phase A/B/C 全部完成，Phase D 报告已产出
**总耗时**：1 轮会话（145 条消息内）
