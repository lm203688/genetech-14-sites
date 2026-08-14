# 科学前沿情报与生态布局简报（2025–2026）

> 文档类型：知识引擎战略情报（GeneTech 14 站）
> 生成日期：2026-08-14
> 数据基础：Nature / Science / Cell 及子刊、各实验室与公司官方发布（2024-12 至 2026-08），8 轮定向检索交叉验证
> 目的：把"顶刊/重大科学发现"作为**生态布局的早期雷达**——在科学拐点之前，提前把相关实体（论文、实验室、公司、人物）补进知识库，并据此锁定低摩擦的生态切入点

---

## 0. 一句话结论

知识引擎的 **22 个站点本身就是一台"科学前沿雷达"**。2025–2026 年最值得押注的 8 个前沿方向，恰好与本项目已建站点高度重合——其中 **AI4Science / 基因编辑 / 生物计算 / 合成生物** 这片"生物×AI"集群，是项目域名（GeneTech）、既有 MCP 资产、站点矩阵都最匹配、生态切入摩擦最低、且科学拐点最密集的地带。**优先把前沿情报灌进这片核心集群，是投入产出比最高的布局。**

---

## 1. 数据库扩张现状（用户核心关切，先给结论）

用户最关心"数据库有没有持续在扩张"。核查结果：**在扩张，且机制真实、可持续。**

| 指标 | 数值 |
|---|---|
| 已提交实体总数 | **47,566 条**（22 站全覆盖，无空站） |
| 单站容量上限 | 4,000 条（引擎默认 `--max-entities=4000`） |
| 当前单站水位 | 1,258 – 2,961 条（仍有 ~4 万条上行空间） |
| 自动化节奏 | `.github/workflows/ops.yml`  hourly cron（`0 * * * *`）+ 日 cron |
| 分页游标 | `state/backfill-cursor.json` 已提交 git（非缓存），进度跨次持久 |
| 增长轨迹（git） | 31,495 → 47,566 单调递增；修复"新增恒为 0"致命缺陷后增量转正 |

> ⚠️ 纠错说明：上一轮我用了一个有 bug 的游标检查脚本，误报"5 个空站（biocomputing / quantum-computing / alien-minerals / bionic-ai / deep-sea-tech）"。真实情况是这 5 站分别已有 2,171–2,774 条实体，仅其游标未进入轮转索引（`cursor~0`）。**数据库无任何空站，误报已澄清。**

**结论：数据库靠 GitHub Actions 每小时自主扩量，可持续；当前是"水位未满、仍在涨"的健康状态，不是"停更"。**

---

## 2. 八大前沿方向 × 站点映射 × 生态切入点

下面每个方向给出：① 具体突破（带时间/机构，可核验）② 为何与项目相关 ③ 应加深的站点 ④ 建议回填的检索词 ⑤ 低摩擦生态动作。

---

### 2.1 量子计算（→ `quantum-computing`）

**突破**
- **Google Willow**（2024-12）：105 物理比特，首次实现"低于阈值"的纠错（错误率随比特数增加反而下降）；随机电路采样 5 分钟 vs 经典超算 10²⁵ 年。
- **Microsoft Majorana 1**（2025-02）：拓扑量子比特芯片（InAs 纳米线 + Al，拓扑导体材料）。
- **IBM**：Loon 处理器 + qLDPC 码，将纠错开销削减约 90%；路线图指向容错。
- **Quantinuum Helios**（2025-11）：48 个逻辑量子比特，双比特门保真度 99.92%。
- **Atom Computing**：1,000+ 中性原子阵列。
- **拐点判断**：行业正从"物理比特数竞赛"跨入"逻辑比特 / 纠错阈值"时代。

**项目关联**：量子是算力上游，与项目"本地大模型 + 推理后端"路线远期相关；当前更适合做**内容与情报层**而非重资产投入。

**生态切入（低摩擦）**
- 把 Willow / Majorana 1 / Helios 的里程碑、机构（Google Quantum AI、Quantinuum、IBM、Atom Computing）回填进 `quantum-computing` 站点。
- 产出"容错量子临界点"系列科普/GEO 内容，抢占"量子实用化"早期搜索心智。

---

### 2.2 核聚变 / 核能（→ `nuclear-energy`）

**突破**
- **NIF**（2025-04）：输入 2.08 MJ → 输出 8.6 MJ，增益 4.13（重复点火、增益创新高）。
- **EAST**：1 亿℃ 维持 1,066 秒。
- **中国环流三号 HL-3**：实现"双亿度"。
- **Commonwealth Fusion (CFS) SPARC**：2026 首次等离子体；ARC 反应堆目标 2030s。
- **Helion + Microsoft**：购电协议（PPA）目标 2028。
- **拐点判断**：点火从"偶然"变"可重复"；私营聚变（CFS/Helion/TAE/Commonwealth）加速，中国 HL-3 同步推进。

**生态切入（低摩擦）**
- 回填 `nuclear-energy`：NIF/CFS/Helion/TAE + HL-3 实体与里程碑。
- 内容角度：能源政策 + "聚变商业化时间表"追踪页，适合做 GEO 长青内容。

---

### 2.3 AI4Science：生成式生物学闭环（→ `ai4science` / `life-science` / `genetech-tools` / `biocomputing`）★核心集群

**突破**
- **AlphaFold 3**（Nature, 2024）：统一建模蛋白质/核酸/小分子相互作用，新增约 200 万 RNA–蛋白复合物。
- **AlphaProteo**（2024）：从头设计蛋白结合子，结合亲和力提升 3–300×。
- **RFdiffusion 3**（2025-12）：速度提升约 10×，可表达率约 50%。
- **Isomorphic Engine**（2025-11）：AI 药物设计引擎。
- **LucaProt**：发现约 16 万种新 RNA 病毒。
- **NVIDIA BioNeMo**：企业级生物基础模型平台。
- **Isomorphic 首款 AI 设计药物进入人体试验**（KRAS，2025-07）。
- **拐点判断**："预测→设计→验证"的生成式生物学闭环正在合上；AI 不再只是分析工具，而是**设计主体**。

**项目关联（最强）**：这正落在 GeneTech 的天然核心——生物 × AI。项目已有 `ai4science`、`life-science`、`genetech-tools`、`biocomputing` 四个相关站点 + 数据引擎 MCP，**生态契合度最高、摩擦最低**。

**生态切入（高优先、低摩擦）**
- 回填四大站点：AlphaFold3 / RFdiffusion3 / AlphaProteo / Isomorphic Engine / BioNeMo 的论文、团队（DeepMind/Isomorphic、Baker 实验室）、公司与里程碑。
- **内容领导力**：做"AI 设计药物元年"系列，建立项目在 AI4Science 的中文权威声量（GEO 红利）。
- **潜在合作雷达**：盯 Isomorphic、Recursion、Relay、Schrödinger 等 AI 制药玩家的开放数据/API 动向，作为未来连接器候选。

---

### 2.4 固态电池（→ `new-energy`）

**突破**
- **Toyota + Idemitsu**：2027–2028 硫化物固态电池量产。
- **QuantumScape**：Cobra 工艺 + 与 Murata 合作。
- **CATL**：锂盐添加剂使循环寿命翻倍。
- **Samsung SDI**：体积能量密度 900 Wh/L。
- **Mercedes**：EQS 实测单次充电 1,205 km（2025）。
- **Stellantis / Factorial**：375 Wh/kg、18 分钟快充。
- **拐点判断**：硫化物电解质从实验室走向产线；能量密度 + 安全 + 快充三重突破。

**生态切入（低摩擦）**
- 回填 `new-energy`：Toyota/QuantumScape/CATL/Samsung SDI 实体与产线时间表。
- 内容角度："固态电池量产倒计时"追踪页，与 EV/储能受众高度重合。

---

### 2.5 基因编辑 / 合成生物（→ `life-science` / `genetech-tools` / `synbio-manufacturing`）★核心集群

**突破**
- **Prime Editing 2.0**（David Liu 实验室）：造血干细胞（HSC）校正率 >70%，脱靶 <0.1%。
- **Prime Medicine（CGD 项目）**：校正率 90% + 获 FDA 突破性疗法认定（2025 末）。
- **PERT / PE-PRISM / LNP 递送**（Nature 2025–2026）：体内递送取得进展。
- **多重编辑**：单次 12 处突变并行编辑。
- **拐点判断**：Prime Editing 进入临床转化；体内 LNP 递送成熟；多重编辑解锁复杂病。

**项目关联（强）**：GeneTech 即"基因科技"。`genetech-tools` / `life-science` / `synbio-manufacturing` 是项目招牌站点，此方向天然契合。

**生态切入（高优先、低摩擦）**
- 回填三站：Prime Medicine / David Liu 实验室 / 各递送平台实体与临床里程碑。
- 内容角度："碱基/先导编辑临床元年"系列，巩固项目在基因科技领域的专业心智。
- **合作雷达**：Prime Medicine、Beam、Intellia 等编辑疗法公司的开放数据与临床披露，作为未来内容/数据合作线索。

---

### 2.6 脑科学 / 连接组学（→ `brain-science`）

**突破**
- **MICrONS**（Nature, 2025-04-09）：8.4 万神经元、5.24 亿突触、4 km 轴突、1 mm³ 小鼠视皮层全重建。
- **FlyWire**：果蝇全脑 16 万神经元连接组完成。
- **H01**：人皮层 1.6 万神经元 / 1.5 亿突触 / 1.4 PB。
- **连接组学**当选 *Nature Methods* 2025 年度方法。
- **中国猕猴全脑图谱**（Cell, 2025-07）。
- **拐点判断**：突触分辨率的全脑连线图成为新常态，反向启发类脑/神经形态 AI。

**生态切入（低摩擦）**
- 回填 `brain-science`：MICrONS / FlyWire / H01 / 中国猕猴图谱实体。
- 内容角度："全脑连线图时代"科普，关联神经形态计算与 AI 架构。

---

### 2.7 具身智能 / 机器人（→ `embodied-ai` / `robot-parts`）

**突破**
- **NVIDIA GR00T N1**（2025-03-18）：开源 VLA 双系统机器人大模型；后续 1.5 / 1.7。
- **Figure Helix**（2025-02）：35 自由度、200 Hz、单一神经网络。
- **Figure 03**（2025-10）：TIME 最佳发明。
- **π0.5**（2025-04-22，Physical Intelligence）。
- **Gemini Robotics**（2025-03）+ 端侧版（2025-06）。
- **Boston Dynamics Atlas**（2025-08）：学习式运动控制（LBM）。
- **BMW + Figure 02** 试点：处理 3 万辆车 / 9 万零部件。
- **市场**：RaaS 2034 年达 160–1,250 亿美元；中国 2025 年人形机器人出货 1.8 万台（+508%）。
- **拐点判断**：VLA 基础模型 + 仿真到现实，RaaS 模式起量。

**生态切入（低摩擦）**
- 回填 `embodied-ai` / `robot-parts`：GR00T / Figure / π0.5 / Gemini Robotics 实体与标杆产线。
- 内容角度："机器人即服务（RaaS）爆发"追踪，关联 `robot-parts` 零部件供应链内容。

---

### 2.8 半导体（→ `semiconductor`）

**突破**
- **High-NA EUV**：ASML EXE:5000/5200（NA 0.55，<10 nm 节距）；SK Hynix EXE:5200B（HBM）。
- **imec + ASML**：20 nm 节距单次曝光、13 nm 关键尺寸（2025）。
- **2 nm 节点**：TSMC N2 / Samsung SF2 / Intel 20A/18A，2025–2026 爬坡。
- **SEMI 2025**：设备市场 1,330 亿美元（+13.7%）。
- **拐点判断**：High-NA 解锁 2 nm 以下；先进封装 / HBM 成为主战场。

**生态切入（低摩擦）**
- 回填 `semiconductor`：ASML/imec/TSMC/Samsung/Intel + HBM 供应链实体。
- 内容角度："High-NA 与 2 nm 时间线"追踪页，B2B 技术受众强相关。

---

## 3. 跨方向生态布局矩阵

| 前沿方向 | 对应站点 | 优先级 | 核心生态动作 | 摩擦 |
|---|---|---|---|---|
| AI4Science（生成式生物） | ai4science / life-science / genetech-tools / biocomputing | ★★★ 最高 | 回填四大站点 + 内容领导力 + AI 制药合作雷达 | 低（天然核心） |
| 基因编辑 / 合成生物 | genetech-tools / life-science / synbio-manufacturing | ★★★ 最高 | 回填三站 + "编辑临床元年"内容 + 编辑疗法公司雷达 | 低（招牌领域） |
| 具身智能 | embodied-ai / robot-parts | ★★ 高 | RaaS 追踪 + 供应链内容 | 低 |
| 固态电池 | new-energy | ★★ 高 | 量产倒计时追踪 | 低 |
| 脑科学 / 连接组 | brain-science | ★★ 中高 | 全脑连线图科普 + 类脑 AI 关联 | 低 |
| 半导体 | semiconductor | ★★ 中高 | High-NA/2nm 时间线 | 低 |
| 量子计算 | quantum-computing | ★ 中 | 容错临界点内容 | 低（远期） |
| 核聚变 | nuclear-energy | ★ 中 | 商业化时间表追踪 | 低（远期） |

> **优先级判据**：★★★ = 与项目域名/资产/受众三重匹配，且科学拐点最密集 → 应作为前沿情报回填与生态布局的**主战场**。

---

## 4. 建议的下一步动作（具体、可落地）

**A. 把前沿实体持续灌进核心集群（让"雷达"越用越准）**
- 给 `ai4science` / `genetech-tools` / `life-science` / `synbio-manufacturing` 四个核心站，追加以下定向检索词（补进 `pipeline-data-backfill.js` 的查询集，CI 会自动轮转扩量）：
  - `AlphaFold 3`, `RFdiffusion`, `AlphaProteo`, `Isomorphic Engine`, `BioNeMo`, `generative biology`
  - `prime editing`, `base editing`, `LNP delivery`, `gene therapy clinical`
  - `CRISPR therapeutic`, `synthetic biology manufacturing`
- 给次优先站追加：`GR00T` / `Figure robot` / `humanoid RaaS`（embodied-ai）、`solid state battery sulfide` / `QuantumScape`（new-energy）、`MICrONS` / `connectomics`（brain-science）、`High-NA EUV` / `2nm process`（semiconductor）。

**B. 内容/GEO 层（AI 备料、用户确认后发）**
- 优先做"AI 设计药物元年""基因编辑临床元年"两篇权威长文 → 抢 AI4Science / 基因科技中文搜索心智（与项目核心最契合）。
- 其余方向做"时间线追踪页"（低成本、长青、利于 GEO 引用）。

**C. 生态合作雷达（轻量、异步）**
- 建立一张"前沿玩家 watchlist"（Isomorphic / Recursion / Prime Medicine / NVIDIA GR00T / CFS / Helion 等），只做公开信息追踪，不主动投入；待出现开放 API / 数据合作信号时，再由用户拍板是否接连接器。

**D. 未 mined 站点（诚实标注，建议二刷）**
- 以下站点本轮**未做深度检索**，仅标注为待办，不编造内容：`alien-minerals`、`deep-sea-tech`、`low-altitude`、`sat-6g`、`spatial-computing`、`privacy-computing`、`agent-ecosystem`、`tcm-tools`、`exo-science`。
- 建议第二轮对 `agent-ecosystem`（与具身/agentic AI 强相关）、`exo-science`（与外星矿物/天体生物交叉）做同样的深度挖掘。

---

## 5. 风险与边界（客观提示）

- **科学性 ≠ 商业确定性**：上述突破多是"实验室/早期临床"信号，转化为产品与收入有长周期与高失败率。本简报定位是"早期雷达 + 内容资产"，不是投资/押注建议。
- **项目摩擦最低处仍是生物×AI 集群**：量子/聚变虽重要，但与项目当前资产距离远，宜以"内容+情报"轻量参与，避免过度分散。
- **数据新鲜度**：情报基于截至 2026-08 的公开检索；High-NA、2nm、聚变 PPA 等时间线可能随厂商披露变动，建议 CI 类任务周期复刷。
- **避免编造**：未 mined 的 9 个站点已显式标注，未填充任何虚构实体。

---

*本简报由知识引擎自动生成，作为 22 站"科学前沿雷达"的首次系统输出；后续可由 CI 按季度/事件复刷，保持生态布局的时效性。*
