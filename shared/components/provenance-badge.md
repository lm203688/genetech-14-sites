# Provenance Badge · 溯源徽章组件

> 对应 v2 报告 §6 G1「把可溯源做成 UI」
> 验收判据：**用户 3 秒内能看懂"这条从哪来、多可信"**
>
> 设计约束
> - 纯静态 HTML + CSS + JS（无框架、无依赖、可离线打开）
> - 单文件即可嵌入任意页面（每个站点自己的 `index.html` 里都能用）
> - 数据源：任意一条 `entities.json` 里的实体
> - 视觉遵循中文环境惯例：涨红跌绿在这里不适用，但**质量高=绿、低=红**是行业通用

---

## 1. 使用方式

在任意 HTML 页面里放：

```html
<!-- 复制整块 -->
<script src="https://data.swarmlabs.tools/shared/components/provenance-badge.js"></script>
<div class="provenance-badge"
     data-id="doi:10.xxxx/yyyy"
     data-source="crossref"
     data-confidence="0.92"
     data-quality-tier="high"
     data-published="2024-03-15"
     data-updated="2026-08-01"
     data-url="https://doi.org/10.xxxx/yyyy">
</div>
```

或者直接嵌入完整 HTML：

```html
<div class="provenance-badge-inline">
  <!-- 见下方 §3 完整代码 -->
</div>
```

---

## 2. 视觉设计（4 个信息位）

按重要性从上到下：

1. **来源**（`source`）—— 用色带 + 品牌色
2. **质量**（`quality_tier` / `confidence`）—— 用色带 + 数字
3. **鲜度**（`publishedDate` vs `addedAt`）—— 相对时间
4. **溯源**（`DOI` / `URL`）—— 一键直达

**颜色语义**（对齐中国 A 股惯例：**红=警示、绿=健康**，不是股价涨跌）：

| 值 | 颜色 | 语义 |
|---|---|---|
| `high` / confidence ≥ 0.85 | 🟢 `#22c55e` | 高质量 |
| `medium` / 0.70–0.84 | 🟡 `#eab308` | 中等 |
| `low` / < 0.70 | 🔴 `#ef4444` | 低质量，需复核 |
| 缺失 | ⚫ 灰色 | 无数据 |

---

## 3. 完整 HTML 代码（可直接复制）

```html
<div class="provenance-badge" style="display:flex;gap:8px;flex-wrap:wrap;font-family:system-ui,sans-serif;font-size:12px;line-height:1.2;">
  <span class="pb-chip pb-source" title="数据源">crossref</span>
  <span class="pb-chip pb-quality-high" title="质量分">high · 0.92</span>
  <span class="pb-chip pb-fresh" title="发布/入库">2024-03-15</span>
  <a class="pb-chip pb-link" href="https://doi.org/10.xxxx/yyyy" target="_blank" rel="noopener">DOI ↗</a>
</div>
```

配套 CSS（放在 `<style>` 或 `<head>`）：

```css
.pb-chip{
  display:inline-flex;
  align-items:center;
  gap:4px;
  padding:2px 8px;
  border-radius:9999px;
  background:#f1f5f9;
  color:#334155;
  border:1px solid #e2e8f0;
  text-decoration:none;
  font-size:12px;
}
.pb-chip:hover{ background:#e2e8f0; }
.pb-source{ background:#eff6ff; color:#1d4ed8; border-color:#bfdbfe; }
.pb-quality-high{ background:#f0fdf4; color:#166534; border-color:#bbf7d0; }
.pb-quality-medium{ background:#fefce8; color:#854d0e; border-color:#fde68a; }
.pb-quality-low{ background:#fef2f2; color:#991b1b; border-color:#fecaca; }
.pb-fresh{ background:#f5f3ff; color:#5b21b6; border-color:#ddd6fe; }
.pb-link{ background:#fff; color:#0ea5e9; border-color:#7dd3fc; }
```

---

## 4. JS 版（自动渲染）

```javascript
// shared/components/provenance-badge.js
(function () {
  const SOURCE_LABELS = {
    crossref: 'Crossref', openalex: 'OpenAlex', pubmed: 'PubMed',
    europepmc: 'EuropePMC', arxiv: 'arXiv', datacite: 'DataCite',
    semanticscholar: 'S2', preprints: 'Preprints',
  };
  function qualityClass(tier, conf) {
    if (tier === 'high' || conf >= 0.85) return 'high';
    if (tier === 'low' || conf < 0.70) return 'low';
    return 'medium';
  }
  function relativeTime(iso) {
    if (!iso) return '未知';
    const d = new Date(iso); if (isNaN(d)) return iso;
    const days = Math.floor((Date.now() - d) / 86400000);
    if (days < 0) return d.toISOString().slice(0, 10);
    if (days === 0) return '今日';
    if (days < 30) return days + ' 天前';
    if (days < 365) return Math.floor(days / 30) + ' 个月前';
    return Math.floor(days / 365) + ' 年前';
  }
  function render(root) {
    const src = root.dataset.source || '?';
    const tier = root.dataset.qualityTier || '';
    const conf = parseFloat(root.dataset.confidence || 0) || 0;
    const qc = qualityClass(tier, conf);
    const pub = root.dataset.published || root.dataset.updated || '';
    const doi = root.dataset.id || root.dataset.doi || '';
    const url = root.dataset.url || (doi.startsWith('doi:') ? 'https://doi.org/' + doi.slice(4) : '');
    root.innerHTML = `
      <span class="pb-chip pb-source">${SOURCE_LABELS[src] || src}</span>
      ${tier || conf ? `<span class="pb-chip pb-quality-${qc}">${tier || 'medium'} · ${conf.toFixed(2)}</span>` : ''}
      ${pub ? `<span class="pb-chip pb-fresh" title="${pub}">${relativeTime(pub)}</span>` : ''}
      ${url ? `<a class="pb-chip pb-link" href="${url}" target="_blank" rel="noopener">溯源 ↗</a>` : ''}
    `;
  }
  document.querySelectorAll('.provenance-badge').forEach(render);
})();
```

---

## 5. 与数据字典的对应关系

参见 [`consumer-sdk/docs/DATA-DICTIONARY.md`](../../consumer-sdk/docs/DATA-DICTIONARY.md)。本组件读取的字段全部是**规范字段**（`source` / `confidence` / `quality_tier` / `publishedDate` / `addedAt` / `doi` / `url`），没有用内部字段。

**红线**：绝不把 `confidence_breakdown`（≈75MB 冗余明细）暴露给前端——用户看的是**结论**，不是**计算过程**。

---

## 6. 与 `verify-online.md` 的对应关系

用户点"溯源 ↗"跳到 `https://doi.org/...`——这个 URL 必须可解析。若跳转失败，说明上游 DOI 抓取错误，属于**必须阻断发布的质量问题**（`pipeline-quality-gate.js --ci` 会拦下）。

---

## 7. 集成到站点页面的最小示例

假设某站已经构建出 HTML：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>量子计算 · GeneTech</title>
  <style>
    body{max-width:960px;margin:2rem auto;font-family:system-ui,sans-serif}
    /* 徽章 CSS 见 §3 */
  </style>
</head>
<body>
  <article>
    <h2>Quantum Computing in the NISQ era</h2>
    <div class="provenance-badge"
         data-source="arxiv"
         data-confidence="0.88"
         data-quality-tier="high"
         data-published="2018-08-06"
         data-added-at="2026-08-01"
         data-id="arxiv:1808.00261"
         data-url="https://arxiv.org/abs/1808.00261">
    </div>
    <p>...</p>
  </article>
  <script src="shared/components/provenance-badge.js"></script>
</body>
</html>
```

---

## 8. 后续动作（本轮不做）

- 每站首页生成 `provenance-summary.html`（汇总该站前 20 条实体）
- 徽章支持国际化（当前英文标签，中文可后续扩展）
- 深色模式适配（当前只支持浅色）

这些属于 §6 G1 的"延伸"部分，本轮先做**最小可用**版本——保证"3 秒看懂"的核心诉求。
