# GeneTech 任务收尾封锁清单（2026-10-17）

## 进度快照
- **已完成 361 / 373**（0 in_progress）
- 剩余 **12 项 pending**，全部为 AI 本次会话无法自主闭环的项
- 本轮（含前序）已将可自主项推进到极限；剩余项经证据核验均为外部账号 / 会话凭证 / 长期架构项

## A 类 — Cloudflare / 域名账号硬阻塞（需你本人登录账号操作）

| # | 任务 | 卡点 | 解锁动作 |
|---|------|------|----------|
| #66 | 激活 genetech.tools 到可用 zone | 无 zone | Cloudflare 添加 `genetech.tools` 为 zone 并激活（账号 61960005） |
| #68 | 改源码端点 + 加 zone 路由 | 依赖 zone 存在 | #66/#69 就绪后改 endpoints + 路由逻辑（可本地写码，但需部署才生效） |
| #69 | genetech.tools 承载 license 端点（方案 A） | 依赖 zone + 部署 | zone 就绪后把 license 端点迁到 `genetech.tools` |
| #158 | 迁移 CF_API_TOKEN 到 Worker Secret | 需账号权限 | Cloudflare Dashboard/API 将 token 设为 Worker Secret（账号 61960005） |
| #269 | §5-A 部署 genetech-license Worker | 需账号登录 | `wrangler login`(61960005) → `wrangler deploy`，见 `unified-license/DEPLOY-NOW.md` |

## B 类 — 会话级凭证阻塞（GITHUB_TOKEN 缺失，Data-API 推送不可行）

| # | 任务 | 卡点 | 解锁动作 |
|---|------|------|----------|
| #21 | 推送上次卡住的代码改动 | 无 GITHUB_TOKEN | 提供 token 后跑 `GITHUB_TOKEN=ghp_xxx bash scripts/push-phase5.sh`（内部走 `.workbuddy/probe/push-new-files.mjs`）。当前本地领先 origin/master **44 commits**、并有 **2 处未提交改动** |
| #97 | 安全推送全部本轮交付 | 无 GITHUB_TOKEN | 同上 |

> 注：本仓库推送惯例不用 `git push`（bot 写远端会分叉），一律走 Data-API 通道；该通道依赖 `GITHUB_TOKEN`。

## C 类 — 真实长期 / 架构项（需部署或网络，依赖 A/B 解锁）

| # | 任务 | 阻塞说明 |
|---|------|----------|
| #198 | 语义索引覆盖 4.4% → 全量 | 全量受 Cloudflare Worker 128MB 内存限制。脚本 `operations-plan/pipeline-search-index.js` 纯本地可跑，但全量需 `--shards` 产出 `data/search-index/manifest.json`，且必须先给 `worker.js` 写分片加载器消费它——该加载器未建，分片默认不写（"无消费方=白占配额"）。需 Worker 改造 + 部署 |
| #199 | 回收 KG 双副本 11.7MB + INTEL_KV 绑定 | `knowledge-graph-entities.json` 被 `mcp-server/src/*`、`tools/build-site.mjs`、各 `tests/*` 多处引用，**非安全直删**；需重构为单一真源并更新全部引用，且需部署。两文件 MD5 相同（c80056b4…），证明从未真正回收 |
| #204 | 回收 KG 双副本并补齐 INTEL_KV | 同 #199；INTEL_KV 绑定需 CF 账号（#150 已建 KV 容器，绑定动作需账号） |
| #207 | 跑通 OpenAlex 扩库，救活 3 个 404 端点 | OpenAlex 对这批 DOI 返回 404（未收录），需换源/补数据 + 部署。`reports/data-quality-2026-10-15.md` 确认仍 0/20 |
| #245 | GeneTech 30 站知识引擎全面实施（Phase 14+） | 路线图总 umbrella，需 A/B/C 多项先后解锁后分期推进 |

## 解锁后建议执行顺序
1. **恢复 GITHUB_TOKEN** → 解除 #21/#97，把 44 commits + 2 处改动推上 main（含 #199/#204 重构若有）。
2. **登录 Cloudflare 61960005** → #66 / #158 / #269（#68 / #69 随之解锁）。
3. **部署后实测** → 补 #198 分片加载器、#207 OpenAlex、#245 分期推进。

## 结论
AI 可自主推进项已全部完成（361/373）。剩余 12 项均卡在「外部账号 / 会话凭证 / 长期架构」三类硬阻塞，非 AI 能在本会话闭环。提供 `GITHUB_TOKEN` 与 Cloudflare 61960005 账号登录后，可立即解锁 B 类全部 + 推进 A/C 类。
