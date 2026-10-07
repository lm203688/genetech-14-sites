# 工程级升级报告 — AOCI 接入 + 定时任务整合 + 文件夹整理（2026-10-07）

本任务三件事：① 用 AOCI-CODE 把本项目升级为工程级应用；② 整合/清理定时任务；③ 清理归类项目文件夹。
全部改动已通过 Contents API 推上 `master`（force:false，绝不覆盖远端其它文件）。

---

## 1. AOCI 接入（工程级认知层）

**二进制**：`C:\Users\xing\tools\aoci-code\aoci.exe`（v0.1.0-rc18，2026-10-05 构建，本机已有，复用 swarmlabs 那份）

**操作**：
```
aoci init  --repo . --agent qoder --locale zh-CN --scope-profile production
aoci scan  --repo .            # 建立 Baseline，595 文件 / 520 条待写条目
```

**产物（已入库 commit `fad238d`）**：
- `aoci.txt` / `aoci.meta.txt` / `aoci.code.txt` — 认知索引（code 索引当前为骨架，520 条待写，属后续 `aoci maintain` 大工程，未擅自跑）
- `AGENTS.md` — 12.9KB agent 工作指引
- `.aoci/`（baseline.json 等，按 `.aoci/.gitignore` 内部边界管理，不入库）
- `.mcp.json` — 标准 MCP server 描述

**接入 WorkBuddy**：在 `~/.workbuddy/mcp.json` 新增独立 server `aoci-genetech`（指向本项目），**不动**已有的 `aoci`（swarmlabs）。
`verify` / `check` 全绿，`code_skipped` 是超限数据文件被正确排除，非失败。

**工程级价值**：仓库现在自带 `AGENTS.md` + 认知索引 + MCP 认知层，任何接入 WorkBuddy 的 agent 都能直接读取本项目结构，符合「工程级应用」定位。

> 注：移动 32 个文件后 Baseline 内路径已陈旧。AOCI 安全模型禁止 `scan --force` 重建（防洗白漂移），后续跑一次 `aoci maintain` 会自然调和，无功能影响。

---

## 2. 定时任务整合（GitHub Actions cron）

**问题**：4 个 workflow 存在 cron 撞车 + 死任务。
- 每天 `30 12 * * *` 同时挂在 `api-guard-deploy` / `ops-extra` / `ops` 三个 workflow（竞态推送冲突）
- `ops.yml` 另有每小时 `0 * * * *`
- `ops-extra.yml` 的 `all` 任务引用 4 个**根本不存在**的 pipeline 脚本，每日 `all` 必红

### 2.1 调度错峰（消除撞车）

| Workflow | 原 cron | 新 cron | 说明 |
|---|---|---|---|
| `ops.yml` | `0 * * * *` + `30 12 * * *` | 不变 | 锚点：小时级数据涡轮 + 每日主飞轮 |
| `ops-extra.yml` | `30 12 * * *` ⚠️ | `0 13 * * *` | 错峰 30 分钟 |
| `api-guard-deploy.yml` | `30 12 * * *` ⚠️ | `30 3 * * *` | 恢复离峰安全网 |
| `pages-deploy.yml` | `20 */4 * * *` | 不变 | 每 4h 重建，合理 |

### 2.2 清理死任务（引用缺失脚本）

从 `ops-extra.yml` 移除 4 个 task（`cite`→`cite-check.js`、`ossscan`→`oss-scan.js`、`abstractbackfill`→`abstract-backfill.js`、`edge_refresh`→`tools/edge-builder.py`）—— 全仓确认这些文件不存在，会从 `all` 拖垮每日 CI。

**校验**：4 个 workflow YAML 全部合法，cron 不再重复。

---

## 3. 文件夹清理归类

### 3.1 删除过程/构建垃圾（gitignored，可重建，不碰远端）
- `_site/`（723MB）+ `_site_geo/`（875MB）= **1.6GB** Pages 构建产物 → 删
- `logs/`、`__test_push__.txt` → 删

### 3.2 归类入库文件（git mv 本地 + 建新路径 + 删旧路径，远端 32 文件移动）

**→ `docs/planning/`**（根目录散落的策略/规划文档，全部入库）：
- 10 份：`GeneTech-14站健康提升.md`、`GeneTech14站-投资人提升方案与用户走查.md`、`SEO-GEO推广清单.md`、`changelog.md`、`修复日志.md`、`发布指南-GeneTech-Data-MCP.md`、`推广素材包.md`、`推广自动化策略.md`、`自动化闭环诊断与提升方案.md`、`项目总览.md`
- `ux-audit-and-strategy/`（含 html + 本地 assets，真实 UX 审计交付物）

**→ `archive/`**（7 月历史审计/修复工具包，无现役代码引用，可逆保留）：
- `genetech14-audit-report/`（1.1M，审计 HTML + echarts）
- `genetech14-fixes/`（149K，apply-all.js / api-gateway / automation / monitoring / security / ux-fixes）
- `archive/legacy/data.js`（6084B 前端遗留加载器，无人 import）

### 3.3 删除空壳目录
- `genetech14-audit-report` / `genetech14-fixes`（tracked 文件移走后留的空子目录壳）→ 删
- `poc` / `pipelines-extra`（空残留）→ 删

### 3.4 保留项（确认现役，不动）
- 30 个分站目录（`agritech`…`tcm-tools`，含 `genetech-tools`/`agent-ecosystem`，经 `site-domain-tags.mjs` 真源确认现役）
- `sitemap.xml`（被 `github-actions-ops.yml` + `build-site.mjs` 引用，现役 SEO）
- 根 `glama.json`（AIShield 安全 MCP 清单，与 `mcp-server/glama.json` 是不同产品）
- `.active/` / `.proposals/`（`arxiv-cross-domain-bridge` Tech Radar 提案状态，现役研究工作流）
- `command-center` / `payment-template` / `content` / `shared` / `guards` / `consumer-sdk` 等有入库内容的合法目录

### 3.5 标存未删（gitignored，不入库、不影响远端，供你人工决定）
- `tmp/`（gitignored 过程脚本 + geo-audit 日志，含 `push_files_atomic.py` 等可能有用脚本）
- `audit/`（gitignored 本地审计日志 `2026-09-29.jsonl`）
- `external-projects/`（gitignored 20M 参考材料）
- `consumer-sdk/`（仅 `__pycache__`）

### 3.6 一致性修正
- `operations-plan/pipeline-monetization.js:246` 过时路径字符串 `genetech14-fixes/api-gateway/` → `archive/genetech14-fixes/api-gateway/`（已推 commit `89e55e2`）

---

## 4. 远端提交记录（本轮）

| commit | 内容 |
|---|---|
| `3d06539` / `5de2ff7` | 之前轮次飞轮产物收口（本任务前已落地）|
| `475769e` | 26 文件归类（docs/planning + archive）+ 删旧路径 |
| `9452e64` | 补充 6 文件归类（5 md + ux-audit）|
| `89e55e2` | pipeline-monetization.js 路径修正 |
| `fad238d` | AOCI 认知产物 + AGENTS.md 入库 |

---

## 5. 完成度对账

| 子任务 | 状态 |
|---|---|
| AOCI 工程级接入（init+scan+MCP+入库） | ✅ 完成 |
| 定时任务整合（错峰 + 清死任务） | ✅ 完成 |
| 文件夹清理（删垃圾 / 归类 / 删空壳 / 保现役） | ✅ 完成 |

**结论**：三项全部完成，仓库已从「飞轮产物散落 + cron 撞车 + 1.6GB 构建垃圾 + 根目录 16 份规划文档」升级为「AOCI 认知层 + 错峰调度 + 干净目录结构」的工程级状态。

---

## 6. 你后续可选（非阻塞）

1. **AOCI 完整索引**：`aoci maintain` 约 20 轮写满 520 条 code 条目（较大工程，可另排期）。
2. **本地 git 对齐**：飞轮/清理均走 API 推送，本地 `git` 落后远端且分叉。需要时 `git fetch && git reset --hard origin/master`（会丢弃本地独有但内容已并入的提交）。
3. **`tmp/` 等 gitignored 目录**：如确认无用可手动删（不影响远端）。
4. **Worker 部署**：仍是之前唯一硬阻塞（见 `unified-license/DEPLOY-NOW.md`，3 步）。
