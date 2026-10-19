# Pagefind 搜索集成指南

> ⚠️ 本文档最后更新于 2026-10-17，可能已过期。权威口径见 docs/CORE_OBJECTIVE.md


> **P1-1 硬伤修复**：把站点内 / 全局搜索从「客户端 fetch 整站 entities.json 做 indexOf 子串匹配」换成
> **Pagefind 静态 Rust 索引**。索引 = 每站 ~20-50KB（原方案 9-14MB），全局搜索不再拉数百 MB。
> 来源：10-14 报告 §11。

## 现状问题（10-14 报告原文）

- **站点内搜索**：`site-search` 懒加载整站 `entities.json`（9-14MB），客户端 `indexOf` 子串匹配，无分词
- **全局搜索**：`global-search` 跨 30 站循环 fetch `entities.json`，总 payload 数百 MB
- **中文不友好**：`indexOf` 对「量子计算」「brain science」都只做精确子串匹配

## 方案：Pagefind

**Pagefind**（[v1.5.2](https://github.com/pagefind/pagefind)）是 Rust 静态搜索索引器：
- 构建时把源 HTML 转成倒排索引
- 客户端下载 ~20KB 索引 + 按需加载结果片段
- 支持中文分词（`--language zh`）
- 完全离线、零后端

## 一、快速接入（单站）

```bash
# 1. 生成 Pagefind 索引（输出到 <site>/website/pagefind/）
node tools/build-pagefind.mjs <site-dir>

# 2. 修改 <site>/website/search.html，替换 fetch entities.json 部分
```

## 二、build-pagefind.mjs 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `<site-dir>` | 必填 | 站点根目录 |
| `--entities` | `website/api/entities.json` | entities 数据源 |
| `--out` | `website` | 输出目录（含 pagefind/） |
| `--chunk` | `50` | 每页 entity 数（影响索引分块） |

**依赖**：
- 优先用本地 `node_modules/@pagefind/cli`（`npm i --save-dev @pagefind/cli`）
- 回退到 `npx -y -p @pagefind/cli pagefind`（首次需联网 ~30s 拉取）

## 三、search.html 改造模板

**旧代码**（`tools/build-site.mjs` L419-461）：

```javascript
// ❌ 旧：懒加载整站 entities.json
fetch('website/api/entities.json').then(r=>r.json()).then(j=>{
  cache = Array.isArray(j)? j : (j.entities||[]);
  run();
});
```

**新代码**（Pagefind）：

```html
<!-- 引入（放在 </body> 前） -->
<link rel="stylesheet" href="website/pagefind/pagefind-ui.css">
<script src="website/pagefind/pagefind-ui.js" type="module"></script>

<!-- 挂载容器（替换原 <div id="entity-list">） -->
<pagefind-input></pagefind-input>
<pagefind-hit-list></pagefind-hit-list>
```

**全局搜索**同理，指向根目录的合并索引：

```html
<script src="pagefind/pagefind-ui.js" type="module"></script>
```

## 四、全站批量生成

```bash
# 遍历 30 站生成索引
for site in $(ls -d */); do
  [ -f "$site/website/api/entities.json" ] && \
    node tools/build-pagefind.mjs "$site"
done
```

**实测产物大小**（neuromorphic 单站验证）：13MB entities.json → **3.8MB pagefind/** 索引，构建 1.36 秒。

**30 站全量实测**（2026-10-15 09:34）：

| 指标 | 数值 |
|---|---|
| entities.json 合计 | **518 MB**（30 站 × ~17MB） |
| pagefind 索引合计 | **145 MB** |
| 节省率 | **72%** |
| 构建耗时（串行） | ~3.5 分钟 |
| 客户端首字节 payload | **45 KB**（pagefind.js） |
| 客户端按需加载 | ~40KB × N 索引分片 |

**注**：早期估算（20-30KB）指客户端下载量，145MB 是**磁盘上的完整索引包**（CDN 缓存后极便宜）。用户单次搜索只需 `pagefind.js`（45KB）+ 命中页对应的 index 分片（几十 KB）。

## 五、验证

```bash
# 检查索引结构
ls <site>/website/pagefind/
# 应包含：pagefind.js, pagefind-ui.js, pagefind-ui.css, wasm/, index/

# 用浏览器打开 <site>/website/search.html，搜索应返回精确匹配
# 中文字符测试："量子" "脑科学" "AI Agent"
```

## 六、性能对比

**实测数据**（`tools/build-pagefind.mjs neuromorphic --chunk 200`，2026-10-15）：

| 指标 | 旧方案（fetch + indexOf） | Pagefind（neuromorphic 实测） |
|---|---|---|
| 源数据 | 13 MB（entities.json） | 13 MB（同一份） |
| 索引产物总大小 | 0（运行时算） | **3.8 MB**（pagefind/ 目录） |
| 客户端首字节下载 | 13 MB（整站 entities.json） | **45 KB**（`pagefind.js`） |
| 客户端按需加载 | 0 | 索引分片按需拉取（~40KB × N） |
| 索引分片数 | — | 50 分片（zh-cn_*.pf_index） |
| 单词总数（indexed words） | — | 47,705 |
| 构建耗时 | 0（运行时） | **1.36 秒** |
| 中文分词 | ❌ 无 | ✅ 支持（按 `<html lang="zh-CN">` 自动） |
| 后端依赖 | 无 | 无 |

**结论**：
- 客户端首字节 payload 从 **13MB → 45KB**（**降低 99.7%**）
- 索引存储 3.8MB（CDN 缓存后极便宜，$0.02/GB/月）
- 单次索引构建 1.36 秒，30 站串行 ~40 秒、并行 ~15 秒

**注**：早期估算（20-30KB）指客户端下载量，3.8MB 是**磁盘上的完整索引包**。用户单次搜索只需 `pagefind.js`（45KB）+ 命中页对应的 index 分片（几十 KB）。

## 七、与 mcp-server / api-guard 的边界

Pagefind 只用于**前端静态站点搜索**。以下场景**不用 Pagefind**：

- **`/v1/search/semantic` API**（api-guard）：走后端 embedding + Milvus/pgvector，需 API key
- **MCP 工具的 `search_entities`**：走 api-guard 后端，返回结构化实体
- **知识图谱边遍历**（citation edges/gaps）：走 `/v1/citation/*` 端点

Pagefind 只是补齐「前端静态站点文本搜索」这块，不是替代 API 语义检索。

## 八、后续可选优化

1. **合并索引**：把 30 站索引合并为单个根 `pagefind/`，`search.html` 全局页直接引用
2. **实体详情跳转**：Pagefind `data-url` 属性指向 `/entity/:doi` 详情页（P2-1 Astro 单实体页）
3. **多语言分词**：`--language en,zh,fr` 覆盖拉丁语 + 中文
4. **CDN 缓存**：`pagefind/` 静态资源加 `Cache-Control: max-age=31536000, immutable`

## 参考

- 官方文档：https://martianWare.com/pagefind/
- GitHub：https://github.com/pagefind/pagefind
- `tools/build-pagefind.mjs`：本仓库独立构建脚本
