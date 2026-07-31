# 通用支付系统模板 — 部署指南

> 适用于 GeneTech 14 站知识引擎项目的所有 Cloudflare Pages 站点。
> 基于 RoboParts 已验证可用的支付实现，参数化后可复用于任意站点。

---

## 目录

1. [模板概述](#1-模板概述)
2. [文件结构](#2-文件结构)
3. [前置准备](#3-前置准备)
4. [配置 Creem 产品](#4-配置-creem-产品)
5. [配置 Cloudflare KV 命名空间](#5-配置-cloudflare-kv-命名空间)
6. [使用部署脚本](#6-使用部署脚本)
7. [手动配置与部署](#7-手动配置与部署)
8. [环境变量说明](#8-环境变量说明)
9. [验证部署](#9-验证部署)
10. [常见问题](#10-常见问题)

---

## 1. 模板概述

本模板提供一套完整的 API 付费系统，包含：

| 功能 | 说明 |
|------|------|
| 用户注册 | 邮箱注册，自动生成 API Key（`gtk_` 前缀），赠送 100 免费积分 |
| 积分余额查询 | 通过 API Key 查询当前积分余额与套餐等级 |
| 积分购买 | 三档定价：Starter ($9/100积分)、Pro ($29/500积分)、Lifetime ($99/无限) |
| License 兑换 | 支付完成后使用 License Key 兑换积分 |
| Webhook 处理 | Creem 支付回调，HMAC-SHA256 签名验证，自动生成 License Key |
| 速率限制 | 免费版 30次/小时，Pro版 60次/小时，Lifetime版 120次/小时 |

**安全特性：**
- 邮箱使用 SHA-256 哈希存储，不保存明文
- API Key 使用 SHA-256 哈希存储，仅注册时明文返回一次
- Webhook 使用 HMAC-SHA256 签名验证，防止伪造请求
- License Key 一次性使用，防止重复兑换

---

## 2. 文件结构

```
payment-template/
├── functions/
│   └── api/
│       ├── register.js              # 用户注册端点 POST /api/register
│       └── credits/
│           ├── balance.js           # 余额查询 GET + License兑换 POST /api/credits/balance
│           └── webhook.js           # Creem Webhook POST /api/credits/webhook
├── credits.html                     # 积分购买页面
├── api-pricing.html                 # API 定价页面
├── success.html                     # 支付成功页面
├── wrangler.toml                    # Cloudflare Pages 配置
├── deploy.js                        # 部署脚本（自动替换占位符）
└── README.md                        # 本文件
```

---

## 3. 前置准备

### 3.1 所需账号

- **Cloudflare 账号**：用于部署 Pages 和创建 KV 命名空间
- **Creem 账号**：用于创建支付产品和接收 Webhook 回调
- **Node.js 18+**：用于运行部署脚本和 Wrangler CLI

### 3.2 安装 Wrangler CLI

```bash
npm install -g wrangler
wrangler login
```

### 3.3 确认站点信息

为每个站点准备以下信息：

| 参数 | 说明 | 示例 |
|------|------|------|
| 站点名称 | Cloudflare Pages 项目名 | `agent-ecosystem` |
| 站点域名 | 完整 URL | `https://agent.genetech.io` |
| Starter 产品 ID | Creem 中的入门包产品 ID | `prod_aaa111` |
| Pro 产品 ID | Creem 中的专业包产品 ID | `prod_bbb222` |
| Lifetime 产品 ID | Creem 中的终身包产品 ID | `prod_ccc333` |

---

## 4. 配置 Creem 产品

### 4.1 创建产品

登录 [Creem 后台](https://creem.io)，为每个站点创建 3 个产品：

| 产品名称 | 价格 | 类型 | 说明 |
|---------|------|------|------|
| Starter 入门包 | $9 | 一次性付款 | 100 积分 |
| Pro 专业包 | $29 | 一次性付款 | 500 积分 |
| Lifetime 终身包 | $99 | 一次性付款 | 无限积分 |

### 4.2 配置 Webhook

1. 在 Creem 后台进入 **Settings > Webhooks**
2. 添加 Webhook URL：`https://<你的域名>/api/credits/webhook`
3. 订阅事件：`checkout.completed`（或 `payment.succeeded`）
4. 记录 **Webhook Secret**（后续需要配置到 Cloudflare）

### 4.3 配置成功跳转

在 Creem 产品设置中，将支付成功后的跳转 URL 设为：
```
https://<你的域名>/success.html
```

### 4.4 获取产品 ID

创建产品后，在 Creem 后台产品列表中复制每个产品的 ID（格式为 `prod_xxxxx`）。

### 4.5 启用 Live Payments

> **重要**：Creem 默认处于测试模式。要接收真实支付，必须在后台启用 **Live Payments**。
> 同时确认支持邮箱已通过 Creem 审核。

---

## 5. 配置 Cloudflare KV 命名空间

每个站点需要创建 3 个 KV 命名空间：

### 5.1 通过 Wrangler 创建

```bash
# 创建 API_KEYS 命名空间
wrangler kv namespace create API_KEYS
# 输出类似：{ "id": "abc123def456..." }

# 创建 USER_CREDITS 命名空间
wrangler kv namespace create USER_CREDITS

# 创建 USER_CREDIT_HISTORY 命名空间
wrangler kv namespace create USER_CREDIT_HISTORY
```

### 5.2 记录命名空间 ID

创建后，记录每个命名空间的 `id`，后续需要填入 `wrangler.toml`：

| 命名空间 | 用途 | wrangler.toml 占位符 |
|---------|------|---------------------|
| API_KEYS | 存储 API Key 哈希、邮箱哈希、License 信息 | `__KV_API_KEYS_ID__` |
| USER_CREDITS | 存储用户积分余额 | `__KV_USER_CREDITS_ID__` |
| USER_CREDIT_HISTORY | 存储积分变动历史记录 | `__KV_HISTORY_ID__` |

### 5.3 通过 Cloudflare Dashboard 创建（替代方式）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **Workers & Pages > KV**
3. 点击 **Create a namespace**
4. 分别创建上述 3 个命名空间
5. 复制每个命名空间的 ID

---

## 6. 使用部署脚本

### 6.1 基本用法

```bash
cd payment-template

node deploy.js \
  --site=agent-ecosystem \
  --domain=https://agent.genetech.io \
  --products=prod_aaa111,prod_bbb222,prod_ccc333
```

### 6.2 完整用法（含 KV ID 和自动部署）

```bash
node deploy.js \
  --site=agent-ecosystem \
  --domain=https://agent.genetech.io \
  --products=prod_aaa111,prod_bbb222,prod_ccc333 \
  --kv-api-keys=abc123def456 \
  --kv-credits=ghi789jkl012 \
  --kv-history=mno345pqr678 \
  --out=./deployed/agent-ecosystem \
  --deploy
```

### 6.3 参数说明

| 参数 | 必需 | 说明 |
|------|------|------|
| `--site` | 是 | 站点名称（Cloudflare Pages 项目名） |
| `--domain` | 是 | 站点完整域名（含 https://） |
| `--products` | 是 | 3 个 Creem 产品 ID，逗号分隔（Starter, Pro, Lifetime 顺序） |
| `--kv-api-keys` | 否 | API_KEYS 命名空间 ID |
| `--kv-credits` | 否 | USER_CREDITS 命名空间 ID |
| `--kv-history` | 否 | USER_CREDIT_HISTORY 命名空间 ID |
| `--out` | 否 | 输出目录（默认：./deployed/\<site\>） |
| `--deploy` | 否 | 替换完成后自动运行 wrangler pages deploy |

### 6.4 脚本执行流程

1. 读取模板目录中的所有文件
2. 将 `__PLACEHOLDER__` 占位符替换为实际值
3. 输出到目标目录
4. 检查是否有未替换的占位符（发出警告）
5. 如果指定 `--deploy`，自动执行 Wrangler 部署

---

## 7. 手动配置与部署

如果不使用部署脚本，可手动操作：

### 7.1 复制模板文件

```bash
cp -r payment-template/ deployed/my-site/
cd deployed/my-site/
```

### 7.2 替换占位符

使用文本编辑器全局替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `__SITE_NAME__` | 站点名称，如 `agent-ecosystem` |
| `__SITE_DOMAIN__` | 站点域名，如 `https://agent.genetech.io` |
| `__PRODUCT_STARTER__` | Starter 产品 ID |
| `__PRODUCT_PRO__` | Pro 产品 ID |
| `__PRODUCT_LIFETIME__` | Lifetime 产品 ID |
| `__KV_API_KEYS_ID__` | API_KEYS 命名空间 ID |
| `__KV_USER_CREDITS_ID__` | USER_CREDITS 命名空间 ID |
| `__KV_HISTORY_ID__` | USER_CREDIT_HISTORY 命名空间 ID |

### 7.3 部署到 Cloudflare Pages

```bash
# 方式一：Wrangler CLI 部署
npx wrangler pages deploy . --project-name agent-ecosystem

# 方式二：Git 关联自动部署
# 1. 将文件推送到 GitHub 仓库
# 2. 在 Cloudflare Pages 中关联该仓库
# 3. 设置构建命令为空，输出目录为 .（根目录）
```

---

## 8. 环境变量说明

### 8.1 必需环境变量

以下环境变量必须配置在 **Cloudflare Pages > Settings > Variables and Secrets** 中：

| 变量名 | 类型 | 说明 |
|--------|------|------|
| `CREEM_WEBHOOK_SECRET` | Secret | Creem Webhook 签名密钥（从 Creem 后台获取） |

### 8.2 可选环境变量

| 变量名 | 类型 | 说明 |
|--------|------|------|
| `SITE_NAME` | Text | 站点名称（已在 wrangler.toml 中配置） |
| `SITE_DOMAIN` | Text | 站点域名（已在 wrangler.toml 中配置） |

### 8.3 配置方法

**通过 Wrangler CLI：**
```bash
echo "你的Creem密钥" | wrangler pages secret put CREEM_WEBHOOK_SECRET --project-name agent-ecosystem
```

**通过 Cloudflare Dashboard：**
1. 进入 **Workers & Pages > 你的项目 > Settings**
2. 找到 **Variables and Secrets**
3. 点击 **Add**，选择 **Secret** 类型
4. 名称填 `CREEM_WEBHOOK_SECRET`，值填 Creem 后台获取的密钥
5. 保存

---

## 9. 验证部署

### 9.1 验证注册接口

```bash
curl -X POST https://你的域名/api/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'
```

预期返回（HTTP 201）：
```json
{
  "success": true,
  "api_key": "gtk_xxxxxxxxxxxxxxxxxxxxxxxx",
  "free_credits": 100,
  "rate_limit": "30 requests/hour",
  "credits_url": "https://你的域名/credits",
  "message": "注册成功！您已获得 100 免费积分。..."
}
```

### 9.2 验证余额查询

```bash
curl https://你的域名/api/credits/balance \
  -H "X-API-Key: gtk_你的API密钥"
```

预期返回（HTTP 200）：
```json
{
  "success": true,
  "site": "agent-ecosystem",
  "balance": 100,
  "tier": "free",
  "rate_limit": "30 requests/hour",
  "is_unlimited": false
}
```

### 9.3 验证 Webhook 签名

可使用 Creem 后台的 **Send Test Webhook** 功能测试。

如果签名验证失败，检查：
- `CREEM_WEBHOOK_SECRET` 是否正确配置
- 密钥值是否与 Creem 后台显示的一致

### 9.4 验证页面

| 页面 | URL |
|------|-----|
| 积分购买 | `https://你的域名/credits.html` |
| API 定价 | `https://你的域名/api-pricing.html` |
| 支付成功 | `https://你的域名/success.html` |

---

## 10. 常见问题

### Q1: 部署后 API 返回 500 错误

**原因**：KV 命名空间未正确绑定。

**解决**：检查 `wrangler.toml` 中的 KV ID 是否正确，确保 3 个命名空间都已创建并绑定。

### Q2: Webhook 签名验证失败（401）

**原因**：`CREEM_WEBHOOK_SECRET` 未配置或值不正确。

**解决**：
1. 确认已在 Cloudflare Pages Secrets 中配置 `CREEM_WEBHOOK_SECRET`
2. 确认值与 Creem 后台 Webhook 设置中的密钥一致
3. 重新部署后重试

### Q3: 支付完成后未自动跳转到成功页面

**原因**：Creem 产品设置中的成功跳转 URL 未配置。

**解决**：在 Creem 后台每个产品的设置中，将成功跳转 URL 设为 `https://你的域名/success.html`。

### Q4: License Key 兑换失败

**可能原因**：
- License Key 已被使用（每个 License Key 只能兑换一次）
- License Key 与 API Key 不匹配（需使用同一注册邮箱对应的 API Key）
- Webhook 未正确触发，KV 中无 pending License 记录

**排查方法**：
1. 检查 Creem 后台 Webhook 发送日志
2. 确认 Webhook URL 可访问（`https://你的域名/api/credits/webhook`）
3. 检查 Cloudflare Pages Functions 日志

### Q5: 免费积分用完后 API 返回 403

**原因**：免费积分耗尽，需要购买积分。

**解决**：前往 `https://你的域名/credits.html` 购买积分包。

### Q6: 如何为 14 个站点批量部署

建议编写批量脚本：

```bash
#!/bin/bash
# batch-deploy.sh
sites=(
  "site1|https://site1.genetech.io|prod_s1a,prod_s1b,prod_s1c"
  "site2|https://site2.genetech.io|prod_s2a,prod_s2b,prod_s2c"
  # ... 更多站点
)

for entry in "${sites[@]}"; do
  IFS='|' read -r site domain products <<< "$entry"
  echo "部署 $site ..."
  node deploy.js --site="$site" --domain="$domain" --products="$products" --deploy
done
```

---

## 附录：占位符对照表

| 占位符 | 出现位置 | 说明 |
|--------|---------|------|
| `__SITE_NAME__` | 所有文件 | 站点名称 |
| `__SITE_DOMAIN__` | JS 文件、wrangler.toml | 站点域名（含 https://） |
| `__PRODUCT_STARTER__` | balance.js, webhook.js, credits.html | Starter 产品 ID |
| `__PRODUCT_PRO__` | balance.js, webhook.js, credits.html | Pro 产品 ID |
| `__PRODUCT_LIFETIME__` | balance.js, webhook.js, credits.html | Lifetime 产品 ID |
| `__KV_API_KEYS_ID__` | wrangler.toml | API_KEYS 命名空间 ID |
| `__KV_USER_CREDITS_ID__` | wrangler.toml | USER_CREDITS 命名空间 ID |
| `__KV_HISTORY_ID__` | wrangler.toml | USER_CREDIT_HISTORY 命名空间 ID |

---

*本模板基于 RoboParts 已验证可用的支付实现参数化而成。*
*如有问题，请参考 GeneTech 14 站知识引擎项目文档。*
