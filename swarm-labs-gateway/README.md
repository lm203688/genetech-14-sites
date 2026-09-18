# SwarmLabs Data Gateway

**独立数据网关** — 把 SwarmLabs 14 站 × 30 领域（约 300K 结构化科研实体）通过**独立 API Key 体系**对外提供，与 SwarmLabs 自身 Pro 定价鉴权（`api-guard` / `unified-license`）**完全解耦**。

> **目标 partner**：蜂群科研数据 (Bee Swarm Science Data) 等外部项目。

---

## 独立性设计（关键）

| 维度 | SwarmLabs Pro (`api-guard`) | 本网关 |
| --- | --- | --- |
| Key 前缀 | `gtk_` | `slb_` |
| 签名密钥 | `PRO_SECRET` | `GATEWAY_SECRET`（独立） |
| 定价 | Pro ¥39.9 / 终身 ¥199（付费墙） | 免费（partner 授信） |
| 限流桶 | `free:<ip>:<min>` / Pro 无限制 | `gw:<clientId>:<min>` |
| 吊销影响 | 影响对应 Pro 用户 | **仅**影响对应 partner，不影响 Pro |
| 数据源 | 同源 | 同源（`lm203688.github.io/genetech-14-sites`） |
| 部署位置 | `genetech-api-guard` worker | **独立** `swarm-labs-gateway` worker |

**含义**：任何一侧故障/吊销/升级都不会波及另一侧。SwarmLabs 主站更新数据 → 网关自动同步（同源 CDN），无需 redeploy 网关。

---

## 数据规模

| 领域数 | 每域实体 | 总计 |
| --- | --- | --- |
| 30 | 10,000 | 300,000 |

领域列表：`agritech` / `ai-safety` / `ai4science` / `alien-minerals` / `biocomputing` / `biomed-ai` / `bionic-ai` / `brain-science` / `carbon-neutral` / `deep-sea-tech` / `digital-twin` / `edge-ai` / `embodied-ai` / `exo-science` / `life-science` / `low-altitude` / `neuromorphic` / `new-energy` / `nuclear-energy` / `privacy-computing` / `quantum-computing` / `quantum-materials` / `robot-parts` / `sat-6g` / `semiconductor` / `spatial-computing` / `synbio-manufacturing` / `tcm-tools` / `agent-ecosystem` / `genetech-tools`

**实体 schema**：`{ id, name, source, abstract, authors, year, tags, related }`（部分字段可能为空）

---

## API

### 1. 健康检查（免鉴权）

```
GET /api/v1/health
→ { ok: true, service: "swarm-labs-gateway", domains: 30 }
```

### 2. 领域清单（需 `slb_` key）

```
GET /api/v1/domains
Authorization: Bearer slb_XXXX
→ { count: 30, domains: [...], per_domain_entities: 10000, total_entities: 300000 }
```

### 3. 实体分页 + 关键词过滤（需 `slb_` key）

```
GET /api/v1/entities?domain=robot-parts&limit=50&offset=0&q=imitation
Authorization: Bearer slb_XXXX
→ { domain, total, limit, offset, hasMore, nextOffset, entities: [...] }
```

参数：
- `domain`（必填）— 30 个领域之一
- `limit`（默认 50，最大 500）
- `offset`（默认 0）
- `q`（可选）— 关键词，命中 `id` / `name` / `abstract` / `tags`

### 4. 单实体查询（需 `slb_` key）

```
GET /api/v1/entities/<id>?domain=robot-parts
Authorization: Bearer slb_XXXX
→ { domain, entity: { id, name, ... } }
```

### 错误响应

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `bad_request` | 缺 domain 参数 |
| 401 | `unauthorized` | 无 Authorization header |
| 403 | `invalid_prefix` / `bad_signature` / `expired` / `revoked` / `forbidden` | Key 问题或 scope 不足 |
| 404 | `unknown_domain` / `not_found` | 领域/实体不存在 |
| 429 | `rate_limited` | 每 key 每分钟 120 次上限 |
| 502 | `upstream_unreachable` | 上游 CDN 不可达 |

---

## Partner 接入（蜂群科研数据）

### 已签发的 Key

`clientId = swarm-buzz-2026`，`scopes = [entities:read, domains:read]`，`expiresAt = 2027-09-16`。

**Key 本体只在签发时打印过一次**（不入库、不入 partners.json），由签发操作者复制到 partner 侧。若丢失，用 `genkey.mjs issue` 重新签发（旧 key 会保留至过期，除非写入 KV 的 `revoked:swarm-buzz-2026`）。

### 客户端 SDK

```javascript
import { SwarmLabsClient } from './client-sdk.mjs';

const client = new SwarmLabsClient({
  baseUrl: 'https://swarm-labs-gateway.<account>.workers.dev',
  apiKey:  'slb_XXXX.YYYY',
});

const domains = await client.listDomains();
const page = await client.listEntities({
  domain: 'robot-parts', limit: 20, q: 'imitation',
});
const entity = await client.getEntity('arxiv-2607.29617v1', 'robot-parts');
```

浏览器/TS 可直接把 `client-sdk.mjs` 拷贝到 partner 项目，无需 Node 依赖（仅用 `fetch` / `AbortController`）。

---

## 运维手册

### 部署（一次性）

1. Cloudflare Dashboard → Workers & Pages → 新建 Worker → 命名 `swarm-labs-gateway`
2. `wrangler deploy`
3. `wrangler secret put GATEWAY_SECRET`（**值在本机生成，绝不写入本仓库任何文件**）
4. 新建 KV 命名空间 `gw-rate`（用于限流桶；不建也可，限流降级为放行）
5. 更新 `wrangler.toml` 里的 `id = "..."` 为 KV UUID
6. 再 `wrangler deploy`
7. 验证：`curl https://swarm-labs-gateway.<account>.workers.dev/api/v1/health`

### 生成新 secret（用于签发 key）

```bash
node genkey.mjs secret
# → 屏幕打印 GATEWAY_SECRET=<64 hex>
#   ⚠️ 只经 wrangler secret put / 环境变量传递，**绝不复制进本仓库任何文件**（本仓为 public）
```

### 签发 partner key

```bash
# 密钥只经环境变量传递，不落盘、不进命令行参数（--secret 会把密钥写进进程列表）
export GATEWAY_SECRET=<64 hex>          # PowerShell: $env:GATEWAY_SECRET="<64 hex>"
node genkey.mjs issue \
  --client swarm-buzz-2026 \
  --project "蜂群科研数据 (Bee Swarm Science Data)" \
  --scopes entities:read,domains:read \
  --exp-days 365 \
  --quota 120
# key 只在本次 stdout 打印一次 → 走私密渠道交付 partner，勿写入仓库/文档/工单
```

### ⚠️ 密钥卫生（2026-09-18 事故复盘）

本仓库是 **public** 仓库。此前 `swarm-labs-gateway/README.md` 与 `swarm-labs-gateway/_test.mjs`
把**真实 `GATEWAY_SECRET` 写成明文**，任何人（无需登录）都能从 GitHub 读到，并据此自签任意
`client` / `scopes` / `exp` 的 `slb_` key。暴露窗口：提交 `95caf35`（2026-09-16 17:22）→
`30b3e835`（2026-09-18 移除明文），约 2 天。

放大影响的两个设计弱点（第 1 个已修）：

1. **`hasScope()` 曾对空 scopes 默认放行** —— 伪造者只要省略 `scopes` 字段即获全部权限，
   使 scope 机制形同虚设。**已改为 fail-closed（空/非法 scopes → 拒绝）**。
2. **吊销只按持钥人自填的 `client` 生效** —— 伪造者换个 `client` 名即可绕开 `revoked:` 名单。
   ⛔ **未修**（属结构性缺口）。根治方向：worker 侧维护已知 client 白名单（KV 或 `[vars]`），
   未在册的 `client` 一律拒绝；轮换 secret 后风险已大幅降低，故未强改。

处置状态：

| 项 | 状态 |
|---|---|
| 从仓库文件移除明文 | ✅ 已改（README / `_test.mjs` 改为环境变量，commit `30b3e835`） |
| **轮换旧 `GATEWAY_SECRET`** | ✅ 已完成 2026-09-18（旧值作废；新值仅存 `.secrets/gateway_secret.txt`，已 gitignore） |
| 用新 secret 重发 蜂群 key | ✅ 已完成 2026-09-18（旧 key 在新 secret 下验签已失败，实测确认） |
| 部署时下发新 secret | ⛔ **待执行**：`wrangler secret put GATEWAY_SECRET` 必须在部署本 worker 前完成，否则网关会用旧值起服 |
| 清理 git 历史中的旧值 | 可选（旧值已作废，历史留存风险归零；如需彻底清除需 force-push + 联系 GitHub 清缓存/分支） |

轮换后的自检（可本地复跑）：

```bash
# 新 secret 指纹（不打印明文）
python -c "import hashlib;print(hashlib.sha256(open('.secrets/gateway_secret.txt').read().strip().encode()).hexdigest()[:12])"
# 旧 key 用新 secret 验签必须失败；新 key 必须通过 —— genkey 不含校验子命令，用 tmp/rotate_gateway_secret.py 的 §4 复核
```

硬规则（新增文件一律对照）：

1. 仓库里只允许占位符（`<hex>` / `替换为新值`）；真实密钥走 Secret / 环境变量 / `.secrets/`（已 gitignore）。
2. 交付 partner key 走私密渠道，不贴 issue / 文档 / 提交记录。
3. 同仓 `unified-license/DEPLOY-SECRETS.md` 早有相同告诫，本次是**没遵守**——说明「写在文档里」不足以防住。
   ✅ 已落地为机制：`tools/scan-secrets.mjs` + `.github/workflows/secret-scan.yml`（扫到即红，fail-closed）。
   本地复跑：`node tools/scan-secrets.mjs`（只扫 git 跟踪文件）或 `--all`（含未跟踪）。

### 吊销 partner key

```bash
# 方式 1：KV 写吊销标记（推荐，秒级生效）
wrangler kv key put gw-rate "revoked:swarm-buzz-2026" "1"
# 方式 2：等 exp 自然过期
```

### 查看台账

```bash
node genkey.mjs list
```

---

## 目录结构

```
swarm-labs-gateway/
├── worker.js          # CF Worker 主逻辑（鉴权 + 限流 + 路由 + 缓存）
├── wrangler.toml      # CF 部署配置
├── genkey.mjs         # Key 管理工具（secret / issue / list）
├── partners.json      # 台账（元数据，不含 key 本体）
├── client-sdk.mjs     # Partner 侧客户端 SDK（Node / 浏览器通用）
├── _test.mjs          # 本地自测（20 项通过）
└── README.md          # 本文档
```

---

## 与 SwarmLabs 主项目的边界

- **数据源**：SwarmLabs 主站 GitHub Pages（`lm203688.github.io/genetech-14-sites`），本 worker 只读，不写。
- **代码隔离**：`swarm-labs-gateway/` 独立目录，不与 `api-guard/` / `unified-license/` / `operations-plan/` 有任何 import / require 交叉。
- **密钥隔离**：`GATEWAY_SECRET` 与 `PRO_SECRET` / `LICENSE_API_SECRET` 完全独立，泄漏一处不影响其他。
- **发布隔离**：本 worker 单独 `wrangler deploy`，不走 SwarmLabs Pages 的 `pages-deploy.yml`。
- **计费隔离**：本 worker 免费（partner 授信），不计入 Pro 定价；SwarmLabs 付费墙（`api-guard`）继续按 Pro 定价运行。
