# GeneTech API 鉴权 Worker (api-auth-guard)

修复报告指出的 **"付费墙形同虚设：公开 JSON 数据可被直接访问绕过"** 问题。

## 策略

GeneTech 的知识库本身是**开放知识**（对 SEO 和开放网络有益），因此静态 JSON 保持公开；
真正的付费价值在 **Pro API**（语义检索、引用导出、跨站关联、更高配额），由本 Worker 守门。

| 层级 | 端点 | 行为 |
|------|------|------|
| 免费 | `<site>/website/api/*.json` | 放行，但每 IP 限流（`PRO_FREE_RATE`/分钟），打 `X-GeneTech-Tier: free` |
| 付费 | `/api/pro/*` | 必须 `Authorization: Bearer <ProKey>`，否则 401/403 |
| 其他 | 任意 | 直接转发 |

## Pro Key 机制（无状态、防伪造）

Key 格式：`gtk_<base64urlPayload>.<hexSig>`
- `payload` = `{"site","exp"}` 的 base64url
- `sig` = HMAC-SHA256(payload, PRO_SECRET)

Worker 用同一 `PRO_SECRET` 重算并常量时间比较，无需数据库即可验证、不可伪造、可过期。

可选：配置 `LICENSE_VALIDATE_URL` 后，改为调用 unified-license Worker 校验 GUX_ 统一许可证
兑换出的 `gtk_` 站点 Key，与统一许可体系打通。

## 部署

```bash
cd api-guard
wrangler secret put PRO_SECRET        # 注入签名密钥（不要写进文件）
wrangler deploy                        # 部署到 Cloudflare
```

路由到你的数据 API 域名（如 `api.genetech.io`）。

## 签发 Pro Key

```bash
PRO_SECRET=你的密钥 node genkey.mjs genetech-tools 30
```

将输出作为 Bearer Token 提供给 Pro 用户。

## 自动化

由 `.github/workflows/ops-extra.yml` 的 `api-guard-check` job 定期校验 Worker 语法与
PRO_SECRET 是否已配置，缺失则自动创建 GitHub Issue 提醒。
