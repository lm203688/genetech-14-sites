# 开源平台扫描与借鉴研发路径（GeneTech 14站 / SwarmLabs Agent Infra）

> 扫描日期：2026-09-07｜扫描方向：科学 KG 构建 / 科研 MCP / Deep Research Agent / GEO 工具 / 引文网络可视化
> 约束背景：零 API 成本偏好、本地 Ollama 多智能体（RTX 3090/4090，ornith-1.5:35b）、CF 自定义域绑定剥离 P0 未解、提升期延至 2026-12-31、30/30 站满容（30 万实体）。
> 诚实标注：以下均基于各仓库 README / 检索结果，**未克隆或运行验证**；落地前需本地 PoC（git clone + dry-run）。

---

## 0. 一句话结论

最值得"借鉴研发"的是 **GEO 闭环双引擎（auto-geo + geo-optimizer-skill）** 与 **本地化 Deep Research Agent（tarun7r）**——两者都零 API 成本可用、且直接补我们已有资产的缺口（GEO 博客产出闭环、周日战略周报）。科研 MCP（research-mcp 系）补回填管道的"引用网络补全 + 推送"，科学 KG（BioKG-Builder）补"研究空白/跨域桥接"实体抽取。

---

## 1. 候选评估表（已验证）

### A. 科研 MCP 生态 — 补 `entities.json` 回填管道

| 仓库 | 活跃度/许可 | 互补点 | 借鉴度 |
|---|---|---|---|
| **benjaminfh/research-mcp** | 2025-10 开源，2026-08 仍更新 | 多源聚合 OpenAlex(250M)/Semantic Scholar/ArXiv/Unpaywall/PDF Mirrors；Docling PDF 抽取；JWT；SQLite；worker pool 并行 | 高（多源元数据层） |
| **chessy795/research-mcp**（lean，MIT） | 活跃，MIT | **3 tools，8+ 源去重+语义/关键词排序；引用图多跳游走（OpenAlex 前后向）；推送 digest 到 Telegram/Discord/飞书/WeCom** | **高（飞书推送+引用游走模块可抽）** |
| adamamer20/paper-search-mcp-openai | 开源 | arXiv/PubMed/bioRxiv/Semantic Scholar，Deep Research ready | 中 |
| niol-zh/research-mcp（LobeHub，MIT） | 开源 MIT | Scopus+CrossRef+OpenAlex+Unpaywall，无需机构权限 | 中 |

### B. GEO 闭环 — 补 GEO 博客产出 / `geo-promotion-tracker.md`

| 仓库 | 活跃度/许可 | 互补点 | 借鉴度 |
|---|---|---|---|
| **shadowresearch/auto-geo** | npm v0.8.4（2026-06），MIT | CLI 闭环 init/doctor/write/fix/check/history；**七段式页面架构**（TL;DR/问答 H2/FAQ/JSON-LD）；多引擎真实引用覆盖测量（Perplexity/OpenAI/Anthropic/Gemini/Grok）+ 历史趋势 | **最高（架构+闭环直接套）** |
| **auriti-labs/geo-optimizer-skill** | 463–740★，1720 tests，MIT | **47 研究方法**（Princeton KDD 2024 + AutoGEO ICLR 2026）；0–100 评分 8 类（robots/llms.txt/JSON-LD/meta/内容质量/AI信号/AI发现/品牌一致性）；11 MCP tools；Python 库+CLI+MCP+Astro；核心审计无 key | **最高（最工程化，可当库 pip 装）** |
| AI2HU/gego（Go） | 开源 | 多 LLM 引用追踪看板 | 中（dashboard 参考） |
| mverab/eGEOagents | 开源 | Skills 式 /geo 命令 | 低 |

### C. Deep Research Agent — 补周日战略周报 / `strategy-weekly.md` / Tech Radar

| 仓库 | 活跃度/许可 | 互补点 | 借鉴度 |
|---|---|---|---|
| **tarun7r/deep-research-agent** | MIT，2026-01 更新 | **LangGraph 4 智能体**（Planner/Searcher/Synthesizer/Writer）；**可信度评分 0–100**（.edu/.gov/HTTPS/学术指标）；矛盾按可信度层级解决；**原生 Ollama 支持**（qwen2.5:7b）；7天 TTL 缓存；Circuit Breaker；checkpoint 恢复 | **最高（本地化零成本+可信度链）** |
| sciknoworg/deep-research | 开源 | 多智能体 deep research | 中（备选） |
| Aryan-Sheregar/deep-research-agent | 开源 | LangGraph deep research | 中（备选） |

### D. 科学 KG 构建 — 补 `entities.json` 结构化 / 跨域桥接

| 仓库 | 活跃度/许可 | 互补点 | 借鉴度 |
|---|---|---|---|
| **Zaoqu-Liu/BioKG-Builder** | MIT，2025 | PubMed 检索 + LLM 抽因果实体关系 + Pyvis 可视化 + AI 报告（DeepSeek API） | **高（因果三元组抽取模式）** |
| ndexbio/llm-text-to-knowledge-graph | 开源 | BEL 生物实体抽取 | 中 |
| javisiierra/KnowledgeGraph | 开源 | GROBID+Wikidata+ROR+RDF | 中 |
| mikemott/Text-Graph | 开源 | FastAPI+PostgreSQL+BERTopic+spaCy 主题建模 | 中 |
| YuxingLu613/awesome-biomedical-KG | 综述+工具清单 | 构建方法论参考 | 参考 |

### E. 引文网络/图谱可视化 — 补 `domain-graph.html` / 合著网络

- networkx、graph-tool、**EasyGraph（复旦，Patterns 论文，复杂网络指标）**、Cytoscape/pyvis/sigma.js。
- 我们用 sigma.js 已可行；**EasyGraph 的复杂网络指标可补跨域桥接权重计算**。

---

## 2. 借鉴研发路径（落地建议，按优先级）

### P0 — 直接复用，零/低改动（建议本周落地）

1. **auto-geo 七段式架构 + check 闭环接入 GEO 博客**
   - 把现有 12 篇 GEO 博客按 auto-geo 七段式（TL;DR → 问答 H2 → 相关指南 → 关键要点 → FAQ → 披露）重排。
   - 用 `auto-geo check --engine all`（或仅 Perplexity 免费层）实测 AI 引擎引用覆盖率，写入 `geo-promotion-tracker.md`。
   - 成本：doctor/架构合规 **零 API**；真实引用 check 需 1 个引擎 key（可先用 Perplexity 免费额度）。

2. **geo-optimizer-skill 当库用**
   - `pip install geo-optimizer-skill` → `geo audit --sitemap https://<domain>/sitemap.xml --max-urls 25` 给 14 站做 AI 可读性体检。
   - 输出 8 类 0–100 分 + 优先级修复清单，补我们 GEO 审计缺口。
   - 成本：**核心审计零 key**；sentiment 特征需 OpenAI/Anthropic/Groq key（可选）。

3. **tarun7r deep-research-agent 本地化跑周报证据链**
   - 配置 `MODEL_PROVIDER=ollama MODEL_NAME=ornith-1.5:35b`（本地 35B），借鉴其可信度评分 + 矛盾按可信度层级解决 + 引用回溯，生成周日深度分支（`strategy-weekly.md`）的证据链。
   - 可改造为 Tech Radar 的 "candidate→promote" 证据链生成器。
   - 成本：**零（本地 Ollama）**；长上下文周报可能需 qwen2.5:7b 或量化。

### P1 — 借鉴模式，自研集成

4. **research-mcp 多源聚合接入回填管道**
   - 抽 chessy795 的 **"飞书/WeCom 推送 + 引用图多跳游走"** 模块，给回填工人加"引用网络补全"与"推送通知"（我们有 **Agent Mail 连接器已连通**，可替代飞书）。
   - 补 SSRN/会议缺口（EPMC→OA 已有）；加 OpenAlex 元数据层。
   - 成本：本地源零 API；Semantic Scholar key / Unpaywall email 免费额度够用；**Sci-Hub fallback 涉及版权，我们不用**。

5. **BioKG-Builder 因果抽取补"研究空白/跨域桥接"实体**
   - 抽因果三元组 (h,r,t) 模式，丰富 `entities.json` 的"研究空白/跨域桥接"类型。
   - 成本：需 DeepSeek/本地 LLM（ornith-1.5:35b 可替代）。

### P2 — 方法论参考

6. EasyGraph 复杂网络指标补 `domain-graph.html` 跨域桥接权重；KG 综述补构建流程规范。

---

## 3. 零成本约束下落地排序（ROI 视角）

| 序 | 项目 | 成本 | ROI | 见效速度 |
|---|---|---|---|---|
| 1 | GEO 双引擎（auto-geo + geo-optimizer）接入 | 零 API（check 可选 1 key） | 最高 | 快（已有 12 篇 GEO 资产直接受益） |
| 2 | tarun7r 本地化周报 | 零（本地 Ollama） | 高 | 中 |
| 3 | research-mcp 引用游走 + 推送 | 零 API（本地源） | 中 | 中 |
| 4 | BioKG 因果抽取 | 本地 LLM | 中 | 慢 |

---

## 4. 风险与缺口（诚实标注）

- **auto-geo / geo-optimizer 的"真实引用覆盖 check"需 API key**（Perplexity/OpenAI 等）；doctor/audit 核心免费，但 check 付费 → 若要做到"实测 AI 引擎引用率"，需至少 1 个引擎 key；否则只做架构合规（零 API）。
- **research-mcp 多源需 Semantic Scholar key / Unpaywall email**：免费额度够用；Sci-Hub fallback 版权风险，我们禁用。
- **tarun7r 本地 Ollama 跑 35B 在 RTX 3090/4090 可行**，但 14 站周报长上下文可能需 qwen2.5:7b 或量化 4_K_M。
- **所有均为外部仓库，未克隆/运行验证**；以上基于 README/检索，落地前需本地 PoC（先 git clone 跑 dry-run）。
- **🔴 CF P0（license/api.swarmlabs.tools 绑定剥离）仍是硬阻塞**：GEO 工具产出的页面若走 swarmlabs.tools 自定义域会被 NXDOMAIN，需先解 P0 才能公网验证 check 覆盖率。

---

## 5. 建议下一步（请厉兴拍板）

- **选项 A（推荐）**：先落地 P0 三项（GEO 双引擎 + 本地周报），我直接 clone + PoC，不动主站，产出对比报告与改造补丁。
- **选项 B（最快见效）**：仅 GEO 一项（最高 ROI，直接提升已有 GEO 资产）。
- **选项 C（全量借鉴）**：含回填 + KG 因果抽取，工作量最大。

> 注：本扫描为"单一对接口子"外的独立研究交付；如需纳入 `automation-digest/OPEN_ISSUES.md` 统一跟踪，待 P0 拍板后我再登记。
