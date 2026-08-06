# GeneTech 14站知识引擎 — 统一许可证系统

> 一次购买，全站通用。用户购买一个统一许可证，即可获得一个 `GUX_` 密钥，凭此密钥在全部 14 个站点兑换并获得站点专属 API Key，访问对应站点服务。

---

## 目录

1. [架构总览](#1-架构总览)
2. [文件说明](#2-文件说明)
3. [许可证数据模型](#3-许可证数据模型)
4. [部署中央 Worker](#4-部署中央-worker)
5. [环境变量与密钥](#5-环境变量与密钥)
6. [与 14 个站点集成](#6-与-14-个站点集成)
7. [虎皮椒 国内支付（微信/支付宝）自动发卡](#7-虎皮椒-国内支付微信支付宝自动发卡)
8. [API 接口文档](#8-api-接口文档)
9. [安全模型](#9-安全模型)
10. [常见问题](#10-常见问题)

---

## 1. 架构总览

```
                         ┌──────────────────────────────────────────┐
                         │      中央许可证 Worker (worker.js)          │
                         │   Cloudflare Worker + KV(UNIFIED_LICENSES) │
                         │                                           │
                         │   POST /api/license/validate  校验密钥      │
                         │   POST /api/license/redeem     兑换站点Key  │
                         │   GET  /api/license/status    状态查询      │
                         │   POST /api/admin/issue        发行(管理员) │
                         │   POST /api/hupijiao/create-order 发起支付 │
                         │   POST /api/hupijiao/callback    虎皮椒回调 │
                         │   GET  /api/hupijiao/order       订单查询   │
                         └───────────────────┬───────────────────────┘
                                  HTTPS + CORS(14域名) + 限流(10/min/IP)
                 ┌────────────────────┼────────────────────┐
            ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
            │  站点 1  │   ...   │  站点 7  │   ...   │  站点 14 │
            │ site-   │         │ site-   │         │ site-   │
            │ adapter │         │ adapter │         │ adapter │
            │  .js    │         │  .js    │         │  .js    │
            │ +缓存1h │         │ +缓存1h │         │ +缓存1h │
            └─────────┘         └─────────┘         └─────────┘
                 ▲                   ▲                   ▲
                 └────────── 前端 verify.js / 直接 fetch ─┘
```

### 核心设计

- **中央 Worker** 是全部 14 站点的「许可证权威」，唯一持有许可证真伪、积分与各站兑换状态。用户一次购买即获得 `GUX_` 统一密钥。
- **站点适配器（site-adapter.js）** 部署在每个站点的 Cloudflare Pages Functions 中，作为本地代理：先查本地 KV 缓存（1 小时），未命中再回源中央 API，并缓存结果。
- **客户端模块（verify.js）** 是纯网络调用模块，可在浏览器端或服务端直接引入，一次调用完成「校验 + 兑换」并返回站点专属 API Key。
- **兑换流程**：用户在某站点输入 `GUX_` 密钥 → 站点适配器/verify.js 调用中央 `validate` + `redeem` → 中央校验通过后为该站点生成专属 `gtk_` API Key 并返回 → 站点据此发放本地服务访问权限。

### 兑换幂等性

同一 `GUX_` 密钥在同一站点**重复兑换**时，中央返回首次兑换时生成的同一个 API Key（幂等），不会重复发放。每个站点首次兑换都会在许可证的 `sites` 数组中记录一条兑换记录。

---

## 2. 文件说明

```
unified-license/
├── worker.js          # 中央许可证 Worker（许可证权威，ES Module）
├── wrangler.toml      # 中央 Worker 部署配置（KV 绑定 + 环境变量）
├── verify.js          # 客户端校验模块（verifyUnifiedLicense，纯网络调用）
├── site-adapter.js    # 站点 Pages Function 适配器（代理 + 1h 缓存）
└── README.md          # 本文档
```

| 文件 | 部署位置 | 说明 |
|------|----------|------|
| `worker.js` | 部署为 1 个 Cloudflare Worker | 全局唯一，作为中央许可证 API |
| `wrangler.toml` | 同上 | `wrangler deploy` 时读取 |
| `verify.js` | 复制到每个站点项目（或前端直接引用） | 纯调用模块，返回 `{ valid, api_key, credits, plan }` |
| `site-adapter.js` | 复制到每个站点的 `functions/api/license/index.js` | Pages Function，代理中央并缓存 |

---

## 3. 许可证数据模型

### 密钥格式

统一许可证密钥：**`GUX_` + 32 位十六进制字符**（16 字节随机），例如：

```
GUX_3f9a2c1e8b7d4065a1c2d3e4f5a6b7c8
```

站点专属 API Key：**`gtk_` + 48 位十六进制字符**（24 字节随机），兑换时由中央生成。

### 存储结构

存储于 KV 命名空间 `UNIFIED_LICENSES`，键 `license:<GUX_KEY>`，值结构：

```jsonc
{
  "key": "GUX_3f9a2c1e8b7d4065a1c2d3e4f5a6b7c8",
  "email_hash": "sha256hex...",        // 邮箱 SHA-256 哈希（脱敏，不存明文）
  "plan": "pro",                        // starter | pro | lifetime
  "plan_name": "专业版",
  "credits_total": 500,                 // 总积分额度（-1 = 无限）
  "credits_used": 0,                   // 已用积分
  "sites": [                            // 已兑换站点列表
    {
      "name": "site1",
      "api_key": "gtk_xxxx...",         // 该站点专属 API Key
      "redeemed_at": "2026-08-01T...",
      "domain": "site1.genetech.io"
    }
  ],
  "created": "2026-08-01T00:00:00Z",
  "expires": "2027-08-01T00:00:00Z",    // null = 终身
  "hupijiao_order_id": "GUXHPJ_xxx",    // 虎皮椒商户订单号（回调自动发行时填入）
  "status": "active",                   // active | revoked
  "source": "hupijiao_callback"          // 发行来源
}
```

### 套餐定义

| 套餐 | 代号 | 总积分 | 有效期 |
|------|------|--------|--------|
| 入门版 | `starter` | 100 | 30 天 |
| 专业版 | `pro` | 500 | 365 天 |
| 终身版 | `lifetime` | 无限 (-1) | 终身 |

> 套餐参数在 `worker.js` 顶部的 `PLANS` 对象中定义，可按需调整。已发行许可证按创建时参数固化。

### KV 键一览

| 键 | 用途 |
|----|------|
| `license:<GUX_KEY>` | 完整许可证对象 |
| `email:<sha256hex>` | 邮箱哈希 → GUX_KEY 反查索引（吊销时用） |
| `meta:stats` | 聚合统计（发行数/按套餐/按站点） |
| `rl:<ip>:<minute>` | 速率限制计数（TTL 120 秒） |

---

## 4. 部署中央 Worker

### 前置条件

- 已安装 [Node.js](https://nodejs.org/) 与 [wrangler](https://developers.cloudflare.com/workers/wrangler/)
- 拥有 Cloudflare 账号

### 步骤

```bash
# 1. 进入目录
cd unified-license

# 2. 登录 Cloudflare
npx wrangler login

# 3. 创建 KV 命名空间
npx wrangler kv namespace create UNIFIED_LICENSES
# 输出示例：
# [[kv_namespaces]]
# binding = "UNIFIED_LICENSES"
# id = "abcd1234..."   <-- 复制这个 id

# 4. 将上一步得到的 id 填入 wrangler.toml
#    把 __KV_UNIFIED_LICENSES_ID__ 替换为真实 id

# 5. 配置 Secrets（交互式输入，切勿写入文件）
npx wrangler secret put ADMIN_SECRET            # 管理员密钥（发行许可证用）
npx wrangler secret put HUPIJIAO_APP_ID         # 虎皮椒 AppID
npx wrangler secret put HUPIJIAO_APP_SECRET    # 虎皮椒 AppSecret

# 6. 编辑 wrangler.toml：
#    - ALLOWED_SITES 填入 14 个真实站点名（逗号分隔，小写）
#    - （可选）ALLOWED_ORIGINS 覆盖 CORS 域名白名单
#    - （可选）HUPIJIAO_PRICE_MAP 配置套餐人民币价格

# 7. 部署
npx wrangler deploy

# 8. 记录部署后的 URL，例如：
#    https://unified-license.<your-account>.workers.dev
#    或绑定自定义域名 license.genetech.io
```

部署成功后，访问 `https://<worker-url>/health` 应返回：

```json
{ "service": "genetech-unified-license", "status": "ok", "version": "2.0", "time": "..." }
```

> 推荐绑定自定义域名 `license.genetech.io`，这样 `verify.js` 与 `site-adapter.js` 中的默认地址无需修改。

---

## 5. 环境变量与密钥

### 中央 Worker

| 名称 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `UNIFIED_LICENSES` | KV 绑定 | 是 | 许可证数据存储（在 wrangler.toml 中绑定） |
| `ADMIN_SECRET` | Secret | 是 | 管理员发行许可证的密钥，`/api/admin/issue` 用于 HMAC 签名 |
| `HUPIJIAO_APP_ID` | Secret | 是 | 虎皮椒 AppID（国内微信/支付宝支付） |
| `HUPIJIAO_APP_SECRET` | Secret | 是 | 虎皮椒 AppSecret |
| `ALLOWED_SITES` | Var | 否 | 允许兑换的站点名白名单（逗号分隔），未配置则放行全部 |
| `ALLOWED_ORIGINS` | Var | 否 | CORS 来源白名单（逗号分隔），未配置则用内置 14 个 genetech.io 子域 |
| `HUPIJIAO_PRICE_MAP` | Var | 否 | 套餐 → 人民币价格（元）的 JSON 映射，如 `{"starter":"9.90","pro":"39.90","lifetime":"199.00"}` |

### 每个站点（在站点 wrangler.toml / Pages 设置中配置）

| 名称 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `UNIFIED_LICENSE_API` | Var | 否 | 中央 API 地址（默认 `https://license.genetech.io`） |
| `SITE_NAME` | Var | 是 | 当前站点名（须在中央 `ALLOWED_SITES` 内） |
| `LICENSE_CACHE` | KV 绑定 | 否 | 许可证缓存命名空间；未绑定时回退 `API_KEYS` |

---

## 6. 与 14 个站点集成

### 6.1 方案 A：使用站点适配器（推荐）

将 `site-adapter.js` 复制到每个站点的 Pages Functions 目录，重命名为 `index.js`：

```
站点项目/
└── functions/
    └── api/
        └── license/
            └── index.js      # 由 site-adapter.js 复制而来
```

前端直接调用本站的 `/api/license`：

```js
// 前端代码
const resp = await fetch('/api/license', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    license_key: 'GUX_xxxx...',
    site_name: 'site1',
    site_domain: 'site1.genetech.io',
  }),
});
const data = await resp.json();
if (data.valid) {
  console.log('站点 API Key:', data.api_key);
  console.log('剩余积分:', data.credits);
  console.log('套餐:', data.plan);
  console.log('命中缓存:', data.cached);
}
```

适配器会自动：
1. 查询站点本地 KV 缓存（命中则直接返回，附带 `cached: true`）
2. 未命中时调用中央 `validate` + `redeem`
3. 将结果写入本地缓存（有效 1 小时，无效 5 分钟）

### 6.2 方案 B：直接引入 verify.js

若站点不需要本地缓存（或已有自己的缓存层），可直接引入 `verify.js`：

```js
import { verifyUnifiedLicense } from './lib/verify.js';

const result = await verifyUnifiedLicense('GUX_xxxx...', 'site1', 'site1.genetech.io');
if (result.valid) {
  console.log(result.api_key, result.credits, result.plan);
} else {
  console.error(result.error);
}
```

`verify.js` 中中央 API 地址为模块常量，可按需修改：

```js
export const UNIFIED_API = 'https://license.genetech.io';
```

### 6.3 与现有站点支付体系兼容

各站点现有的 `gtk_` API Key 与 `<product>-<hex>` 本地 License 完全不受影响。本系统新增的 `GUX_` 密钥是独立的「跨站统一许可证」层，兑换后生成的 `gtk_` 站点 Key 可与站点现有 API Key 体系无缝衔接（站点可直接用返回的 `api_key` 作为用户凭据）。

---

## 7. 虎皮椒 国内支付（微信/支付宝）自动发卡

### 配置思路

虎皮椒提供国内聚合支付（微信 / 支付宝），用户扫码支付成功后，虎皮椒异步回调中央 Worker，
由 Worker 验签并自动发行 `GUX_` 统一许可证，无需在境外注册任何支付账号。

三个套餐对应统一的人民币价格（在 `wrangler.toml` 的 `HUPIJIAO_PRICE_MAP` 中配置）：

| 套餐 | 代号 | 总积分 | 有效期 | 默认价格 |
|------|------|--------|--------|----------|
| 入门版 | `starter` | 100 | 30 天 | ¥9.90 |
| 专业版 | `pro` | 500 | 365 天 | ¥39.90 |
| 终身版 | `lifetime` | 无限 | 终身 | ¥199.00 |

### 回调地址

虎皮椒后台将异步回调（notify_url）指向中央 Worker：

```
https://license.genetech.io/api/hupijiao/callback
```

（默认从请求域名自动推导，无需手动配置；如需覆盖可设 `HUPIJIAO_NOTIFY_URL`。）

中央收到支付成功（`status=OD`）后，自动：
1. 校验回调签名（MD5，按虎皮椒规则）
2. 通过 `attach` 中的 `plan` 确定套餐并发行 `GUX_` 统一许可证
3. 将许可证密钥写入 KV（由前端轮询 `/api/hupijiao/order` 获取，展示在支付成功页）

收到退款（`status=CD`）时，自动通过邮箱哈希反查并吊销对应许可证。

### 发起支付

前端调用 `POST /api/hupijiao/create-order` 发起下单，返回微信/支付宝二维码（`url_qrcode`）
与手机支付链接（`pay_url`）。完整字段见 [第 8 节](#8-api-接口文档)。

### 手动发行（管理员）

也可通过管理员接口手动发行，不依赖任何支付渠道：

```bash
# 生成 HMAC 签名（示例：使用 openssl）
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
BODY='{"plan":"pro","email":"user@example.com"}'
SIG=$(printf "%s\n%s" "$TIMESTAMP" "$BODY" | openssl dgst -sha256 -hmac "$ADMIN_SECRET" | sed 's/^.* //')

curl -X POST https://license.genetech.io/api/admin/issue \
  -H "Content-Type: application/json" \
  -H "X-Admin-Timestamp: $TIMESTAMP" \
  -H "X-Admin-Signature: $SIG" \
  -d "$BODY"
```

> 调试阶段也可使用简化方式：`-H "X-Admin-Secret: <ADMIN_SECRET>"`（明文头，常量时间比较）。

---

## 8. API 接口文档

### POST /api/license/validate — 校验许可证

校验 `GUX_` 密钥，返回站点列表与积分（只读，不修改状态）。

```bash
curl -X POST https://license.genetech.io/api/license/validate \
  -H "Content-Type: application/json" \
  -d '{"key":"GUX_3f9a...","site_name":"site1"}'
```

成功响应：

```json
{
  "success": true,
  "valid": true,
  "key": "GUX_3f9a...",
  "plan": "pro",
  "plan_name": "专业版",
  "credits_total": 500,
  "credits_used": 0,
  "credits_remaining": 500,
  "sites": ["site1"],
  "already_redeemed": true,
  "status": "active",
  "expires": "2027-08-01T...",
  "cache_ttl": 3600
}
```

### POST /api/license/redeem — 兑换站点专属 API Key

为指定站点兑换许可证，返回该站点的专属 API Key。首次兑换生成新 Key，重复兑换幂等返回同一 Key。

```bash
curl -X POST https://license.genetech.io/api/license/redeem \
  -H "Content-Type: application/json" \
  -d '{"key":"GUX_3f9a...","site_name":"site1","site_domain":"site1.genetech.io"}'
```

成功响应：

```json
{
  "success": true,
  "valid": true,
  "key": "GUX_3f9a...",
  "api_key": "gtk_9f8e7d6c...",
  "plan": "pro",
  "plan_name": "专业版",
  "credits": 500,
  "credits_total": 500,
  "credits_used": 0,
  "sites": ["site1"],
  "already_redeemed": true,
  "redeemed_at": "2026-08-01T...",
  "expires": "2027-08-01T..."
}
```

### GET /api/license/status — 查询状态

```bash
curl "https://license.genetech.io/api/license/status?key=GUX_3f9a..."
```

返回许可证全站使用情况（已兑换站点、积分、过期时间等），不包含各站 API Key 明文。

### POST /api/admin/issue — 发行许可证（管理员）

需要 HMAC-SHA256 签名鉴权（见 [第 7 节](#7-虎皮椒-国内支付微信支付宝自动发卡)）。

请求体：

```json
{
  "plan": "pro",
  "email": "user@example.com",
  "expires": "2027-08-01T00:00:00Z",
  "source": "admin_issue"
}
```

成功响应（201）：

```json
{
  "success": true,
  "message": "统一许可证已发行",
  "license_key": "GUX_xxxx...",
  "plan": "pro",
  "plan_name": "专业版",
  "credits_total": 500,
  "expires": "2027-08-01T...",
  "created": "2026-08-01T..."
}
```

### POST /api/hupijiao/create-order — 发起虎皮椒支付

请求体：

```json
{ "plan": "pro", "email": "user@example.com", "channel": "default" }
```

成功响应：

```json
{
  "success": true,
  "order_id": "GUXHPJ_xxx",
  "url_qrcode": "https://api.xunhupay.com/.../qr.png",
  "pay_url": "https://api.xunhupay.com/.../pay",
  "price": "39.90",
  "currency": "CNY"
}
```

`url_qrcode` 为微信/支付宝二维码图片地址，前端直接展示；`pay_url` 为手机端拉起支付链接。

### POST /api/hupijiao/callback — 虎皮椒异步回调

由虎皮椒直接调用（form 表单，非 JSON），通过 MD5 签名校验。支付成功（`status=OD`）自动发行许可证，退款（`status=CD`）自动吊销。返回纯文本 `success` 表示已处理。

### GET /api/hupijiao/order — 查询订单与许可证

```
https://license.genetech.io/api/hupijiao/order?order_id=GUXHPJ_xxx
```

支付成功后返回已签发的 `GUX_` 许可证密钥，供前端轮询展示在支付成功页。

### GET /health — 健康检查

```bash
curl https://license.genetech.io/health
```

---

## 9. 安全模型

### 管理员鉴权（HMAC-SHA256 签名）

`/api/admin/issue` 采用 HMAC-SHA256 签名验证，防重放：

- 请求头 `X-Admin-Timestamp`：ISO 时间戳（5 分钟有效窗口）
- 请求头 `X-Admin-Signature`：`HMAC-SHA256("${timestamp}\n${rawBody}", ADMIN_SECRET)`
- 常量时间比较签名，防止时序攻击
- 调试阶段兼容 `X-Admin-Secret` 明文头（常量时间比较）

### 虎皮椒回调鉴权

`/api/hupijiao/callback` 校验虎皮椒回调签名（MD5，按虎皮椒规则对非空参数排序拼接后附加 AppSecret 计算），签名不符直接拒绝。

### 速率限制

- 公开接口（validate / redeem / status）限制 **10 次/分钟/IP**
- 管理员与虎皮椒回调路径豁免（由各自鉴权/签名保护）
- 基于 KV 的近似限流；如需更严格限流，建议叠加 Cloudflare 原生 Rate Limiting 规则

### CORS 跨域

- 默认内置 14 个 `*.genetech.io` 子域白名单
- 命中白名单时反射具体 `Origin`，未命中回退 `*`
- 可通过环境变量 `ALLOWED_ORIGINS` 覆盖

### 数据安全

- **邮箱脱敏**：仅存储邮箱的 SHA-256 哈希，不存明文
- **密钥不落盘**：`ADMIN_SECRET` / `HUPIJIAO_APP_ID` / `HUPIJIAO_APP_SECRET` 通过 `wrangler secret put` 配置，不出现在代码与 wrangler.toml 中
- **站点白名单**：配置 `ALLOWED_SITES` 后，仅允许列表内站点发起兑换
- **API Key 不外泄**：`validate` / `status` 仅返回站点名列表，不返回各站 API Key 明文；API Key 仅在 `redeem` 时返回给调用方
- **幂等兑换**：同一密钥在同一站点重复兑换返回同一 Key，不会重复发放

### 站点侧缓存安全

- 站点适配器缓存有效结果 1 小时、无效结果 5 分钟
- 许可证被吊销后，已缓存结果最多 1 小时后失效；如需立即生效，可缩短 `site-adapter.js` 的 `CACHE_TTL_VALID` 或手动清除站点 KV 缓存

---

## 10. 常见问题

**Q: 用户购买后，GUX_ 密钥在哪里查看？**
A: 虎皮椒支付成功后，中央 Worker 自动发行 `GUX_` 许可证，前端轮询 `/api/hupijiao/order` 取回密钥，可展示在支付成功页或通过邮件发送。也可由管理员通过 `/api/admin/issue` 手动发行。

**Q: 一个 GUX_ 密钥能在同一站点重复兑换吗？**
A: 可以重复调用，但幂等返回首次生成的同一个 API Key，不会重复发放。

**Q: 同一密钥能在 14 个站点都用吗？**
A: 可以。每个站点首次兑换时，中央会在 `sites` 数组记录一条兑换记录并生成该站专属 API Key。

**Q: 站点本地缓存会导致吊销延迟生效吗？**
A: 缓存有效期为 1 小时。吊销后已缓存的站点最多 1 小时后失效。如需立即生效，可缩短缓存 TTL 或清除站点缓存。

**Q: 中央 Worker 免费额度够用吗？**
A: Cloudflare Workers 免费版每日 100,000 次请求。站点适配器缓存 1 小时，单站单密钥每日最多 24 次回源，14 站合计远低于额度。如需更高可用，可升级 Workers Paid 计划。

**Q: 如何调整套餐的积分与有效期？**
A: 修改 `worker.js` 顶部 `PLANS` 对象后重新部署。已发行许可证按创建时参数固化，不受影响。

**Q: credits 字段代表什么？**
A: `credits_remaining`（兑换返回的 `credits`）为许可证剩余可用积分，`-1` 表示无限（终身版）。站点可据此控制用户调用额度。`credits_used` 用于追踪已消耗积分，可由后续用量上报机制更新。
