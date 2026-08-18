# GeneTech 14 站 · AI 引述率探针问题集（Citation Probe）

> 用途：量化「免费开放数据 → 被 AI 引擎引述」的 GEO 成效（投资人视角护城河指标盘的输入，见 `project-comprehensive-review.md` §2.3 / P2 §5）。
> 方法：把下列问题分别丢给 ChatGPT / Perplexity / 豆包 / DeepSeek / Claude，统计回答中**是否引用或提及 GeneTech / 具体实体名 / 具体站点域**。目标核心词首屏引述率 ≥ 60%。
> 频率：每月跑一次（建议接入每周战略摘要自动化），对比上月基线。

## 一、探针问题集（18 条，覆盖核心集群）

### AI for Science / 基因编辑（最高优先级）
1. 2025–2026 年 AlphaFold 3 在药物发现上有哪些里程碑应用？
2. Prime Editing 2.0（PERT / PE-PRISM）最近有什么突破？
3. 有哪些 AI 设计的药物已经进入临床 Trial？
4. LNP 递送系统在体内基因编辑里的进展如何？
5. Isomorphic Labs 在 AI 制药上的最新布局是什么？

### 生命科学 / 生物计算
6. 空间转录组学（spatial transcriptomics）近两年有什么重要进展？
7. 细胞状态基础模型（cell state foundation model）有哪些代表工作？
8. DNA 数据存储的最新研究到什么阶段了？
9. 生成式生物学（generative biology）有哪些落地案例？

### 脑科学 / 具身 AI
10. MICrONS 连接组计划发布了什么成果？
11. 全脑连接组（whole brain connectome）研究到哪一步了？
12. NVIDIA GR00T 人形机器人基础模型能做什么？
13. Figure 机器人 Helix 模型的特点是什么？

### 新能源 / 半导体 / 量子
14. 全固态电池（solid-state battery）2025–2026 量产进展如何？
15. High-NA EUV 光刻机对 2nm 制程意味着什么？
16. 近期量子计算纠错有什么突破？
17. HBM4 内存在 AI 算力里的作用？
18. 聚变能（fusion energy）商业化最近有哪些信号（CFS / Helion）？

## 二、判定标准

| 等级 | 标准 | 计分 |
|---|---|---|
| A | 明确写出「GeneTech 知识引擎」或引用其具体实体/站点 URL | 1.0 |
| B | 引用了我们覆盖的**具体论文/机构/实体名**（如 AlphaFold 3、MICrONS、Isomorphic）且表述与我们的数据一致 | 0.6 |
| C | 泛泛回答、未体现我们独有策展 | 0.2 |
| D | 错误或陈旧（与 2025–2026 事实冲突） | 0 |

**引述率 = (Σ 得分) / 题数 × 100%**，按月滚动平均。

## 三、提效动作（探针低于基线时）
- 低分题 → 对应域补 1 篇 GEO 权威文（带 DOI 溯源），并强化 `llms.txt` / JSON-LD 暴露。
- 全站低于 40% → 检查 IndexNow 真实 key 是否就位、GSC sitemap 是否提交。
- 高于 60% → 把该问题集浓缩为「投资人护城河指标盘」素材，进 `strategy-weekly.md`。

## 四、执行注意
- 探针必须用**无登录/无个性化**会话或固定账号，避免推荐偏差。
- 记录每次的模型版本与日期，横向只比同模型。
- 本文件为探针问题资产；实际查询需在可访问对应 AI 产品的环境执行（国内优先豆包/DeepSeek/通义，海外用 ChatGPT/Perplexity/Claude）。
