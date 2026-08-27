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
- `content/blog/biocomputing-2025-2026.md` — 生物计算：DNA 存储 / CRISPRi 基因电路 / ML×代谢建模（biocomputing 域）· 2026-08-17 本周产出，默认带 X 算法排名信号结构（钩子问题 / 配图占位 / 收藏级长文 / 垂直关键词 / 转化 CTA / 避罚）
- `content/blog/life-science-2025-2026.md` — 生命科学前沿：空间蛋白组虚拟组织 / 单细胞 in-context learning 基础模型 / 合成生物评测体系 / 类器官组织干细胞（life-science 域）· **2026-08-24 本周产出**，默认带 X 算法排名信号结构（钩子问题 / 配图占位 / 收藏级长文 / 垂直关键词 / 转化 CTA / 避罚）
- `content/blog/synbio-manufacturing-2025-2026.md` — **合成生物制造：AI×Biofoundry 把「造分子」做成流水线**（synbio-manufacturing 域，2711 条实体；取材 QbD×AI×Biofoundry 自动化 / 数据稀缺 ML 工艺建模 / 无质粒细胞工厂 / 智能+可持续制造 / 生物安全治理，12 条跨 PubMed·arXiv·Crossref·Europe PMC 可溯源引用）· **2026-08-24 本周追加产出（同周第 2 篇，主题轮换至 synbio-manufacturing，未与已有 6 篇前沿长文重复）**，默认带 X 算法排名信号结构（钩子问题 / 配图占位 / 收藏级长文 / 垂直关键词 / 转化 CTA / 避罚）

这四篇带可溯源引用、答案优先，是喂给 AI 引擎做「XX 领域最新进展」类问句的高价值语料；发布后建议在知乎/公众号各改写一篇。主题已按周轮换：AI4S 范式 → 基因编辑 2.0 → 生物计算 → 生命科学 → 合成生物制造，避免重复。

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

---

## 每周进度（自动化维护）

> 每周日 10:00 由 automation-1786923647158 更新，标记本周 GEO 产出与推送状态。

| 周次 | 日期 | 本周 GEO 产出 | 累计博客 | 推送状态 |
|---|---|---|---|---|
| W1（基线） | 2026-08-23 | `biocomputing-2025-2026.md`（2026-08-17，带 X 算法排名信号结构：钩子/配图/收藏级长文/垂直关键词/CTA/避罚） | 4 篇（1 roundup + 3 前沿权威长文） | ⏳ 待用户手动推送（本环境无 GitHub 凭据，`api-push.mjs` 鉴权失败） |
| W2 | 2026-08-23 | **实施阶段补写 1 篇** ✅ `high-na-euv-2025-2026.md`（High-NA EUV 光刻，补最薄前沿环节，带 X 算法排名信号：钩子/收藏级长文/垂直关键词/CTA）+ 新增独立停摆巡检 workflow | 5 篇（1 roundup + 3 前沿权威长文 + 1 High-NA EUV） | ⏳ 待用户用 PAT 推送（本地已提交；A/B 已定为方案 B：引擎重新入库作公开兜底，无需 ENGINE_TOKEN） |
| W3 | 2026-08-24 | **本周 GEO 产出** ✅ `life-science-2025-2026.md`（生命科学前沿：空间蛋白组虚拟组织 / 单细胞基础模型 / 合成生物评测 / 类器官，带 X 算法排名信号：钩子/配图占位/收藏级长文/垂直关键词/CTA/避罚），主题轮换至 life-science 域，避免与已有 3 篇前沿长文重复 | 6 篇（1 roundup + 4 前沿权威长文 + 1 High-NA EUV） | ⏳ 待用户手动推送（本环境无 GitHub 凭据，`api-push.mjs` 鉴权失败） |
| W4 | 2026-08-24 | **本周追加产出** ✅ `synbio-manufacturing-2025-2026.md`（合成生物制造：AI×Biofoundry 把「造分子」做成流水线；synbio-manufacturing 域 2711 条实体，12 条跨源可溯源引用，带 X 算法排名信号：钩子/配图占位/收藏级长文/垂直关键词/CTA/避罚），主题轮换至 synbio-manufacturing 域，未与已有 6 篇前沿长文重复 | 7 篇（1 roundup + 5 前沿权威长文 + 1 High-NA EUV） | ⏳ 待用户手动推送（本环境无 GitHub 凭据，`api-push.mjs` 鉴权失败） |

### W2 补充说明（2026-08-23）

- **GEO 资产存量**：4 篇长文 + llms.txt / JSON-LD / RSS / IndexNow 全链路仍在线，被引概率未退化。
- **增量为 0 的根因**：数据飞轮停转 17 天（21 站 `lastUpdated` 停在 2026-08-06），上游无新实体 → GEO 选题缺新料。根因与修复见 `docs/strategy-weekly.md` 第 2 期 §6。
- **下期 GEO 选题建议（补最薄前沿环节）**：High-NA EUV（线上仅 8 条实体，最薄）与固态电池（new-energy 240 条，料足），二者均属 2025-2026 真突破，兼具补数据与产 GEO 资产双重收益。
- **渠道现状**：Glama / Smithery MCP 目录认领仍待用户登录（P2）；远端 open issue 仅 `#1 🚀 GEO 自动推广状态`（2026-08-22 更新）。
