# heyclicky 开源项目调研与借鉴分析

> 调研日期：2026-09-14 ｜ 仓库：`farzaa/clicky`（MIT）｜ 目标：对 GeneTech 14 站知识引擎的借鉴与落地
> 结论先行：**三项核心能力中两项本站已有雏形（CF Worker 代理密钥、页面级上下文问答），最差异化的「Visual Cursor Pointing（指向式引导）」此前缺失——已移植为 `tools/static/point-guide.js` 并全站注入。**

## 1. heyclicky 是什么

| 维度 | 内容 |
|---|---|
| 产品定位 | macOS 原生 AI 助手，"AI 来到你身边，而不是你去找 AI"——直接在屏幕上把光标飞过去指着教用户 |
| 技术栈 | Swift + SwiftUI（macOS 原生）、ScreenCaptureKit（屏幕采集）、Anthropic Computer Use API（坐标推理）、Cloudflare Worker（密钥代理） |
| 开源许可 | MIT（仓库 `farzaa/clicky`，含 `worker/`、`leanring-buddy/`、`scripts/`） |
| 核心差异化 | **Visual Cursor Pointing**：模型输出 `[POINT:x,y]` 坐标标签，前端 overlay 渲染动画光标飞过去指着；屏幕截图作 LLM 上下文 |

## 2. 三大核心机制拆解

### ① Visual Cursor Pointing（最差异化）
- 模型用 Computer Use API 定位屏幕元素坐标 → 返回 `[POINT:x,y]` 这类坐标协议
- 前端 `CompanionResponseOverlay` 解析坐标，驱动一个蓝色动画光标"飞过去指着"+ 气泡说明
- `ElementLocationDetector` 负责把逻辑位置换算成屏幕绝对像素

### ② 屏幕即上下文（Screen-as-Context）
- 截屏作为 LLM 上下文，让模型"看到"用户当前在做什么
- 配套 `leanring-buddy/` 内的上下文拼接逻辑

### ③ Cloudflare Worker 代理密钥
- `worker/` 是 CF Worker，把 Anthropic 等 API key 留在服务端，客户端只发截图/指令
- key 不进客户端，规避泄露

## 3. 可移植性评估（对静态知识站）

| 机制 | 本站现状 | 可移植性 | 处置 |
|---|---|---|---|
| Visual Cursor Pointing | **无**（ask.js 无页面上下文感知、无指向引导） | ✅ 高（可 Web-native 化） | **已落地** `point-guide.js` |
| 屏幕即上下文 | ask.js 已用固定系统提示词 + api-guard 转发 | ⚠️ 中（Web 无原生截屏，但可"当前页内容作上下文"） | 已有雏形，待增强（见 §5） |
| CF Worker 代理密钥 | api-guard Worker 已存在（P0 绑定剥离前可用） | ✅ 已对齐 | 保持，P0 修后复用 |
| macOS 屏幕采集 / Computer Use API | 无 | ❌ 不可移植 | Web 静态站无法使用，不采纳 |

**关键判断**：heyclicky 最值钱的是「①指向式引导」——它解决了"教程文字写『点这里』但用户找不到"的体验断层。这正是知识引擎站（30 站、功能入口多）的痛点。②③本站已有对应物，无需重复造轮子。

## 4. 已落地的借鉴：指向式引导组件

**文件**：`tools/static/point-guide.js`（零依赖，浏览器原生，默认 no-op 零副作用）

**Web-native 适配（比原版更稳）**：
- 不依赖 macOS ScreenCaptureKit / Computer Use API，改绑**真实 DOM 元素 id**
- 每次重算坐标（响应式），比 heyclicky 的绝对像素在重排/移动端更鲁棒
- 内容作者用声明式属性即可，无需截图推理

**两种用法**：
```html
<!-- 引导式：脚本自动注入「▶ 开始引导」按钮 -->
<div class="point-guide" data-auto="true">
  <button data-target="#search" data-label="在这里输入关键词，回车做混合检索">① 搜索框</button>
  <button data-target="#ask"    data-label="进入 AI 问答，答案带参考来源">② AI 问答</button>
</div>

<!-- 内联式：教程正文写 [[指向:#id|说明]]，自动替换为可点击「指向」徽标 -->
<p data-point-inline>先到 [[指向:#data|数据下载页导出 JSON]]，再喂给你的 Agent。</p>
```

**构建器接入**（`tools/build-site.mjs`，已改、语法校验通过）：
- `</head>` 前注入 `<script src="${BASE}/assets/point-guide.js" defer>`（line 524）
- 导航新增「指向演示」入口 → `point-guide.html`（line 501）
- `writeFile('assets/point-guide.js', …)` 输出源文件（line 2011）
- 新增 `renderPointGuideDemo()` 演示页（line 1336），含 4 步引导（搜索/问答/数据/主题）

**无标记页面**：脚本加载后若无 `.point-guide` / `data-point-inline`，直接 return，零开销。

## 5. 未采纳 / 待设计拍板

| 项 | 状态 | 说明 |
|---|---|---|
| 屏幕即上下文增强 | 待拍板 | ask.js 可加"把当前页实体/标题作上下文"；但涉及 prompt 工程，需你确认交互预期 |
| Anthropic Computer Use 式坐标推理 | 不采纳 | 依赖原生截屏，Web 站无此能力 |
| 全站教程页批量加指向标记 | 待拍板 | 可挑 3–5 个核心页（首页/数据页/问答页）做引导，需你定优先级 |
| GEO 对 point-guide 的加成 | 已自然获得 | 演示页带 `farzaa/clicky` 外链 + 结构化说明，属 E-E-A-T 信号 |

## 6. 后续可推进（等你选）

1. **全站引导铺开**：挑核心页批量加 `.point-guide` 标记（低工作量，复用现有组件）
2. **ask.js 上下文增强**：让 AI 问答感知"当前浏览的站点/实体"，对齐 heyclicky ②
3. **GEO 复测**：D1 根部署后 GEO 基线已更新，本组件作为交互信号待主闭环自然复测

---

**交付物**：
- `tools/static/point-guide.js`（新，零依赖指向式引导组件）
- `tools/build-site.mjs`（4 处改动：head 注入 / nav / writeFile / 演示页）
- `docs/heyclicky-borrowing-analysis.md`（本报告）
- 已通过 `node --check` 语法校验，待 push.mjs 推送 + CI 构建验证
