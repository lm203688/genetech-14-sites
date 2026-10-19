---
title: 基因编辑 2.0：体内编辑、Prime Editing 与 LNP 递送的 2025–2026 突破
desc: 2025–2026 年基因编辑从「敲除」走向「精准修正 + 体内递送」。本文梳理 Prime Editing 三连击（PERT / PE-PRISM / PE-LNP）、LNP 体内递送主流化、以及临床转化加速，并说明如何用 GeneTech 知识引擎跟踪基因工具前沿。
date: 2026-08-14
keywords: 基因编辑, Prime Editing, PERT, LNP 递送, 体内编辑, 碱基编辑, 基因治疗, 知识引擎
---

基因编辑正在经历从「1.0 敲除」到「2.0 精准修正 + 体内递送」的跃迁。2025–2026 年的关键信号不是某一项实验更漂亮，而是**精准编辑的化学、递送的载体、临床的节奏，三条线同时成熟**——这让「一次治疗、永久修正」从罕见病走向更大众的适应症。

## 一、Prime Editing 三连击（David Liu 实验室，2025–2026）

Prime Editing（先导编辑）由 David Liu 团队发明，能在不造成 DNA 双链断裂的前提下完成所有 12 类单碱基转换与小额插入缺失，安全性优于传统 CRISPR 核酸酶。2025 下半年到 2026 年，该团队连发三项里程碑：

- **PERT**（Prime Editing-mediated Readthrough of Premature Termination Codons），*Nature* 2025（DOI: 10.1038/s41586-025-09732-2）：不逐个修正突变，而是用先导编辑把内源 tRNA 改成「抑制型 tRNA」，通读提前终止密码子——一种**与具体突变无关**的广义遗传病策略；在 Hurler 综合征小鼠模型中实现近完全病理 Rescue。
- **PE-PRISM**（*Nature Biotechnology* 2026，DOI: 10.1038/s41587-026-03123-2）：高通量平台，定向进化出更优的 pegRNA 设计，把编辑效率显著推高。
- **PE-LNP**：高效非病毒脂质纳米颗粒体内递送系统，解决「体内怎么送进去」这一临床转化最后一步。

## 二、LNP 递送成为体内编辑主流

脂质纳米颗粒（LNP）凭「瞬时暴露、可量产、天然肝向性、可重复给药」的优势，成为 2025 年体内编辑的主角：

- **Verve VERVE-101**（Phase 1b HEART-1）：体内碱基编辑 PCSK9，高剂量组 LDL 胆固醇降低 39%–55%（2025 投资者更新）；VERVE-102 优化肝靶向配方 2025 年进临床。这把基因编辑从罕见病推向心血管这种大适应症。
- **NTLA-2001**（Intellia）：已验证 LNP 用于体内 CRISPR 治疗 TTR 淀粉样变，为同类打开大门。
- **个性化体内 CRISPR**（CHOP + NIH，2025）：为一名 CPS1 缺乏症婴儿定制碱基编辑疗法，LNP 包裹、数月内完成从设计到给药——「therapy-for-one」的可复制模板。
- **PE7 + mRNA–LNP**（2025）：在苯丙酮尿症小鼠模型中编辑率达 20.7%，血苯丙氨酸降至治疗阈值以下。

## 三、临床转化节奏明显加速

- **Prime Medicine**：2024 年启动首批临床试验，AATD 与 Wilson 病项目预计 2026 年中提交 IND/CTA。
- **Casgevy**（2024）：全球首个 CRISPR 药物获 FDA 批准，确认监管对基因编辑疗法的接受度。
- 行业共识（2025 *Nature Biotechnology* 综述）：高保真 Cas9、碱基编辑、先导编辑的脱靶率比一代 Cas9 低数倍，临床体内应用的安全门槛被实质性抬高。

## 四、对基因工具知识跟踪的启示

基因编辑 2.0 的难点在于**跨域**：化学（pegRNA 设计）、材料（LNP 配方）、临床（适应症选择）、监管（个体化 CMC）同时演进。任何单一信息源都难追上。更稳的做法是把这些进展做成**结构化、带来源、可批量导出的实体库**，让 Agent 在综述或立项时直接调用。

### 如何用 GeneTech 跟踪基因工具前沿

通过一行命令接入 GeneTech 的基因工具（genetech-tools）、生命科学（life-science）、生物计算（biocomputing）等垂直域结构化知识：

```
npx -y @genetech/data-mcp
```

或在 [GeneTech 全局搜索](https://lm203688.github.io/genetech-14-sites/search.html) 检索「Prime Editing / LNP 递送 / 体内碱基编辑」，每条实体都带原始论文链接与置信度，可溯源、可导出 BibTeX。

> 我们的护城河四句：**Agent 原生 · 垂直策展 30 域 · 微信/支付宝买断（¥9.9 起）· 开放结构化数据可被 AI 直接调用**。

*本文基于 2025–2026 年公开论文与报道整理（David Liu 实验室 PERT/PE-PRISM/PE-LNP、Verve、Intellia、Prime Medicine、CHOP+NIH 等），具体数据请以原始论文为准。GeneTech 知识引擎持续收录基因编辑方向的入库实体。*
