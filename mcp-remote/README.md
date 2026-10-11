# GeneTech MCP Remote — 部署手册

Cloudflare Worker 实现 MCP v2 streamable-HTTP 端点，让付费用户无需装本地 SDK，直接远程接入。

## 一、快速部署（~5 分钟）

```bash
cd mcp-remote

# 1. 登录 Cloudflare（选 61960005@qq.com 账户）
npx wrangler login

# 2. 创建限流 KV 命名空间（可选但推荐）
npx wrangler kv namespace create RATE_KV
# → 输出 namespace id，替换 wrangler.toml 里 [[kv_namespaces]].id

# 3. 部署
npx wrangler deploy

# 4. 注入密钥
npx wrangler secret put LICENSE_VALIDATE_URL
# 输入：https://license.swarmlabs.tools/api/license/validate
npx wrangler secret put LICENSE_API_SECRET
# 输入：unified-license Worker 里的 API secret

# 5. 绑定自定义域名（可选）
npx wrangler routes list  # 查看当前路由
# 在 CF 控制台 → Workers & Pages → genetech-mcp-remote → Settings → Domains & Routes
# 添加 mcp.swarmlabs.tools
```

## 二、验证部署

```bash
# 健康检查（免鉴权）
curl https://mcp.swarmlabs.tools/health
# → {"jsonrpc":"2.0","id":null,"result":{"status":"ok","server":"genetech-data",...}}

# MCP Registry 元数据
curl https://mcp.swarmlabs.tools/manifest
# → glama.json 内容

# tools/list 请求
curl -X POST https://mcp.swarmlabs.tools/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# → 14 个工具列表

# tools/call 请求
curl -X POST https://mcp.swarmlabs.tools/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_sites","arguments":{}}}'
# → 30 站点列表
```

## 三、MCP 客户端接入

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "genetech-data": {
      "type": "streamable-http",
      "url": "https://mcp.swarmlabs.tools/mcp"
    }
  }
}
```

### Cursor

`Settings → MCP → Add Server → Remote → streamable-http`：

```
URL: https://mcp.swarmlabs.tools/mcp
Auth: Bearer <your GUX_ token>  (可选)
```

### 通用 MCP 客户端

Streamable-HTTP 是 2026-07-28 spec 新增的传输方式，几乎所有主流 MCP 客户端（Cursor / Windsurf / Cline / MCP Inspector）都已支持。

## 四、鉴权模型

| 层级 | 认证 | 限额 | 使用场景 |
|---|---|---|---|
| Free | 无 | 60 req/min（每 IP） | 试用/评估 |
| Pro | `Bearer GUX_*** | 600 req/min | 付费用户 |
| Team | `Bearer GUX_*** | 2000 req/min | 团队/合作 |

Pro 层的 GUX_ 是 unified-license Worker 签发（见 `unified-license/README.md`）。校验流程：

```
Client → MCP Remote (POST /mcp) → LICENSE_VALIDATE_URL (POST /api/license/validate)
                                            ↓
                                   { valid: true, tier: "pro", rateLimit: 600 }
```

## 五、数据源

Worker 不复制数据，全部转发到 `API_BASE_URL`（默认 `https://api.swarmlabs.tools`）：

| MCP 工具 | 上游端点 |
|---|---|
| list_sites | `GET /v1/domains` |
| query_entities | `GET /v1/entities?site=&source=&q=&limit=&offset=` |
| get_entity | `GET /v1/entities/{id}` |
| semantic_search | `GET /v1/search/semantic?q=&site=&topK=&graphHop=` |
| graph_search | `GET /v1/search/graph?q=&hops=&site=` |
| export_citation | `GET /v1/entities/{id}/citation?format=bibtex` |
| citation_gaps | `GET /v1/citation/gaps?topN=20` |
| ask | `GET /v1/ask?q=&site=` |
| submit_request | `POST /v1/intel/request` |
| retrieve_requests | `GET /v1/intel/requests?status=&project=&limit=&offset=` |
| intake_health | `GET /v1/intel/health` |
| verify_entity | `GET /v1/entities/{id}/verify` |
| snapshot_at | `GET /v1/domains/{site}/snapshot?date=YYYY-MM-DD` |
| domain_relatedness | `GET /v1/citation/relatedness?siteA=&siteB=` |

## 六、错误处理

| 状态码 | 场景 | 处理 |
|---|---|---|
| 200 | 正常 JSON-RPC 响应 | — |
| 400 | 无效 JSON 或非 2.0 请求 | 返回 JSON-RPC -32700 |
| 401 | 鉴权失败 / 过期 token | 提示换 token |
| 404 | 非 /mcp /health /manifest 路径 | 404 |
| 405 | 非 GET/POST/OPTIONS 方法 | 405 |
| 429 | Free tier 限流 | 60 req/min per IP |
| 500 | 内部错误 / 上游不可达 | 返回 JSON-RPC -32603 |

## 七、监控

Worker 支持 CF 的 Observability（默认开启）。关键指标：

- `requests` — 总请求数
- `cpu` — CPU 时间（每个 Worker 调用平均 <10ms）
- `exceptions` — 异常数（应 <1%）
- `kv.requests` — KV 请求数（限流计数）

Dashboard: Cloudflare 控制台 → Workers & Pages → genetech-mcp-remote → Analytics

## 八、成本估算

| 用量 | 成本 | 说明 |
|---|---|---|
| 100 万次请求/月 | ~¥0 | Free tier 覆盖 |
| 500 万次请求/月 | ~¥15 | $0.05/100K extra |
| KV 存储（限流计数） | ~¥0 | 每次 TTL 65s，几乎不占空间 |
| 域名 + TLS | 免费 | CF 免费证书 |

**结论**：即使 Pro 层跑满 60 req/min 全天，日均请求 8.6 万，月成本 <¥1。

## 九、与本地 SDK 的关系

| 维度 | 本地 SDK（@genetech/data-mcp） | 远程 MCP（本 Worker） |
|---|---|---|
| 部署 | `npx @genetech/data-mcp` | CF Worker 已部署 |
| 数据 | 读本地文件 | 转发到 API_BASE |
| 鉴权 | 无（读本地） | Bearer GUX_ 可选 |
| 成本 | 免费 | ~¥0（Free tier） |
| 场景 | 数据探索 / 离线 | 生产 / 多设备 / 云端 |

两个入口共存，用户按需选择。付费客户推荐远程（免装、多端、统一鉴权）；本地开发者推荐 SDK（零门槛）。

## 十、下一步

- [ ] 加 Prometheus/OpenTelemetry 指标导出（当前用 CF 内建）
- [ ] 支持 SSE 长连接（预留 GET /mcp 但当前返回 empty）
- [ ] 缓存 manifest 减少上游请求（TTL 5 分钟）
- [ ] 支持 Pro tier 自定义 rate limit（当前统一 600/min）
- [ ] 加请求日志（脱敏后写到 Logpush）
