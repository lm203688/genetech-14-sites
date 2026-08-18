# GeneTech 14 站知识引擎 · 运维手册（Ops Runbook）

> 配套 `project-comprehensive-review.md` §4。目的：把"哪些 AI 自动做、哪些你本机做"钉死，定义告警阈值与升级路径，降低单人 ops 依赖。

---

## A. 自动化清单（本项目的）

| 自动化 ID | 名称 | 频率 | 产出 | 推送？ |
|---|---|---|---|---|
| `automation-1786700735812` | 每周 GEO 内容生成 | 周一 09:00 | `content/blog/*` + 更新 `geo-promotion-tracker.md` | 可（api-push） |
| **新增** | 每日数据库扩张健康巡检 | 每日 06:10 | `reports/db-health/<date>.json` + `log.md` | ❌ 不推送（游标归 CI） |
| **新增** | 每周战略指标摘要 | 周一 09:30 | `reports/weekly-digest/<周一>.md` | ❌ 不推送（仅本地指标盘） |

> SwarmLabs / AIShield / RoboParts 的 18+ 个自动化**与本项目的数据库/商业闭环无关**，勿混淆。

---

## B. 告警阈值（健康巡检用）

| 指标 | 阈值 | 严重度 | 动作 |
|---|---|---|---|
| 任一站实体数 = 0 | 触发 | 🔴 | 立即查该站 `entities.json` 是否生成失败，手动跑 `node operations-plan/pipeline-data-backfill.js --site=<站>` |
| 24h 总增量 < 50 | 触发 | 🟠 | 查 CI 是否仍在跑（`ops.yml` cron）、`state/backfill-cursor.json` 是否推进 |
| 游标连续 2 日未变 | 触发 | 🟠 | CI 可能挂了，查 GitHub Actions `ops.yml` 最近运行 |
| 构建失败 / 数据契约破坏 | 触发 | 🔴 | CI 内置「Verify data contract」会拦，先本地 `node tools/build-site.mjs` 复现 |

---

## C. 责任人分工（清楚划线）

**AI 自动做（无人值守）**
- 数据扩量（CI 每小时）、GEO 内容（每周）、DB 健康巡检（每日）、指标摘要（每周）、文档/策略撰写与推送。

**你必须本机做（硬阻塞，AI 代做不了）**
1. 虎皮椒支付闭环：`wrangst` → 实为 `wrangler secret put HUPIJIAO_APP_ID/APP_SECRET/ADMIN_SECRET`（账户须 `61960005`）。
2. CF 路由：`swarmlabs.tools` 加 `api.swarmlabs.tools/* → genetech-api-guard`（ask 推理国内可用）。
3. 撤销暴露的 `ghp_…` / `github_pat_…` PAT 换 fresh token。
4. 企业数据授权BD（谈客户、签合同）、私域社群开通、Glama/Smithery 认领。

---

## D. 手动步骤速查（关键路径）

**支付闭环（最关键）**
```
cd unified-license
npx wrangler secret put HUPIJIAO_APP_ID      # 201906181178
npx wrangler secret put HUPIJIAO_APP_SECRET  # 你给的 App Secret
npx wrangler secret put ADMIN_SECRET         # 自定义强随机串
```
健康自检：`curl https://license.swarmlabs.tools/health` → `{"status":"ok",...}`
付一笔 ¥9.90，页面 3 秒内显示 `GUX_` 即通。

**ask 推理路由**
CF Dashboard → `swarmlabs.tools` → Workers Routes → 加 `api.swarmlabs.tools/*` → `genetech-api-guard`。

**安全推送（AI 用）**
`tools/api-push.mjs` 走 `api.github.com`，推送前必先同步 `state/backfill-cursor.json` 远端副本，避免覆盖数据库扩张游标（历史踩坑）。

---

## E. 文档真相表（防漂移）
| 说法 | 真相 | 来源 |
|---|---|---|
| 虎皮椒后台需配 notify_url | ❌ 虎皮椒后台无此入口；回调由 worker.js 每笔订单自动带 | 已 WebSearch 核实 + 代码第 660 行 |
| `*.workers.dev` 可作国内主端点 | ❌ 国内被墙（ERR_CONNECTION_TIMED_OUT） | 实测 |
| genetech.tools 已可加路由 | ❌ Registrar 在未知账户，zone pending/ns_mismatch | CF API 实测 |
| 数据库持续每小时扩张 | ❌ 2026-08-17 后游标触顶停滞于 49,879（CI 无新增） | 本仓实算 + db-health-history.json |
| §4.5 运维/质量改进已推送部署 | ❌ 仅编码未推送，DOI 仍 0% 印证未部署 | git status + 线上 DOI 0% |
| 每日巡检会自动告警触达 | ❌ 此前仅写本地日志无触达，8-18 的 STALL 未被看到（本轮补强为经 Agent Mail 发信） | db-health-log.md 2026-08-18 |
