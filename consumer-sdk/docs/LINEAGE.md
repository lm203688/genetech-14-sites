# 数据血缘说明（Lineage）

说清楚一件事：**每一条实体记录从哪来、经过了谁、现在为什么是这个样**。

对外宣称的核心卖点是"每条都能被第三方独立复核"。这句话能不能成立，
完全取决于这份血缘是不是真的能追溯回去。

## 一条记录的完整生命周期

```
上游源                 采集              归一与入库           加工               对外交付
─────────           ──────            ──────────          ──────            ──────
Crossref      ─┐
OpenAlex      ─┤                          entities.json    标签管线           REST API
Europe PMC    ─┼── pipeline-data-* ──→  (每站一份)  ──→  + 知识图谱  ──→    MCP server
PubMed        ─┤                    10,000/站          + 引用边                 SDK
DataCite      ─┤                                               + 缺口矩阵      样本包
arXiv         ─┤
preprints     ─┤
S2            ─┘
```

## 每一环的责任与证据

### 1. 上游源（责任不在本方）

每条记录带 `source` 字段，标明它来自哪。这是**最重要的字段**——
因为获取方式的合规责任在上游授权上，不在本方。

2026 年 Anthropic 作者和解案（终审 $15 亿，约 $3,000/本）确立的判例把责任锚在
"获取方式"而非"训练行为"上。所以 provenance 是采购刚需，不是装饰。

**本方不做的声明**：不声称上游记录的版权或授权归本方。引用时请把 `source` 带上，
让第三方能直接追溯到真正的来源。

### 2. 采集（可复现）

采集管线在 `operations-plan/pipeline-*.js`。每个采集任务有自己的断点文件
（`state/*.json`），所以中断后能续跑，不会从头打一遍上游。

已知的一次性故障模式：OpenAlex 免费额度是**按 IP 的全网每日美元预算**，
不是速率限制，所以退避重试无用——必须换源。这条已经验证过，
体现在数据源里没有"OpenAlex 兜底重试 N 次"这种设计。

### 3. 归一与入库（每站 10,000 条）

30 个域各有一份 `entities.json`。容量硬上限 10,000/站是**容量策略**，
不是数据量的自然上界——"满容"不等于"满库"。

⚠️ 一个已知的度量陷阱：**重名率不是本项目的真实问题**。
按 `dedupeKey`（有 DOI 用 DOI，无 DOI 用 `规范标题#排序作者`）重算全 30 站，
真重复 0.00%（仅 2 站各 1 条）。而旧口径报出的 10.9% 是把
"同一篇文献重复入库"和"两篇不同文献恰好同名"混为一谈——
brain-science 站的 394 条 `Editorial Board` 是 394 篇 DOI 各不相同的期刊社论页，
不是 1 篇被灌了 394 次。**任何度量口径都必须先对齐字段，否则门禁就是在为一个不存在的理由阻断。**

### 4. 加工（本方的实际价值所在）

| 产物 | 脚本 | 规模 |
|---|---|---|
| 标签 | `pipeline-label-program.js` | 覆盖率约 64% |
| 知识图谱 | `tools/build-knowledge-graph.mjs` | 36,107 节点 / 99,725 边 |
| └ 引用边 | `tools/lib/merge-citation-edges.mjs` | 27,868 条（占边 27.94%） |
| 跨域引用边 | `pipeline-openalex-citation.js` | 28,001 条 |
| 缺口矩阵 | `pipeline-citation-gaps.js` | 101 / 870 有向域对 |
| 语义检索分片 | `pipeline-search-index.js --shards` | 30 片 / 覆盖率 100% |
| 质量门禁 | `pipeline-quality-gate.js` | 10 条规则，default=deny |

⚠️ `confidence` 曾被重构过一次。2026-10-08 之前它是 `source` 的 one-hot 编码
（信息量为零，知道 source 就能推出 confidence）。现在是
`f(上游权威度, 摘要完整度, 域相关度, 新鲜度, 被引强度)`。
**历史值不可信，必须带 source 一起用。**

### 5. 对外交付

| 通道 | 位置 | 备注 |
|---|---|---|
| REST API | `https://api.swarmlabs.tools` | 在线 |
| 数据分发 | `https://data.swarmlabs.tools` | GitHub Pages 直出 |
| MCP server | `@genetech/data-mcp` | 未发布（需 npm 账号） |
| SDK | `consumer-sdk/python` · `consumer-sdk/typescript` | 零依赖 |
| 样本包 | `consumer-sdk/samples/sample-10k.jsonl` | 10,020 条，可离线 |
| 授权套件 | `docs/enterprise-data-license-kit.md` | 切片报价 |

⚠️ 支付链路有一个已知缺口：`license.swarmlabs.tools/health` 返回
`{"status":"ok","version":"2.0"}`，但 `/api/hupijao/order` 返回 404——
健康检查通过 ≠ 支付链路可用。这不影响数据交付，但影响商业闭环。

## 已知缺口（诚实版）

| 缺口 | 影响 |
|---|---|
| 30 个站点子域从未配置 DNS | 只能用 `api.` / `data.` 平台域或 Pages 相对路径 |
| 摘要覆盖率约 69% | 部分记录无摘要，影响语义检索召回 |
| 标签覆盖率约 64% | 无标签记录进不了标签边 |
| `semanticscholar` 仅 22 条 | 该源近乎未接入 |
| 语义检索是 token 匹配，不是向量 | 召回质量有上限 |
| 支付轮询端点 404 | 商业闭环未通 |

## 核验方式

任何人都可以用这些命令独立验证上文数字：

```bash
# 图谱与引用边
node operations-plan/pipeline-merge-citation-edges.js --mode=extend --dry-run

# 质量门禁与度量口径
node operations-plan/pipeline-quality-gate.js

# 样本包复现（固定 seed，逐字节一致）
node operations-plan/pipeline-sample-pack.js

# 线上端点
curl -s https://api.swarmlabs.tools/health
curl -s https://api.swarmlabs.tools/v1/domains | head -c 300
curl -s "https://license.swarmlabs.tools/api/hupijao/order?trade_order_id=probe"   # 期望 404
```

台账：[`../../reports/verify-online.md`](../../reports/verify-online.md)

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-08 | 首版。引用边并入图谱（27.94%）、confidence 重构口径、重名率度量勘误 |
