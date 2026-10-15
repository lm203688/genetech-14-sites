# Logpush 审计配置（Cloudflare → R2 不可变审计）

> 目的：把 `audit/` 从「1 个 6 行 jsonl 的尽调红旗」升级为**不可篡改的外部审计源**。
> 报告锚点：`reports/项目分板块深度评估报告-2026-10-14.md` §13b audit 板块（完整度 15 / 成熟度 5）。

## 现状

- `audit/2026-09-29.jsonl`：6 行，actor 全是 `cli_test`，**无一条真实发证 / 支付审计记录**。
- 无法回答"哪张许可证发给了谁"这个基础尽调问题。
- Worker 侧 `unified-license/worker.js` 和 `api-guard/worker.js` 都没有接日志推送。

## 方案（Cloudflare Logpush → R2）

Cloudflare Logpush 每 5 分钟把 Worker 的 request / error 日志推到 R2 bucket。R2 提供对象锁（Object Lock），
一旦写入不可变（合规保留期内禁止修改、禁止删除）。

### 一、Cloudflare Dashboard 步骤（一次性，5 分钟）

1. **创建 R2 bucket**（如 `genetech-audit-logs`）
   - Workers & Pages → R2 → Create bucket
   - Location: `APAC`（就近，减少日志推送延迟）
   - Versioning: **Enabled**
2. **配置 Object Lock**（合规要求）
   - R2 → bucket → Settings → Object Lock
   - Mode: **Compliance**
   - Retention: `10y`（与许可证最长有效期对齐，可自调）
3. **创建 Logpush 任务**
   - Workers & Pages → Observability → Logpush → Create dataset
   - Name: `genetech-audit`
   - Source: **Worker Log**
   - Workers: 选 `genetech-license`、`genetech-api-guard`、`genetech-mcp-remote`
   - Destination: **R2**
   - Dataset: `WORKER_LOG`
   - Destination bucket: `genetech-audit-logs`
   - Key prefix: `/genetech-license/`（每个 Worker 独立前缀）
4. **验证**：观察几分钟后 R2 里出现 `genetech-license/*.jsonl.gz`

### 二、Worker 侧需要打的关键字段

Logpush 采集的是 Worker 的 `console.log()` 输出。要拿到"哪张许可证发给了谁"，
`unified-license/worker.js` 里需要**在关键路径打结构化日志**（当前缺失）。补丁如下（示例）：

```js
// unified-license/worker.js 关键路径埋点
function auditLog(env, event) {
  // event = { type, license_id, customer_email_hash, plan, ts, upstream_order_id }
  // 脱敏：邮箱只存 SHA-256，license_id 只存前 8 位
  console.log(JSON.stringify({
    type: 'audit',
    event_type: event.type,        // issue / redeem / revoke / admin_create
    license_id_prefix: String(event.license_id).slice(0, 8),
    customer_email_hash: event.customer_email_hash,
    plan: event.plan,
    ts: new Date().toISOString(),
    upstream_order_id: event.upstream_order_id,
    ip_range: request.headers.get('cf-connecting-ip'),  // 若需按 IP 段追溯
    // 不要打 secret / 完整 license key
  }));
}

// 在 issueLicense / redeemLicense / adminIssue 三处调用
auditLog(env, { type: 'issue', license_id: key, customer_email_hash: emailHash, plan: planSlug, upstream_order_id: orderId });
```

**关键脱敏原则**：
- 不记录完整 license key（可反查 = 泄露）
- 不记录明文邮箱（GDPR / 个保法）
- 只记 hash 与前缀，足够做尽调对账

### 三、本地 audit/ 目录的角色重定义

原 `audit/` 目录里的 jsonl 从"手工 append 的审计日志"降级为"CLI 侧测试记录"（历史遗留）。
真正的生产审计在 R2 里。为免混淆，把这里改名为：

```
audit/
├── LOGPUSH-SETUP.md            ← 本文件，配置指南
├── README.md                   ← 说明本目录定位
└── 2026-09-29.jsonl            ← 历史保留，仅作归档
```

### 四、查询与对账

生产审计查询走 R2 的 JSON 语法（Logpush 每条是一行 JSON，多行文件是 gzip）：

```bash
# 本地（开发者）
rclone sync r2:genetech-audit-logs ./local-audit/ --include "*.jsonl.gz"

# 按时间 + license 前缀查
gunzip -c local-audit/genetech-license/*.jsonl.gz | \
  jq 'select(.type == "audit" and .license_id_prefix == "gtk-abc1")'
```

Cloudflare 侧也可在 R2 控制台直接浏览对象；R2 JSON 语法查询见 R2 JSON Queries 文档。

### 五、OPA 决策日志（可选增强）

`guards/*.policy.json` 判定结果目前不产生持久日志。要把它也纳入审计：

1. `tools/guard-eval.mjs` 每次判 deny 时打 `console.log({ type: 'guard_denied', rule_id, subject, ts })`
2. Logpush 会一并采集到同一 R2 bucket，与发证日志按 ts 关联

### 六、成本估算

- R2 存储：Worker 日志每天约 5–20 MB × 365 天 × 10 年 = 20–70 GB，成本 ~$0.02/GB/月 → **$50–150/年**
- Logpush 免费（在免费额度内：每天 10 亿条事件）
- R2 Object Lock 无额外费

### 七、验证清单

- [ ] R2 bucket 已建，Object Lock = Compliance
- [ ] Logpush 任务已建，5 分钟后 R2 出现首个 `.jsonl.gz`
- [ ] Worker 侧关键路径（issue / redeem / revoke）已打结构化审计日志
- [ ] 脱敏验证：日志里无完整 license key、无明文邮箱
- [ ] 本地脚本可从 R2 拉取并 jq 过滤
- [ ] `docs/ops-runbook.md` 里加入 "如何导出审计" 一节

### 八、后续工作（P2）

- [ ] 把 OPA 决策日志（guard_denied / guard_allowed）也接进来
- [ ] 每周自动汇总 → 邮件 / 企业微信推送给运营
- [ ] 与 `payment-template/functions/api/credits/webhook.js` 的支付审计对接

---

*配置指南由 Phase 5（2026-10-15）编写。报告锚点：`reports/项目分板块深度评估报告-2026-10-14.md` §13b。*
