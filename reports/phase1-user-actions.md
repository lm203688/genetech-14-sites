# GeneTech 阶段一 P0 用户手动动作清单

> 生成时间：2026-10-11（GMT+8）
> 基于：`reports/下一阶段全面提升报告-2026-10-11.md` §8 阶段一（0-30 天）
> 说明：本清单只列**必须用户本人操作**的项（账号/资金/登录硬阻塞），AI 已自主完成的技术项不在此列。

---

## 🔴 优先级 1：硬阻塞（不解会阻塞后续全部工作）

### 1. 部署支付 Worker（防重复付款）
- **动作**：`wrangler login` → `wrangler deploy`
- **位置**：`unified-license/`（或当前支付 Worker 目录）
- **预期**：支付回调正常，避免重复扣款
- **风险**：不部署则支付可能重复扣款或失败
- **耗时**：约 5 分钟
- **参考**：`unified-license/DEPLOY-NOW.md`（如存在）

### 2. DNS 决策（站点域 NXDOMAIN）
- **动作**：决定 `genetech.tools` 归属（是保留、迁移还是放弃）
- **背景**：memory 记录 `genetech.tools` 注册商与 DNS 托管在未知第三账户，61960005/463102527 两账户均不持有
- **选项**：
  - A. 找回 `genetech.tools` 所有权（需注册商操作）
  - B. 迁移到已持有的 `swarmlabs.tools` 子域
  - C. 放弃 `genetech.tools`，统一用 `swarmlabs.tools`
- **推荐**：B 或 C（A 可能耗时且不确定）

### 3. npm 发布 MCP Server
- **动作**：`npm publish`（在 `mcp-server/` 目录）
- **包名**：`@genetech/data-mcp` v2.0.0
- **前置**：需 npm 账号 + 2FA 配置
- **预期**：`npx -y @genetech/data-mcp` 可用
- **耗时**：约 10 分钟（含 2FA 设置）

---

## 🟡 优先级 2：商业化与增长

### 4. Glama 上架 MCP
- **动作**：在 https://glama.ai 提交 MCP Server
- **材料**：`mcp-server/glama.json`（已存在，需填充 tools 定义）
- **预期**：MCP 生态可见
- **耗时**：约 15 分钟

### 5. Smithery 上架 MCP
- **动作**：在 https://smithery.ai 提交 MCP Server
- **材料**：`smithery.yaml`（已存在，YAML 格式）
- **预期**：MCP 生态可见
- **耗时**：约 15 分钟

### 6. BD LOI 名单
- **动作**：确认目标客户名单，准备 LOI 模板
- **背景**：报告 §18 商业化完成度 15%，需 BD 推进
- **选项**：
  - A. 学术机构（AI4Science 方向）
  - B. 企业研发（生物医药、半导体）
  - C. 投资机构（技术尽调）
- **推荐**：A + B 并行

---

## 🟢 优先级 3：可选但推荐

### 7. GitHub Actions 工作流诊断
- **动作**：访问 https://github.com/lm203688/genetech-14-sites/actions 查看失败原因
- **背景**：21 次 workflow_dispatch 只有 1 次成功，其余 20 次 2 秒 failure（0 steps）
- **可能原因**：runner 分配失败 / workflow permissions 策略 / org policy 阻断
- **耗时**：约 10 分钟（看 UI）

### 8. PAT 轮换
- **动作**：Revoke 已暴露的 PAT，生成新 PAT
- **背景**：4 个 PAT 在聊天历史暴露（包括 classic + fine-grained）
- **推荐**：保留 1 个 classic PAT（capability 足够），Revoke 其余
- **耗时**：约 5 分钟

---

## 📊 当前状态摘要

| 项 | 状态 | 阻塞 |
|---|---|---|
| 支付 Worker 部署 | 🔴 未部署 | 需 wrangler login |
| DNS 决策 | 🔴 未决定 | 需用户选择 |
| npm 发布 | 🔴 未发布 | 需 npm 账号 |
| Glama 上架 | 🔴 未上架 | 需平台账号 |
| Smithery 上架 | 🔴 未上架 | 需平台账号 |
| BD LOI | 🔴 未开始 | 需用户决策 |
| CI 诊断 | 🟡 待查看 | 需访问 GitHub UI |
| PAT 轮换 | 🟡 待处理 | 需用户操作 |

---

## ✅ AI 已自主完成的技术项（无需用户操作）

1. **引用网络扩容**：refs JSONL → 25,682 跨站边（13x 提升）
2. **ER 试点**：biomed-ai 329 clusters（7.95% 实体），发现数据源重复问题
3. **飞轮诊断**：backfill-cursor 39 天、growth-baseline 50 天未更新
4. **Pipeline 脚本**：新增 `pipeline-refs-to-edges.js` + `pipeline-entity-resolution.js`
5. **数据更新**：citation-edges.json + citation-gaps.json 已更新

---

## 🎯 建议执行顺序

1. **立即**：PAT 轮换（5 分钟，降低安全风险）
2. **今天**：DNS 决策 + npm 发布（25 分钟，解除技术阻塞）
3. **本周**：支付 Worker 部署 + CI 诊断（20 分钟，解除生产阻塞）
4. **下周**：Glama/Smithery 上架 + BD LOI（30 分钟，启动商业化）
