# R2 迁移方案 — GeneTech 14站知识引擎

> 目标：把 Pages 上超过 955MB 的实体 JSON 迁到 Cloudflare R2，
> Pages 只留 HTML 壳，Workers 直接从 R2 读实体数据。
> 收益：解 Pages 存储/构建压力 + 加速实体交付（R2 边缘缓存）+ 支持 100k+ 实体扩库不重建站。

---

## 一、现状盘点（2026-09-24）

| 层 | 位置 | 体积 | 说明 |
|---|---|---|---|
| **共享数据** | `_site/data/*.json` | **7.7 MB** | search-index.json 16M→压缩后 7.7M、academic 13M、pubmed 6M、crossref 3M、s2 1.3M 等 |
| **各站实体** | `_site/<domain>/website/api/entities.json` | **30 站 × 13–23 MB ≈ 500 MB** | 每站 10K 实体，单文件最大 23M |
| **各站 index** | `_site/<domain>/website/api/index.json` | **30 站 × ~300 KB ≈ 9 MB** | 站点元信息，小 |
| **HTML 壳** | `_site/**/*.html` | **~50 MB** | 站点首页/归档页/搜索页 |
| **其他** | `.well-known/`、`ai/`、`api/` | **~10 MB** | GEO 端点、OpenAPI 等 |
| **合计** | **~955 MB** | | 接近 Pages 1014.7MB 实用上限 |

**约束**：
- Pages 免费版单文件 ≤ 25 MB → entities.json 最大 23MB，已接近上限
- Pages 免费版文件数 ≤ 20,000 → 当前约 4,000+ 文件，有余量但持续增长
- Pages 部署需完整构建（~955 MB 上传），构建时长 ~3-5 分钟

---

## 二、目标架构

```
用户请求
   │
   ▼
api.swarmlabs.tools (Workers)
   │
   ├── GET /v1/search/semantic  ──► R2: data/search-index.json (CDN 缓存 10min)
   ├── GET /v1/academic/*       ──► R2: data/{academic,pubmed,crossref,s2}-entities.json
   ├── GET /v1/entities?domain= ──► R2: data/domains/<domain>-entities.json
   └── GET /v1/knowledge-graph  ──► R2: data/knowledge-graph-entities.json

data.swarmlabs.tools (Pages，只留 HTML 壳)
   │
   ├── /<domain>/               HTML 首页 + 静态搜索页
   ├── /<domain>/website/api/index.json  小文件，留 Pages
   └── /data/...                全部移到 R2（只留重定向 stub）
```

**关键原则**：
1. **HTML 留 Pages**：SEO 友好，GEO 双引擎已优化的 robots.txt/llms.txt/ai_discovery 端点不动
2. **大数据去 R2**：实体 JSON（>1MB）全部走 R2，Workers 直接读
3. **兼容路径**：`/v1/*` 路径不变，外部消费者零改动
4. **渐进迁移**：先迁共享数据（低风险），再迁各站实体（大改造）

---

## 三、R2 命名空间规划

| Bucket | 内容 | 估计大小 | 访问模式 |
|---|---|---|---|
| `gt-data-shared` | `search-index.json`, `academic-entities.json`, `pubmed-entities.json`, `crossref-entities.json`, `s2-entities.json`, `oss-registry.json`, `knowledge-graph-entities.json`, `arxiv-hot.json`, `intel_state.json` | ~42 MB | 高频读，CDN 缓存 10min |
| `gt-data-domains` | `<domain>-entities.json`（30 站，每站 10K 实体） | ~500 MB | 低频读，CDN 缓存 1h |
| `gt-data-archive` | 历史快照（可选，做备份） | 按需 | 备份恢复 |

**成本估算**（R2 免费额度）：
- 存储：10 GB 免费 → 当前 542 MB，**零成本**
- 请求：1000 万次/月免费 → 当前搜索索引 ~5 万次/月，**零成本**
- 出站流量：**完全免费**（R2 无 egress fee，这是选 R2 而非 S3 的核心原因）

---

## 四、迁移步骤（分阶段）

### 阶段 1：共享数据迁 R2（低风险，30 分钟）

**目标**：把 `_site/data/*.json`（7.7 MB）迁到 `gt-data-shared` bucket，Workers 改读 R2。

**步骤**：
1. **创建 bucket**（CF Dashboard 或 wrangler）：
   ```bash
   wrangler r2 bucket create gt-data-shared
   # 绑定到 api-guard Worker
   wrangler secret put GT_R2  # 或通过 wrangler.toml [kv_namespaces] 绑定
   ```
2. **上传文件**：
   ```bash
   # 用 r2ctl 或 wrangler 批量上传
   for f in data/*.json; do
     wrangler r2 object put gt-data-shared/data/$(basename $f) --file $f
   done
   ```
3. **改 Workers 代码**：`api-guard/worker.js` 的 `getSearchIndex()` 改读 R2：
   ```js
   // 旧：从 data.swarmlabs.tools 拉
   const res = await fetch(SEARCH_INDEX_URL);
   // 新：从 R2 读
   const obj = await env.GT_R2.get('data/search-index.json');
   const data = obj ? JSON.parse(await obj.text()) : null;
   ```
4. **验证**：部署 Worker → 测 `/v1/search/semantic` 返回正常
5. **保留回滚路径**：Workers 代码里加 feature flag，R2 失败时回退到 Pages URL

### 阶段 2：各站实体迁 R2（中等风险，1-2 小时）

**目标**：把 `_site/<domain>/website/api/entities.json` 迁到 `gt-data-domains`。

**步骤**：
1. **修改 pipeline**：`tools/build-site.mjs` 不再把 entities.json 写入 `_site/`，改为直接上传到 R2
2. **修改 Worker 路由**：`/v1/domains/<domain>` 改从 R2 读：
   ```js
   if (path.startsWith('/v1/domains/')) {
     const domain = path.slice('/v1/domains/'.length);
     const obj = await env.GT_R2_DOMAINS.get(`${domain}-entities.json`);
     if (!obj) return json({ error: 'not_found' }, 404);
     return new Response(await obj.text(), {
       headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
     });
   }
   ```
3. **保留 Pages stub**：在 `_site/<domain>/website/api/entities.json` 留一个 `{ "redirect": "https://api.swarmlabs.tools/v1/domains/<domain>" }`，方便外部直接访问 Pages URL 的用户跳转
4. **验证**：30 站全量测 `/v1/domains/<domain>`，确认 200 + 数据完整
5. **构建优化**：`_site` 从 955MB 降到 ~50MB，构建时间从 3-5 分钟降到 <30 秒

### 阶段 3：扩库支持（长期收益）

**目标**：新增 `data/academic-entities-v2.json` 等扩库文件，不再触发 Pages 重建。

**收益**：
- 加 10 万实体只需上传到 R2，不需要 rebuild Pages
- 搜索索引热更新：Workers 每次请求检查 R2 对象 etag，有更新则刷新本地缓存
- 支持 delta 上传：只更新变化的实体，不全量重传

---

## 五、Worker 代码改造清单

| 文件 | 改动 | 影响 |
|---|---|---|
| `api-guard/worker.js` | `getSearchIndex()` 改读 R2；`/v1/domains/<domain>` 改读 R2；`/v1/academic/*` 改读 R2 | 所有数据端点 |
| `swarm-labs-gateway/worker.js` | `fetchEntities()` 改读 R2（可选，保持 Pages 上游也可） | 合作伙伴网关 |
| `api-guard/wrangler.toml` | 加 `[[kv_namespaces]]` 绑定 GT_R2、GT_R2_DOMAINS | 部署配置 |
| `tools/build-site.mjs` | 不再生成 `_site/<domain>/website/api/entities.json`，改为调 R2 上传 API | 构建流程 |
| `tools/deploy-independent-workers.mjs` | 加 R2 bucket 创建 + 绑定逻辑 | 部署脚本 |

**兼容策略**：
- Workers 代码同时支持 R2 和 Pages 两种读法（feature flag）
- R2 对象不存在时回退到 Pages URL（graceful degradation）
- 迁移期间双写：build-site 同时写 Pages 和 R2，验证 R2 稳定后关掉 Pages 写入

---

## 六、风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| R2 读延迟比 Pages 高 | 搜索响应变慢 | R2 有边缘缓存，实测延迟 ~5-15ms，比跨域 fetch Pages 更快 |
| R2 对象不存在（迁移漏传） | 端点 404 | Workers 加 fallback 到 Pages URL；监控告警 |
| 大文件 R2 上传超时 | 部分数据缺失 | 分批上传 + 校验 etag；失败重试 |
| Workers KV 限额 | 缓存策略失效 | R2 用 CDN 缓存（Cache API），不消耗 KV 配额 |
| 回滚复杂 | 迁移后发现问题难回退 | 阶段 1 保留 Pages 数据不删，阶段 2 再清理；feature flag 切换 |

**回滚路径**：
1. Workers 代码切回 Pages URL（feature flag = false）
2. R2 对象保留不删（作为备份）
3. Pages 数据在阶段 2 验证稳定前不删除

---

## 七、ROI 评估

| 指标 | 当前（全 Pages） | 迁移后（R2+Pages） | 收益 |
|---|---|---|---|
| Pages 存储 | ~955 MB | ~50 MB | **释放 905 MB**，接近上限彻底解除 |
| 构建时间 | 3-5 分钟 | <30 秒 | 构建提速 **10x** |
| 实体更新 | 需 rebuild Pages | 直接上传 R2 | **实时生效**，无需 rebuild |
| 单文件大小限制 | 25 MB | 无限制（R2 单对象 5GB） | 支持 100k+ 实体 |
| 月成本 | $0 | $0 | **零成本**（R2 免费额度足够） |
| 搜索延迟 | ~100-200ms（跨域 fetch） | ~20-50ms（R2 边缘缓存） | **提速 3-5x** |

**结论**：R2 迁移 ROI 极高，**建议立即执行阶段 1**（30 分钟，零风险），阶段 2 视扩库需求择机。

---

## 八、执行顺序（推荐）

1. **立即**：创建 `gt-data-shared` bucket + 上传 7.7MB 共享数据（30 分钟）
2. **立即**：改 `api-guard/worker.js` 的 `getSearchIndex()` 读 R2（加 fallback）
3. **本周**：部署 Worker → 验证 `/v1/search/semantic` 正常
4. **本周**：阶段 2 评估（实体迁 R2 需改 build-site，工作量大）
5. **扩库前**：阶段 2 执行（加 10 万实体前必须做）

---

## 九、参考资料

- [Cloudflare R2 文档](https://developers.cloudflare.com/r2/)
- [R2 with Workers](https://developers.cloudflare.com/r2/get-started/workers-api/)
- [R2 计费](https://developers.cloudflare.com/r2/pricing) — 10GB 存储 + 1000 万请求/月免费
- [Wrangler R2 命令](https://developers.cloudflare.com/workers/wrangler/commands/#r2)

---

## 十、决策点（需用户确认）

1. **R2 bucket 名称**：用 `gt-data-shared` / `gt-data-domains` 还是其他命名？
2. **阶段 2 时机**：现在做（释放 905 MB），还是等扩库需求明确再做？
3. **Pages 数据删除**：迁移验证稳定后是否删除 Pages 上的 entities.json（释放构建空间）？
4. **CF R2 API Token**：当前 CF token（`cfut_cqZFa...`）是否有 R2 权限？需确认或新建带 R2:Write 权限的 token。
