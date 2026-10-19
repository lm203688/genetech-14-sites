# API Gateway 部署指南

## 概述

本目录包含一个 Cloudflare Worker，用于为所有 14 个站点的 `/api/*.json` 端点添加认证、速率限制和配额管理。

部署后效果：
- **匿名用户**：每日 100 次调用，每分钟 10 次，数据被裁剪（仅返回摘要）
- **免费层用户**：同上，但可注册获得稳定的 API Key
- **Pro 用户**：每日 10000 次调用，每分钟 60 次，完整数据
- **Enterprise 用户**：同 Pro，可定制更高配额

## 部署步骤

### 1. 安装 Wrangler CLI
```powershell
npm install -g wrangler
wrangler login
```

### 2. 创建 KV Namespace
```powershell
cd api-gateway
wrangler kv:namespace create KB_KV
```
将输出的 `id` 填入 `wrangler.toml` 中。

### 3. 设置管理员密钥
```powershell
# 生成随机密钥
$adminKey = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})
Write-Output "你的管理员密钥: $adminKey"

# 写入 Worker Secret
wrangler secret put API_GATEWAY_ADMIN_KEY
# 粘贴上面的密钥
```

### 4. 部署 Worker
```powershell
wrangler deploy
```

### 5. 配置路由规则

在 Cloudflare Dashboard 中，为每个子域名添加路由规则：

1. 进入 **Workers Routes** > **Add Route**
2. 路由模式：`agent.genetech.tools/api/*`（以 Agent 生态站为例）
3. 选择 Worker：`genetech-api-gateway`
4. 为所有 14 个子域名重复此操作

或者使用通配符路由（如果使用 Cloudflare Enterprise）：
```
*.genetech.tools/api/*
```

### 6. 生成用户 API Key

部署完成后，使用管理员密钥为用户生成 API Key：

```powershell
# 为 Pro 用户生成 Key
curl -X POST https://api-gateway.<your-worker>.workers.dev/api/admin/keys `
  -H "X-Admin-Key: $adminKey" `
  -H "Content-Type: application/json" `
  -d '{"tier":"pro","userId":"user_001","expires":"2026-12-31"}'
```

响应：
```json
{
  "api_key": "gtk_a1b2c3d4...",
  "tier": "pro",
  "user_id": "user_001",
  "expires": "2026-12-31"
}
```

**重要**：`api_key` 仅在创建时返回一次，必须妥善保存。

### 7. 更新前端调用

修改前端的 API 调用，添加 API Key Header：

```javascript
// 之前
fetch('/api/data.json')

// 之后
fetch('/api/data.json', {
  headers: {
    'X-API-Key': localStorage.getItem('api_key')
  }
})
```

### 8. 更新定价页面

更新 `credits.html` 和 `api-pricing.html`，添加 "获取 API Key" 流程：
- 免费层：填写邮箱 → 自动生成 Key（tier=free）
- Pro 层：完成支付 → 调用 `/api/admin/keys` 生成 Key（tier=pro）

## 验证部署

### 测试匿名访问（应被裁剪）
```powershell
curl https://agent.genetech.tools/api/data.json
# 返回数据，但实体列表被截断为 10 个，每个仅含摘要
```

### 测试带 API Key 访问
```powershell
curl -H "X-API-Key: gtk_xxx" https://agent.genetech.tools/api/data.json
# 返回完整数据
```

### 测试速率限制
```powershell
# 连续调用 11 次，第 11 次应返回 429
for ($i=1; $i -le 12; $i++) {
  curl -s -o NUL -w "请求 $i : %{http_code}`n" https://agent.genetech.tools/api/data.json
}
```

## 成本估算

Cloudflare Workers 免费层：
- 100,000 次请求/天
- 10ms CPU 时间/请求

如果超过免费层，Workers Paid 计划为 $5/月，包含 1000 万次请求。

KV 免费层：
- 100,000 次读/天
- 1,000 次写/天
- 1GB 存储

对于初期阶段，免费层应该足够。当用户增长到数千 API 调用/天时，需要升级到付费计划。
