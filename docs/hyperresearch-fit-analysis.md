# HyperResearch 研究智能体 · 对本项目适配性评估

> 评估日期：2026-09-15 · 来源：`jordan-gibbs/hyperresearch`（MIT），实测/官方描述交叉核验
> 结论：**方法论可借鉴，工具本身不可直接采用**（模型锁 + 输出形态不匹配）

## 一、它是什么（事实锚定）

| 维度 | 内容 | 出处 |
|---|---|---|
| 形态 | 装在 **Claude Code** 里的深度研究 pipeline，敲 `/hyperresearch <问题>` 开跑 | 思渺 / 叁雾Lab 实测 |
| 核心 | 16 步分层研究（light 5步 / full 16步 200+源 1.5–2.5h / dissertation 300–450源 4–8h） | 官方 |
| 持久库 | 每源存 Markdown+YAML 到 `research/notes/`，SQLite 索引，全文/语义检索 + 图分析（hubs/backlinks），Git 版本化 | ProductCool |
| 对抗审计 | 4 个 critic（dialectic/depth/width/instruction）并行攻击；patcher 只能打补丁（Claude Code 工具锁），禁重写 | ProductCool |
| 溯源核验 | 每条源带 `suggested_by` 血缘树；cite-checker 逐条核对引文是否原文存在，查 DOI 撤回 | ProductCool |
| 独立性审计 | 转载副本聚类，避免虚假共识 | ProductCool |
| 学术优先 | Semantic Scholar/arXiv/OpenAlex/PubMed 先查再补网页；`run resume` 断点续跑 | 实测 |

## 二、三个硬约束（作者自述 + 实测）

1. **绑死 Claude**：工具锁（patcher 只能 Edit hunks）依赖 Claude Code 权限体系；官方称 TOML 可配模型，但与 Claude Code 强耦合，移植非 trivial（思渺明确点出"换别家不是改配置"）。
2. **烧钱烧时**：full 档一两次 Opus、200+ 源。
3. **保证结构不保证事实**：作者自己在"它不做什么"里写明，结论仍需人工判断。

## 三、对本项目（GeneTech 14站）适配矩阵

项目真实底座：GitHub Pages 知识引擎（现 `data.swarmlabs.tools`）、300k 实体 + 47k 结构化科研实体护城河、Tech Radar 闭环、AIShield 对抗式 critic、GEO 双引擎审计、来源可信度评分 `source-credibility.mjs`、本地模型优先栈（ornith-1.5:35b + SenseNova，**非 Anthropic**）。

| HyperResearch 能力 | 本项目现状 | 判断 |
|---|---|---|
| 持久复利知识库 | entities.json + 实体库已是结构化复利库（强于 markdown 笔记） | 已超越 |
| 来源可信度评分 | 已有 `source-credibility.mjs`（与上游逐分一致） | 已对齐 |
| 对抗式 critic | AIShield Tech Radar + GEO 双引擎已在做 | 已具备 |
| 断点续跑/分层 | ops 飞轮已是分层闭环 | 已具备 |
| **cite-checker 逐条核验引文** | 日报/周报/洞察文无此关 | 🟡 缺口，可补 |
| **patch-never-regenerate 纪律** | 更新实体报告可能整体重写 | 🟡 可补原则 |
| **独立性/转载聚类审计** | 竞品情报环跑新闻，可能重复稿计入 | 🟡 可补 |
| 多 Agent 编排框架 | 依赖 Claude Code 工具锁，与本地栈冲突 | 🔴 不适配 |

## 四、结论与建议

- **作为要安装运行的工具：不采用。** ① 工具锁耦合 Claude Code，与本地模型优先栈冲突；② 产出"长报告"，本项目产品是"结构化实体库"，形态不匹配；③ full 档烧 Opus，成本不划算。
- **作为方法论文献：高价值（与 heyclicky 同类——借机制不借平台）。** 最该移植的 3 点，均可用本地 `ornith-1.5:35b` 实现、零新增平台依赖：
  1. **cite-checker 接入洞察/周报流水线**：发布前逐条核验引文是否原文存在、DOI 是否撤回。
  2. **patch-never-regenerate 纪律**：更新已有实体/洞察文档只允增量 Edit，禁整体重写（护住结构化数据）。
  3. **独立性审计接入竞品情报环**：新闻稿聚类去重，防重复稿制造虚假共识（Tech Radar 竞争情报环薄弱点）。

## 五、落地情况（2026-09-15 已执行 A + B）

| 项 | 状态 | 产物 |
|---|---|---|
| A. cite-checker 可复用脚本 + 接入飞轮 | ✅ 已落地 | `tools/cite-checker.mjs`（零依赖）+ `operations-plan/pipeline-cite-check.js`（闭环六）+ `ops-extra.yml` 新增 `cite` 任务 |
| B. patch-never-regenerate 更新纪律 | ✅ 已落地 | `operations-plan/UPDATE_DISCIPLINE.md`（规范）+ `pipeline-geo-promotion.js` 加 `existsSync` 守卫（此前同日重跑会整篇盲覆盖） |
| C. 独立性/转载聚类审计 | ⏸ 未做 | 竞品情报环（`pipeline-intelligence.js`）当前无重复稿判据，优先级低于 A/B |

### A 的实测结果（首份台账 `reports/cite-check-2026-09-15.md`）

扫描 49 个 Markdown / 143 条引文：**ok 102 · blocked 22 · dead 5 · unreachable 14 · unresolved 0 · server-error 0 · retracted 0**。
逐条核验 19 条 → verified 1 · mismatch 15 · unverified 3（advisory）。

5 条 dead 里真正需要处理的只有 1 条（`docs/competition-2026/TECH-DEEP-DIVE.md` 引用的 HPE 博客 404），
其余是 DOI 尾字符过捕与文档占位符（已加占位符过滤，占位符类已消除）。

### A 的三个关键工程判据（实测得出，非假设）

1. **403 ≠ 死链**。首轮把 `doi.org` 的 403 当 dead，产生 43+ 假阳性死链。修正为 401/403/429/451 → `blocked`（出版商对 bot 恒拦截），
   仅 404/410 → `dead`；DOI 存活性改以 OpenAlex 记录为准。**误杀代价高于漏报，这是刻意的口径选择。**
2. **`--ssl-no-revoke` 是 Windows Schannel 专有**。写死会让 GitHub Actions（Linux/OpenSSL）curl 直接 unknown option 退出 2，整条管线全灭。
   现按 `curl -V` 探测 TLS 后端动态组装参数（本机 Schannel → 加；CI OpenSSL → 不加）。
3. **curl 失败时 `-w` 仍输出**（http_code `000`），故不用 `-o /dev/null`（Windows 上写盘失败报 E23 且 stdout 为空），
   改为正文走 stdout + 分隔符切分元信息，curl 非零退出也保留 stdout。

### 门禁强度

`pipeline-cite-check.js` 默认 flag 模式（恒 exit 0，仅提示）；`STRICT_CITE=1` 时在 dead 或 retracted 存在时 exit 1。
当前未开 STRICT（现网有 1 条真实死链待修，开了会绿站变红），修完后再开。已实测：STRICT exit 1 / flag exit 0。

### 未采纳项

- **多 Agent 编排框架**：依赖 Claude Code 工具锁，与本地模型优先栈冲突，不移植。
- **对抗式 critic 升级**：AIShield 已有对抗式 critic，无需重复引入。

