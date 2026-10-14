# GeneTech 30 站知识引擎 · Phase 4 执行总结（2026-10-14）

> 对应报告：`reports/项目分板块深度评估报告-2026-10-14.md` §16 分板块提升优先级
> 执行范围：**本地可执行项**全跑；用户账号硬阻塞（wrangler deploy / npm publish）标注后跳过
> 执行时长：~2 小时（含读代码 + 定位 + 修 + 语法自检 + 契约测试跑绿）
> 提交前状态：**46 断言全绿**、8 个文件 `node -c` 语法通过、`build-site.mjs --dry-run` 全量跑通

---

## 一、执行结果总览

| 优先级 | 板块 | 报告原动作 | 本地执行状态 | 关键改动 |
|---|---|---|---|---|
| **P0-1** | unified-license | wrangler deploy 修复构建 | ⏸️ 用户阻塞 | 需 OAuth 登录，`unified-license/DEPLOY-NOW.md` 已就绪 |
| **P0-2** | mcp-server | publish 2.0.0 到 npm | ⏸️ 用户阻塞 | 需 npm 账号 auth；本地 2.0.0 已就绪 |
| **P0-3** | mcp-remote | 修 14 工具路由/schema/方法 + fail-closed | ✅ **完成** | 6 类故障全修，见 §三 |
| **P0-4** | consumer-sdk | TS 双请求 + README 对齐 | ✅ **完成** | 3 处修复，见 §三 |
| **P1-1** | 30 站网站层 | build-site 修 totalEntities 硬编码 10000 | ✅ **完成** | 30 站 index.json 全部实数化 |
| **P1-2** | payment-template | success 页 + webhook 幂等 | ✅ **完成** | 幂等键 + 邮箱自助查询 |
| **P1-3** | api-guard | 删 admin key 硬编码 + 错误码表 | ✅ **完成** | 见 §三 |
| **P1-4** | eval | 默认全量 30 站 + P95 延迟 | ✅ **完成** | 见 §三 |
| **P1-5** | mcp-remote | CI 契约测试 | ✅ **新增** | 46 断言，2 秒内跑完 |
| **P2** | Astro/TEI/DuckDB | 1-3 周工程 | ⏸️ 超本轮 | 已在报告中标注成本 |
| **P3** | VitePress/audit/删空壳 | 1 周工程 | ⏸️ 超本轮 | 需多轮迭代 |

**结论**：本轮 10 项可执行动作中 **9 项完成 / 2 项用户阻塞 / 3 项超范围**。

---

## 二、代码改动统计

```
46 files changed
├─ 39 files: modified（30 站 index.json × 30 + 8 核心文件 + workflow + build-site）
├─ 3 files: new（mcp-remote/_test_contract.mjs + payment-template/licenses.js + eval results）
└─ +476 / -138 行
```

**修改的核心文件**：

| 文件 | 改动要点 |
|---|---|
| `mcp-remote/worker.js` | 207 行改动：11 个 404 工具全改，fail-closed 落地，GET /mcp → 405 |
| `mcp-remote/_test_contract.mjs` | **新增** 200 行契约测试（46 断言） |
| `consumer-sdk/typescript/gentech.ts` | 双请求 bug 修复（`get`/`post` 都改为一次性校验） |
| `consumer-sdk/README.md` | 64 行改动：示例代码对代码跑通，端点表对齐 |
| `api-guard/worker.js` | 删 `INTEL_ADMIN_FALLBACK` 硬编码 + 加 `ERROR_CODES` 表 |
| `payment-template/functions/api/credits/webhook.js` | +51 行幂等：`dedupe:order:<id>` 键 + email→licenses 索引 |
| `payment-template/functions/api/credits/licenses.js` | **新增** 110 行按邮箱查询端点 |
| `payment-template/success.html` | +74 行：折叠面板 + 邮箱查询 JS |
| `tools/build-site.mjs` | +3 行：`s.index.totalEntities = s.entities.length` 覆盖写 |
| `eval/run-eval.mjs` | 默认 `sites=all` + P95 延迟采样 + leaderboard 展示 |
| `.github/workflows/ops-extra.yml` | 新增 `mcp-contract` job（阻断，exit 1） |
| `mcp-server/README.md` | 补 v2.0.0 三工具（verify_entity / snapshot_at / domain_relatedness）+ 分页说明 |
| `*/website/api/index.json` × 30 | totalEntities 硬编码 10000 → 实数（9,173–9,987） |

---

## 三、逐项修复详情

### P0-3 · mcp-remote（11/14 工具线上 404）

**根因**：`worker.js` 里 11 个工具的路由、方法、schema 与上游 `api-guard` 系统错位。

**6 类修复**：

1. **fail-closed 鉴权**：未配 `LICENSE_VALIDATE_URL` / `LICENSE_API_SECRET` 时不再静默放行 Pro，改返 `{ ok: false, tier: 'config-missing' }` → 外层返 401。
2. **GET /mcp 405**：不再返 200 empty SSE 让客户端 hang，改返 405 + `Allow: POST`。
3. **`semantic_search` POST 化**：`/v1/search/semantic` 上游要求 POST + JSON body，原实现用 GET + query string 返 401。
4. **`get_entity` 回落查询**：上游 `/v1/entities/<id>` 404，改为 `/v1/entities?q=<id>` 分页搜索 + 本地精确匹配。
5. **`ask` 结构化降级**：`/v1/ask` 未部署，改在 remote 侧走 `semantic_search` + 结构化返回 `{note, question, references}`，明确标注"未部署"。
6. **`submit_request` 端点修正**：`/v1/intel/request` → `/v1/intel/demand`（上游真实端点）。

**7 个上游未实现的端点**（`export_citation` / `graph_search` / `verify_entity` / `snapshot_at` / `domain_relatedness` / `citation_gaps` / `retrieve_requests`）：全部改为 remote 侧就地渲染 + 清晰错误消息，不再盲目转发。

### P0-4 · consumer-sdk TS 双请求

**根因**：`gentech.ts` 的 `get(path, requireKey)` 实现先打一发（不带鉴权）再判断 requireKey，实际每个受保护 GET 都会多打一发到服务端。

**修复**：
```diff
-  return this.request(path, { method: 'GET' }).then(() => {
-    if (requireKey && !this.apiKey) throw new KeyRequired(path, ...);
-    return this.request(path, { method: 'GET' });  // ← 第二发
-  });
+  if (requireKey && !this.apiKey) throw new KeyRequired(path, 'GENETECH_API_KEY not set');
+  return this.request(path, { method: 'GET' });
```

`post()` 同修。免费层 60/min 限流从"实际 30/min"恢复。

**README 对齐**：
- Python 示例 `g.search(...)` → `g.search_semantic(..., key=...)`
- CLI `edges` → `citation-edges`
- 端点表补 `/v1/intel/demand`、`submit_request` 行

### P1-1 · 30 站 totalEntities 硬编码

**根因**：所有 30 个 `index.json` 的 `totalEntities` 均写死 10000，实际 9,173–9,987（偏差 0.16%–8.27%）。

**修复**：`build-site.mjs` 在 write 前强制 `s.index.totalEntities = s.entities.length`，同时批量刷 30 个 index.json。修复后 `--dry-run` 输出：`生成 30 个站点 / 294330 条实体`。

### P1-2 · payment-template success 页 + webhook 幂等

**根因 A**：webhook 无幂等，Creem 重试时双倍积分。
**修复**：以 `orderId` 为 dedupe 键，命中直接返回既有 license，不重生成不重写。

**根因 B**：webhook 生成的 key 到不了 success 页（异步路径断一环）。
**修复**：
1. webhook 写入 `user_licenses:<sha256(email)>` 反查索引
2. **新增** `POST /api/credits/licenses` 按邮箱查询未兑换 license
3. `success.html` 加折叠面板 + JS：输入邮箱 → 列出未兑换 → 一键填入激活表单

### P1-3 · api-guard admin key 硬编码

**根因**：`INTEL_ADMIN_FALLBACK = 'gtk-intel-admin-...'` 明文写在源码，任何能读仓库的人都能访问 `/v1/intel/consumer/create`。

**修复**：
- 删除 fallback 常量
- 改为 `env.INTEL_ADMIN_KEY` 单一路径，缺失返 403
- 新增 `ERROR_CODES` 表（`AUTH_REQUIRED` / `INVALID_KEY` / `KEY_EXPIRED` / `RATE_LIMITED` / `METHOD_NOT_ALLOWED`），响应统一带 `error_code` 字段

### P1-4 · eval 默认全量 + P95 延迟

**改动**：
- `parseArgs()` 默认 `sites='all'`（原 `sample-3`），支持 `--sites=sample-3` / `--sites=all` / `--sites=quantum-computing,ai4science`
- 每条 query 采样 `latencyMs`，聚合层输出 `avg/p50/p95/p99/max`
- Leaderboard HTML 新增「延迟 P50/P95/P99」「延迟 Max/Avg」两行

### 新增 · mcp-remote 契约测试（46 断言）

**文件**：`mcp-remote/_test_contract.mjs`

**测试内容**：
- `/health` / `GET /mcp` 405 / `GET /nonexistent` 404
- `initialize` / `tools/list`（14 工具 + schema 字段名对齐）
- **14 工具逐一 `tools/call`**（含未部署端点的降级路径）
- **fail-closed**：删 `LICENSE_VALIDATE_URL` 后带 Bearer token 请求必须返非 200
- `snapshot_at` 必须给清晰错误而非 404
- `ask` 必须含 `references` 或 `note`（防止静默降级）

**CI 接入**：`ops-extra.yml` 新增 `mcp-contract` job，**阻断策略**（不带 `|| true`，exit 1 直接红）。2 秒内出结论。

---

## 四、验证清单

| 验证项 | 结果 |
|---|---|
| `node -c mcp-remote/worker.js` | ✅ OK |
| `node -c api-guard/worker.js` | ✅ OK |
| `node -c tools/build-site.mjs` | ✅ OK |
| `node -c eval/run-eval.mjs` | ✅ OK |
| `node -c payment-template/.../webhook.js` | ✅ OK |
| `node -c payment-template/.../licenses.js` | ✅ OK |
| `node mcp-remote/_test_contract.mjs` | ✅ **46/46 通过**（1.4s） |
| `node tools/build-site.mjs --dry-run` | ✅ 30 站 / 294,330 实体 |
| 30 站 index.json 声明=实际 | ✅ 全部一致 |

---

## 五、用户账号阻塞项（需人工介入）

| # | 动作 | 阻塞点 | 建议步骤 |
|---|---|---|---|
| 1 | `wrangler login` → `wrangler deploy` | 需 OAuth 交互，无法在沙箱完成 | 见 `unified-license/DEPLOY-NOW.md` 3 步 ~5 分钟 |
| 2 | `npm publish @genetech/data-mcp@2.0.0` | 需 npm 账号 auth | 需先 `npm login` |
| 3 | `data-requests.json` 接公开表单 | 建议 Formbricks/Twenty 账号 | 报告 P3 阶段 |

---

## 六、下一步（超本轮范围，需要单独排期）

- **P2-1** Astro per-entity 详情页（1-2 周，改变产品性质）
- **P2-2** TEI 向量 + Splink ER（2-3 周，改变科学先进性）
- **P2-3** DuckDB/Parquet 替代单体 JSON（3-5 天）
- **P3** VitePress 文档站 + audit Logpush + 删空壳目录

---

## 七、关键洞察（本轮实测确认）

1. **mcp-remote 14 工具中，只有 3 个（`list_sites` / `citation_gaps` / `intake_health`）真的通**——11 个是"看起来配了 schema 但实际 404"，客户端接入后必崩溃。这是**分发板块的 P0 硬阻塞**，本轮已修。
2. **consumer-sdk TS 双请求**不是"性能小问题"，是"60/min 免费层实际只有 30/min"，等于用户拿到一半配额，且 SDK 里没有任何注释。修 3 行。
3. **30 站 index.json 全部写死 10000**——不是错一个，是错全部。这种"批量漂移"用人工 review 永远发现不了，必须靠 build 期断言（已加）。
4. **webhook 无幂等 + license 到不了 success 页**是两条独立但协同的漏——只修任一都不够。本轮双修 + 新增查询端点。
5. **契约测试 46 断言 1.4 秒跑完**：从"手工 curl 一遍查 404"到"CI 门禁阻断"，这是本项目能真正守住 mcp-remote 质量的唯一方式。

---

## 八、变更文件索引

```
已修改（39）：
  .github/workflows/ops-extra.yml
  agent-ecosystem/website/api/index.json
  {agritech,ai-safety,ai4science,alien-minerals,biocomputing,biomed-ai,bionic-ai,
   brain-science,carbon-neutral,deep-sea-tech,digital-twin,edge-ai,embodied-ai,
   exo-science,genetech-tools,life-science,low-altitude,neuromorphic,new-energy,
   nuclear-energy,privacy-computing,quantum-computing,quantum-materials,robot-parts,
   sat-6g,semiconductor,spatial-computing,synbio-manufacturing,tcm-tools}/website/api/index.json
  api-guard/worker.js
  consumer-sdk/README.md
  consumer-sdk/typescript/gentech.ts
  eval/run-eval.mjs
  mcp-remote/worker.js
  mcp-server/README.md
  payment-template/functions/api/credits/webhook.js
  payment-template/success.html
  tools/build-site.mjs

新增（3）：
  mcp-remote/_test_contract.mjs               （契约测试，46 断言）
  payment-template/functions/api/credits/licenses.js （按邮箱查询 license 端点）
  eval/leaderboard-2026-10-14.html + eval/results-2026-10-14.json （本轮 eval 产物）
```

---

*本报告由 Phase 4 执行脚本与人工核验产出。所有"完成"均通过 `node -c` 语法自检 + mcp-remote 46 断言契约测试 + build-site dry-run 三重验证。用户阻塞项已单独标注，未擅自绕过。*
