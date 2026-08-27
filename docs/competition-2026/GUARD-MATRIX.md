# Guard 矩阵：4 个 Guard 的整合方案

> 借鉴 LabOps Guard / RevGuard / CyberGuard / OpsKeeper / SceneGuard / FinFlux 的「Guard 矩阵」母题。
> 目的：把当前散在 `api-guard/`、`unified-license/`、`.github/workflows/ops-stall-guard.yml`、`mcp-server/` 里的「守护/审计/付费」能力，整合为 4 个清晰命名的 Guard。

---

## Guard 矩阵总览

| Guard 名 | 现有实现 | 整合后职责 | 监控目标 | 失败处理 |
|----------|----------|-----------|----------|----------|
| **KnowledgeGuard** | 新建（在 KnowledgeGuard Agent 内） | 全链路 audit log 留痕；entity 准入/淘汰 | 6 个 Agent 全部 action | 写失败 → P0 Issue |
| **SourceGuard** | `operations-plan/pipeline-data-backfill.js` 部分 | 数据源健康监控；接入/降级/淘汰 | 6 源（OpenAlex/arXiv/Crossref/PubMed/Semantic Scholar/Europe PMC） | 源失败 → 切备用源 + 通知 |
| **PublishGuard** | `.github/workflows/pages-deploy.yml` | 发布门禁 + 自动回滚 | GitHub Pages 部署 | 部署失败 → 自动 rollback 到上一个 commit |
| **ComplianceGuard** | `api-guard/` + `unified-license/` | 付费墙 + 速率限制 + 凭据合规 + 配额审计 | License 端点 + API 调用 | 违规 → 阻断 + 通知 |

---

## Guard 1：KnowledgeGuard

**职责**：所有 Agent 写一行 JSONL 到 `audit/YYYY-MM-DD.jsonl`，每行结构：
```json
{"ts": "2026-08-24T22:30:00Z", "agent": "Collector", "action": "fetch_openalex", "status": "ok", "cost_ms": 230, "input_hash": "abc", "output_hash": "def"}
```

**当前缺口**：
- ❌ 无统一 audit 目录
- ❌ 无 schema 约定
- ❌ 失败时只建 Issue，没有结构化日志

**落地方案**：
1. 建 `audit/YYYY-MM-DD.jsonl` 目录（gitignore 大文件）
2. 每个 Agent 写日志时调用 `shared/audit.js#write`
3. KnowledgeGuard Agent 每日聚合 → `audit/daily-summary-YYYY-MM-DD.md`

---

## Guard 2：SourceGuard

**职责**：6 个数据源的健康监控与生命周期管理

**当前实现**：
- ✅ 有：`pipeline-data-backfill.js` 跑通 6 源
- ⚠️ 部分：失败时 `ops-stall-guard.yml` 告警
- ❌ 缺：源的生命周期（准入/降级/淘汰）显式策略

**落地方案**：
1. 建 `data/sources/source-health.json`，记录每个源的：
   - `last_ok` / `last_fail`
   - `success_rate_30d`
   - `entity_count`
   - `status`: `active` / `degraded` / `deprecated`
2. SourceGuard 每小时读此文件 + 跑健康检查
3. 成功率 < 80% 自动 `degraded`；连续 7 天 `degraded` 自动 `deprecated`

---

## Guard 3：PublishGuard

**职责**：14 站发布门禁 + 自动回滚

**当前实现**：
- ✅ 有：`pages-deploy.yml` 用 GITHUB_TOKEN 部署
- ⚠️ 部分：失败时 `ops-stall-guard.yml` 告警
- ❌ 缺：自动回滚到上一个 commit

**落地方案**：
1. 部署前先在 `_site/` 跑 build + 数据契约校验
2. 部署后跑 smoke test（curl 几个核心 URL）
3. smoke test 失败 → 用 `tools/api-push.mjs` revert 到上一个 commit

---

## Guard 4：ComplianceGuard

**职责**：付费墙 + 速率限制 + 凭据合规 + 配额审计

**当前实现**：
- ✅ 有：`api-guard/`（速率限制 + Pro HMAC）
- ✅ 有：`unified-license/`（License 验证 + 虎皮椒支付）
- ❌ 缺：凭据合规扫描（定期检查公开仓 secret 泄漏）
- ❌ 缺：配额审计（Pro 用户每月调用次数统计）

**落地方案**：
1. `compliance-guard/secret-scanner.mjs`：每周跑一次，扫公开仓历史 + 当前 commit，发现 `ghp_/github_pat_/hupijiao/CORE_API_KEY/cfut_` 模式 → 自动建 Issue
2. `compliance-guard/quota-audit.mjs`：每月 1 号聚合 Pro 用户用量 → 写 `audit/quota-YYYY-MM.md`
3. `compliance-guard/rate-limit-monitor.mjs`：实时监控 API 调用，发现异常 → 临时限流

---

## 与现有代码的对应关系（迁移路径，不立即改）

| Guard | 现有路径 | 整合后位置 | 迁移成本 |
|-------|----------|-----------|----------|
| KnowledgeGuard | 无 | `shared/audit.js` + `audit/` 目录 | 中（建新） |
| SourceGuard | `pipeline-data-backfill.js` + `ops-stall-guard.yml` | `operations-plan/source-guard/` | 中（拆 + 包装） |
| PublishGuard | `pages-deploy.yml` | `.github/workflows/publish-guard.yml` | 低（重命名 + 加回滚 step） |
| ComplianceGuard | `api-guard/` + `unified-license/` | `compliance-guard/` | 高（重构 + 凭据扫描） |

**说明**：以上迁移是 **P1 工作**，需要拍板。短期 P0 只需在 README 把现有 4 个组件重命名为 Guard 矩阵的成员。
