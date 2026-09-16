# 引文完整性核验台账 — 2026-09-16

> 模式：**STRICT 硬门禁** · 生成时间：2026-09-16T00:24:14.484Z

## 汇总

| 指标 | 数值 |
|---|---|
| 扫描文件数 | 57 |
| 引文总数 | 186 |
| ✅ 存活（ok） | 136 |
| ↪ 重定向（redirect） | 1 |
| ❌ 死链（dead, 404/410） | 0 |
| 🚫 出版商拦截（blocked, 401/403/429/451） | 33 |
| ❓ 索引查无（unresolved） | 0 |
| 🔧 上游故障（server-error, 5xx） | 0 |
| ⚠ 本次不可达（unreachable） | 14 |
| 🔴 已撤回（retracted） | 0 |
| 引用逐条核验 | 1/22 verified · 17 mismatch · 4 unverified |

## ✅ 无死链、无撤回文献

## ⚠ 引文逐条核验未通过（引号文本未在原文中逐字命中）

| 文件:行 | 目标 | 引文片段 |
|---|---|---|
| `content\blog\bio-ai-frontier-2025-2026.md:44` | https://lm203688.github.io/genetech-14-sites/search.html | AlphaFold 3 / 生成式生物学 / AI 设计药物 |
| `content\blog\biocomputing-2025-2026.md:61` | https://doi.org/10.1093/toxsci/kfag079 | 可学习、可 benchmark、可复现 |
| `content\blog\biocomputing-2025-2026.md:61` | https://doi.org/10.64898/2026.07.15.738660 | 可学习、可 benchmark、可复现 |
| `content\blog\biocomputing-2025-2026.md:69` | https://doi.org/10.1021/acssynbio.5c00925 | 储备池计算（reservoir computing） |
| `content\blog\gene-editing-2-0-2025-2026.md:45` | https://lm203688.github.io/genetech-14-sites/search.html | Prime Editing / LNP 递送 / 体内碱基编辑 |
| `content\blog\life-science-2025-2026.md:42` | https://pubmed.ncbi.nlm.nih.gov/42557331/ | Virtual Tissues |
| `content\blog\life-science-2025-2026.md:64` | https://doi.org/10.1093/nargab/lqag012 | 怎么评这批数据靠不靠谱 |
| `content\blog\life-science-2025-2026.md:72` | https://doi.org/10.2174/0109298673399575251122111729 | 生命科学里的 Transformer |
| `content\blog\quantum-error-correction-2025-2026.md:66` | https://lm203688.github.io/genetech-14-sites/search.html | Willow / Majorana 1 / 逻辑量子比特 / 表面码 |
| `content\blog\quantum-error-correction-2025-2026.md:66` | https://lm203688.github.io/genetech-14-sites/blog/index.html | Willow / Majorana 1 / 逻辑量子比特 / 表面码 |
| `content\blog\synbio-manufacturing-2025-2026.md:44` | https://doi.org/10.1016/j.biotechadv.2026.109001 | 可规模化生物制造 |
| `content\blog\synbio-manufacturing-2025-2026.md:54` | https://arxiv.org/abs/2607.20539v1 | 生物动力学知识先验 |
| `content\blog\synbio-manufacturing-2025-2026.md:64` | https://doi.org/10.1016/j.synbio.2026.04.021 | 从途径设计到高产菌株 |
| `docs\competition-2026\AUDIT-LOG.md:45` | https://export.arxiv.org/api/query?id_list= | source_url |
| `docs\competition-2026\TECH-DEEP-DIVE.md:149` | https://arxiv.org/abs/2401.12345 | source_url |
| `docs\references\creem-skill-reference.md:11` | https://api.creem.io | api_base |
| `docs\references\creem-skill-reference.md:12` | https://test-api.creem.io | test_api_base |

> 说明：此项为 best-effort 建议项（advisory），受目标页正文抓取限制，未通过≠引文有误，需人工复核。

## ↪ 重定向目标（建议更新为最终 URL）

| 文件 | 原目标 | 最终目标 |
|---|---|---|
| `docs\references\creem-skill-reference.md` | https://app.com/welcome | https://www.app.com/welcome |

## ⚠ 本次不可达（网络/代理/超时，非死链）

共 14 条，多为网络受限或目标超时，**不判定为死链**；下次运行会重试。

## 🚫 出版商/反爬拦截（blocked，非死链，不需处理）

共 33 条。多为出版商对 bot 返回 401/403/429/451（如 ScienceDirect、Wiley、Hindawi 对自动化请求恒 403），
DOI 已通过 OpenAlex 索引确认真实存在，**不判定为引文失效，门禁不阻断**。

## 口径说明

- **dead（死链）**：仅指 HTTP 404/410，即目标不存在或已永久移除。这是唯一会阻断门禁的 HTTP 问题。
- **blocked（拦截）**：401/403/429/451。出版商对 bot 拦截极常见，**不等于引文失效**，不阻断。
- **unresolved**：OpenAlex 索引中查无该 DOI，可能为新文献/预印本/录入笔误，需人工确认。
- **server-error**：5xx 上游临时故障，重试可能恢复，不阻断。
- **unreachable**：网络/代理/超时导致的取不到响应，**不判死**；下次运行会重试。
- **DOI 存活性主判据 = OpenAlex 是否有记录**（索引有记录即判 ok），不走 doi.org 浏览器路径（该路径对 bot 恒 403，会造成大面积假阳性）。
- **撤回判定**：OpenAlex `is_retracted`；retracted 会阻断门禁。
- **逐条核验**：仅当引文所在行含「…」或 "…" 引号时执行，每文件上限 `CITE_CLAIM_LIMIT`（默认 3）条；best-effort 建议项，未通过≠引文有误。
- **借鉴来源**：HyperResearch（jordan-gibbs/hyperresearch，MIT）的 cite-checker 机制，已本地化为零依赖 curl 实现。
