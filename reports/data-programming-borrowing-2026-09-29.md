# Scrapling + Snorkel 借鉴方案与实施记录

日期：2026-09-29
对象仓库：`lm203688/genetech-14-sites`（GeneTech 14 站知识引擎，分支 `master`）

---

## 一、结论先行

| 来源 | 判断 | 落地形式 |
|---|---|---|
| **Snorkel 的 Labeling Functions + LabelModel** | ✅ 直接落地 | `operations-plan/lib/labeling-functions.mjs`（15 个 LF + LabelModel），300k 实体全量跑通 |
| **Snorkel 的 validation split 标定法** | ✅ 直接落地 | 用已标注的 63.5% 实体标定 LF 准确率，替代无 ground truth 的盲估 |
| **Snorkel 的 Data-as-a-Service 商业模式** | ⚪ 观察，不跟进 | 本项目护城河是 30 站结构化实体，不在训练数据赛道 |
| **Scrapling 的 Adaptive Parsing** | ✅ 移植思路 | `operations-plan/lib/adaptive-fields.mjs`（候选路径降级 + 漂移指纹） |
| **Scrapling 的 StealthyFetcher / 反爬** | ❌ 明确不引入 | 11 个数据源均为开放学术 JSON API，无反爬需求；伦理与 ToS 均不应碰 |
| **Scrapling 的 Spider 框架 / 浏览器自动化** | ❌ 不引入 | 项目是 Node 栈，跨语言引入 Python 生态成本远大于收益 |
| **Scrapy 的下载中间件链 + AutoThrottle** | ✅ 移植思路 | `operations-plan/lib/http-client.mjs` |
| **Scrapy / Scrapling 本体** | ❌ 不引入 | 同上，Node 栈 + JSON API 场景下 Selector/Stealth 收益≈0 |

**一句话**：借的是**方法论**（规则投票 + 统计加权、字段自适应、统一请求层），不是框架本体。上一轮已论证过 Python 生态不该引入，本轮在同一个判断上补了两个具体实现。

---

## 二、Snorkel 业务梳理（事实锚定）

来源：新浪财经 2026-09-27、TechCrunch 转述的 Series E 公告、Omega Technology / Inside AI 报道。

- 2019 年从 **Stanford AI Lab** 分拆，Alex Ratner 创办。技术曾用于 Google、Intel、Apple、Stanford Medicine。
- 2020 年推出商业产品 **Snorkel Flow**，定位是数据标注自动化软件。
- **2025-05**：D 轮 1 亿美元，估值 13 亿。案例：一家美国大行让贷款专家参与构建 AI 系统，模型准确率 25% → 93%。
- **2025-09**：从"卖软件"转为 **Data-as-a-Service**，直接交付成品训练数据、评测数据、强化学习环境。
- **2026-09**：E 轮 3.5 亿美元，估值 **35 亿**；年化收入从约 2000 万涨到 **3.5 亿美元**（一年内约 17 倍）；预计当年盈利。
- 业务三支柱：Expert-in-the-Loop（数万名领域专家设计任务与评分标准）、Automated Scaling（AI agent 做重复质检）、Synthetic Data Generation（合成交付）。

**技术内核（对本项目真正有价值的部分）**：不雇人逐条标注，而是写**标注函数（LF）**批量投票，再用 **LabelModel** 估计每个 LF 的准确率与 LF 间相关性，合并成置信度加权标签。核心洞察：**LF 会互相冲突和冗余，绝不能简单多数投票，必须统计地加权**。

---

## 三、Scrapling 梳理（事实锚定）

来源：Scrapling 官方对比表、GitHub（D4Vinci/Scrapling，BSD-3-Clause）。

- Python 3.10+，作者 Karim Shoair（D4Vinci）。`pip install scrapling`。
- **Adaptive Scraping**（核心卖点）：不只记 CSS 选择器，还给元素记多维特征指纹（文本内容、属性值、DOM 位置、相邻关系、样式），页面改版后用相似度算法重新定位。官方称元素相似度搜索比 AutoScraper 快 5.2 倍。
- **解析性能**：文本抽取 2.02ms，与 Parsel/Scrapy（2.04ms）持平，比 BeautifulSoup（1584ms）快约 784 倍。
- **三层 Fetcher**：Fetcher（HTTP + TLS 指纹伪装）、StealthyFetcher（Cloudflare Turnstile 绕过）、DynamicFetcher（Playwright Chromium）。
- **Spider 框架**：并发、断点续爬、多会话、代理轮换、DNS-over-HTTPS、内置约 3500 域广告拦截。
- **MCP server**：`pip install "scrapling[ai]"`，喂 LLM 前先抽取正文以减少 token。

**对本项目的真实相关性**：只有 Adaptive Parsing 一条成立。本项目 11 个数据源全是开放学术 JSON API，**没有反爬、没有 HTML 结构**，所以 StealthyFetcher、Spider、代理轮换、广告拦截全部不适用。

---

## 四、本项目实施

新增 4 个文件，零外部依赖，全部零副作用（不写 `entities.json`）：

| 文件 | 行数 | 作用 |
|---|---|---|
| `operations-plan/lib/labeling-functions.mjs` | ~640 | 15 个 LF + 标定 + 相关度估计 + LabelModel |
| `operations-plan/lib/adaptive-fields.mjs` | ~230 | 候选路径降级 + JATS/倒排摘要还原 + 漂移指纹 |
| `operations-plan/lib/http-client.mjs` | ~250 | 统一 UA / 重试 / 429 感知 / 自动节流 / 并发批处理 / 熔断 |
| `operations-plan/pipeline-label-program.js` | ~290 | 主流水线，默认 dry-run，`--write` 显式写回 |

**为什么 http-client 是 CommonJS 生态里的 ESM**：pipeline 用 `await import()` 加载，所以 `.mjs` 可被 `.js` pipeline 复用，而纯 `.js` CJS 无法被 `.mjs` 静态 `import`。

**为什么默认不写回**：CF Pages 存储已用 ~99.1%（1014MB 上限）。再灌任何数据即超限、整站下线。写回必须先做容量核算。

---

## 五、实测数据（30 站全量，非抽样）

命令：`node operations-plan/pipeline-label-program.js --threshold=0.3`
耗时 89.6 秒，报告 58 KB。

### 5.1 语料画像

| 指标 | 实测值 |
|---|---|
| 实体总数 | 300,000 |
| 已有标签 | 190,443（63.5%） |
| 无标签 | **109,557（36.5%）** ← LF 的靶点 |
| 摘要字段解析率 | 67.7%（32.3% 缺失） |
| 去重标签先验 | 8,418 |

站点标签率差异极大：**neuromorphic 25.9%**（最差）→ **ai-safety 88.5%**（最好）。

### 5.2 标注结果

| 指标 | 值 |
|---|---|
| 填充 | 283,905 |
| 弃权 | 16,095（5.4%） |
| 产出标签数 | 489,114 |
| 平均置信度 | 0.5214 |
| **不同标签数** | **11** ← 关键局限，见第六节 |

### 5.3 LF 权重（标定 + 相关度后的真实排序）

```
lf_misroute_detector      acc=0.500  nov=0.967  wt=0.363   ← 最高权重
lf_source_prior           acc=0.203  nov=0.477  wt=0.224
lf_title_keywords         acc=0.303  nov=0.183  wt=0.191
lf_abstract_keywords      acc=0.248  nov=0.161  wt=0.190
lf_doi_prefix             acc=0.240  nov=0.871  wt=0.183
lf_site_title_agreement   acc=0.249  nov=0.233  wt=0.175
lf_site_domain            acc=0.139  nov=0.063  wt=0.094   ← 被判最冗余
lf_era_marker             acc=0.000  nov=0.063  wt=0.034
```

两条有价值的自动发现：
1. `lf_site_domain` 被正确识别为**最冗余**（novelty 0.063），因为它与 `lf_site_title_agreement` 覆盖高度重叠。权重因此被压低到 0.094，不再是无脑最高权重。
2. `lf_era_marker`、`lf_language`、`lf_interdisciplinary` 的准确率是 **0**——它们产出的标签（`emerging-2024+`、`中文文献`、`interdisciplinary`）根本不在语料的 8,418 个标签词表里，**永远无法校验**。这不是 LF 坏，是词表不匹配，必须区别对待。

### 5.4 错路由检测（本次最高价值产出）

**90,179 条（30.1%）**被站点标签与摘要正交证据冲突检出。

| 排名 | 站点 | 检出数 | | 排名 | 被否决标签 | 次数 |
|---|---|---|---|---|---|---|
| 1 | genetech-tools | 9,176 | | 1 | materials science | 15,721 |
| 2 | ai-safety | 6,233 | | 2 | environmental science | 14,813 |
| 3 | digital-twin | 5,118 | | 3 | computer science | 13,391 |
| 4 | low-altitude | 4,909 | | 4 | psychology | 11,753 |
| 5 | biocomputing | 4,770 | | 5 | artificial intelligence | 9,759 |

**抽样人工验证是真阳性**。被否决 `medicine` 的样本：
- "Artificial Intelligence in Midwifery: A Scoping Review"（AI in 助产）
- "AI and machine learning adoption in the **financial sector**"（金融）
- "AI Tools on Chinese **EFL Learners'** Self-Regulation"（英语教学）
- "AI and ML for optimized **crop management**"（农业）

这些都是真的不在 `biomed-ai` 站点该在的领域。附带发现：**现有标签本身也有跨域噪声**——助产 AI 论文被标 `Inclusion (mineral)`，EFL 教育论文被标 `Resilience (materials science)`。疑似上游概念 ID 消歧不彻底。

---

## 六、实施中发现并修复的四个真问题

不是"跑通了"就完事，以下四个都是**跑出来才暴露**的。

### 6.1 置信度公式退化为恒等于 1.0（严重）

第一版公式 `conf = (posW - negW) / totalW`。当没有负票时恒等于 1.0——**单票 +1 就必然 1.0，置信度完全没有区分度**。

换成贝叶斯后验：
```
base        = 标签语料基率（未标定时中性 0.60）
likelihoodR = K^(posW - negW)，K = 1 + 5*accuracy
conf        = base·likelihoodR / (base·likelihoodR + (1-base))
```
`K` 随 LF 准确率单调：acc=1 → K=6（每单位权重证据力 6 倍）；acc=0 → K=1（证据力归零）。修后置信度分布 0.48–0.78，有真实区分度。

### 6.2 novelty 维度完全失效

`novelty = 1 - max(corr)`，实测**所有 15 个 LF 的 novelty 都是 0**，靠 `Math.max(nov, 0.05)` 的地板值兜住——整个维度形同虚设。

根因：只算"一致率"，把**依赖**当成**冗余**。`lf_site_title_agreement` 是 `lf_title_keywords` 的派生，在共同投票的标签上必然 100% 一致，但它们覆盖的实体集合很不同。

改为 `冗余度 = 一致率 × 重叠率`。修后 novelty 从 0.063 到 1.0，有真实区分度，`lf_site_domain` 被正确降权。

### 6.3 错路由检测是假阳性工厂（严重）

旧规则：**站点标签在摘要里找不到支持 → 投负票**。但"缺证据 ≠ 反对证据"，而关键词词表只覆盖 10 个标签，大量正常论文因此被判错路由。实测初版 **27.7%** 误判率。

抽样发现真凶：KW_MAP 里**根本没有 "artificial intelligence" 这个模式**，AI 相关只有 machine learning / deep learning / agent。于是标题写着 "Artificial Intelligence Literacy" 的论文完全拿不到 AI 标签，被投出 1,137 张假负票。另有 `" transformer"` 前缀游离空格 bug，导致词首/连字符前的 Transformer 全部漏匹配。

修两条：
- 补 `artificial intelligence` / `\bai\b` / `intelligent (agent|system|techn)` 模式，修 `transformer` 空格
- 错路由改为要求**正交学科簇的竞争性正向证据**：摘要需 ≥2 个正向标签，且全部落在与站点不同的学科簇，且站点所属簇零支持

`artificial intelligence` 假负票 1,137 → 367。抽样复查其余部分确认为真阳性。

### 6.4 Windows 路径两处崩溃

- `await import(绝对路径)` 报 `ERR_UNSUPPORTED_ESM_URL_SCHEME` → 必须 `pathToFileURL()`
- ESM 自检测守卫用 `import.meta.url === 'file://' + process.argv[1]` 在**非 ASCII 路径**（`知识引擎14站`）下永不匹配 → 统一为 `path.resolve(argv[1]) === path.resolve(fileURLToPath(import.meta.url))`

顺带发现：`tools/circuit-breaker.mjs` 与 `tools/data-quality.mjs` 用的是旧式守卫，在这台机器上它们的冒烟测试**永不触发**。不影响被 import 时安全，但直接 `node tools/circuit-breaker.mjs` 跑不出来。建议单独修。

---

## 七、一个被推翻的假设（负结果，必须记）

**假设**：32.6% 摘要缺失中，相当一部分是"字段名不统一"造成的假缺失（OpenAlex 用 `abstract_inverted_index`、EuropePMC 用 `resultAbstract`、Crossref 用 JATS 包裹）。自适应字段解析应该能救回来。

**实测**：300k 实体的摘要字段，`abstract` 首选路径命中 **67.7%**，**降级率 0.0%**。32.3% 的缺失是**真缺失**，不是 schema 漂移。

**结论**：`adaptive-fields.mjs` 在这份语料上**没有帮到任何摘要恢复**——整份语料 schema 高度一致，不需要降级。这个模块的价值在未来接入新数据源时（不同 schema 的源并存）才体现，对当前 30 站无收益。

摘要缺口的正确解法是**从源 API 回填**，不是字段解析。

---

## 八、局限（不掩盖）

1. **词表太窄是硬伤**。产出仅 11 个标签，而语料有 8,418 个。`emerging-2024+` 覆盖 68%、`computer science` 覆盖 61%，本质是 era/粗领域标签通吃；`biology`、`quantum computing`、`materials science` 等具体领域标签大多过不了阈值。**LF 框架是对的，词表是当前瓶颈。**
2. **准确率普遍偏低**（0.14–0.30，除无法校验的 LF）。部分原因是词表窄——窄词表的 LF 在宽语料上必然低命中率。这不等于 LF 错，等于**当前词表不足以评判 LF**。
3. **30.1% 错路由率偏高**，虽已抽样验证为真阳性，但需要人工复核清单才能动作。报告里只留了 50 条样本，全量清单需另外产出。
4. **未写回任何实体**。90,179 条错路由与 489,114 个标签提案都还在报告里，没有进 `entities.json`。这是刻意的——Pages 容量 99.1%，未做容量核算前不碰生产数据。

---

## 九、下一步（按杠杆排序）

| # | 事项 | 说明 |
|---|---|---|
| 1 | **扩 LF 词表到 Top-100 语料标签** | 当前 11 个产出标签是硬瓶颈。词表扩上去后，第 6.3 节的准确率判断才有意义 |
| 2 | **人工复核清单** | 从 90,179 条错路由里按置信度排序导出前 500 条，人工过一遍验证精确率，再决定批量重路由 |
| 3 | **摘要回填走源 API** | 第七节的负结果已经明确：字段解析救不了，只能从 OpenAlex/PubMed 回填 |
| 4 | **pipeline 收口** | `withRetry` 6 份 / `httpGet` 9 份 / UA 3 种并存 → 迁到 `lib/http-client.mjs`，UA 单点收敛 |
| 5 | **修 tools 旧式守卫** | `tools/circuit-breaker.mjs`、`tools/data-quality.mjs` 的冒烟测试在本机永不触发 |
| 6 | **容量核算后才能 --write** | Pages 99.1%，写回前必须先算增量，否则整站下线 |

---

## 附：可复现命令

```bash
# 全量（89.6s）
node operations-plan/pipeline-label-program.js --threshold=0.3

# 限定站点 + 更保守阈值
node operations-plan/pipeline-label-program.js --sites=biomed-ai,quantum-computing --threshold=0.35

# 三个 lib 的自检
node operations-plan/lib/labeling-functions.mjs
node operations-plan/lib/adaptive-fields.mjs
node operations-plan/lib/http-client.mjs
```

回归验证方式：把某个 LF 替换为恒投错标签的函数，观察其权重是否被标定压下去。实测注入后权重从 0.158 降到 0.032（降 5 倍），独立 LF 支持的标签置信度仍稳定在 0.743，而假标签仅到 0.6——**标定真的在起作用，不是装饰**。
