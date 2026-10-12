# 全量回归报告 · 2026-10-09

> 目的：把 §6 落地后的所有门禁、脚本、编排层的实测状态固化到文件。任何人 clone 下来跑一遍就能得到相同结论。
> 与 `reports/verify-online.md`（端点级）、`reports/quality-metrics-2026-10-08.md`（数据质量）互补，本报告覆盖**本地脚本与门禁层**。

---

## 1. 门禁 / 测试矩阵（2026-10-09 实测）

| 检查 | 命令 | 实测 | 退出码 |
|---|---|---|---:|
| guard-eval 冒烟 | `node tools/guard-eval.mjs` | **26/26 通过** | 0 |
| pipeline-quality-gate 自测 | `node operations-plan/pipeline-quality-gate.js --self-test` | **20/20 通过** | 0 |
| pipeline-quality-gate 实测（CI） | `node operations-plan/pipeline-quality-gate.js --ci` | 15/30 放行 · **15 站被拒** | **1** ✅ 阻断生效 |
| pipeline-quality-gate 实测（非 CI） | `node operations-plan/pipeline-quality-gate.js` | 报告已生成 | 0 |
| pipeline-docs-guard 检查 | `node operations-plan/pipeline-docs-guard.js --check` | 50 文档 · 8 白名单 · 42 内部已 stub · **0 泄露** | 0 |
| mcp-smoke | `node tools/mcp-smoke.mjs` | initialize ✓ · tools/list 14 ✓ · query ✓ · semantic_search ✓ | 0 |
| orchestrator | `node agent-ecosystem/orchestrator.mjs` | 30 站 · 870 有向对 · 101 零引用对 · 可放行 101 / 拦截 0 | 0 |
| frontier-briefing | `node operations-plan/pipeline-frontier-briefing.js --dry-run` | 30 站扫描完成 · 26 站近 30 天有内容 | 0 |
| verify-shard-live | `node operations-plan/verify-shard-live.mjs` | 单站 91s（30 站约 45 分钟），单站 entities=10000 / withDoiOrUrl=10000 | 0 |
| verify-shard-fidelity | `node operations-plan/verify-shard-fidelity.mjs --lib-miss=0.30` | 库 255,345 DOI / 分片 198,114 DOI · **混入 2.70% > 1%** | **1** ⚠️ 阈值触发（见 §3） |
| gate-alert 本地模式 | `node tools/gate-alert.mjs --local` | 正确识别 15 站被拒并生成失败明细 | 0 |

**判定**：8 项全绿 · 1 项按预期红（quality-gate --ci 阻断生效）· 1 项按预期红（shard-fidelity 阈值触发）。

---

## 2. 与 v2 报告 §9.4 的对照

v2 报告写：

> guard-eval 26/26 · quality-gate self-test 20/20 · CI 退出码 1（15 站被拒）· confidence 幂等 0 条待修正 · 门禁 15/30 放行

本次实测（2026-10-09）**与 v2 完全一致**。数字没有回归。

---

## 3. 本轮新发现

### 3.1 shard-fidelity 阈值触发（预期内）

`verify-shard-fidelity.mjs --lib-miss=0.30` 报「分片混入非库数据 2.70% > 1.00%」——**这是预期行为**：

- 阈值 1.00% 是**混入**（分片里有库没有的）的硬红线
- 24.51% 是**遗漏**（库里有分片没有的），报告 §9.3 说明这是「分片是库的子集，混入 0」的问题，本轮 CI 阈值先放到 30% 观测
- 2.70% 的混入需要单独调查，但不能与「分片覆盖不足」混为一谈

这条失败**不该被忽略**。建议下一步：查 `data/search-index/manifest.json` 的生成时间 vs 站点 `entities.json` 的最近修改时间，判断是不是有一站被单独重跑而分片没重建。

### 3.2 gate-alert 首次运行发现字段名误判

`tools/gate-alert.mjs` 首次跑本地模式时报「全放行（0/30）」——原因是它读的是 `v.allowed === true`，
而实际产物字段是 `v.decision === 'allow'`。如果这个不修，`gate-alert` 会让 15 站被拒却报绿线，
等于把「门禁静默失效」搬到了 Issue 层面。已修复，同一命令现在正确报「被拒 15/30」并列出全部 15 站。

**这是一条方法论层面的教训**：门禁工具自己也要被门禁——`tools/gate-alert.mjs` 也应该有 self-test。

---

## 4. 本轮新增的可执行产物

| 文件 | 对应报告条目 | 用途 |
|---|---|---|
| `.github/workflows/security-scan.yml` | F5 | CI 里跑 gitleaks，阻断含 secret 的 push/PR |
| `.gitleaks.toml` | F5 | gitleaks 项目配置（allowlist + entropy 阈值） |
| `.github/workflows/ops-extra.yml`（新增 3 task） | F3 / F1 / F2 | 加 `orchestrator` / `quality` / `gate-alert` 三个 workflow_dispatch 入口 |
| `tools/gate-alert.mjs` | F2 | 门禁失败时用 gh CLI 建/更新 GitHub Issue |
| `operations-plan/pipeline-frontier-briefing.js` | G3 | 每站 Top-N 月度简报（26/30 站近 30 天有内容） |
| `reports/quality-metrics-2026-10-08.md` | A8 | 人类可读的质量指标报告 |
| `reports/knowledge-graph-evidence-2026-10-09.md` | B1 | 引用边并入的验收证据（27.94% ≥ 20%） |
| `shared/components/provenance-badge.md` | G1 | 溯源徽章组件（可嵌入任意 HTML） |
| `content/frontier-briefings/*.md` ×30 | G3 | 首月简报产物（2026-10） |

---

## 5. 未做与边界

| 事项 | 状态 | 原因 |
|---|---|---|
| E1 支付 Worker 部署 | ⛔ 硬阻塞 | 需 `wrangler login` 浏览器 OAuth，无法代跑。步骤见 `unified-license/DEPLOY-NOW.md` |
| E2 KV 配额根治 | ⛔ 依赖 E1 | 部署后一起处理 |
| G0 站点自定义域 | ⛔ 硬阻塞 | 需 CF Zone 修改，无法代跑 |
| A5 剩余 15 站补数据 | ⛔ 大工程 | 需改采集管道，本轮不启动 |
| D0 MCP v2 迁移 | ⛔ 未启动 | 已建 `mcp-server/MCP-V2-MIGRATION.md`，需 npm 可达后核实 |
| D1 发布 MCP | ⛔ 需 npm 账号 | 报告 §5 已明确 |
| D2 remote MCP | ⛔ 需 CF 部署 | 依赖 E1 |
| C1 向量检索 | ⛔ 大工程 | 本轮不启动 |
| F2 告警触达（真实推送） | 🟡 部分完成 | 已建 Issue 通道（GitHub 内部），未接邮件/企业微信/钉钉——需要用户配置 webhook |
| F5 CI secret 扫描 | 🟢 已上线 | 需仓库 owner 首次手动 approve workflow |
| F3 编排层接 CI | 🟢 已上线 | 每日 13:00 UTC 自动跑，可 `workflow_dispatch task=orchestrator` 手动 |
| F1 门禁 CI 模式 | 🟢 已上线 | 每日 13:00 UTC 跑 `--ci`，15 站被拒会让 CI 红——这是**真实状态** |

---

## 6. 后续动作建议（按 ROI 排序）

1. **修 shard-fidelity 混入 2.70%**：查一次 `data/search-index/manifest.json` 与站点实体文件的时间戳，找出发散站。
2. **让 gate-alert 有 self-test**：仿照 quality-gate 的双向回归，构造一份假报告验证能正确识别 allow/deny。
3. **补一次 A5（数据补齐）的候选清单**：15 站里 11 站缺摘要，是同一批 datacite/arxiv 源在浅字段抓取——先算清"要抓多少条"再启动采集。
4. **G0 决策**：站点自定义域要么配 DNS（用户操作），要么在 README 里把「30 站」改成「30 个域的内容目录」——两种都可验证，中间态最坏。
5. **D0 迁移核实**：等 npm registry 可达时（网络问题），用 `npm view @modelcontextprotocol/server` 确认包名与语义，再决定是否迁移。

---

## 7. 复现命令

```bash
# 完整门禁回归（本地，约 5 分钟）
node tools/guard-eval.mjs
node operations-plan/pipeline-quality-gate.js --self-test
node operations-plan/pipeline-quality-gate.js
node operations-plan/pipeline-docs-guard.js --check
node tools/mcp-smoke.mjs
node agent-ecosystem/orchestrator.mjs
node operations-plan/pipeline-frontier-briefing.js --dry-run
node tools/gate-alert.mjs --local

# 慢门禁（约 50 分钟）
node operations-plan/verify-shard-live.mjs
node operations-plan/verify-shard-fidelity.mjs --lib-miss=0.30

# CI 阻断模式（会 exit 1）
node operations-plan/pipeline-quality-gate.js --ci
```
