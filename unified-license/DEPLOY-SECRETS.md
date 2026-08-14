# 虎皮椒支付上线运行手册（license.swarmlabs.tools）

> 目标：把真实虎皮椒凭据接入已上线的统一许可证 Worker，闭合「用户付款 → 自动签发 GUX_」链路。

## 当前就绪状态（已验证代码层）

- **后端 Worker**（`unified-license/worker.js` + `hupijiao.js`）已部署并上线于
  `https://license.swarmlabs.tools`（Cloudflare 账户 `61960005`，KV `a24af3fc…`）。
  - 已支持单通道凭据：`HUPIJIAO_APP_ID` + `HUPIJIAO_APP_SECRET`
  - 已支持多通道凭据：`HUPIJIAO_CHANNELS`（JSON 数组，见 README）
- **前端购买页**（`tools/build-site.mjs` → `renderLicensePage()` → `_site/license.html`）已完整实现：
  选套餐 → `POST /api/hupijiao/create-order` → 展示二维码/支付链接 → 每 3 秒轮询
  `GET /api/hupijiao/order` → 显示 `GUX_` 密钥。已内置多端点故障转移，优先 `license.swarmlabs.tools`。
- **虎皮椒 API 事实**：官方 `api.xunhupay.com/payment/do.html` 仅需 `appid` + `appsecret`
  + 订单字段，**没有 `payment`/`type` 字段**，也没有任何 `cfut_` 字段。现有 `hupijiao.js` 实现与官方一致，无需改代码。

## 你只需做两件事即可闭环

### 1) 把真实虎皮椒凭据注入 Worker（Cloudflare Secret）

在本机 `unified-license/` 目录执行（需已 `npm i -g wrangler` 并 `wrangler login`，且账户为 `61960005`）：

```bash
cd unified-license
npx wrangler secret put HUPIJIAO_APP_ID        # 粘贴：你提供的 AppID（201906181178）
npx wrangler secret put HUPIJIAO_APP_SECRET    # 粘贴：你提供的 App Secret
# 若 ADMIN_SECRET 尚未设置（手动发卡接口 /api/admin/issue 需要），一并设置：
npx wrangler secret put ADMIN_SECRET           # 粘贴一个你自己定的强随机串
```

> 凭据走 Cloudflare Secret，**不写入任何仓库文件**。本地 `wrangler dev` 可把同样的值放进
> `unified-license/.dev.vars`（已被根 `.gitignore` 忽略，不会提交）。

### 2) 在虎皮椒商户后台配置异步回调（关键 —— 自动发卡靠它）

登录虎皮椒后台 → 支付/接口设置 → **异步回调 notify_url** 填写：

```
https://license.swarmlabs.tools/api/hupijiao/callback
```

Worker 收到 `status=OD` 且验签通过后，自动签发 `GUX_` 统一许可证并写入 KV（前端轮询取回）。
Worker 默认从请求域名自动推导该地址，但虎皮椒侧必须显式填写。

**跳转地址 return_url（可选）** 建议填站点许可证页：

```
https://lm203688.github.io/genetech-14-sites/license.html
```

### 3) 部署/更新 Worker 代码（仅当你改过 worker.js / hupijiao.js / wrangler.toml 时才需要）

```bash
cd unified-license && npx wrangler deploy
```

> `wrangler.toml` 的 `account_id` 已是 `61960005` 账户、`kv_namespaces` 已是 `a24af3fc`，
> 部署即更新线上 `license.swarmlabs.tools`，**不会动 dashboard 上已绑定的自定义域名**。
> 若改过代码，部署后请到 Cloudflare Dashboard 确认 `license.swarmlabs.tools` 仍映射到该 Worker。

## 验证清单

1. 打开 `https://lm203688.github.io/genetech-14-sites/license.html`，填邮箱、选「专业版」。
2. 出现微信/支付宝二维码 → 手机扫码支付。
3. 支付成功后，页面 3 秒内显示 `GUX_…` 密钥。
4. 用该 `GUX_` 密钥到任一站点兑换，得到 `gtk_` 站点 API Key。
5. 健康检查：`https://license.swarmlabs.tools/health` 应返回 `{ "status": "ok", "version": "2.0" }`。

## 关于你提供的 `cfut_` 令牌

虎皮椒官方 API 不需要 `cfut_` 字段。你给的 3 个 `cfut_…` 令牌不属于该接口必填项，可能属于：
虎皮椒子通道/设备密钥，或另一个服务的令牌。**当前核心支付链路不需要它们**。
已暂存于 `unified-license/.dev.vars` 的 `HUPIJIAO_UNKNOWN_TOKENS`（gitignored，未提交）以防丢失。
请确认其用途后，再决定是否纳入 `HUPIJIAO_CHANNELS`（多通道 JSON）。

## 安全须知

- 本次凭据曾在对话中明文出现；若此对话非私密，建议用完后在虎皮椒后台重置 AppSecret。
- **切勿**把 `.dev.vars` 或任何含密钥文件提交到公开仓库（`genetech-14-sites` 为 GitHub Pages 公开库）。
- `api.cloudflare.com` 在本工作环境不可达，故上述 `wrangler` 命令需你在本机执行；本仓库只负责代码与文档。
