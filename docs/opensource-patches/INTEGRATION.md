# 补丁接入指南 — 把 GEO 补丁合并进 `tools/build-site.mjs`

> 本文件描述如何将对主站的 GEO 改造落地。**PoC 阶段未执行**，待授权。

## 现状（已核实）
- 构建脚本：`tools/build-site.mjs`
- 输出目录：`_site/`（GitHub Pages 根）
- 文件写出：`writeFile(rel, content)`（约 :1821）— 自动建目录、对文本跑 `localizeSiteCount`
- JSON-LD 注入点：`<head>` 模板中的 `ldScripts` 变量（约 :512）
- 当前 **无** `robots.txt` / `llms.txt` / `.well-known/ai.txt` / `ai/summary.json` / `ai/faq.json`

## 改动 1：emit 静态 GEO 文件
在 `main()` 内主内容写出之后，追加（内容来自本目录对应补丁文件）：

```js
// GEO 基础设施补丁（2026-09-08，PoC 报告）
writeFile('robots.txt', fs.readFileSync(path.join(__dirname,'../docs/opensource-patches/robots.txt'),'utf8'));
writeFile('llms.txt',    fs.readFileSync(path.join(__dirname,'../docs/opensource-patches/llms.txt'),'utf8'));
writeFile('.well-known/ai.txt', fs.readFileSync(path.join(__dirname,'../docs/opensource-patches/ai.txt'),'utf8'));
writeFile('ai/summary.json',    fs.readFileSync(path.join(__dirname,'../docs/opensource-patches/ai-summary.json'),'utf8'));
writeFile('ai/faq.json',        fs.readFileSync(path.join(__dirname,'../docs/opensource-patches/ai-faq.json'),'utf8'));
```
> 注意：`writeFile` 对 `.txt/.xml` 跑 `localizeSiteCount`（会把"14 个"本地化），`.json` 不受影响，安全。

## 改动 2：注入 JSON-LD 到 `ldScripts`
在 `ldScripts` 拼接处追加 Organization + Article 块（模板见 `organization-jsonld.html` / `article-jsonld.html`）：

```js
const orgLd = `...Organization JSON-LD（来自 organization-jsonld.html）...`;
const articleLd = `...Article JSON-LD，headline/datePublished/description 用页面变量替换...`;
ldScripts = [orgLd, articleLd, existingLd].filter(Boolean).join('\n');
```

## 改动 3（内容侧，持续）：answer-first + TL;DR + 问句 H2
- 内容模板首段改为 20–120 词 answer-first（auto-geo 要求）。
- H1 后插入 40–60 词 `TL;DR` 块。
- 每个内容页至少 1 个问句形式 H2（用户会问 AI 引擎的问题）。
- 内容扩展至 300+ 词，并补充外部权威引用链接（提升 signals/content 分项）。

## 复测门禁
重新构建后运行：
```bash
python tools/opensource-integration/geo_audit.py --url https://lm203688.github.io/genetech-14-sites/
```
目标：全站均分 > 60/100（基础设施三项满分后可达），再合并发布 PR。

## 风险
- `assets/logo.png` 路径需确认存在于 `_site`（否则 Organization/Article logo 404，但不影响评分主干）。
- CF P0（license/api.swarmlabs.tools 绑定剥离）不影响 `github.io` 根址验证。
