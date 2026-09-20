# 引文完整性核验台账 — 2026-09-20

> 模式：**STRICT 硬门禁** · 生成时间：2026-09-20T00:11:47.739Z

## 汇总

| 指标 | 数值 |
|---|---|
| 扫描文件数 | 59 |
| 引文总数 | 192 |
| ✅ 存活（ok） | 130 |
| ↪ 重定向（redirect） | 0 |
| ❌ 死链（dead, 404/410） | 0 |
| 🚫 出版商拦截（blocked, 401/403/429/451） | 36 |
| ❓ 索引查无（unresolved） | 0 |
| 🔧 上游故障（server-error, 5xx） | 0 |
| ⚠ 本次不可达（unreachable） | 24 |
| 🔴 已撤回（retracted） | 0 |
| 引用逐条核验 | 0/1 verified · 1 mismatch · 0 unverified |

## ✅ 无死链、无撤回文献

## ⚠ 引文逐条核验未通过（引号文本未在原文中逐字命中）

| 文件:行 | 目标 | 引文片段 |
|---|---|---|
| `content\blog\life-science-2025-2026.md:42` | https://pubmed.ncbi.nlm.nih.gov/42557331/ | Virtual Tissues |

> 说明：此项为 best-effort 建议项（advisory），受目标页正文抓取限制，未通过≠引文有误，需人工复核。

## ⚠ 本次不可达（网络/代理/超时，非死链）

共 24 条，多为网络受限或目标超时，**不判定为死链**；下次运行会重试。

## 🚫 出版商/反爬拦截（blocked，非死链，不需处理）

共 36 条。多为出版商对 bot 返回 401/403/429/451（如 ScienceDirect、Wiley、Hindawi 对自动化请求恒 403），
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
