# 6 个 Agent 角色定义

> 借鉴 RepoMesh / DevOrbit / 2origin / MergePilot / Multi-Agent Collab Runtime 的「多 Agent 团队」母题。
> 目的：把本项目隐式散在 `operations-plan/`、`shared/`、`mcp-server/`、`api-guard/` 里的能力，**显式映射**到 6 个 Agent 角色，每个角色都有明确的输入/输出/工具。

---

## 角色总览

```
                      ┌─────────────────────────┐
                      │   KnowledgeGuard        │
                      │   (审计/留痕)           │
                      └────────▲────────────────┘
                               │ 写 audit log
                               │
   ┌─────────────┐    ┌────────┴────────┐    ┌──────────────┐
   │  Collector  │───▶│   Normalizer    │───▶│  Validator   │
   │  Agent      │    │   Agent         │    │  Agent       │
   └─────────────┘    └─────────────────┘    └──────┬───────┘
   拉数据              归一/去重/转码              质量门禁
                                                   │
                                                   ▼
                                          ┌──────────────────┐
                                          │   Publisher      │
                                          │   Agent          │
                                          └────────┬─────────┘
                                                   │ 发布到 14 站
                                                   ▼
                                          ┌──────────────────┐
                                          │   Repair         │
                                          │   Agent          │
                                          └──────────────────┘
                                          失败时回滚/重抓
```

---

## 角色 1：Collector Agent（采集者）

| 字段 | 内容 |
|------|------|
| 职责 | 从 6 源（OpenAlex/arXiv/Crossref/PubMed/Semantic Scholar/Europe PMC）拉数据 |
| 当前实现 | `operations-plan/pipeline-data-backfill.js` + `pipeline-data-accumulation.js` |
| 输入 | 数据源 API key / query |
| 输出 | 原始 JSON，存入 `raw/` |
| 工具 | 各源 SDK / API；rate limiter |
| 失败处理 | 重试 3 次 → 写 `audit/failures.log` → 通知 Repair Agent |

---

## 角色 2：Normalizer Agent（归一者）

| 字段 | 内容 |
|------|------|
| 职责 | 跨源归一、字段映射、去重、ID 体系统一 |
| 当前实现 | `shared/` 下的部分工具 + `mcp-server/` 的检索层 |
| 输入 | Collector 产出的原始 JSON |
| 输出 | 标准 entity schema（参考 `entities.json`） |
| 工具 | 中文/英文 NLP；DOI/arXiv ID 解析 |
| 失败处理 | 字段缺失 → 标记为 `incomplete` 而非丢弃 |

---

## 角色 3：Validator Agent（验证者）

| 字段 | 内容 |
|------|------|
| 职责 | 质量门禁：引用核验、事实查证、跨源交叉 |
| 当前实现 | ⚠️ **未显式存在**，需新建 `operations-plan/agents/validator.js` |
| 输入 | Normalizer 产出的 entity |
| 输出 | 评分（0-100）+ 通过/拒绝 |
| 工具 | `mcp-server/data-mcp`（混合检索）+ 外部 LLM 验证 |
| 失败处理 | 评分 < 阈值 → 退回 Normalizer 或进 quarantine |

---

## 角色 4：Publisher Agent（发布者）

| 字段 | 内容 |
|------|------|
| 职责 | 把合格 entity 发布到对应垂直站 + 索引 + 缓存 |
| 当前实现 | `tools/build-site.mjs`（构建 + 部署） |
| 输入 | Validator 通过的 entity |
| 输出 | 14 站 `website/api/index.json` 更新；GitHub Pages 自动部署 |
| 工具 | GitHub API（推送 commit）；`pages-deploy.yml` 触发 |
| 失败处理 | 回滚上一个 commit → 通知 Repair Agent |

---

## 角色 5：Repair Agent（修复者）

| 字段 | 内容 |
|------|------|
| 职责 | 处理 Collector/Publisher 失败；自动回滚/重抓 |
| 当前实现 | ⚠️ **部分存在**（看门狗 + 部分 ops.yml retry） |
| 输入 | `audit/failures.log` 实时流 |
| 输出 | 修复后的状态 + 修复记录 |
| 工具 | `ops-stall-guard.yml` + Repair 决策表（轻量 rule engine） |
| 失败处理 | 3 次修复失败 → 建 GitHub Issue 通知用户 |

---

## 角色 6：KnowledgeGuard Agent（守卫者）

| 字段 | 内容 |
|------|------|
| 职责 | 全链路 audit log 留痕；异常检测；凭据/合规检查 |
| 当前实现 | ⚠️ **分散**（api-guard 是限流，license 是付费墙）→ 整合为 KnowledgeGuard |
| 输入 | 所有其他 Agent 的 action event |
| 输出 | `audit/YYYY-MM-DD.jsonl` + 异常告警 |
| 工具 | 写文件 + Webhook（可选） |
| 失败处理 | 写失败 → 升级为 P0 Issue（audit 缺失意味着不可信） |

---

## 协作流程（典型 1 次「研究问题→答案」全链路）

1. 用户在 ask.html 输入 query
2. **Collector Agent** 拉相关 entity 候选集
3. **Normalizer Agent** 统一为内部 schema
4. **Validator Agent** 评分 + 引用核验
5. **Publisher Agent** 把新增 entity 入库 + 更新 14 站
6. **Repair Agent** 监听失败，做回滚/重抓
7. **KnowledgeGuard Agent** 全程留痕，事后可回放

每一步都进 audit log，每一步都可独立替换/升级。
