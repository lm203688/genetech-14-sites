# AIShield 服务恢复报告 2026-07-31

## 恢复时间
2026-07-31 00:10 (UTC+8)

## 故障持续时间
连续 8 天 (2026-07-24 ~ 2026-07-31)

## 根因
腾讯云 ICP 备案拦截 — 域名 aishield.tools 未完成 ICP 备案，腾讯云在网络层放行 TCP 握手，但在应用层拦截所有 HTTP/HTTPS 数据传输。

## 解决方案
**Cloudflare Tunnel** — 通过从服务器主动出站连接到 Cloudflare，绕过入站流量拦截。

### 实施步骤
1. 在 Cloudflare Zero Trust 创建 Tunnel (aishield-tunnel)
2. 服务器安装 cloudflared 并连接到隧道 (2 个 connector, version 2026.7.3)
3. DNS 记录从源站 IP 改为隧道 CNAME:
   - aishield.tools → 0c39bcfb-0c96-4858-9025-d54131e062ec.cfargotunnel.com
   - www.aishield.tools → 同上 (CNAME)
   - swarm.aishield.tools → 同上 (CNAME)
4. 添加 Page Rule: www.aishield.tools/* → 301 → https://aishield.tools
5. Cloudflare SSL 模式设为 Flexible

### 验证结果
| 端点 | 状态 | 详情 |
|------|------|------|
| https://aishield.tools/api/v1/health | 200 OK | status=ok, version=4.2, rules=133 |
| https://aishield.tools/ | 200 OK | 首页正常加载 |
| https://aishield.tools/openapi.json | 200 OK | OpenAPI 3.0.3 规范正常 |
| https://www.aishield.tools/* | 404 | Page Rule 传播中，预计 30 分钟内生效 |

### 连接器状态
- Connector 1: 8ed01a75-ded4-4854-83c6-1c36d725618d — Connected (v2026.7.3)
- Connector 2: c754eadc-d780-4e78-a675-b281b685e4cb — Connected (v2026.7.3)

## 后续待办
1. AIShield 服务恢复 — 已完成
2. www 子域名重定向传播验证 (低优先级)
3. Glama 平台提交评估 (P1)
4. npm 包 @aishield/mcp-server 发布 (P3)
5. 服务恢复后验证 Creem Webhook 全链路 (P2)
6. MCP 无状态协议兼容性评估 (P0)
