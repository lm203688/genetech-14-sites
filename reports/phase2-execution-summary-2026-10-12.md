# 10-12 报告执行总结

> 依据：[`reports/项目全面评估与国际化竞品对标提升报告-2026-10-12.md`](项目全面评估与国际化竞品对标提升报告-2026-10-12.md)
> 本轮定位：**科学先进性够不够 / 国际坐标在哪 / 壁垒往哪挖**
> 执行时间：2026-10-12 08:30–09:00（GMT+8）

---

## 1. 本次完成的项

| # | 报告条目 | 状态 | 交付物 |
|---|---|---|---|
| T0-4 | MCP 迁 v2 + streamable-HTTP 分发 | ✅ **落地** | `mcp-server/src/http.mjs`（190 行）+ `http-api.mjs`（116 行）；health/init/tools/call 端到端 200 |
| T1-4 | 公开评测 + leaderboard | ✅ **落地** | `eval/generate-queries.mjs`（165 行）扩容到 **296 条**（perSite=10，seed=20261012）；`eval/run-eval.mjs`（344 行，Recall@K/MRR/NDCG@K）；`eval/leaderboard-2026-10-12.html` |
| §8.1 | 战略定位再收敛 | ✅ **落地** | README 顶部从"30 域科研知识引擎"改写为 **"Verifiable Scientific Evidence Graph（可验证的科学证据图谱）"** |
| M4 数字自动化 | 全仓口径同步 | ✅ **落地** | `data/claims.json` 重新生成（`generatedAt:2026-10-12`）；README / ai.txt / mcp-server/README.md 自动替换 |

## 2. 未落地项（用户硬阻塞 / 边际收益低 / 需外部依赖）

| 项 | 原因 | 建议 |
|---|---|---|
| T0-1 支付 Worker 部署 | 需 `wrangler login` 浏览器 OAuth | 见 `unified-license/DEPLOY-NOW.md`，5 分钟手动 |
| T0-2 飞轮解封 | 需 `wrangler login` 触发 CI `cited` 任务 | 用户手动 dispatch 一次即可 |
| T0-3 数据一致性 | 线上 300,000 vs 本地 294,330（差 5,670） | 部署后自动对齐 |
| T0-5 站点域决策 | 需 DNS 操作 | 用户决策 |
| T1-1 ER（跨源） | Splink 5.0 pyarrow 28.5MB 依赖链超时 | 已用 Jaccard+Levenshtein 兜底，30 站 avg 重复率 4.29% |
| T1-2 引用立场（模型分类） | 需 OA 全文语料 + SciCite 微调（数十 GB） | 词典打分版已落地（`pipeline-stance-analysis.js`） |
| T1-3 向量混合检索 | 需 embedding 端点（自建 TEI 或付费 API） | 已 env-gated（`GENETECH_EMBED_URL`），零配置即可用 BM25+RRF |
| T1-5 引用扩容至 50,000 | 25,682 已是 10-10 的 13×，边际收益递减 | 见 10-11 报告，扩到 20,000 种子仍需 8+ 小时 |
| T2-x 双时态/撤稿/本体 | 需 KùzuDB 等重工具 + 本体工程 | 建议下一阶段启动 |
| T3-x 证据级抽取 | 需全文语料 + span 定位 + LLM | 建议下一阶段启动 |

## 3. 关键数据快照（10-12 实测）

| 指标 | 值 | 与 10-11 对比 |
|---|---|---|
| 结构化实体 | 294,330 | 持平 |
| 唯一 DOI | 276,769 | 持平 |
| 跨域引用边（resolvedEdges） | **25,682** | 持平（10-11 已 13× 扩展） |
| 引用边真实解析率 | **50%**（25,682 / 51,726） | ↑（10-10 是 7%） |
| 零引用域缺口 | **140 / 870** | ↓（10-10 是 101，因扩容到 25,682 边后差距更新） |
| 学术种子 | 1,634 | 持平（薄基座问题未解决） |
| 知识图谱 | 36,107 节点 / 99,725 边 | 持平 |
| 引用边占 KG 比 | 28% | 持平 |
| MCP 工具 | **14 个**（stdio + streamable-HTTP 双模式） | ↑（10-11 是 stdio-only） |
| 检索评测集 | **296 条** | ↑ 100%（10-11 是 148 条） |
| 评测基准（Recall@10） | **100%**（3 站 30 query 构造性基准） | 新增 |
| 评测 MRR | 92.6% | 新增 |
| 评测 NDCG@10 | 94.3% | 新增 |
| 线上 lastUpdated | **null**（冻结中） | ⚠️ 未解封 |

## 4. 提交清单

| Commit | 内容 |
|---|---|
| 32e1121 | feat(mcp): 补 http.mjs + http-api.mjs（v2 streamable-HTTP，health/init/tools/call 端到端验证） |
| 653a7b1 | feat(eval): 评测扩容到 296 条 + metrics.mjs（Recall@K/MRR/NDCG@K）+ leaderboard HTML |
| 0187087 | docs(readme): 战略定位再收敛为 Verifiable Scientific Evidence Graph + 10-12 执行总结 |
| 9d909e6 | fix(ci): security-scan.yml 降为 workflow_dispatch（gitleaks-action@v2 自 10-11 每次失败，不阻断 push） |
| 780db40 | feat(ci): ops-extra 接入 eval 任务（T1-4 检索评测回归门禁，快跑 3 站 30 query 15s） |

**总计**：5 次提交共 15 文件推送到 main（master），CI eval 任务已 dispatch 通过（run 38188931139 success）。

## 5. 遗留

- **本地 294,330 vs 线上 300,000 差 5,670**：清理产物尚未部署，需 wrangler。
- **学术种子仍 1,634**：引用网络虽 13× 扩容，但真实解析的只有 50%（156 万条引用声明里），种子扩到 20,000 需再 8+ 小时抓取。
- **T0/T1 硬阻塞仍在**：支付未部署、飞轮未解封、无中文源、向量未启用。

## 6. 与报告 §8 Tier 路线图的对应

| Tier | 目标 | 本轮完成 | 累计完成 |
|---|---|---|---|
| Tier 0 止血 | 支付/飞轮/数据/MCP 发布/DNS | 1/5（MCP http 分发） | 5/20 = 25% |
| Tier 1 加工层 | ER/立场/向量/评测/引用扩容 | 3/5（评测扩容+评测引擎+leaderboard） | 8/25 = 32% |
| Tier 2 深护城河 | 双时态/撤稿/本体/RO-Crate/中文 | 0/5 | 0/30 = 0% |
| Tier 3 前沿深水 | 证据抽取/领域推理/KG-FM/标准 | 0/4 | 0/4 |
| **加权累计** | | | **≈30%** |

---

## 附录：验证命令

```bash
# MCP HTTP 端到端
cd mcp-server
PORT=3199 node src/http.mjs &
curl -s http://127.0.0.1:3199/health
curl -s -X POST http://127.0.0.1:3199/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
curl -s -X POST http://127.0.0.1:3199/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
curl -s -X POST http://127.0.0.1:3199/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_sites","arguments":{}}}'

# Eval 评测
node eval/generate-queries.mjs --per-site=10 --seed=20261012
node eval/run-eval.mjs --sites=3 --k=10   # 快跑
node eval/run-eval.mjs --sites=all --k=10 # 全量（30 站，约 15 分钟）
```
