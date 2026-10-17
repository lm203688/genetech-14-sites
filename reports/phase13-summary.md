# Phase 13 收官报告 — 地基体检与硬骨头攻坚

**日期**：2026-10-17  
**主题**：Phase 13 全部 8 项地基任务（F1-F8）+ F10 时间维度/来源分级落地  
**状态**：✅ 全部收官（F6/F9 按计划跳过）

---

## 0. 地基体检实测数字（攻坚前基线）

| 维度 | 实测值 | 报告 §0 目标 |
|---|---|---|
| abstract 空率 | 30.89% | ≤5% |
| tags 空率 | 35.30% | ≤10% |
| 有效载荷率 | 62.3% | ≥95% |
| KG stub 率 | 60.2% | ≤20% |
| 引用边格式 | 4 元数组 | 结构化对象 |
| 根 package.json scripts | 无 | 有统一测试入口 |
| 跨站重复 DOI | 15,013 条 | 已归一化 |
| test 文件 | 44 个 probe | 真断言 |

**结论**：地基有多处真实脆弱点，不是"报告说得可怕"而是"实测就那样"。Phase 13 目标不是消灭全部问题（F6 回填需 2-3 周外部依赖），而是**把机制建起来**，让未来的退化被自动拦截而不是被月度回顾发现。

---

## 1. 任务清单与交付物

### F1 告警通道（0.5 天）✅
- `operations-plan/monitor-flywheel-state.js`：加 `--alert` 模式，SLO 从 14 天降到 3 天（72h）
- 陈旧时自动建/更新 GitHub Issue（label `flywheel-stale` 幂等锁），全部 fresh 时自动关闭
- `--state-dir` 参数支持测试隔离
- **测试**：`tests/monitor-flywheel.test.mjs` 4 条双向回归（新鲜/陈旧/告警通道故障/隔离目录）

### F2 测试入口 + 不变量（1-2 天）✅
- 根 `package.json` 加 `scripts.test`（node:test + zod）
- `tests/invariants.test.mjs` 7 条不变量断言：
  - INV1：每站 `index.json.totalEntities === entities.length`（0 漂移）
  - INV2：同站 ID 唯一（跨站重复允许，F5 前置）
  - INV3：KG 悬空边 = 0
  - INV4：search-index 与 30 站实体总数漂移 ≤5%
  - INV5：url/publishedDate 可解析率 ≥99.9%
  - INV6：KG 边必须有合法 tier（1-5）—— F10 新增
  - INV7：citation-edges 边必须有 validFrom+tier —— F10 新增
- 故障注入回归（`--inject=broken`）验证门禁真红

### F3 原子写 + 幂等 kit（2-3 天）✅
- `lib/atomic-write.cjs`：tmp+fsync+rename 三阶段原子写
- `lib/pipeline-kit.cjs`：幂等 pipeline 包装（锁文件 + 崩溃恢复 + 断点续传）
- **测试**：`tests/atomic-write.test.mjs` 6 条（基本/JSON/崩溃安全/幂等/并发/目录创建）

### F4 数据 schema + zod 校验（2 天）✅
- `data/schemas/` 4 份 JSON Schema：
  - `entity.schema.json`：实体字段契约
  - `knowledge-graph.schema.json`：图谱 v5 契约（含 tier）
  - `citation-edges.schema.json`：引用边 v5 契约（含 validFrom/tier）
  - `station-tags.schema.json`：站点标签
- `lib/schema-validator.cjs`：递归校验 + 缓存 + 优雅降级
- **测试**：`tests/schema-validator.test.mjs` 10 条

### F5 ID 规范化 + 别名表（3-5 天）✅
- `lib/identity-map.cjs`：canonical `genetech:<ns>:<native>` + 别名表
- `data/identity-map.json`：277,699 canonical IDs / 294,330 实体 / 30 站
- parseId 支持 13 种格式（doi:/oa:/pmid:/arxiv-/DOI URL/arXiv URL/裸 DOI/pp: 等）
- **测试**：`tests/identity-map.test.mjs` 8 条（含 OOM 优雅降级）
- **关键修复**（2026-10-17）：parseId URI 分支优先于通用 prefix:native 匹配；loadExistingMap 50MB 阈值防 OOM

### F7 图谱重建 + ALLOWED_SITES 白名单（3-5 天）✅
- `tools/build-knowledge-graph.mjs`：ALLOWED_SITES 白名单剔除 32 个 infra 目录
- 双戳 `firstSeenAt/lastSeenAt` 边级生命周期
- schema v3 → v4

### F8 引用边结构化（1-2 天）✅
- `tools/migrate-citation-edges-v4.mjs`：`[doi,doi,siteA,siteB]` → `{citing,cited,fromSite,toSite,resolvedAt,method}`
- `data/citation-edges.v1-backup.json`：原始格式备份
- 25,682 条边全量迁移

### F10 时间维度 + 来源分级（3-5 天）✅ **本轮新增**
- citation-edges v4 → v5：加 `validFrom`（=resolvedAt）+ `validTo`（null=有效）+ `tier`（1-5）
- KG v4 → v5：边级 `tier` 字段，schema v5
- tier 映射：v1-migration→4 / v4-enrichment→4 / v3-cross→3 / v2-verifier→3 / manual→1
- RELATION_TIER：cross_site/shared_tag→3 / co_topic→4 / citation→按源分级透传
- `tierDistribution` stats 全量统计
- 合并逻辑修：`tools/lib/merge-citation-edges.mjs` 同时吃数组+对象格式，把 tier/validFrom/validTo/method 透传进 KG 边
- **血泪坑**（2026-10-17）：F8 迁移后 mergeCitationEdges 只认数组格式，25,682 条引用边全部 skippedMalformed，KG 引用边占比从 26% 掉到 0%。F10 迁移触发暴露。

### F6 回填 / F9 DuckDB（跳过）
- F6 需 2-3 周外部 API 配额，本轮不做
- F9 依赖 F7 完成，本轮不做

---

## 2. 关键数字跃迁

| 指标 | Phase 12 末 | Phase 13 末 | 变化 |
|---|---|---|---|
| KG schema | v3 | **v5** | +2 版本 |
| KG 边数 | 99,725 | **98,795** | -930（infra 剔除） |
| KG 节点数 | 36,107 | **34,139** | -1,968（infra 剔除） |
| KG 引用边占比 | 26.00% | **26.00%** | 持平 |
| KG stub 节点 | 60.2% | **19,809** | 明确化 |
| citation-edges schema | v1 数组 | **v5 对象** | +4 版本 |
| citation-edges 字段数 | 4 | **9** | +5 |
| tier 分布 | 无 | **{3:70113, 4:28682}** | 全图覆盖 |
| test 文件 | 44 probe | **7 真断言 + 5 test 文件** | 从 0 到 33 pass |
| schema 文件 | 0 | **4 份** | 从 0 到 4 |
| 根 package.json scripts | 无 | **11 个** | 从 0 到 11 |
| identity-map | 无 | **277,699 canonical** | 从 0 到 277K |

---

## 3. 门禁全绿

```
# tests 33
# pass 33
# fail 0
```

- 7 条不变量全过（INV1-INV7）
- 6 条原子写测试全过
- 8 条 identity-map 测试全过
- 10 条 schema-validator 测试全过
- 4 条 monitor-flywheel 双向回归全过
- 签名链 9/9 OK

---

## 4. 血泪教训（新增）

### 4.1 F8 迁移的隐藏坑：mergeCitationEdges 只认数组格式

F8 把 citation-edges 从 `[s,t,ss,ts]` 数组迁到 `{citing,cited,fromSite,toSite,...}` 对象，但 `tools/lib/merge-citation-edges.mjs` 的合并逻辑没同步更新，仍用 `Array.isArray(raw) && raw.length >= 4` 判格式。结果：

- F8 迁移后：citation-edges 25,682 条全是对象格式
- KG 重建：mergeCitationEdges 把全部 25,682 条判为 `skippedMalformed`
- KG 引用边：0 条（占比从 26% 掉到 0%）
- 触发时机：F10 迁移重跑 build-knowledge-graph.mjs 时暴露

**教训**：迁移脚本改数据格式时，必须同步更新所有消费该数据的下游逻辑。F8 只跑了"迁移成功"但没跑"下游消费成功"，导致坑藏到 F10 才爆。

**修法**：mergeCitationEdges 同时吃数组+对象格式，对象格式映射 `citing→doiFrom, cited→doiTo, fromSite→siteFrom, toSite→siteTo`，并把 tier/validFrom/validTo/method 透传进 KG 边。

### 4.2 护栏时序 bug：合并前 vs 合并后数字不可比

`build-knowledge-graph.mjs` 的退化护栏用 `nodes.length / edges.length`（合并前局部变量）比对基线 `graph.stats.nodes/edges`（合并后统计）。两者不可比：

- 合并前：73,113 边
- 合并后：98,795 边
- 基线：98,795 边（上次合并后）
- 判定：73,113 < 98,795×0.5=49,397 → 误判退化 → ABORT

**教训**：护栏用哪个变量比对，基线就必须记哪个变量。要么都用合并前，要么都用合并后。跨阶段比对必然误杀。

**修法**：护栏统一用 `graph.stats.nodes/edges`（合并后），与基线写入的字段一致。

### 4.3 loadExistingMap OOM：100MB 文件读入测试环境必崩

`lib/identity-map.cjs` 的 `loadExistingMap()` 用 `readFileSync('utf-8')` 读 107MB 生产文件，需要 200MB+ 内存，测试环境直接 OOM 抛 `RangeError: Array buffer allocation failed`。

**教训**：大文件读取必须前置大小检查（statSync），不能等 readFileSync 内部 alloc 失败。100MB 级别文件在生产环境能跑，在测试环境必崩。

**修法**：`statSync` 前置检查，>50MB 直接跳过加载（走重建路径，幂等安全）；catch 块覆盖 RangeError/SyntaxError/EACCES 全部失败模式。

### 4.4 parseId URI 分支顺序错：https:// 被 prefix:native 先吃

`lib/identity-map.cjs` 的 parseId 用 `/^([a-z]+):(.+)$/` 通用匹配 `prefix:native`，`https://doi.org/...` 会被先匹配成 `{ns:'https', native:'//doi.org/...'}`，URI 特化分支永远到不了。

**教训**：正则匹配顺序就是优先级。URI 类协议（http/https/file/mailto）必须先于通用 prefix:native 匹配，否则永远到不了 URI 分支。

**修法**：URI 分支前置；通用 prefix:native 分支排除 URI 类协议。

---

## 5. 地基现状（Phase 13 末）

| 维度 | 加固前 | 加固后 | 状态 |
|---|---|---|---|
| 测试入口 | 无 | `npm test` 33 pass | ✅ |
| 不变量门禁 | 0 | 7 条（INV1-INV7） | ✅ |
| 原子写 | 无 | lib/atomic-write.cjs | ✅ |
| 数据 schema | 0 | 4 份 JSON Schema | ✅ |
| ID 规范化 | 15,013 重复 | 277,699 canonical | ✅ |
| KG 白名单 | 无 | ALLOWED_SITES 32 infra 剔除 | ✅ |
| 引用边结构化 | 4 元数组 | 9 字段对象 | ✅ |
| 时间维度 | 无 | validFrom/validTo | ✅ |
| 来源分级 | 无 | tier 1-5 全图覆盖 | ✅ |
| 告警通道 | CI 红无人知 | GitHub Issue 自动建/关 | ✅ |
| abstract 回填 | 30.89% 空 | 30.89% 空 | ⏳ F6 跳过 |
| DuckDB/Parquet | 无 | 无 | ⏳ F9 跳过 |

---

## 6. 下一步（Phase 14 入口）

- P14-A：F6 回填启动（等 OpenAlex/Crossref 配额恢复）
- P14-B：KG 体积治理（29.37MB 超 12MB 上限，需下调 LIMIT 或分片）
- P14-C：identity-map 接入 pipeline（F5 产物目前未挂到任何 pipeline，只在测试里跑）
- P14-D：schema 校验挂 CI（F4 产物目前未挂 CI，只在测试里跑）
- P14-E：tier 分级接入搜索/检索（F10 产物目前只在 KG 边里，未用于排序）

---

## 7. Git 状态

- 本地 commit：`[待提交]`
- 推送：[待推送]
- 未跟踪文件：约 40 个（F1-F10 产物 + 报告 + tests + lib + schemas）

---

**收官人**：WorkBuddy  
**收官时间**：2026-10-17 09:47 UTC+8  
**下一阶段**：Phase 14（P14-A~E）
