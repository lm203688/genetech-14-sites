# 错路由人工复核清单（前 500 条）

生成时间：2026-09-29T08:08:13.526Z
来源：`operations-plan/export-misroute-review.js`（参数：limit=500, threshold=0.35）

## 这个清单是什么

每条是「实体的**站点标签**被其**摘要**里的正交学科簇证据否决」的候选。
否决不是猜测——`lf_misroute_detector` 要求摘要至少命中 2 个标签、且这些标签的学科簇与站点标签不同。

**排序键**：`strength = round(主簇标签数 × 集中度 × 纯度 × 100 + topConfidence×10)`。
集中度 = 主簇证据标签数 / 全部正交证据标签数；纯度 = 1 / 正交簇数。
**证据越集中在单一簇越靠前**——「站点是量子计算但摘要从头到尾在讲临床」才是错路由。
摘要横跨 3 个以上学科簇的实体排在靠后，因为那更像跨学科论文（误报高发区）。

### 三种类型的含义

- **`cross-domain`** — 只有 1 个正交簇——最可能是真错路由
- **`mixed`** — 2 个正交簇
- **`cross-cutting`** — ≥3 个正交簇——最可能是跨学科论文（误报高发区）

## 怎么用它

1. 从上往下过。看 `title` 与 `abstract`，判断摘要里的学科簇是不是真的不属于当前站点。
2. 如果是 → 记为**真错路由**，看 `proposal` 里的 top 提案决定重路由目标站点。
3. 如果否（跨学科论文、方法论通用论文）→ 记为**误报**，无需动作。
4. 抽样验证精确率后，再决定是否批量重路由。**在此之前不要动 entities.json。**

## 汇总统计

- 语料实体：300,000
- 有摘要可判：141,459，产生跨簇否决：93,267
- 候选池 93,267 条，本次导出前 500 条

### 候选池的三类分布（这是估误报率的关键）

| 类型 | 条数 | 占比 |
|---|---|---|
| `cross-domain` | 40,160 | 43.1% |
| `mixed` | 37,298 | 40% |
| `cross-cutting` | 15,809 | 17% |

### 本次导出的三类分布

| 类型 | 条数 |
|---|---|
| `cross-domain` | 500 |

### 证据主簇分布（「应该去哪个学科」）

| 主簇 | 条数 |
|---|---|
| `cs` | 418 |
| `med` | 82 |

### 按被否决的站点标签（Top 20）

| 被否决标签 | 条数 |
|---|---|
| `psychology` | 128 |
| `biology` | 100 |
| `materials science` | 75 |
| `environmental science` | 62 |
| `neuroscience` | 33 |
| `medicine` | 27 |
| `biotechnology` | 21 |
| `quantum computing` | 21 |
| `artificial intelligence` | 16 |
| `natural language processing` | 9 |
| `computer science` | 5 |
| `robotics` | 2 |
| `machine learning` | 1 |

### 按站点

| 站点 | 条数 |
|---|---|
| `ai-safety` | 87 |
| `deep-sea-tech` | 38 |
| `bionic-ai` | 36 |
| `neuromorphic` | 34 |
| `tcm-tools` | 34 |
| `alien-minerals` | 33 |
| `brain-science` | 32 |
| `life-science` | 26 |
| `agritech` | 24 |
| `biomed-ai` | 22 |
| `exo-science` | 20 |
| `agent-ecosystem` | 18 |
| `digital-twin` | 17 |
| `quantum-computing` | 17 |
| `low-altitude` | 15 |
| `biocomputing` | 12 |
| `quantum-materials` | 8 |
| `synbio-manufacturing` | 8 |
| `carbon-neutral` | 4 |
| `nuclear-energy` | 4 |
| `new-energy` | 2 |
| `ai4science` | 2 |
| `embodied-ai` | 2 |
| `genetech-tools` | 2 |
| `sat-6g` | 2 |
| `semiconductor` | 1 |

## 明细（前 60 条）

### #1 `agritech` `cross-domain` — Combining VLM and LLM for Enhanced Semantic Object Perception in Robotic Handover Tasks

- **否决**：站点标签 `biology`（簇 `bio`）
- **证据**：主簇 `cs`，6/6 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.38)
- **来源**：crossref
- **链接**：https://doi.org/10.1109/wrcsara64167.2024.10685688
- **摘要**：We are utilizing a combination of Large Language Model (LLM) and Vision Language Model (VLM) to perform a robot-to-human handover task with semantic object knowledge. Current object perception systems for this task often work with a fixed s…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #2 `agritech` `cross-domain` — Combining VLM and LLM for Enhanced Semantic Object Perception in Robotic Handover Tasks

- **否决**：站点标签 `environmental science`（簇 `env`）
- **证据**：主簇 `cs`，6/6 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.38)
- **来源**：crossref
- **链接**：https://doi.org/10.1109/wrcsara64167.2024.10685688
- **摘要**：We are utilizing a combination of Large Language Model (LLM) and Vision Language Model (VLM) to perform a robot-to-human handover task with semantic object knowledge. Current object perception systems for this task often work with a fixed s…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #3 `ai-safety` `cross-domain` — A physics-guided neural network framework for prediction and control of spring-mass running.

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，6/6 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.38)
- **来源**：europepmc
- **链接**：https://doi.org/10.1088/1748-3190/ae7e2d
- **摘要**：The spring-mass template acts as a fundamental bridge between animal locomotion and legged robotic platforms. However, controlling spring-mass dynamics involves a persistent trade-off: numerical integration offers accuracy but high computat…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #4 `alien-minerals` `cross-domain` — Space-LLaVA: a Vision-Language Model Adapted to Extraterrestrial Applications

- **否决**：站点标签 `materials science`（簇 `phys`）
- **证据**：主簇 `cs`，6/6 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、review-article (0.6)、computer science (0.463)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2408.05924v2
- **摘要**：Foundation Models (FMs), e.g., large language models, possess attributes of intelligence which offer promise to endow a robot with the contextual understanding necessary to navigate complex, unstructured tasks in the wild. We see three core…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #5 `alien-minerals` `cross-domain` — Space-LLaVA: A Vision-Language Model Adapted to Extraterrestrial Applications

- **否决**：站点标签 `materials science`（簇 `phys`）
- **证据**：主簇 `cs`，6/6 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、review-article (0.6)、computer science (0.422)
- **来源**：crossref
- **链接**：https://doi.org/10.1109/aero63441.2025.11068757
- **摘要**：Foundation Models (FMs), e.g., large language models, possess attributes of intelligence [1] which offer promise to endow a robot with the contextual understanding necessary to navigate complex, unstructured tasks in the wild. We see three …

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #6 `bionic-ai` `cross-domain` — A Deep Learning Framework With Domain Generalization and Few-Shot Learning for Locomotion Mode Classification Across Users, Sessions, and Prostheses.

- **否决**：站点标签 `biology`（簇 `bio`）
- **证据**：主簇 `cs`，6/6 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：cs.lg [cs]、machine learning [cs]、natural language processing [cs]、computer science [cs]、robotics [cs]、artificial intelligence [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.422)
- **来源**：pubmed
- **链接**：https://pubmed.ncbi.nlm.nih.gov/41924131/
- **摘要**：Transfemoral amputees don and doff their prostheses at least daily, making inter-session classification performance important for clinical implementation of locomotion mode classification algorithms. Here, we present a deep-learning framewo…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #7 `deep-sea-tech` `cross-domain` — Gemini Robotics: Bringing AI into the Physical World

- **否决**：站点标签 `biology`（簇 `bio`）
- **证据**：主簇 `cs`，6/6 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、cs.lg [cs]、natural language processing [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.463)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2503.20020v1
- **摘要**：Recent advancements in large multimodal models have led to the emergence of remarkable generalist capabilities in digital domains, yet their translation to physical agents such as robots remains a significant challenge. This report introduc…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #8 `deep-sea-tech` `cross-domain` — Gemini Robotics: Bringing AI into the Physical World

- **否决**：站点标签 `environmental science`（簇 `env`）
- **证据**：主簇 `cs`，6/6 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、cs.lg [cs]、natural language processing [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.463)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2503.20020v1
- **摘要**：Recent advancements in large multimodal models have led to the emergence of remarkable generalist capabilities in digital domains, yet their translation to physical agents such as robots remains a significant challenge. This report introduc…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #9 `deep-sea-tech` `cross-domain` — Underwater SLAM Meets Deep Learning: Challenges, Multi-Sensor Integration, and Future Directions.

- **否决**：站点标签 `biology`（簇 `bio`）
- **证据**：主簇 `cs`，6/6 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.38)
- **来源**：europepmc
- **链接**：https://doi.org/10.3390/s25113258
- **摘要**：The underwater domain presents unique challenges and opportunities for scientific exploration, resource extraction, and environmental monitoring. Autonomous underwater vehicles (AUVs) rely on simultaneous localization and mapping (SLAM) for…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #10 `deep-sea-tech` `cross-domain` — Underwater SLAM Meets Deep Learning: Challenges, Multi-Sensor Integration, and Future Directions.

- **否决**：站点标签 `environmental science`（簇 `env`）
- **证据**：主簇 `cs`，6/6 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.38)
- **来源**：europepmc
- **链接**：https://doi.org/10.3390/s25113258
- **摘要**：The underwater domain presents unique challenges and opportunities for scientific exploration, resource extraction, and environmental monitoring. Autonomous underwater vehicles (AUVs) rely on simultaneous localization and mapping (SLAM) for…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #11 `digital-twin` `cross-domain` — Towards a Digital Twin Framework for Sensory-Aware Neurodivergent Route Personalisation

- **否决**：站点标签 `environmental science`（簇 `env`）
- **证据**：主簇 `cs`，6/6 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：cs.lg [cs]、machine learning [cs]、natural language processing [cs]、computer science [cs]、artificial intelligence [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.389)
- **来源**：openalex
- **链接**：https://openalex.org/W7204740116
- **摘要**：Around 90% of autistic adults report atypical sensory processing, which is a known barrier to independent travel. Existing navigation systems optimise for time and distance and do not account for the sensory demands of a route. We present N…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #12 `low-altitude` `cross-domain` — VLM-Nav: Mapless UAV navigation using monocular vision driven by vision-language models.

- **否决**：站点标签 `materials science`（簇 `phys`）
- **证据**：主簇 `cs`，6/6 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]、artificial intelligence [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.38)
- **来源**：europepmc
- **链接**：https://doi.org/10.1371/journal.pone.0345778
- **摘要**：Autonomous vehicles, such as Unmanned Aerial Vehicles (UAVs), have the potential to completely reshape various industries such as parcel delivery, agriculture, surveillance, monitoring, and search-and-rescue missions. Consequently, the dema…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #13 `neuromorphic` `cross-domain` — Towards neuromorphic visual SLAM: A spiking neural network for efficient pose estimation and loop closure based on event camera data

- **否决**：站点标签 `neuroscience`（簇 `bio`）
- **证据**：主簇 `cs`，6/6 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、review-article (0.6)、computer science (0.38)
- **来源**：datacite
- **链接**：https://doi.org/10.25958/tfkv-5t55
- **摘要**：The need for effective Simultaneous Localisation and Mapping (SLAM) solutions has been pivotal across a wide range of applications, including autonomous vehicles, industrial robotics, and mobile service platforms where accurate localisation…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #14 `neuromorphic` `cross-domain` — Towards neuromorphic visual SLAM: A spiking neural network for efficient pose estimation and loop closure based on event camera data

- **否决**：站点标签 `materials science`（簇 `phys`）
- **证据**：主簇 `cs`，6/6 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、review-article (0.6)、computer science (0.38)
- **来源**：datacite
- **链接**：https://doi.org/10.25958/tfkv-5t55
- **摘要**：The need for effective Simultaneous Localisation and Mapping (SLAM) solutions has been pivotal across a wide range of applications, including autonomous vehicles, industrial robotics, and mobile service platforms where accurate localisation…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #15 `bionic-ai` `cross-domain` — Learning tactile skills through curious exploration

- **否决**：站点标签 `biology`（簇 `bio`）
- **证据**：主簇 `cs`，6/6 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]、robotics [cs]
- **提案**：computer science (0.38)
- **来源**：crossref
- **链接**：https://doi.org/10.3389/fnbot.2012.00006
- **摘要**：We present curiosity-driven, autonomous acquisition of tactile exploratory skills on a biomimetic robot finger equipped with an array of microelectromechanical touch sensors. Instead of building tailored algorithms for solving a specific ta…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #16 `deep-sea-tech` `cross-domain` — Supervised time series classification for anomaly detection in subsea engineering

- **否决**：站点标签 `biology`（簇 `bio`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：subsea (0.671)、emerging-2024+ (0.6)、computer science (0.422)
- **来源**：openalex
- **链接**：https://doi.org/10.3934/jcd.2024019
- **摘要**：Time series classification is of significant importance in monitoring structural systems. In this work, we investigate the use of supervised machine learning classification algorithms on simulated data based on a physical system with two st…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #17 `deep-sea-tech` `cross-domain` — Supervised time series classification for anomaly detection in subsea engineering

- **否决**：站点标签 `environmental science`（簇 `env`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：subsea (0.671)、emerging-2024+ (0.6)、computer science (0.422)
- **来源**：openalex
- **链接**：https://doi.org/10.3934/jcd.2024019
- **摘要**：Time series classification is of significant importance in monitoring structural systems. In this work, we investigate the use of supervised machine learning classification algorithms on simulated data based on a physical system with two st…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #18 `exo-science` `cross-domain` — Prospective analysis of UGT1A1 promoter polymorphism for irinotecan dose escalation in metastatic colorectal cancer patients treated with bevacizumab plus FOLFI…

- **否决**：站点标签 `biology`（簇 `bio`）
- **证据**：主簇 `med`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：clinical-trial [med]、medicine [med]、randomized-controlled-trial [med]、cancer [med]、pharmacology [med]
- **提案**：randomized-controlled-trial (0.688)、clinical-trial (0.688)
- **来源**：crossref
- **链接**：https://doi.org/10.1186/s13063-016-1153-3
- **摘要**：Background Irinotecan is approved and widely administered to metastatic colorectal cancer (mCRC) patients; however, it can cause severe toxicities including neutropenia and diarrhea. The polymorphisms of genes encoding drug-metabolizing enz…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #19 `exo-science` `cross-domain` — Prospective analysis of UGT1A1 promoter polymorphism for irinotecan dose escalation in metastatic colorectal cancer patients treated with bevacizumab plus FOLFI…

- **否决**：站点标签 `environmental science`（簇 `env`）
- **证据**：主簇 `med`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：clinical-trial [med]、medicine [med]、randomized-controlled-trial [med]、cancer [med]、pharmacology [med]
- **提案**：randomized-controlled-trial (0.688)、clinical-trial (0.688)
- **来源**：crossref
- **链接**：https://doi.org/10.1186/s13063-016-1153-3
- **摘要**：Background Irinotecan is approved and widely administered to metastatic colorectal cancer (mCRC) patients; however, it can cause severe toxicities including neutropenia and diarrhea. The polymorphisms of genes encoding drug-metabolizing enz…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #20 `tcm-tools` `cross-domain` — Rapid identification of medicinal plants via visual feature-based deep learning

- **否决**：站点标签 `medicine`（簇 `med`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：cs.lg [cs]、machine learning [cs]、natural language processing [cs]、computer science [cs]、artificial intelligence [cs]
- **提案**：medicinal plants (0.671)、emerging-2024+ (0.6)、review-article (0.6)
- **来源**：crossref
- **链接**：https://doi.org/10.1186/s13007-024-01202-6
- **摘要**：Abstract Background Traditional Chinese Medicinal Plants (CMPs) hold a significant and core status for the healthcare system and cultural heritage in China. It has been practiced and refined with a history of exceeding thousands of years fo…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #21 `tcm-tools` `cross-domain` — Rapid identification of medicinal plants via visual feature-based deep learning

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：cs.lg [cs]、machine learning [cs]、natural language processing [cs]、computer science [cs]、artificial intelligence [cs]
- **提案**：medicinal plants (0.671)、emerging-2024+ (0.6)、review-article (0.6)
- **来源**：crossref
- **链接**：https://doi.org/10.1186/s13007-024-01202-6
- **摘要**：Abstract Background Traditional Chinese Medicinal Plants (CMPs) hold a significant and core status for the healthcare system and cultural heritage in China. It has been practiced and refined with a history of exceeding thousands of years fo…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #22 `agritech` `cross-domain` — Research note: A machine learning approach for authentication of laying hen housing systems based on egg quality parameters.

- **否决**：站点标签 `biology`（簇 `bio`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.415)
- **来源**：europepmc
- **链接**：https://doi.org/10.1016/j.psj.2026.107219
- **摘要**：Eggs originating from outdoor housing systems, such as organic and free-range production, are often sold at a higher price than conventional eggs. This price difference creates an incentive for potential fraud, highlighting the need for rel…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #23 `agritech` `cross-domain` — Research note: A machine learning approach for authentication of laying hen housing systems based on egg quality parameters.

- **否决**：站点标签 `environmental science`（簇 `env`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.415)
- **来源**：europepmc
- **链接**：https://doi.org/10.1016/j.psj.2026.107219
- **摘要**：Eggs originating from outdoor housing systems, such as organic and free-range production, are often sold at a higher price than conventional eggs. This price difference creates an incentive for potential fraud, highlighting the need for rel…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #24 `agritech` `cross-domain` — Identifying strawberry appearance quality based on unsupervised deep learning

- **否决**：站点标签 `biology`（簇 `bio`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：recent-2020s (0.6)、computer science (0.415)
- **来源**：crossref
- **链接**：https://doi.org/10.1007/s11119-023-10085-x
- **摘要**：The strawberry appearance is an essential standard for judging the quality, so it is crucial to accurately identify the strawberry appearance quality for intelligent picking. This study proposed a new strawberry appearance quality detection…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #25 `agritech` `cross-domain` — Identifying strawberry appearance quality based on unsupervised deep learning

- **否决**：站点标签 `environmental science`（簇 `env`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：recent-2020s (0.6)、computer science (0.415)
- **来源**：crossref
- **链接**：https://doi.org/10.1007/s11119-023-10085-x
- **摘要**：The strawberry appearance is an essential standard for judging the quality, so it is crucial to accurately identify the strawberry appearance quality for intelligent picking. This study proposed a new strawberry appearance quality detection…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #26 `agritech` `cross-domain` — Automated road surface classification in OpenStreetMap using MaskCNN and aerial imagery.

- **否决**：站点标签 `biology`（簇 `bio`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、natural language processing [cs]、computer science [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.422)
- **来源**：pubmed
- **链接**：https://pubmed.ncbi.nlm.nih.gov/40881822/
- **摘要**：OpenStreetMap (OSM) road surface data is critical for navigation, infrastructure monitoring, and urban planning but is often incomplete or inconsistent. This study addresses the need for automated validation and classification of road surfa…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #27 `agritech` `cross-domain` — Automated road surface classification in OpenStreetMap using MaskCNN and aerial imagery.

- **否决**：站点标签 `environmental science`（簇 `env`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、natural language processing [cs]、computer science [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.422)
- **来源**：pubmed
- **链接**：https://pubmed.ncbi.nlm.nih.gov/40881822/
- **摘要**：OpenStreetMap (OSM) road surface data is critical for navigation, infrastructure monitoring, and urban planning but is often incomplete or inconsistent. This study addresses the need for automated validation and classification of road surfa…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #28 `agritech` `cross-domain` — An Intelligent Cloud-Integrated Electronic Nose System for Non-Destructive Fruit Ripeness Monitoring in Precision Agriculture

- **否决**：站点标签 `biology`（簇 `bio`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.38)
- **来源**：crossref
- **链接**：https://doi.org/10.3390/electronics15122502
- **摘要**：Precision in estimating the ripeness of fruits is critical in quality control and minimizing losses in supply chains of agricultural produce following harvesting. Conventional ripeness assessment techniques tend to be destructive, time-cons…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #29 `agritech` `cross-domain` — An Intelligent Cloud-Integrated Electronic Nose System for Non-Destructive Fruit Ripeness Monitoring in Precision Agriculture

- **否决**：站点标签 `environmental science`（簇 `env`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.38)
- **来源**：crossref
- **链接**：https://doi.org/10.3390/electronics15122502
- **摘要**：Precision in estimating the ripeness of fruits is critical in quality control and minimizing losses in supply chains of agricultural produce following harvesting. Conventional ripeness assessment techniques tend to be destructive, time-cons…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #30 `ai-safety` `cross-domain` — JEPA for AI-Native 6G: Predictive Representations and Open Challenges

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、cs.lg [cs]、machine learning [cs]、natural language processing [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.463)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2607.09798v1
- **摘要**：Sixth-generation (6G) networks are moving toward AI-native operation, where learning modules are embedded across the radio access network (RAN), edge, and core. This transition requires learning from limited labels, heterogeneous wireless a…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #31 `ai-safety` `cross-domain` — Steerable Cultural Preference Optimization of Reward Models

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、cs.lg [cs]、natural language processing [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.418)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2606.18606v1
- **摘要**：It is essential for large language model (LLM) technology to serve many different cultural sub-communities in a manner that is acceptable to each community. However, research on LLM alignment has so far predominantly focused on predicting a…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #32 `ai-safety` `cross-domain` — Alignment for Honesty

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：recent-2020s (0.6)、computer science (0.418)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2312.07000v2
- **摘要**：Recent research has made significant strides in aligning large language models (LLMs) with helpfulness and harmlessness. In this paper, we argue for the importance of alignment for \emph{honesty}, ensuring that LLMs proactively refuse to an…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #33 `ai-safety` `cross-domain` — Meta Prompting for AI Systems

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：recent-2020s (0.6)、computer science (0.422)
- **来源**：openalex
- **链接**：https://doi.org/10.48550/arxiv.2311.11482
- **摘要**：We introduce Meta Prompting (MP), a framework that emphasizes the formal structure of a task rather than content-specific worked examples. We give a categorical formalization in which a functor maps typed task transformations to typed promp…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #34 `ai-safety` `cross-domain` — Prompt Engineering for Conversational AI Systems: A Systematic Review of Techniques and Applications

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、cs.lg [cs]、natural language processing [cs]
- **提案**：emerging-2024+ (0.6)、review-article (0.6)、computer science (0.422)
- **来源**：openalex
- **链接**：https://doi.org/10.32628/cseit25111276
- **摘要**：This article comprehensively analyzes prompt engineering techniques in conversational AI systems, focusing on their implementation and impact on large language model (LLM) performance. The article examines the fundamental principles of effe…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #35 `ai-safety` `cross-domain` — How to Leverage Demonstration Data in Alignment for Large Language Model? A Self-Imitation Learning Perspective

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：cs.lg [cs]、machine learning [cs]、natural language processing [cs]、computer science [cs]、artificial intelligence [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.463)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2410.10093v1
- **摘要**：This paper introduces a novel generalized self-imitation learning ($\textbf{GSIL}$) framework, which effectively and efficiently aligns large language models with offline demonstration data. We develop $\textbf{GSIL}$ by deriving a surrogat…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #36 `ai-safety` `cross-domain` — Automated Meta Prompt Engineering for Alignment with the Theory of Mind

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、natural language processing [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.418)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2505.09024v1
- **摘要**：We introduce a method of meta-prompting that jointly produces fluent text for complex tasks while optimizing the similarity of neural states between a human's mental expectation and a Large Language Model's (LLM) neural processing. A techni…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #37 `ai-safety` `cross-domain` — Beyond Labels: Aligning Large Language Models with Human-like Reasoning

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：cs.lg [cs]、machine learning [cs]、natural language processing [cs]、computer science [cs]、artificial intelligence [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.463)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2408.11879v1
- **摘要**：Aligning large language models (LLMs) with a human reasoning approach ensures that LLMs produce morally correct and human-like decisions. Ethical concerns are raised because current models are prone to generating false positives and providi…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #38 `ai-safety` `cross-domain` — CoFInAl: Enhancing Action Quality Assessment with Coarse-to-Fine Instruction Alignment

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：emerging-2024+ (0.6)、review-article (0.6)、computer science (0.418)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2404.13999v1
- **摘要**：Action Quality Assessment (AQA) is pivotal for quantifying actions across domains like sports and medical care. Existing methods often rely on pre-trained backbones from large-scale action recognition datasets to boost performance on smalle…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #39 `ai-safety` `cross-domain` — Trustworthy and Ethical AI for Intrusion Detection in Healthcare IoT (IoMT) Systems: An Agentic Decision Loop Framework

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、cs.lg [cs]、natural language processing [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.422)
- **来源**：europepmc
- **链接**：https://doi.org/10.21203/rs.3.rs-9081737/v1
- **摘要**：Abstract The rapid expansion of Internet of Medical Things (IoMT) ecosystems has intensified cybersecurity challenges in healthcare settings, where network disruptions can compromise clinical safety and operational continuity. Traditional i…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #40 `ai-safety` `cross-domain` — Empowering smart app development with SolidGPT: an edgecloud hybrid AI agent framework

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、natural language processing [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.422)
- **来源**：openalex
- **链接**：https://doi.org/10.54254/2977-3903/2025.25283
- **摘要**：The integration of Large Language Models (LLMs) into mobile and software development workflows faces a persistent tension among three demands: semantic awareness, developer productivity, and data privacy. Traditional cloud-based tools offer…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #41 `ai-safety` `cross-domain` — LLM Fine-Tuning: Concepts, Opportunities, and Challenges

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、cs.lg [cs]、natural language processing [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.38)
- **来源**：openalex
- **链接**：https://doi.org/10.3390/bdcc9040087
- **摘要**：As a foundation of large language models, fine-tuning drives rapid progress, broad applicability, and profound impacts on human–AI collaboration, surpassing earlier technological advancements. This paper provides a comprehensive overview of…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #42 `ai-safety` `cross-domain` — APPLICATIONS AND IMPACTS OF AI TOOLS IN EDUCATION

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、cs.lg [cs]、natural language processing [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.422)
- **来源**：openalex
- **链接**：https://doi.org/10.47716/978-93-92090-38-7
- **摘要**：ABSTACT - Artificial Intelligence (AI) is being woven rapidly into the fabric of contemporary education, prompting a reevaluation of established pedagogical models. This monograph assesses the diverse applications and consequences of AI tec…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #43 `ai-safety` `cross-domain` — Findings of the Fourth Shared Task on Multilingual Coreference Resolution: Can LLMs Dethrone Traditional Approaches?

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.418)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2509.17796v2
- **摘要**：The paper presents an overview of the fourth edition of the Shared Task on Multilingual Coreference Resolution, organized as part of the CODI-CRAC 2025 workshop. As in the previous editions, participants were challenged to develop systems t…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #44 `ai-safety` `cross-domain` — Ensembling Large Language Models to Characterize Affective Dynamics in Student-AI Tutor Dialogues

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、cs.lg [cs]、natural language processing [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.463)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2510.13862v1
- **摘要**：While recent studies have examined the leaning impact of large language model (LLM) in educational contexts, the affective dynamics of LLM-mediated tutoring remain insufficiently understood. This work introduces the first ensemble-LLM frame…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #45 `ai-safety` `cross-domain` — Data Alignment for Zero-Shot Concept Generation in Dermatology AI

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、cs.lg [cs]、natural language processing [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.463)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2404.13043v2
- **摘要**：AI in dermatology is evolving at a rapid pace but the major limitation to training trustworthy classifiers is the scarcity of data with ground-truth concept level labels, which are meta-labels semantically meaningful to humans. Foundation m…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #46 `ai-safety` `cross-domain` — Born a Transformer -- Always a Transformer? On the Effect of Pretraining on Architectural Abilities

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.418)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2505.21785v3
- **摘要**：Transformers have theoretical limitations in modeling certain sequence-to-sequence tasks, yet it remains largely unclear if these limitations play a role in large-scale pretrained LLMs, or whether LLMs might effectively overcome these const…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #47 `ai-safety` `cross-domain` — Beyond the Surface: Enhancing LLM-as-a-Judge Alignment with Human via Internal Representations

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.418)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2508.03550v3
- **摘要**：The growing scale of evaluation tasks has led to the widespread adoption of automated evaluation using LLMs, a paradigm known as "LLM-as-a-judge". However, improving its alignment with human preferences without complex prompts or fine-tunin…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #48 `ai-safety` `cross-domain` — The Architecture of Erasure: A Forensic Audit of the CollectiveOS Expropriation and the Sovereign Isomorphism

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、natural language processing [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、review-article (0.6)、computer science (0.38)
- **来源**：datacite
- **链接**：https://doi.org/10.5281/zenodo.19568050
- **摘要**：The Architecture of Erasure: A Forensic Audit of the CollectiveOS Expropriation and the Sovereign Isomorphism The Epistemological Crisis of Agentic Autonomy and the August 2025 Singularity The global ecosystem of artificial intelligence and…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #49 `ai-safety` `cross-domain` — The Architecture of Erasure: A Forensic Audit of the CollectiveOS Expropriation and the Sovereign Isomorphism

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、natural language processing [cs]、robotics [cs]
- **提案**：emerging-2024+ (0.6)、review-article (0.6)、computer science (0.38)
- **来源**：datacite
- **链接**：https://doi.org/10.5281/zenodo.19568049
- **摘要**：The Architecture of Erasure: A Forensic Audit of the CollectiveOS Expropriation and the Sovereign Isomorphism The Epistemological Crisis of Agentic Autonomy and the August 2025 Singularity The global ecosystem of artificial intelligence and…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #50 `ai-safety` `cross-domain` — EXPERIMENT OF LARGE LANGUAGE MODEL ADAPTATION MECHANISM TO AMBON LOCAL KNOWLEDGE: COMPARISON OF MINI GENERATION CULTURAL PROMPTING AND RETRIEVAL-AUGMENTED STRAT…

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、cs.lg [cs]、natural language processing [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.422)
- **来源**：datacite
- **链接**：https://doi.org/10.5281/zenodo.19531762
- **摘要**：This study is designed as an experimental-comparative basic study by integrating quantitative and interpretive analysis. Three treatment conditions—generic prompting without cultural context (K0), cultural prompting based on local sensitivi…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #51 `ai-safety` `cross-domain` — EXPERIMENT OF LARGE LANGUAGE MODEL ADAPTATION MECHANISM TO AMBON LOCAL KNOWLEDGE: COMPARISON OF MINI GENERATION CULTURAL PROMPTING AND RETRIEVAL-AUGMENTED STRAT…

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、cs.lg [cs]、natural language processing [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.422)
- **来源**：datacite
- **链接**：https://doi.org/10.5281/zenodo.19531761
- **摘要**：This study is designed as an experimental-comparative basic study by integrating quantitative and interpretive analysis. Three treatment conditions—generic prompting without cultural context (K0), cultural prompting based on local sensitivi…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #52 `ai-safety` `cross-domain` — Cultural Alignment in Large Language Models: An Explanatory Analysis Based on Hofstede's Cultural Dimensions

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、cs.lg [cs]、robotics [cs]
- **提案**：recent-2020s (0.6)、computer science (0.38)
- **来源**：openalex
- **链接**：https://doi.org/10.48550/arxiv.2309.12342
- **摘要**：The deployment of large language models (LLMs) raises concerns regarding their cultural misalignment and potential ramifications on individuals and societies with diverse cultural backgrounds. While the discourse has focused mainly on polit…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #53 `ai-safety` `cross-domain` — No Captions, No Problem: Captionless 3D-CLIP Alignment with Hard Negatives via CLIP Knowledge and LLMs

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.418)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2406.02202v2
- **摘要**：In this study, we explore an alternative approach to enhance contrastive text-image-3D alignment in the absence of textual descriptions for 3D objects. We introduce two unsupervised methods, $I2I$ and $(I2L)^2$, which leverage CLIP knowledg…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #54 `ai-safety` `cross-domain` — Weak-to-Strong Search: Align Large Language Models via Searching over Small Language Models

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.418)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2405.19262v3
- **摘要**：Large language models are usually fine-tuned to align with human preferences. However, fine-tuning a large language model can be challenging. In this work, we introduce $\textit{weak-to-strong search}$, framing the alignment of a large lang…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #55 `ai-safety` `cross-domain` — Fine-Tuning Language Models for Ethical Ambiguity: A Comparative Study of Alignment with Human Responses

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.418)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2410.07826v1
- **摘要**：Language models often misinterpret human intentions due to their handling of ambiguity, a limitation well-recognized in NLP research. While morally clear scenarios are more discernible to LLMs, greater difficulty is encountered in morally a…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #56 `ai-safety` `cross-domain` — ARES: Alternating Reinforcement Learning and Supervised Fine-Tuning for Enhanced Multi-Modal Chain-of-Thought Reasoning Through Diverse AI Feedback

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：artificial intelligence [cs]、computer science [cs]、machine learning [cs]、cs.lg [cs]、natural language processing [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.463)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2407.00087v2
- **摘要**：Large Multimodal Models (LMMs) excel at comprehending human instructions and demonstrate remarkable results across a broad spectrum of tasks. Reinforcement Learning from Human Feedback (RLHF) and AI Feedback (RLAIF) further refine LLMs by a…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #57 `ai-safety` `cross-domain` — Rethinking Federated Graph Foundation Models: A Graph-Language Alignment-based Approach

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：cs.lg [cs]、machine learning [cs]、natural language processing [cs]、computer science [cs]、artificial intelligence [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.418)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2601.21369v2
- **摘要**：Recent studies of federated graph foundational models (FedGFMs) break the idealized and untenable assumption of having centralized data storage to train graph foundation models, and accommodate the reality of distributed, privacy-restricted…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #58 `ai-safety` `cross-domain` — Safety Arithmetic: A Framework for Test-time Safety Alignment of Language Models by Steering Parameters and Activations

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.418)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2406.11801v2
- **摘要**：Ensuring the safe alignment of large language models (LLMs) with human values is critical as they become integral to applications like translation and question answering. Current alignment methods struggle with dynamic user intentions and c…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #59 `ai-safety` `cross-domain` — OpenDlign: Open-World Point Cloud Understanding with Depth-Aligned Images

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：emerging-2024+ (0.6)、review-article (0.6)、computer science (0.418)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2404.16538v3
- **摘要**：Recent open-world 3D representation learning methods using Vision-Language Models (VLMs) to align 3D point cloud with image-text information have shown superior 3D zero-shot performance. However, CAD-rendered images for this alignment often…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

### #60 `ai-safety` `cross-domain` — Enhancing Domain Adaptation through Prompt Gradient Alignment

- **否决**：站点标签 `psychology`（簇 `psych`）
- **证据**：主簇 `cs`，5/5 个正交标签（集中度 1，正交簇 1 个）
- **证据标签**：machine learning [cs]、artificial intelligence [cs]、cs.lg [cs]、natural language processing [cs]、computer science [cs]
- **提案**：emerging-2024+ (0.6)、computer science (0.418)
- **来源**：arxiv
- **链接**：https://arxiv.org/abs/2406.09353v3
- **摘要**：Prior Unsupervised Domain Adaptation (UDA) methods often aim to train a domain-invariant feature extractor, which may hinder the model from learning sufficiently discriminative features. To tackle this, a line of works based on prompt learn…

- [ ] 真错路由 → 应重路由到：`________________`
- [ ] 误报（跨学科 / 方法通用），无需动作

> 余 440 条见 `misroute-review-top500.json`

---

**注意**：这份清单是待复核的**提案**，不是结论。
`cross-cutting` 类型大多是误报——跨学科论文天然命中多个簇，站点路由未必错了。
真正值得动作的是 `cross-domain` 类型：证据完全集中在一个与站点无关的学科。
抽样验证精确率之后再考虑批量动作。