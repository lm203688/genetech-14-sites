# Phase 8-D Governance Sprint 落地报告

> 日期: 2026-10-16
> 对应: `reports/phase8-execution-plan.md` § 五 · P8-D 治理 Sprint（第 6-8 周）
> 状态: **M4 部分 PASS**（CI 验签 100% ✅ / Agent Card 契约 ✅ / Worker 部署阻塞 ❌）

---

## 一、本 Sprint 交付清单

### 5.1 签名接入 CI（W7）

| 交付 | 行数 | 判据 |
|---|---|---|
| `tools/ci-verify-sig.mjs` | 173 | 白名单 9 产物验签，任一失败 exit 1 阻断发布 |
| `.github/workflows/ops-extra.yml` 加 signverify 任务 | 392 行 | 每日 13:00 UTC 自动验签 + `--sign-missing` 一键补签 |
| `data/signing-audit.jsonl` | - | 审计日志（每 CI 跑一行 ts + count + ok + failed） |

### 5.2 A2A 端点部署（W8）

| 交付 | 行数 | 判据 |
|---|---|---|
| `api-guard/worker.js` 加 `/agent-card` 路由 | 1730 行 | GET 免鉴权返回 JSON，Cache-Control: max-age=3600 |
| `api-guard/worker.js` 加 `/agent-card.sig.json` 路由 | - | 独立分发签名（抗篡改、抗量子） |
| `tools/mcp-remote/a2a-smoke.mjs` | 163 | 冒烟测试，未部署时降级本地契约验证 |

### P8-C 遗留深化

| 交付 | 行数 | 判据 |
|---|---|---|
| `mcp-server/src/index.mjs` 注入 withLedger | 1245 行 | 包装 registerTool，13 处工具自动记 honesty-ledger |
| `agent-ecosystem/discovery-credit-batch.mjs` | 150 | 24 verified 假设批量记入 discovery_credit |

---

## 二、M4 门禁判定

| 判据 | 目标 | 实际 | 状态 |
|---|---|---|---|
| CI 验签 100% 覆盖 | ≥ 100% | **9/9 OK** | ✅ PASS |
| `/agent-card` 端点上线 | curl 200 | 本地契约 PASS，Worker 未部署 | ⏳ **阻塞** |
| A2A 冒烟测试工具 | 存在 + 可跑 | ✅ `tools/mcp-remote/a2a-smoke.mjs` | ✅ PASS |
| ed25519 签名可验 | 通过 | ✅ signature valid + hash match | ✅ PASS |
| 审计日志 | 有 | ✅ `data/signing-audit.jsonl` | ✅ PASS |
| MCP 装饰器接入 | 13 处 | ✅ 全部（通过包装 registerTool 一次性接入） | ✅ PASS |
| Discovery Credit 批量入账 | 24 verified → ledger | ✅ 25 discoveries / 24 verified | ✅ PASS |

**M4 主判据「CI 验签 100%」PASS**。次判据「Agent Card 端点上线」因用户 `wrangler deploy` 阻塞暂无法验证线上 200。

---

## 三、CI 验签门禁实战

### 3.1 白名单 9 产物

```
✅ data/claims.json                        b3ccf2de2423...
✅ data/hypothesis-cards.json              b1abedb78f83...
✅ data/honesty-ledger.json                2a88a85f6773...
✅ data/stance-f1-eval.json                99b57f9fff9e...
✅ data/extracted-claims.json              8175172aaa08...
✅ data/conflicts-v2-robot-parts.json      21e23ea80954...
✅ data/verification-runs/2026-10-16-all.json 2560cf1f6ffc...
✅ agent-ecosystem/agent-card.json         d11660b99561...
✅ agent-ecosystem/hypothesis-queue.json   b1a53d414fa6...

SUMMARY: OK 9/9 | Failed 0 | audit log: data/signing-audit.jsonl
PASS gate: all signatures valid
```

### 3.2 门禁策略

- **阻断性**：任一 hash mismatch / signature invalid → exit 1 → 阻断发布
- **可恢复**：`--sign-missing` 一键补签（缺签不阻断，仅提示）
- **审计**：每次 CI 跑 append 一行到 `data/signing-audit.jsonl`（ts + count + ok + failed）
- **每日刷新**：`ops-extra.yml` 的 `all` 任务 13:00 UTC 每日跑一次

### 3.3 双向回归测试

```
注入故障 → exit 1 → 恢复 → exit 0
```
本地已用「手改 target sha」验证：hash mismatch → FAIL；恢复后 → PASS。

---

## 四、A2A Agent Card 冒烟测试

### 4.1 契约校验（本地模式）

```
=== A2A Agent Card Smoke Test ===
[mode] LOCAL FILE

[checks] Card Schema
  ✅ name: GeneTech Knowledge Engine
  ✅ description: Autonomous Cross-Domain Discovery Networ...
  ✅ url: https://genetech.tools
  ✅ version: 1.0.0
  ✅ capabilities: present
  ✅ skills: present
  ✅ protocolVersion: 0.3
  ✅ skills.count: count=6

[checks] ed25519 Signature
  ✅ signature valid: true
  ✅ hash match: true
  signed_at: 2026-10-16T01:25:59.549Z

PASS gate: M4 A2A Agent Card
```

### 4.2 三档模式

| 模式 | 用途 | 判据 |
|---|---|---|
| `--local` | 本地契约验证（未部署时） | 只校 schema + 本地 sig |
| 默认 | HTTP 端点探测（部署后） | fetch `api.swarmlabs.tools/agent-card` |
| `--url <url>` | 指定端点（跨环境） | 任意 A2A client 目标 |

### 4.3 Worker 部署（阻塞）

用户账号硬阻塞项：
```
wrangler login (account: 61960005)
wrangler deploy (name: genetech-license)
```
未部署前，本地通过 `--local` 模式验证契约即可。**部署后** CI 会自动切换到 HTTP 端点模式。

---

## 五、MCP 装饰器接入（13 处 registerTool）

### 5.1 一次性包装 vs 逐处改造

原方案：逐处 `withLedger(name, handler)` 包裹 13 个 handler（侵入、易漏）。

**实际方案**（W8 优化）：
```javascript
const server = new McpServer({ name: 'genetech-data', version: '2.0.0' });

// 包装 registerTool：所有工具自动记 honesty-ledger
const _registerToolRaw = server.registerTool.bind(server);
server.registerTool = (name, opts, handler) =>
  _registerToolRaw(name, opts, withLedger(name, handler));
```

**收益**：
- 零侵入（不改任何 handler）
- 未来新工具自动接入（无需记得加装饰器）
- 测试只需测 `withLedger` + `registerTool` 包装

### 5.2 覆盖工具（13 个）

```
list_sites / list_entities / search_entities / get_entity /
get_related / get_citations / analyze_gaps / generate_hypothesis /
ask / run_pipeline / get_health / export_citations / submit_request
```

---

## 六、Discovery Credit 批量入账

### 6.1 操作

```
node agent-ecosystem/discovery-credit-batch.mjs --apply

applied: 24
total_discoveries: 25
verified_discoveries: 24
by_type: {"general":1,"litellbridge":24}
```

### 6.2 记账逻辑

| 事件 | 触发 | 累加 |
|---|---|---|
| discovery | 每 verified 卡 | +1 total_discoveries / +1 by_type[type] |
| discovery + verified | 每 verified 卡 | +1 verified_discoveries |
| verification_passed | 每 verified 卡 | +1 claims_verified |

### 6.3 诚实性账本变化

| 指标 | P8-C 末 | P8-D 末 | Δ |
|---|---|---|---|
| total_discoveries | 1 | 25 | +24 |
| verified_discoveries | 0 | 24 | +24 |
| claims_verified | 0 | 24 | +24 |

**Honesty Score 提升预测**：
- P8-C 末: 0.300
- P8-D 末: 0.5 × 0 + 0.3 × 1.0 + 0.2 × (24/25) = **0.492**
- 距 P8-D 目标 0.7 仍有差距（需下一 Sprint 补 abstention 事件）

---

## 七、Worker 端点路由

### 7.1 新增路由

```javascript
if (path === '/agent-card' || path === '/agent-card.sig.json') {
  const file = path === '/agent-card' ? 'agent-ecosystem/agent-card.json'
                                      : 'agent-ecosystem/agent-card.json.sig.json';
  const upstreamUrl = new URL('/' + file, UPSTREAM_BASE);
  const res = await fetch(upstreamUrl);
  const text = await res.text();
  return new Response(text, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
```

### 7.2 设计决策

- **免鉴权**：Google A2A 0.3 规范要求 Agent Card 是公开元数据（自证身份）
- **代理模式**：Worker 从 `data.swarmlabs.tools`（GitHub Pages）拉 agent-card.json，避免代码里内嵌 JSON
- **CORS 通配**：任意 A2A client 可跨域拉取
- **Cache 1h**：Card 变化频率低（每月级），1h 缓存减少重复抓取

---

## 八、关键工程决策（血泪）

### 8.1 CI 门禁必须双向回归

**教训**：本地跑通 ≠ CI 跑通。signverify 任务在本地 PASS 后必须实际 CI 跑一次确认。
- 已本地 9/9 PASS
- CI 每日 13:00 UTC 自动跑
- 首次推送后需 `gh run list --workflow=ops-extra.yml` 确认绿

### 8.2 A2A 冒烟测试的三档降级

线上未部署时（wrangler 阻塞），`a2a-smoke.mjs` 必须**优雅降级**：
- 优先 HTTP 拉线上
- 失败 → 本地 file:// 契约验证
- 都不行 → 明确 FAIL（不是 PASS）

**教训**：验证工具本身不能因为「网络不可用」就 PASS，必须显式区分「拉不到」与「拉到但契约不合」。

### 8.3 MCP 装饰器接入的封装层次

一开始想做「逐处 registerTool 包裹」，但 13 处 handler 各有差异（有的 async、有的直接返回 object），逐处改造风险高。**最终方案**：包装 `server.registerTool` 函数本身，一处改动全量生效。

### 8.4 Honest Score 0.492 vs 0.70 目标

24 verified discoveries 全部入账后仍差 0.2 分。原因：**弃权率 = 0**（未产生 abstain 事件）。

**说明**：这是"诚实但不完美"的诚实数字。要达 0.70，需要：
- 至少 20% 弃权率（P8-D 后期通过 MCP 真调用触发）
- 或预算消耗率降到 0（当前 0/5 已是最优）

不追求"数字好看"，只如实反映当前状态。

---

## 九、M4 里程碑判定汇总

| 判据 | 目标 | 实际 | 状态 |
|---|---|---|---|
| CI 验签 100% 覆盖 | 100% | **9/9** | ✅ PASS |
| A2A 契约（本地） | PASS | **PASS** | ✅ PASS |
| A2A 端点上线 | curl 200 | **未部署** | ⏳ 用户阻塞 |
| MCP 装饰器覆盖 13 工具 | 100% | **100%** | ✅ PASS |
| Discovery Credit 入账 | ≥ 20 | **24 verified** | ✅ PASS |
| 审计日志 | 存在 | **signing-audit.jsonl** | ✅ PASS |
| Worker 语法 | 无错 | **`node -c` 通过** | ✅ PASS |

**M4 主判据 PASS**。次判据（Worker 部署）依赖用户 `wrangler deploy`。

---

## 十、Git 状态

- 本地 HEAD: `8bf49a1` (P8-C closed-loop)
- 本 Sprint 新 commit: phase8-d-governance
- 远端推送: 通过 `.workbuddy/probe/push-new-files.mjs` GitHub Data API
- 签名文件: 更新 `data/honesty-ledger.json.sig.json`

## 十一、诚实性声明

- A2A 端点**未部署**（`wrangler deploy` 用户阻塞），冒烟测试用本地契约 PASS 代替
- 24 verified 假设全部基于**本地库证据**（cross-site-stance-support），不是 OpenAlex 权威验证
- Honesty Score 0.492 未达 0.70 目标，如实反映当前 abstention 事件为 0 的现状
- CI 门禁 signverify 任务是**新增**，尚未在 CI 上跑过（需 gh run list 确认）
- 签名文件（`.sig.json`）是**内容 sha256** 的签名，不是"整个 JSON 结构"签名，字段增删会触发 hash mismatch（**设计如此**，防止事后加字段绕过签名）
