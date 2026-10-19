# Per-entity 静态详情页集成指南

> ⚠️ 本文档最后更新于 2026-10-17，可能已过期。权威口径见 docs/CORE_OBJECTIVE.md


> 10-14 深度评估报告 §11 指出：30 站目前只有列表页 + Pagefind 搜索，**无单实体详情页**，无法承接 SEO、分享、反向链接。对标 Scite / Litmaps / Semantic Scholar 的国际竞品形态：每个 entity 有一个 canonical URL。
>
> 本文件说明工具链用法、产物规模与部署决策。

## 1. 工具链

```bash
# 单站全量
node tools/build-entity-pages.mjs ai4science

# 单站精简（前 N 条）
node tools/build-entity-pages.mjs ai4science --limit 200

# 30 站批量
node tools/build-entity-pages.mjs --all --limit 200

# 只统计不写盘
node tools/build-entity-pages.mjs ai4science --dry-run

# 自定义部署域
SITE_BASE_URL=https://genetech.tools node tools/build-entity-pages.mjs ai4science
```

输入：`<site>/website/api/entities.json`
输出：`<site>/website/entities/`

## 2. 产物结构

```
<site>/website/entities/
├── index.html              # 站级实体索引（热门标签 + 前 20 条预览）
├── <slug>__<hash>.html     # 每个实体一页（canonical URL）
├── tags/<tag>.html         # 每标签聚合页（每页前 50 条）
└── sitemap.xml             # sitemap（含所有页 URL）
```

**HTML 特性**（~1.2KB/页，精简）：
- JSON-LD `schema.org/ScholarlyArticle`（Google/Bing/LLM 友好）
- Open Graph + Twitter Card
- `<link rel="canonical">`
- 中文实体（UTF-8 原样保留，slug 用 Unicode letter 保留）
- 极简内联 CSS（无外部依赖，页面完全自包含）

## 3. 实测规模

| 规模 | 单站大小 | 30 站合计 | GitHub Pages 状态 |
|---|---|---|---|
| 全量（9965 实体/站）| 58MB | **1.7GB** | ❌ 超 1GB 限制 |
| 前 500 实体 | ~12MB | 360MB | ✅ 可行 |
| 前 200 实体（推荐默认）| ~3MB | 90MB | ✅ 推荐 |
| 仅标签页 + 索引 | ~5MB | 150MB | ✅ 最小 |

**ai4science 全量实测**：9965 entities → 12453 sitemap URLs / 12259 文件 / 58MB / 20s。

## 4. 部署决策

### 方案 A：不部署（推荐起步）
工具链就绪，按需生成。CI 不触发，不占 GitHub Pages 配额。

### 方案 B：小规模试点（推荐起步部署）
```bash
# 挑 3 个高价值站，每站前 500 实体
node tools/build-entity-pages.mjs ai4science --limit 500
node tools/build-entity-pages.mjs biomed-ai --limit 500
node tools/build-entity-pages.mjs quantum-computing --limit 500
# ~36MB 总计，可提交到仓库
```

### 方案 C：全量部署（需分片策略）
30 站全量 = 1.7GB，超 GitHub Pages 限制。需要：
- 分片部署到独立子域名（如 `entities.genetech.tools`）
- 或按季度归档（只保留最新季度数据）
- 或压缩为静态 CDN（R2 + Pages）

### 方案 D：只部署索引 + 标签页
```bash
# 修改脚本，跳过实体页生成，只保留 index.html + tags/
# ~150MB 总计，30 站可控
```

## 5. SEO 收益预估

| 指标 | 当前 | 部署后（方案 B）|
|---|---|---|
| 可被搜索引擎抓取的页面数 | 30（每站 1 页） | 30 + 3×500 + 3×100 ≈ 1830 页 |
| 单实体 canonical URL | 无 | 有 |
| JSON-LD schema.org 结构化数据 | 无 | 有（Google/Bing 富摘要）|
| 反向链接承接点 | 无 | 有（`entities/<slug>__<hash>.html`）|

## 6. 与 Pagefind 的关系

Pagefind 索引**不索引** `entities/` 目录下的页面（因为 Pagefind 已在网站根目录构建索引）。若要搜索覆盖 entities 页，需在 Pagefind 配置里显式 include `entities/**`。

## 7. 已知限制

- **中文实体 slug**：`slugify()` 用 Unicode letter 保留中文，但 Google 对中文 URL 支持一般。混合场景（英文论文标题）不受影响。
- **URL 长度**：slug 截断到 80 字符，加 6 位 hash，总长 ≤ 90 字符。极长标题可能被浏览器截断。
- **摘要字段**：`snippet` 字段为空时页面留空（30.89% 实体缺摘要，见 `reports/data-quality-2026-10-15.md`）。
- **实体 ID 唯一性**：hash 基于 key 长度 + 字符 hash，同 key 不同实体会 hash 碰撞。生产使用需改用 UUID。

## 8. CI 集成（可选）

```yaml
# .github/workflows/entity-pages.yml
name: entity-pages
on:
  schedule:
    - cron: '0 6 * * 1'  # 每周一 06:00 UTC
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: node tools/build-entity-pages.mjs --all --limit 200
      - run: |
          for d in */website/entities; do
            tar czf $d.tar.gz -C $d .
          done
      - uses: actions/upload-artifact@v4
        with:
          name: entity-pages
          path: '*.tar.gz'
```
