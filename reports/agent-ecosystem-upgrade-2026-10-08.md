# GeneTech 30 站知识引擎 — Agent 生态位补全报告

> 生成时间：2026-10-08
> 范围：与核心目标对标 + 开源市场扫描 + 自研补齐各层生态位 + 需用户配合的逐步指引（含链接）
> 立场：对外展示英文；本文件中文，供内部决策。

---

## 0. 与核心目标的对标结论

**核心目标（四条硬线）**
1. 数据飞轮跑通 + 守住（扩库 → 边变多 → 缺口更准 → 指导扩库）
2. 付款不重复（线上 KV 写失败被吞 → 用户重复下单）
3. 对外可达（30 站 + API 端点 + 知识库能被外部消费）
4. 护栏防回归（治理策略 + CI 门禁不被悄悄绕过）

**本轮判定的「符合就继续 / 自研补齐」项**
- ✅ **编排层（Orchestration）**：此前唯一缺失的生态位。自研 `agent-ecosystem/orchestrator.mjs`，把 认知(AOCI) + 数据(citation-gaps) + 治理(guards) 串成飞轮扩域自主决策管线 → 直接服务目标 1。
- ✅ **可观测层（Observability）基线**：自研 `agent-ecosystem/observe.mjs`，把分散的运行信号聚合成健康卡，专门盯「静默失败 / 护栏回归 / 支付异常」→ 直接服务目标 2/4。
- ✅ **分发生态位（Distribution）**：`mcp-server` 已就绪（v1.2.0），发布到 npm/Glama/Smithery 即把知识库开放给外部 Agent → 直接服务目标 3。**这一步需要你的账号，已给出逐步指引。**
- ⏸ **运行时层部署（Runtime）**：`unified-license` Worker 修复代码已入库并通过 CI，但 `wrangler deploy` 需你浏览器登录一次 → 直接服务目标 2。**已给出逐步指引。**

**不符合 / 不在此轮范围**：Model 层（仓库只消费外部 LLM，无需托管模型）；纯展示型前端改造（已由 `tools/build-site.mjs` 在前序收口）。

---

## 1. Agent 生态分层模型（2026 行业共识）

沿用 2026 年收敛的「四纵 + 五横」分层：

**纵向（执行栈）**
| 层 | 职责 | 2026 主流 OSS |
|---|---|---|
| Model | 推理引擎 / LLM | vLLM、Ollama、各类 API |
| Runtime | Agent 执行环境 / 服务化 | Cloudflare Workers、NVIDIA OpenShell、LangGraph runtime |
| Orchestration (Harness) | 多 Agent 编排 / 状态机 / 决策流 | LangGraph、CrewAI、AutoGen(AG2)、Microsoft Agent Framework |
| Agent (App) | 领域应用 / 具体智能体 | 领域专用 |

**横向（贯穿层）**
| 层 | 职责 | 2026 主流 OSS |
|---|---|---|
| Memory | 记忆 / 上下文 | mem0、Letta、Graphiti |
| Tools | 工具 / 协议 | MCP 协议（Anthropic）、~600+ 公开 server |
| Security/Governance | 策略 / 护栏 | OPA/Rego、policy-as-code |
| Observability | 追踪 / 评估 / 回归 | Langfuse(MIT)、Arize Phoenix、Comet Opik、OpenLIT |
| Distribution | 分发 / 上架 | npm、Glama、Smithery、Official MCP Registry |

---

## 2. 开源市场扫描 + 本仓现状对标（核心表）

| 生态位 | 本仓现状 | 缺口 | 开源对标（2026） | 本仓对策 |
|---|---|---|---|---|
| **Model** | 消费外部 LLM API（商汤/DeepSeek 等） | 无（消费方） | vLLM / Ollama | 不托管，保持 BYOK |
| **Runtime** | `api-guard`（Pro Key HMAC 鉴权）+ `unified-license`（支付）两个 Worker 源在位 | `unified-license` 未部署上线 | Cloudflare Workers、NVIDIA OpenShell | **自研已就绪，部署需用户**（见 §5-A） |
| **Orchestration** | 本轮前缺失；`command-center` 仅做跨项目状态聚合 | 无真正编排 | LangGraph（生产默认）、CrewAI、AutoGen | **自研 `orchestrator.mjs`**，零框架依赖、Policy 驱动（见 §3） |
| **Agent/App** | 30 站 + 数据飞轮（28k+ 边）+ guards | 无 | 领域专用 | 已就绪，核心资产 |
| **Memory** | AOCI 认知层（`aoci.txt` meta+code）已接入 | 无 | mem0 / Letta / Graphiti | 已就绪（上轮收口） |
| **Tools** | `mcp-server` = `@genetech/data-mcp` v1.2.0（list_sites/query/semantic/graph/citation_gaps…） | 未发布到市场 | MCP 协议 | **自研已就绪，发布需用户**（见 §5-B） |
| **Security/Governance** | `guards/*.policy.json` ×3（publish/ingest/evolve，default=deny）+ `tools/guard-eval.mjs`（json-logic 求值引擎） | 无 | OPA/Rego | 已就绪，语义对齐 OPA |
| **Observability** | `command-center`（跨项目聚合）+ 本轮新增 `observe.mjs` | 无 trace/eval 闭环 | Langfuse / Phoenix / Opik | **自研 `observe.mjs` 基线**（见 §3），后续可接 OTLP→Langfuse |
| **Distribution** | `mcp-server` 有 `glama.json` 清单，未上架 | 未上 npm/Glama/Smithery | npm / Glama / Smithery | **需用户账号上架**（见 §5-B） |

**扫描结论**：记忆 / 工具 / 治理 / 运行时 / 领域应用 五层本仓**已实现对应功能**，无需重写；唯一结构性缺口是**编排层**与**可观测基线**，本轮已自研补齐。Distribution 层是「功能已完、只差上架」，属用户账号动作。

---

## 3. 本轮自研交付（零新依赖）

| 文件 | 层 | 作用 | 验证结果 |
|---|---|---|---|
| `agent-ecosystem/orchestrator.mjs` | Orchestration | 串联 AOCI(认知)+citation-gaps(数据)+guards(治理)，输出飞轮扩域自主决策 | 运行：可放行 101 / 拦截 0 |
| `agent-ecosystem/flywheel-plan.json` + `.md` | Orchestration 产物 | Top-10 优先扩域（按 `combinedSize` 收益排序） | 正常渲染 |
| `agent-ecosystem/observe.mjs` | Observability | 聚合管线报告 + 各层状态 → `ecosystem-health.json` 健康卡 | 运行：8 层状态全采集 |
| `agent-ecosystem/ecosystem-health.json` | Observability 产物 | 机器可读的生态健康快照 | 已生成 |

**编排层设计要点**（避免重蹈覆辙，见 memory §2 血泪）：
- 严格复用 `tools/guard-eval.mjs`，**不截取生产代码做 harness**；
- 决策以 `publish.policy.json` 的 `allowed_sites` 白名单为主判定（真实治理语义），**容量在本地不可靠（index.json 多报 10000 占位）时按「未知即视为可行」处理**，不退化成全拒；
- 串行执行，避免共享计数器交错（CI 门禁双向回归已验证）。

---

## 4. 开源对标取舍：哪些「接入」而非「重写」

- **编排**：LangGraph 是 2026 生产默认，但重且绑定 LangChain。我们的飞轮决策是**纯 Policy 驱动、无图状态**的薄编排，符合「许多团队写受 LangGraph 启发但更薄的自定义编排器」的趋势——**不引入框架依赖**。
- **可观测**：Langfuse/Phoenix/Opik 是 2026 OSS 主流（trace + eval + 会话回放）。我们先以零依赖本地聚合跑通信号收集，**结构上预留 OTLP 出口**，后续可把同一批 span 接到 Langfuse/Phoenix，不必现在重写。
- **记忆**：AOCI 已覆盖仓库级认知；若需对话级/会话级记忆可后续评估 mem0/Letta，但当前非核心目标瓶颈。
- **工具/协议**：直接采用 **MCP 协议**（已是事实标准，~600+ 公开 server），本仓 `mcp-server` 即 MCP server，无需自造协议。

---

## 5. 需要你配合的操作（逐步 + 链接）

> 这两步都因「Cloudflare 浏览器 OAuth / npm 账号」而无法由我代跑。下面是每一步的精确命令与链接。

### A. 部署 `genetech-license` Worker（支付防重复 · 硬阻塞）

**为什么必须你做**：我的 CF token 能读能写脚本，但 `wrangler deploy` 需浏览器 OAuth 登录（Turnstile 拦自动化）；且 `secret_text` 绑定只能经 `wrangler deploy` 走（API 单独改是 405）。详细根因见 `unified-license/DEPLOY-NOW.md`。

**步骤（约 5 分钟）**
1. **登录**（一次性）：打开终端（Git Bash / PowerShell 均可）—
   ```bash
   cd "C:/Users/xing/Desktop/知识引擎14站/unified-license"
   npx wrangler login
   ```
   浏览器弹授权页 → 选 **61960005@qq.com** 账户（另两个账户没有这个 Worker）。
   - wrangler 文档：https://developers.cloudflare.com/workers/wrangler/commands/login/
   - Cloudflare 登录入口：https://dash.cloudflare.com/login

2. **部署**（`wrangler.toml` 的 `name` 已预置为 `genetech-license`，无需改）—
   ```bash
   npx wrangler deploy
   ```
   看到 `Uploaded genetech-license (37.4 KB …)` 且 Total Upload 成功即完成。
   - 部署文档：https://developers.cloudflare.com/workers/wrangler/commands/deploy/

3. **验收（两条 curl 必须都过）**—
   ```bash
   curl -s -X POST https://license.swarmlabs.tools/api/hupijiao/create-order \
     -H "Content-Type: application/json" -d '{"plan":"pro","email":"you@example.com"}'
   ```
   期望 `order_persisted":true`（KV 满则是 `confirm_mode:"async"` —— 同样是修复生效证据）。
   ```bash
   curl -s "https://license.swarmlabs.tools/api/hupijiao/order?trade_order_id=<上一步返回的ID>"
   ```
   修复前 `404 not_found`（用户以为失败→重复付）；修复后 `202 unknown / 请勿重复下单`。

> 部署后 KV 0 keys 的根因是免费版每日写配额耗尽（非绑定缺失）。根治方案（Durable Object / R2，约 30 行，我可写好只留部署）见 `DEPLOY-NOW.md` 第五节，零成本先做方案 A（等 UTC 0 点配额重置）。

### B. 发布 `mcp-server` 到 npm / Glama / Smithery（分发生态位）

`mcp-server` 代码、README、`glama.json` 清单已就绪（v1.2.0，MIT）。上架让外部 Agent 能实时查询 30 站知识库 → 直接服务「对外可达」。

**1) npm（代码分发）**
```bash
cd "C:/Users/xing/Desktop/知识引擎14站/mcp-server"
npm login            # 浏览器登录你的 npm 账号：https://www.npmjs.com/login
npm publish --access public
```
- 需先有 npm 账号：https://www.npmjs.com/signup
- 发布文档：https://docs.npmjs.com/cli/commands/npm-publish

**2) Glama（MCP 发现/一键安装）**
- 清单 `mcp-server/glama.json` 已就位。去 https://glama.ai/mcp/register 注册/登录后提交该 server（或连接 GitHub 仓库 `lm203688/genetech-14-sites` 自动识别）。
- Glama 上架指南：https://glama.ai/docs

**3) Smithery（MCP 市场）**
- 注册/登录 https://smithery.ai ，新增 server 指向本仓库或已发布的 npm 包 `@genetech/data-mcp`。
- Smithery 文档：https://smithery.ai/docs

> 三项都只需你的账号授权，代码与清单我已备齐。完成后把 `mcp-server` 的线上链接回发我，我可补进对外文档与 `oss/registry` 端点描述。

---

## 6. 下一步建议（按优先级）

| 优先级 | 动作 | 归属 | 阻塞 |
|---|---|---|---|
| P0 | 执行 §5-A 部署 Worker | 用户 | 浏览器登录 |
| P0 | 执行 §5-B 发布 mcp-server | 用户 | npm/Glama/Smithery 账号 |
| P1 | 把 `observe.mjs` 接入 CI（每次 push 后生成 `ecosystem-health.json` 并告警） | 我 | 无 |
| P1 | 用 `orchestrator.mjs` 驱动一轮真实扩域（101 对里 Top-10） | 我 | 无（需先确认扩域批次策略） |
| P2 | 把 `observe.mjs` 的 span 接 OTLP → Langfuse/Phoenix | 我 | 无（可选） |
| P2 | KV 配额根治（Durable Object / R2） | 我写好，用户部署 | 同 §5-A |

---

## 附：本次新增/改动文件（待推送远端 master）

- `agent-ecosystem/orchestrator.mjs`（新建·编排层）
- `agent-ecosystem/flywheel-plan.json` / `.md`（新建·产物）
- `agent-ecosystem/observe.mjs`（新建·可观测层基线）
- `agent-ecosystem/ecosystem-health.json`（新建·产物）
- `reports/agent-ecosystem-upgrade-2026-10-08.md`（本报告）

---
*由 WorkBuddy 在 agent 会话中生成；事实锚定：30 站白名单治理、AOCI 接入、unified-license 部署手册、mcp-server v1.2.0、开源扫描（LangGraph/CrewAI/AutoGen、Langfuse/Phoenix/Opik、MCP 协议，2026-10-08 检索）。*
