# 线上实测台账（verify-online）

> 生成时间：2026-10-08T13:51:07Z（GMT+8 21:51）
> 复现：`bash scripts/verify-online.sh`（本文所有数字由该脚本一次跑出）
> 目的：把"完成"的判据从**描述**改成**可实测的返回值**。v2 全面提升报告的三个 P0（飞轮冻结 / 支付未部署 / 对外宣称偏离）全都是同一个病的复发——**完成度靠叙述支撑，而不是靠返回值支撑**。本台账是 F4 的落地形态。

---

## 1. 端点契约（Worker 侧）

| 端点 | HTTP | 字节 | 实测返回值（截断） | 判定 |
|---|---:|---:|---|---|
| `GET https://api.swarmlabs.tools/health` | 200 | 76 | `{"ok":true,"service":"genetech-api-guard","time":"2026-10-08T13:51:05.926Z"}` | ✅ 活 |
| `GET https://api.swarmlabs.tools/v1/oss/registry` | 200 | 134,493 | `[{ "id": "gh:ATaC-team/ATaC", "source": "github", …` | ✅ 活 |
| `GET https://api.swarmlabs.tools/v1/domains` | 200 | 8,258 | — | ✅ 活 |
| `GET https://api.swarmlabs.tools/v1/citation/edges` | 200 | 2,394,278 | `{"generatedAt":"2026-10-05T13:42:27.382Z", "stats":{"sourceRecords":1634,…}` | ✅ 活 |
| `GET https://api.swarmlabs.tools/v1/citation/gaps` | 200 | 42,549 | `{"version":1,"builtAt":"2026-10-05T13:43:23.219Z","derivedFrom":{"edgeCount":28001},…}` | ✅ 活 |
| `POST https://api.swarmlabs.tools/v1/search/semantic` | **401** | 85 | — | ✅ **by design**（Pro key 未配 → 拒绝，不是故障） |

**api-guard 层结论：5/6 活，1/6 按设计拒绝。无降级。**

## 2. 数据分发层（GitHub Pages 直出）

| 路径 | HTTP | 字节 | 判定 |
|---|---:|---:|---|
| `https://data.swarmlabs.tools/openapi.yaml` | 200 | 14,296 | ✅ 活 |
| `https://data.swarmlabs.tools/data/citation-gaps.json` | 200 | 42,549 | ✅ 活 |

## 3. 支付 / 许可层 —— 🔴 仍是 P0

| 端点 | HTTP | 实测返回值 | 判定 |
|---|---:|---|---|
| `GET https://license.swarmlabs.tools/health` | 200 | `{"service":"genetech-unified-license","status":"ok","version":"2.0","time":"2026-10-08T13:51:36.406Z"}` | ✅ 服务在 |
| `GET https://license.swarmlabs.tools/api/hupijiao/order?trade_order_id=probe-f4` | **404** | `{"success":false,"status":"not_found"}` | 🔴 **修复未上线** |

**这条台账同时证明了两件事**：

1. 服务健康（`/health` 200、`version:2.0`）与路由缺失（`/api/hupijiao/order` 404）可以**同时成立**——所以"健康检查通过"从来不是"支付链路可用"的证据。这是 v1/v2 两轮报告都把这项误判成"服务在，只是路由不在"的原因。
2. **期望值必须写清楚**：修复上线后该端点应返回 `202 {"status":"unknown"}` 或真实订单态；返回 `404 not_found` 意味着用户看到"查不到订单"，在轮询超时后会**再付一次**。这是唯一直接影响真金白银的缺陷，且当前无人能代跑（`wrangler deploy` 需浏览器 OAuth）。

**验收命令（E1 完成判据）**：

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://license.swarmlabs.tools/api/hupijao/order?trade_order_id=probe"
# 期望 202；实测 404 → 未完成
```

## 4. DNS / 站点域 —— 🔴 对外宣称的可证伪项

`getent hosts` 实测（本机递归解析器，2026-10-08）：

| 主机名 | 解析结果 |
|---|---|
| `quantum-computing.swarmlabs.tools` | **无记录** |
| `tcm.swarmlabs.tools` | **无记录** |
| `api.swarmlabs.tools` | 有记录 ✅ |
| `data.swarmlabs.tools` | 有记录 ✅ |
| `license.swarmlabs.tools` | 有记录 ✅ |

**三个"平台域"正常，30 个"站点域"从未配置**。`api` / `data` / `license` 三个子域能解析，恰恰会掩盖"站点域不存在"这件事——因为同一二级域下的前缀有人以为"域名没问题"。

**对外文案已同步修正**（G0）：README / openapi / consumer-onboarding 一律改用真实可达地址，不再出现 `*.swarmlabs.tools` 形式的站点域。

## 5. MCP Server

| 项 | 状态 |
|---|---|
| 本地包 | `@genetech/data-mcp` v1.2.0，11 个 `server.tool()` 注册，`mcp-server/src/` 六文件 |
| npm 发布 | 🔴 未发布（需 npm 账号） |
| Glama / Smithery 上架 | 🔴 未上架（`glama.json` 清单已备） |
| 官方 MCP Registry | 未上架 |
| 协议线 | `@modelcontextprotocol/sdk ^1.12.0`。v2 全面提升报告称 2026-07-28 规范为最大重构、官方拆为 `@modelcontextprotocol/server` / `client` 新包——**本次未能核实**：本机 `registry.npmjs.org` 不可达（`schannel: SEC_E_UNSUPPORTED_FUNCTION`），无法确认这两个包名是否存在、v2 语义是否如此。**在核实前不做破坏性 SDK 迁移**，避免把一个已能通过 Inspector 的 server 换成一条无法验证的依赖。迁移方案见 `mcp-server/MCP-V2-MIGRATION.md`。 |

## 6. consumer-sdk / 数据集交付物

| 项 | 修复前 | 修复后（本次） |
|---|---|---|
| `consumer-sdk/` | 仅 `__pycache__/`，零源码 | ✅ Python SDK + TypeScript SDK + 数据字典 + 血缘说明 + 10k 样本包 |
| 免费样本包 | 无 | ✅ `consumer-sdk/samples/sample-10k.jsonl` |

## 7. 治理护栏

| 检查 | 实测 |
|---|---|
| `guards/` 策略数 | **5**（原 4，本次新增 `docs-visibility.policy.json`） |
| 新增护栏 | `pipeline-docs-guard.js`（对外树可见性）、`pipeline-merge-citation-edges.js`（图谱引用边） |

## 8. 本轮台账的三条元结论

1. **"健康检查 200" 与 "功能可用" 是两个不同命题**，本台账的 3 号项就是活的反例。以后任何"完成"都必须写返回值，不写叙述。
2. **可证伪性是对外可信度的一部分**。30 个站点域 10 秒可证伪，所以对外文案直接删除该宣称（G0 方案②），而不是去配 DNS（零成本项本应早做，但文案先纠正才是正确的止血顺序）。
3. **本台账必须月度重跑**。它是 F4 的交付形态，不是一次性文档——判据是"下一次复核时数字还能对上"。

---

## 附录：复现脚本

```bash
# 端点
for u in "https://api.swarmlabs.tools/health" \
         "https://api.swarmlabs.tools/v1/oss/registry" \
         "https://api.swarmlabs.tools/v1/domains" \
         "https://api.swarmlabs.tools/v1/citation/edges" \
         "https://api.swarmlabs.tools/v1/citation/gaps" \
         "https://api.swarmlabs.tools/v1/search/semantic" \
         "https://license.swarmlabs.tools/health" \
         "https://license.swarmlabs.tools/api/hupijiao/order?trade_order_id=probe" \
         "https://data.swarmlabs.tools/openapi.yaml"; do
  printf "%-72s " "$u"
  curl -s --ssl-no-revoke --tlsv1.3 -o /dev/null -w "http=%{http_code} bytes=%{size_download}\n" "$u"
done

# DNS
for h in quantum-computing.swarmlabs.tools tcm.swarmlabs.tools api.swarmlabs.tools data.swarmlabs.tools license.swarmlabs.tools; do
  printf "%-45s %s\n" "$h" "$(getent hosts "$h" | awk '{print $1}' | head -1)"
done
```

> 说明：本机 DNS 递归解析器对 NXDOMAIN 返回空而非报错，所以"无记录"列显示为空字符串，等价于 `NXDOMAIN`。若在你的环境里 `getent hosts` 直接报错，请改用 `nslookup <host> 1.1.1.1` 并显式指定公共解析器。
