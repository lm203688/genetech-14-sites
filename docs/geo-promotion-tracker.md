# GeneTech 14 站 · GEO / 引流推广追踪表（持续更新）

> 用途：① 用户可执行的「线上平台嫁接」清单（AI 备料、用户只点发布/确认）；② 自动化每周维护的进度看板。
> 原则：免费层 GEO 自动获客（边际成本≈0）为主，付费分发（目录/社媒/发布）为辅；所有「需要账号/私钥」的动作由用户执行，AI 不替用户注册。
> 关联文档：`docs/growth-strategy.md` §11（渠道分层）、`docs/growth-materials.md`（复制即发文案）、`docs/competitor-models.md`（商业模式借鉴）、**`docs/x-algorithm-promo-playbook.md`（X 开源算法 → 推广打法，所有内容默认带其 §5 信号自检）**。

---

## A. AI 目录 / 开发者市场认领（低摩擦、一次搞定）

| 平台 | 状态 | 用户动作 | 物料位置 |
|---|---|---|---|
| Glama（glama.io） | ⬜ 待认领 | GitHub 登录 → 粘贴 A1 描述 | growth-materials §A1 |
| Smithery（smithery.ai） | ⬜ 待认领 | 提交 genetech-data + 英文描述 | growth-materials §A2 |
| mcp.so | ⬜ 待认领 | 提交中文摘要 | growth-materials §A3 |
| PulseMCP（pulsemcp.com） | ⬜ 待认领 | 提交同上 + 主页链接 | growth-materials §A4 |

**完成标准**：在各自平台搜 `genetech` / `GeneTech Data MCP` 能出现我们的条目，且描述带护城河四句。

---

## B. 中文社媒矩阵（复制即发，每篇 5 分钟）

| 平台 | 内容 | 状态 | 物料 |
|---|---|---|---|
| 知乎（长文） | Elicit 中文替代 / bio×AI 前沿 | ⬜ 待发 | growth-materials §B1 |
| 小红书（种草） | 科研人必看知识库 | ⬜ 待发 | growth-materials §B2 |
| 公众号（推文） | 中文版 Elicit 故事 | ⬜ 待发 | growth-materials §B3 |
| CSDN / 掘金（技术） | 手把手接 MCP | ⬜ 待发 | growth-materials §B4 |

**新增 GEO 权威长文（本批产出，建议同步分发）**：
- `content/blog/bio-ai-frontier-2025-2026.md` — AI for Science 范式转移（bio×AI 核心集群）· 2026-08-14
- `content/blog/gene-editing-2-0-2025-2026.md` — 基因编辑 2.0（genetech-tools 域）· 2026-08-14
- `content/blog/biocomputing-2025-2026.md` — 生物计算：DNA 存储 / CRISPRi 基因电路 / ML×代谢建模（biocomputing 域）· **2026-08-17 本周产出**，默认带 X 算法排名信号结构（钩子问题 / 配图占位 / 收藏级长文 / 垂直关键词 / 转化 CTA / 避罚）

这三篇带可溯源引用、答案优先，是喂给 AI 引擎做「XX 领域最新进展」类问句的高价值语料；发布后建议在知乎/公众号各改写一篇。主题已按周轮换：AI4S 范式 → 基因编辑 2.0 → 生物计算，避免重复。

---

## C. Bot 商店 / 微信生态

| 项目 | 状态 | 用户动作 | 物料 |
|---|---|---|---|
| Coze（扣子）bot 导入发布 | ⬜ 待发 | 导入 `content/coze/*` + 发布到商店/微信 | growth-materials §C |

---

## D. 产品发布（一次性曝光高峰）

| 平台 | 状态 | 用户动作 | 物料 |
|---|---|---|---|
| ProductHunt | ⬜ 待发 | 发布 + 同步 X/微博/即刻 | growth-materials §D1 |
| Hacker News（Show HN） | ⬜ 待发 | 发帖 | growth-materials §D2 |
| 稀土掘金 / 少数派 | ⬜ 待发 | 改标题发 B4 技术文 | growth-materials §D3 |

---

## E. 技术前提（必须先闭合，否则引流来了转化不了）

| 项目 | 状态 | 说明 |
|---|---|---|
| 虎皮椒 `notify_url`/`return_url` → `license.swarmlabs.tools` | ⬜ 待用户配 | 支付回调闭环最后一环 |
| Cloudflare `api.swarmlabs.tools/* → genetech-api-guard` 路由 | ⬜ 待用户建 | ask 推理闭环国内可用前提 |
| `genetech.tools` NS 改（lee/vera → jillian/osmar） | ⬜ 待用户改 | 加 `license/genetech.tools` 路由前置条件 |
| Glama/Smithery 浏览器 GitHub 登录认领 | ⬜ 待用户 | 目录分发 |
| Google Search Console 交 sitemap / IndexNow 真实 key | ⬜ 待用户 | 搜索可见性 |
| **撤回已暴露的 PAT**（`ghp_...` + `github_pat_...`） | ⬜ 待用户 | 安全红线，必须做 |

---

## F. 自动化节奏（持续做推广）

- **每周一（自动化）**：基于最新入库实体生成 1 篇 bio×AI / 前沿集群 GEO 博客 → **默认带 X 算法排名信号结构（钩子问题 / 配图 / 收藏级长文 / 垂直关键词 / 转化 CTA / 避罚，见 `docs/x-algorithm-promo-playbook.md` §5）** → 写入 `content/blog/` → 更新本追踪表 → 推送 GitHub 触发 Pages 重建。
- **每月**：跑一次「引用率探针」（15–20 个真实买家问句，在 ChatGPT/Perplexity/豆包/DeepSeek 测是否被引述），针对缺口补内容。
- **每季度**：刷新企业数据授权商务进展（$20万–500万/年 给 AI 公司，见 growth-strategy §9.1）。

---

## H. X（Twitter）算法借鉴 —— 原理转译，非直连

- **现实约束**：你在中国大陆，X 无法直接直连。因此不依赖"在 X 上发帖"，而是把 X 开源推荐算法揭示的**通用排名原理**（回复>>点赞、早期势能 log2、媒体 boost、社区对齐 SimClusters、作者信誉 Tweepcred、垃圾重罚）转译为所有可达平台的打法。详见 `docs/x-algorithm-promo-playbook.md`。
- **Track A（当下就能做）**：把上述原理用于小红书 / 知乎 / 公众号 / 掘金 / B站 与我们自有 GEO 引擎——末尾抛评论钩子、必带图、投对垂直圈子、养权威号、躲惩罚。已写入每周自动化。
- **Track B（需海外通道）**：若你有合规的海外节点 / 合伙人可触达 X，手册 §4 给了可直接发的英文模板与发布纪律。无通道则跳过。

---

## G. 引用率探针问句库（示例，每月轮换）

1. 最好的中文 AI 科研知识库 / MCP
2. Elicit 的中文替代
3. 2025 AI for Science 有哪些突破
4. AlphaFold 3 之后结构生物学怎么变
5. Prime Editing 2025 最新进展
6. 基因编辑 2.0 是什么
7. 怎么用 MCP 接科研数据
8. 国内能用的科研知识引擎
9. 生成式生物学 最新进展
10. AI 设计的药物 进入临床 有哪些

**目标**：核心词 AI 引述率 ≥ 60%；AI 引荐流量占比逐步 > 自然搜索 1/3。
