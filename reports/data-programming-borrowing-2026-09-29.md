# Scrapling + Snorkel 借鉴方案与实施记录

日期：2026-09-29
对象仓库：`lm203688/genetech-14-sites`（GeneTech 14 站知识引擎，分支 `master`）

---

## 一、结论先行

| 来源 | 判断 | 落地形式 |
|---|---|---|
| **Snorkel 的 Labeling Functions + LabelModel** | ✅ 直接落地 | `operations-plan/lib/labeling-functions.mjs`（16 个 LF + LabelModel），300k 实体全量跑通 |
| **Snorkel 的 validation split 标定法** | ✅ 直接落地 | 用已标注的 63.5% 实体标定 LF 准确率，替代无 ground truth 的盲估 |
| **Snorkel 的可靠性估计（往上一层）** | ✅ 落地并见效 | 逐标签标定 phrase→概念 的可靠性，词表 LF 准确率 0.061 → 0.375，见第十节 |
| **Snorkel 的 Data-as-a-Service 商业模式** | ⚪ 观察，不跟进 | 本项目护城河是 30 站结构化实体，不在训练数据赛道 |
| **Scrapling 的 Adaptive Parsing** | ✅ 移植思路 | `operations-plan/lib/adaptive-fields.mjs`（候选路径降级 + 漂移指纹） |
| **Scrapling 的 StealthyFetcher / 反爬** | ❌ 明确不引入 | 11 个数据源均为开放学术 JSON API，无反爬需求；伦理与 ToS 均不应碰 |
| **Scrapling 的 Spider 框架 / 浏览器自动化** | ❌ 不引入 | 项目是 Node 栈，跨语言引入 Python 生态成本远大于收益 |
| **Scrapy 的下载中间件链 + AutoThrottle** | ✅ 移植思路 | `operations-plan/lib/http-client.mjs` |
| **Scrapy / Scrapling 本体** | ❌ 不引入 | 同上，Node 栈 + JSON API 场景下 Selector/Stealth 收益≈0 |

**一句话**：借的是**方法论**（规则投票 + 统计加权、字段自适应、统一请求层），不是框架本体。上一轮已论证过 Python 生态不该引入，本轮在同一个判断上补了两个具体实现。

**当日追加（第十节）**：词表 LF 准确率 0.061 → **0.375**，全量跑 204.6s → **89.0s**。关键发现是"短语在标题里出现 ≠ OpenAlex 指派了该概念"，这层可靠性差异**可测且跨样本稳定**，因而可标定。

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
| `operations-plan/lib/labeling-functions.mjs` | 871 | 16 个 LF + 标定 + 相关度估计 + LabelModel |
| `operations-plan/lib/vocab.json` | 411.8 KB | 受控词表 2,200 标签 + 逐标签可靠性标定（LF-16 的数据源） |
| `operations-plan/build-vocab.js` | 232 | 词表生成：df 筛选 + guarded 短语规则 + 可靠性标定 |
| `operations-plan/experiment-vocab-scope.js` | 157 | 定向实验：匹配作用域对 precision 的影响 |
| `operations-plan/experiment-vocab-exact.js` | 244 | 定向实验：短语构造与逐标签可靠性（含留一评估） |
| `operations-plan/lib/adaptive-fields.mjs` | 282 | 候选路径降级 + JATS/倒排摘要还原 + 漂移指纹 |
| `operations-plan/lib/http-client.mjs` | 331 | 统一 UA / 重试 / 429 感知 / 自动节流 / 并发批处理 / 熔断 |
| `operations-plan/pipeline-label-program.js` | 264 | 主流水线，默认 dry-run，`--write` 显式写回 |

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

> ⚠️ 第 1、2 条已被**第十节**推翻并重写。当时的判断"LF 框架是对的，词表是当前瓶颈"方向对了但**定位错了**——瓶颈不在词表宽度，在单个标签的可靠性差异。以下为当时原文，保留以记录推理路径。

1. ~~**词表太窄是硬伤**~~ → 见第十节，真因是标签可靠性不可标定。
2. ~~**准确率普遍偏低**~~ → 同上，词表宽度不是原因。
3. **30.1% 错路由率偏高**，虽已抽样验证为真阳性，但需要人工复核清单才能动作。报告里只留了 50 条样本，全量清单需另外产出。
4. **未写回任何实体**。90,179 条错路由与 489,114 个标签提案都还在报告里，没有进 `entities.json`。这是刻意的——Pages 容量 99.1%，未做容量核算前不碰生产数据。

---

## 九、下一步（按杠杆排序）

> **更新（2026-09-29 晚）**：第 1、2、4、5、6 项已处理，第 10 节有对应小节。原表保留以便对照。

| # | 事项 | 状态 |
|---|---|---|
| 1 | 扩 LF 词表到 Top-100 语料标签 | ✅ 完成（第十节）：不是扩宽而是**标定**，precision 0.061→0.375 |
| 2 | 人工复核清单 | ✅ 完成（10.7）：`misroute-review-top500.md`，候选池 93,267 条 |
| 3 | 摘要回填走源 API | ⏳ 未做：需要 OpenAlex/PubMed 配额，属运营任务，与本轮无耦合 |
| 4 | pipeline 收口 | 🟡 部分（10.9）：UA 单点化已做；函数收口因返回结构不一致**有意不做** |
| 5 | 修 tools 旧式守卫 | ✅ 完成：`circuit-breaker.mjs`、`data-quality.mjs`、`audit-logger.mjs` 冒烟测试均实际触发 |
| 6 | 容量核算后才能 --write | ✅ 完成（10.8）：实测增量仅 +8.09 MB，当前 64.1%，**可以写** |

原始排序（历史记录）：

| # | 事项 | 说明 |
|---|---|---|
| 1 | ~~扩 LF 词表到 Top-100 语料标签~~ | 当前 11 个产出标签是硬瓶颈。词表扩上去后，第 6.3 节的准确率判断才有意义 |
| 2 | ~~人工复核清单~~ | 从 90,179 条错路由里按置信度排序导出前 500 条，人工过一遍验证精确率，再决定批量重路由 |
| 3 | **摘要回填走源 API** | 第七节的负结果已经明确：字段解析救不了，只能从 OpenAlex/PubMed 回填 |
| 4 | ~~pipeline 收口~~ | `withRetry` 6 份 / `httpGet` 9 份 / UA 3 种并存 → 迁到 `lib/http-client.mjs`，UA 单点收敛 |
| 5 | ~~修 tools 旧式守卫~~ | `tools/circuit-breaker.mjs`、`tools/data-quality.mjs` 的冒烟测试在本机永不触发 |
| 6 | ~~容量核算后才能 --write~~ | Pages 99.1%，写回前必须先算增量，否则整站下线 |


---

## 十、词表瓶颈的三轮定位与修复（同日追加）

第七、八节把瓶颈归因于"词表太窄"。这个方向对了一半——**但定位错了**。用两个定向实验把它钉死后，词表 LF 的标定准确率从 0.061 提到 0.375（6.1 倍），全量跑时间从 204.6s 降到 89.0s。

### 10.0 先修一个让第一批实验作废的 bug

`experiment-vocab-scope.js` 里写着 `if (gold.has(tag)) continue;`——把真实标签整体剔出候选预测空间，而 TP 又按「预测 ∩ gold」算。两者自相矛盾，5 组配置的 TP **结构性恒为 0**、precision 全 0.0000。

那一批发出来的表格里只有**覆盖率与耗时两列是真的**（与预测无关），已被本节复算取代。教训：**指标脚本里的过滤条件必须和判定条件分开审查**——"只看预测"这个直觉在算 precision 时是自杀。

### 10.1 第一轮：作用域（`experiment-vocab-scope.js`，30,000 条已标注实体）

| 配置 | pred | TP | precision | recall | 覆盖率 | 耗时 |
|---|---|---|---|---|---|---|
| A 线上（多词=标题+摘要 / 单词=标题） | 185,370 | 11,082 | 0.0598 | 0.0881 | 92.6% | 151.8s |
| **B 全部仅标题** | **69,575** | 5,729 | **0.0823** | 0.0455 | 77.5% | **20.3s** |
| C 全部仅标题前 80 字 | 52,576 | 4,329 | 0.0823 | 0.0344 | 68.9% | 19.2s |
| D 标题+摘要前 300 字 | 168,335 | 10,650 | 0.0633 | 0.0847 | 95.3% | 68.8s |
| E 全部标题+摘要 | 365,770 | 16,574 | 0.0453 | 0.1318 | 98.8% | 191.3s |

结论明确：**只匹配标题**。precision +38%，预测量 −63%，耗时 151.8s → 20.3s（7.5 倍）。C 与 B precision **完全相同**（0.0823），说明标题前 80 字之后没有边际信息。

但 0.0823 仍然很低。同一次实验的逐标签表暴露了下一个问题。

### 10.2 第二轮：短语扩展自污染（`experiment-vocab-exact.js`）

`build-vocab.js` 的 `phrasesOf()` 会给每个标签追加「最长 3 词子串」。于是：

| 标签 | A 配置预测 | TP | precision |
|---|---|---|---|
| `artificial intelligence`（规范形） | 6,467 | 2,354 | **0.364** |
| `artificial intelligence and image processing` | 6,610 | 0 | 0.000 |
| `artificial intelligence and robotics` | 6,548 | 4 | 0.0006 |
| `generative artificial intelligence` | 6,468 | 0 | 0.000 |
| `artificial intelligence (cs.ai)` | 6,467 | 3 | 0.0005 |
| `applications of artificial intelligence` | 6,467 | 17 | 0.0026 |
| `edge artificial intelligence` | 6,467 | 1 | 0.0002 |
| `frugal artificial intelligence` | 6,467 | 0 | 0.000 |

这 8 个变体**预测次数几乎完全相同**（6,467–6,610）却只有规范形有 TP。不是语料特性，是 `artificial intelligence and image processing` 展开出的子短语 `artificial intelligence` **本身就是一个词表标签**——子短语命中却把功劳记给更长的标签，等于偷走短标签的证据。

修法规则（guarded）：**子短语若本身也是词表标签，则剔除**。同时先做掉一个必须先排除的干扰——那 30k 样本是按站点字母序顺序取的，某些标签在样本内 gold 可能为 0，TP=0 就无信息量。所以逐标签都报 gold，只把 gold ≥ 20 的列为可评判对象（样本内 359 个）。

30k 样本（含 22,500 标定 / 7,500 留一）：

| 短语集（均仅标题） | pred | TP | precision | recall |
|---|---|---|---|---|
| variants（线上，含子串扩展） | 63,513 | 5,560 | 0.0875 | 0.0443 |
| exact（仅标签串本身） | 43,815 | 5,262 | **0.1201** | 0.0419 |
| guarded（子串扩展但剔除自指子短语） | 46,494 | 5,530 | 0.1189 | 0.0441 |

**但这一轮说明问题主要不在这儿**：24 个高频标签里 20 个三种模式结果完全相同，子短语盗用只污染了 **3 个标签、2,340 次预测、2 次命中**。

### 10.3 第三轮：真因是标签可靠性不可标定（主菜）

同一张表里，precision 差异是结构性的：

| 高可靠标签 | 标定 precision | 低可靠标签 | 标定 precision |
|---|---|---|---|
| `cancer` | 0.547 | `precision agriculture` | 0.014 |
| `agriculture` | 0.481 | `smart farming` | 0.009 |
| `reinforcement learning` | 0.450 | `control` | 0.051 |
| `robotics` | 0.448 | `generative ai` | 0.004 |
| `workflow` | 0.419 | `architecture` | 0.070 |

**根因不是文本匹配失败，而是「短语在标题里出现 ≠ OpenAlex 指派了该概念」。** `precision agriculture` 在标题里出现 943 次，只有 13 篇真的被指派了这个概念——OpenAlex 用自己的 NLP 做归属判定，正文提两个词不等于被指派复合概念。

这是可修的，因为**该差异可测且跨样本稳定**。用 22,500 标定 / 7,500 留一验证：

| 标签 | 标定 precision | 留一 precision |
|---|---|---|
| `agriculture` | 0.481 | 0.375 |
| `cancer` | 0.547 | 0.489 |
| `robotics` | 0.448 | 0.421 |
| `systematic review` | 0.259 | 0.349 |
| `workflow` | 0.419 | 0.316 |
| `precision agriculture`（被筛掉） | 0.014 | 0.000 |
| `smart farming`（被筛掉） | 0.009 | 0.000 |
| `machine learning`（被筛掉） | 0.187 | 0.107 |

保留的都在，剔除的继续坏——**不是过拟合**。

### 10.4 落地与全量结果

改动两处：
- `operations-plan/build-vocab.js`（232 行）：加 guarded 短语规则 + 逐标签可靠性标定，只保留 `support ≥ 50 且 precision ≥ 0.2` 的标签，其余清空 `phrases`（LF 侧天然安全）但保留 `reliability` 供审计
- `operations-plan/lib/labeling-functions.mjs`（871 行）：LF-16 改为纯标题域，`buildVocabIndex()` 加硬守卫（`keep === false` 或 `phrases` 为空的标签绝不进索引）

全量 190,443 条已标注实体标定：

| | pred | TP | precision |
|---|---|---|---|
| 全词表 2,200 标签 | 319,898 | 53,244 | 0.1664 |
| **筛选后 245 标签** | 92,043 | 37,691 | **0.4095** |

precision **2.46 倍**，预测量 −71%，TP 保留 71%。

全量 pipeline 重跑（`--threshold=0.35`）：

| 指标 | 修前 | 修后 |
|---|---|---|
| `lf_corpus_vocab` 标定准确率 | 0.061 | **0.375**（6.1 倍） |
| `lf_corpus_vocab` 权重 | 全场垫底 | **0.291，全场第 2** |
| distinctTags | 11 | **91** |
| 平均置信度 | 0.5214 | 0.5281 |
| 全量耗时 | 204.6s | **89.0s**（2.3 倍） |
| 填充 / 弃权 | — | 283,763 / 16,237 |
| 产出标签 | — | 495,273 |
| 错路由 | — | 88,889 |

distinctTags 从上一轮未筛选时的 698 降到 91，**这是刻意的不是回退**——那 698 里有大量低置信度噪声被阈值滤掉了，distinctTags 从来不是成功指标，precision 才是。

### 10.5 方法论收获（比数字更重要）

**Snorkel 的可靠性估计可以往上一层用。** 标准用法是估计 LF 的准确率并加权合并；这里把同一套思路用在 LF **自己的特征**上——一个词表 LF 的准确率上限被它每个标签的可靠性约束，必须先标定特征再谈 LF 加权。逐标签 precision 是稳定的、可标定的、跨样本可迁移的，所以它是一个可以直接算出来的量，不需要人工判断。

这也是一次**负向归因的完整链路**：先怀疑作用域（成立但非主因）→ 再怀疑短语构造（成立但只占 3 个标签）→ 最后定位到标签可靠性（主因）。前两轮各自都把 precision 从 0.06 提到 0.09 左右，看起来"改进了"，但都不是真因。

### 10.6 新发现：`vocab.json` 从未进远端

查远端树时发现 `operations-plan/lib/vocab.json` 一直是 MISS——上一轮推送漏了它。远端 LF-16 的 `buildVocabIndex()` 因文件不存在**静默返回 null、整个 LF 空跑**，没有报错、没有日志。`labeling-functions.mjs` 里那行 `if (!idx) return votes([]);` 是防御性正确的，但代价是**一个 LF 可以在生产上彻底失效而不留痕迹**。

本轮一并推送。教训：**"优雅降级"在离线脚本里是优点，在生产上是静默故障**。这类 LF 至少应该在报告里报一句 `vocabIndex: null`，否则只能靠人肉核对远端树发现。

### 10.7 错路由清单：第一版排序键是错的

上节说的 88,889 条错路由需要人工复核才能动作，所以这轮产出了清单（`reports/misroute-review-top500.md` / `.json`）。第一版排序键写成了「正交簇越多越可疑」，跑完 top500 **全部是跨 3 个以上学科簇的实体**——这本身就暴露了问题：摘要横跨 3 个以上簇的实体，恰好是**跨学科论文**，是最典型的误报，不是错路由。真正的错路由信号是**证据集中在一个特定的正交簇**（站点是量子计算、摘要从头到尾讲临床），而不是证据分散。

修正后的排序键：

```
concentration = 主簇证据标签数 / 全部正交证据标签数
purity        = 1 / 正交簇数
strength      = round(主簇标签数 × concentration × purity × 100 + topConfidence × 10)
```

候选池 93,267 条的三类分布，这是估算误报率的基础：

| 类型 | 条数 | 占比 | 含义 |
|---|---|---|---|
| `cross-domain` | 40,160 | 43.1% | 只有 1 个正交簇，最可能是真错路由 |
| `mixed` | 37,298 | 40.0% | 2 个正交簇 |
| `cross-cutting` | 15,809 | 17.0% | ≥3 个正交簇，最可能是跨学科论文 |

修正后 top500 全部落在 `cross-domain`（证据主簇 cs 418 条 / med 82 条），被否决最多的站点标签是 `psychology` 128 条、`biology` 108 条。清单每条带主簇、集中度、正交标签明细、labelModel top-3 提案、来源与 DOI 链接，可直接拿去抽查。

**一个口径差异值得记**：`pipeline-label-program.js` 报的 88,889 是**偏低估计**。它的循环里 `if (r.abstained) { abstained++; continue; }` 在错路由检测**之前**，弃权实体根本不进检测。本次清单覆盖全部 141,459 条有摘要实体，得 93,267。弃权实体的标签置信度本就不足，其站点路由恰恰更值得复核——所以本清单的口径更合理，不是口径变松了。

### 10.8 `--write` 容量核算：可以写，前提是记忆里的"99.1%"已经过时

`--write` 一直被 `Pages 容量 99.1%，不能写` 挡住。写回会往每个无标签实体注入 `tags` / `tagConfidence` / `tagSource` 三个字段，所以先做了一次纯内存的增量测算（`operations-plan/estimate-write-capacity.js`，不落盘、不动 entities.json）：

| 项 | 值 |
|---|---|
| 当前 `_site` | 649.96 MB（**64.1%** / 1014.7 MB 上限） |
| 写回后预估 | 658.05 MB（**64.9%**） |
| 增量 | **+8.09 MB**（占 entities 部分的 +1.72%） |
| 距硬上限余量 | 356.65 MB |
| 距 90% 安全水位余量 | 255.15 MB |
| 判定 | **OK，可以写** |

填充 103,829 个实体、弃权 5,728 个、无提案 0。单站最大增幅 sat-6g +0.52 MB（+4.12%）、neuromorphic +0.50 MB（+4.65%，增幅比最高）。

三条必须记住的前提：
1. 只补 `tagsOf(e).length === 0` 的实体，已有标签的实体一个字节都不动——所以增量只有 8 MB，不是"把 30 万条都加了标签"。
2. 增量按 build-site 的 minified 输出计量（源文件 entities.json 是缩进格式，不能拿源文件大小外推）。
3. `facets.json` 的 tags 分面会因新标签微增，未计入 8 MB——量级远小于 255 MB 安全余量，但写回后应当复测一次实际构建体积。

结论：**记忆里的「99.1% 满、绝不 --write」是瘦身前的旧结论，已经失效**。现在可以放心写回。

### 10.9 HTTP 层收口：只做了一半，另一半是有意不做

**已做：UA 单点化。** 此前 operations-plan 下 4 种 UA 并存（`GeneTechBot/1.0`、`GeneTechBot/2.0 (mailto:ops@genetech.example)`、`GeneTechBot/2.0 (mailto:ops@swarmlabs.tools)`、`genetech-geo-bot`），散在 7 个 pipeline 里。这不只是代码不整洁，有实际危害：上游的限流是按 UA 分桶的，同一个 OpenAlex / Crossref / GitHub 被用四个身份访问，等于**把自己的配额自己切成四份，每份更容易触顶**。

新增 `operations-plan/lib/user-agent.cjs` 作为单一真源（做成 `.cjs` 是因为 pipeline-*.js 是 CJS、lib/*.mjs 是 ESM，两种模块系统都要读同一个 named export），7 个 pipeline 全部接入，`lib/http-client.mjs` 改为从它 re-export。换 UA 以后只改一处。

**有意不做：withRetry / httpGet 全量迁移。** 报告第九节 #4 写的是「6 份 withRetry + 9 份 httpGet 迁到 lib」。实际动手前先盘了返回结构，发现**不能直接迁**：

| 文件 | 本地 httpGet 返回 |
|---|---|
| 6 个 pipeline | `{statusCode, headers, body}` |
| `pipeline-pro-db-sync.js` | `{status, body}` ← 字段名不同 |
| `pipeline-rollout-verify.js` | 直接返回 `res.statusCode` ← 裸数字 |
| `lib/http-client.mjs` | `{statusCode, headers, body, ms}` |

全量迁移会**静默破坏** pro-db-sync 和 rollout-verify 的调用点，而这两个是每日运营脚本、没有测试覆盖，改坏只能等运营跑挂了才发现。风险收益比不佳。

折中做法：在 `lib/http-client.mjs` 加了 `withRetryValue(fn, maxRetries, baseDelayMs)` 桥接，签名与 6 份本地 withRetry 完全一致（位置参数、返回裸值而非 `{value, attempts}`）。以后要迁某个 pipeline，只需删本地定义、把 import 指过来，**调用点零改动**。等真需要一个统一行为的地方（比如新的采集源）再迁，而不是为了整洁去动生产脚本。

验证：7 个改动文件 `node --check` 全过；`lib/http-client.mjs` 自检正常；`pipeline-intelligence.js --dry-run` 端到端跑通、退出码 0。

---

## 附：可复现命令

```bash
# 重建受控词表（含可靠性标定，11.3s）
node operations-plan/build-vocab.js --min-df=20 --max-tags=2200 --min-support=50 --pr-th=0.2

# 全量（89.0s，2026-09-29 第十节修正后）
node operations-plan/pipeline-label-program.js --threshold=0.35

# 限定站点 + 更保守阈值
node operations-plan/pipeline-label-program.js --sites=biomed-ai,quantum-computing --threshold=0.35

# 两个定向实验（第十节）
node operations-plan/experiment-vocab-scope.js    # 作用域对照，30k 实体 338s
node operations-plan/experiment-vocab-exact.js    # 短语构造 + 留一评估，30k 实体 1s

# 错路由人工复核清单（10.7，71s，产出前 500 条 + 候选池三类分布）
node operations-plan/export-misroute-review.js --limit=500 --threshold=0.35

# --write 容量核算（10.8，30s，纯内存不落盘）
node operations-plan/estimate-write-capacity.js --threshold=0.35

# 三个 lib 的自检
node operations-plan/lib/labeling-functions.mjs
node operations-plan/lib/adaptive-fields.mjs
node operations-plan/lib/http-client.mjs

# 远端核查（推送漏件排查）
node .workbuddy/probe/check-remote-head.mjs "operations-plan/lib/vocab.json"
node .workbuddy/probe/show-lf-report.mjs
```

回归验证方式：把某个 LF 替换为恒投错标签的函数，观察其权重是否被标定压下去。实测注入后权重从 0.158 降到 0.032（降 5 倍），独立 LF 支持的标签置信度仍稳定在 0.743，而假标签仅到 0.6——**标定真的在起作用，不是装饰**。
