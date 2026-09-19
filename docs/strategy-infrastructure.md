# SwarmLabs 基础设施战略定位（2026-09-19）

## 一句话

SwarmLabs 从「30 领域知识引擎」升级为「**信息收集 + 结构化**的基础设施项目」——**广度做深**（持续开源平台扫描 + 结构化入库），**接口做规范**（OpenAPI 3.1 + 三档 API key），**边界做清晰**（不与下游项目混合，通过规范接口输出价值），**护城河做厚**（数据规模 100k → 1M → 10M 实体）。

## 三条下游消费者（价值锚点）

| 消费者 | 需要什么 | 我们提供什么 | 数据源 |
|---|---|---|---|
| 小模型（ornith-1.5:35b 等） | 专业领域知识库，避免幻觉 | 结构化实体 + 摘要 + 引用链 | `entities.json` + `oss-registry.json` |
| 蜂群科技（SwarmLabs） | 30 领域趋势 / 研究空白 / 跨域桥接 | 全量结构化数据 + API 网关 | 同源 CDN 30 站 + `slb_` key |
| 机器人项目（RoboParts） | 最新发展 + 路线建议 | embodied-ai 领域 + OSS 项目扫描 + 维护状态 | `oss-registry.json` 中 `domain_tags=embodied-ai` |
| 外部付费客户 | 结构化数据订阅 | REST API + OpenAPI 规范 + SLA | `gtk_` Pro key |

**共同点**：下游不需要训练/推理能力，也不需要我们承担业务逻辑——**我们只做信息收集与结构化**，价值随数据规模线性增长。

## 两路径执行

### 路径一：广度 + 深度（信息收集能力）

**已具备的信号源**（`operations-plan/pipeline-domain-expansion.js` + `pipeline-intelligence.js`）：
- arXiv 12 分类（cs.AI / cs.CL / cs.CV / cs.LG / cs.IR / cs.RO / cs.SE / cs.DB / cs.CR / cs.HC / cs.CY / cs.NE）
- Semantic Scholar API（限流 100/5min 未认证）
- Papers with Code
- HuggingFace Papers
- GitHub 搜索（trending / topic / repo metadata）

**2026-09-19 新增**（`operations-plan/pipeline-oss-scan.js`）：
- GitHub trending（7 topic 每日）
- HuggingFace models（5 tag 每日，按 downloads 排序）
- HuggingFace datasets（5 tag 每日）
- Papers with Code（best-effort，5xx 视为 miss）
- 输出：`data/oss-registry.json`（累计全量）+ `reports/oss-scan-YYYY-MM-DD.json`（当日快照）+ `reports/oss-scan-trend.json`（趋势 delta）

**结构化字段**（30 个）：
- 通用：`id / source / name / url / description / domain_tags[] / first_seen_at / last_seen_at / maintenance_status`
- GitHub：`stars / forks / watchers / language / topics[] / license / first_commit_date / last_commit_date / pushed_at / archived / open_issues`
- HF models：`downloads / likes / framework / task_type[] / pipeline_tag / tags[] / created_at`
- HF datasets：`downloads / likes / task_category[] / modality[] / tags[] / created_at`
- PWC：`arxiv_id / citations / code_repos[]`

**深度**：为三个重点方向（`embodied-ai` / `llm-frontier` / `agent-ecosystem`）建立 domain-specific 深度采集，通过 `DOMAIN_MAP` 自动打标，趋势报告按 domain 聚合。

**规模目标**：
- 2026-12-31 前：`oss-registry.json` 50k+（覆盖 GitHub top 10k + HF top 5k + PWC top 3k）
- 2027-06-30 前：100k+
- 2028 目标：500k+ 开源实体 + 1M+ 站点实体

### 路径二：规范接口 + 独立性边界（对外服务能力）

**接口规范**（`openapi.yaml`）：
- OpenAPI 3.1，9 条 endpoint，5 个 schema
- 三档 API key 商业模型：
  - **Free**（无 key）：60 req/min，仅元数据 + 前 100 条实体
  - **Partner**（`slb_` 前缀）：120 req/min，实体 + 领域读权限，供蜂群科技等合作方
  - **Pro**（`gtk_` 前缀）：600 req/min，全字段 + 语义搜索 + 引用导出，¥39.9 / Pro，¥199 终身
- HMAC 签名密钥：Pro = `PRO_SECRET` / Partner = `GATEWAY_SECRET`（独立）

**独立性边界**（本项目做 vs 不做）：

| 做 | 不做 |
|---|---|
| 信息收集（GitHub / HF / arXiv / Crossref / EuropePMC / PWC） | 模型训练 / 微调 |
| 结构化入库（entities.json + oss-registry.json） | 模型推理 / 部署 |
| API 网关（REST + MCP + Partner 独立网关） | 商业数据加工 / 合规 |
| OpenAPI 规范 + SDK | 下游项目鉴权（保持独立） |
| 数据趋势报告（跨轮 delta） | 项目特定业务逻辑 |

**边界的技术实现**：
- 独立仓库：`genetech-14-sites`（本站） + `swarmlabs-engine-kit`（MIT 开源） + `roboparts`（机器人项目独立仓）
- 独立 API key 前缀：`gtk_` / `slb_` / 无 key（三档不共享 HMAC 密钥）
- 独立限流桶：`free:<ip>:<min>` / `gw:<clientId>:<min>` / `pro:<key>:<min>`
- 独立部署：`genetech-api-guard` Worker / `swarm-labs-gateway` Worker / `roboparts-api`（待建）

**对外接口清单**（OpenAPI 3.1 已定义）：
- `GET /v1/entities` — 实体列表
- `GET /v1/entities/{id}` — 实体详情
- `GET /v1/domains` — 领域元数据
- `GET /v1/domains/{slug}` — 领域详情
- `GET /v1/oss/registry` — 开源注册表
- `POST /v1/search/semantic` — 语义搜索（Pro only）
- `POST /v1/license/verify` — 许可校验
- `GET /v1/license/quota` — 配额查询
- `GET /health` — 健康检查（无需 key）

## 数据护城河路径

```
    当前（2026-09）       中期（2027）        长期（2028+）
    ─────────────        ─────────────       ─────────────
    30 站 300k 实体       30 站 1M 实体        50 站 10M 实体
    + 100k OSS 项目       + 500k OSS 项目      + 5M OSS 项目
    + 47k 结构化实体      + 200k 结构化实体     + 5M 结构化实体
    ─────────────        ─────────────       ─────────────
    支付链路（虎皮椒）     三档 API key 全通    Enterprise 定制
    Free/Partner/Pro     + Glama / Smithery    + 行业垂直订阅
    ─────────────        ─────────────       ─────────────
    竞争点：数据广度      竞争点：接口规范      竞争点：数据规模 + 生态
```

**不可达替代**（护城河逻辑）：
1. **数据规模**：10M+ 实体是别人短期无法复制的
2. **结构化字段**：30+ 字段的规范化比纯爬虫数据价值高 10x
3. **规范接口**：OpenAPI 3.1 + 三档 key 让任何 agent 都能自助接入
4. **开源生态**：MIT 许可证 + `swarmlabs-engine-kit` 开源工具，形成开发者生态
5. **每日增量**：`oss-scan` 每日扫描 + 趋势报告，数据是"活的"不是"死的"

## 后续 6 周路线图

| 周 | 任务 | 产出 |
|---|---|---|
| W1 (09-19~09-25) | OSS 扫描上线 + OpenAPI 规范 + 战略文档 | `pipeline-oss-scan.js` / `openapi.yaml` / 本文档 |
| W2 (09-26~10-02) | 部署 `swarm-labs-gateway` + `PRO_SECRET` 补齐 + `genetech.tools` CNAME 补建 | Partner 网关可用 |
| W3 (10-03~10-09) | OSS 扫描扩源：arXiv trending + Semantic Scholar 每日 | 5 源每日自动扫描 |
| W4 (10-10~10-16) | 为 `embodied-ai` / `llm-frontier` / `agent-ecosystem` 3 个重点领域加深度采集 | 3 领域数据完整度提升 |
| W5 (10-17~10-23) | SDK 补：Python + TypeScript 双语言 SDK（基于 OpenAPI 生成） | `swarmlabs-engine-kit` 加 SDK |
| W6 (10-24~10-30) | Glama / Smithery 平台登记 + GSC 搜索验证 + 官网更新 | 对外品牌全通 |

## 商业模式（三档 API key + 数据护城河）

| 档位 | Key 前缀 | 单价 | 目标客户 | 预计年收入（保守） |
|---|---|---|---|---|
| Free | 无 | 0 | 学生 / 独立开发者 | 0 |
| Partner | `slb_` | 协商（¥5000-¥50000/年） | 蜂群科技 / 机器人项目等 5-10 家 | 5-10 万元 |
| Pro 月付 | `gtk_` | ¥39.9/月 | 商业 API 消费者 | 5-20 万元（200-500 用户） |
| Pro 终身 | `gtk_` | ¥199/次 | 一次性付费 | 5-15 万元（300-750 单） |
| Enterprise | 定制 | ¥50000+/年 | 大机构定制数据订阅 | 30-100 万元（3-10 家） |

**关键洞察**：单点 Pro 收入天花板低（¥39.9 × 500 = 2 万/年），真正价值来自 **Partner + Enterprise 数据订阅**。护城河随数据规模线性增长——10M 实体时，Enterprise 客户会愿意付 5-10 万/年订阅独家数据。

## 关键风险与对冲

| 风险 | 影响 | 对冲 |
|---|---|---|
| 国内网络被墙（`*.workers.dev` 全 502） | 国内支付/API 不可用 | 走 `swarmlabs.tools` CNAME（已生效，海外用户可用）；如需国内可用，需自建国内 CDN + Worker 回源 |
| 数据规模超 Pages 1GB 上限 | 无法继续增长 | 归档分页懒加载（`data/` 分片 + `reports/` 增量）；`oss-registry.json` 独立于站点，不受 Pages 约束 |
| API key 泄露 | 未授权访问 | HMAC + 独立密钥 + KV 吊销（`revoked:<clientId>` 写入即生效） |
| 上游 API 限流 | 数据采集不完整 | 单源失败不阻断其他源（`STRICT_OSS_SCAN=1` 可选）；cursor 幂等，miss 自然重试 |
| 竞品（Scite / Semantic Scholar / Papers with Code） | 用户选择竞品 | 差异化：跨域桥接 + 30 领域结构化 + 蜂群/机器人垂直数据，非通用学术搜索 |

## 一句话总结

**SwarmLabs 现在是「30 领域 + 100k OSS 项目」的结构化信息基础设施；随数据规模增长，护城河线性加厚，通过 OpenAPI 3.1 + 三档 API key 规范接口服务下游，永不与消费者项目混合——这是数据规模型基础设施项目的标准打法，也是唯一能形成"无法替代"护城河的路径。**
