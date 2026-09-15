# 外部成果包扫描与引用报告（2026-09-15）

扫描对象：`核心工作成果包_20260915.zip（9.zip`（9.6MB / 395 目录 / 2439 文件）
结论：**5 项已引用，其余为旧架构冗余或与本项目无关，未引用**。

---

## 一、已引用（5 项）

### 1. 发明专利申请包 → `docs/patent/`（最高价值）

| 项 | 内容 |
|---|---|
| 发明名称 | 一种基于 DMTL 闭环和 Arrhenius 方程的化学实验优化方法及系统 |
| 官方格式 XML | 6 个，全部通过 `xml.etree` 解析校验，根节点 `http://www.cnipa.gov.cn/patent/xml/standard...`（国知局标准） |
| 附图 | 5 张 JPG（整体流程 / 3 轮 DMTL 迭代 / 收敛折线 / Arrhenius 计算 / 系统架构） |
| 申报指南 | 完整流程 + 费用表（申请 ¥900 / 实审 ¥2500，个人可减缴 85% 至 ¥142.5）+ 时间线 + 检查清单 |
| 排错 | `XML格式问题解答.doc` |

共 14 文件 / 560KB。`专利申请全包.zip` 因仓库 `*.zip` 全局忽略而未入库——它是上述文件的打包副本，删掉 6 个单文件冗余 zip 后无任何数据损失。

**意义**：这是本项目唯一具备「可申请的知识产权」形态的资产，把 DMTL 闭环（广撒网→贝叶斯→精细搜索）+ Arrhenius 速率常数集成 + 催化剂/溶剂差异化建模 + 独立 Reviewer 偏差标记 + 逆合成规划固化为 8 项权利要求。30 万实体的数据护城河目前无知识产权保护，这是缺口。

**注意**：专利请求书需填申请人/发明人信息后才能提交；发明人必须是自然人。费用与减缴资格属账号侧操作。

### 2. 实体跨域图谱 → `data/knowledge-graph-entities.json`（925KB）

4075 实体节点（11 域）+ **50 条跨域桥接边**，如「量子算法 → BCI 信号处理」「solar → storage」。

- **已接入**：`agent-discovery.json` 的 `cross_domain_links` 字段直接引用这 50 条边。
- **诚实标注**：该图的节点 URL 指向旧版 12 站架构页面，现行 v3 站点实测 **全部 404**（已实测 `genetech/entity/btc-crispr-ther.html` 与 `agent-ecosystem/entity/...` 均 404）。因此构建器在 `cross_domain_links_note` 中显式声明：只把 `relation`/`label` 当跨域桥接**设计参考**，实体定位改用 `api/topics.json`。
- **不是缺口**：本项目现有活图谱（`_site/api/graph.json`）已有 260 节点 / **2192 条主题共现边**，比这份更密。此资产价值在于**实体级**跨域关系定义，而非替换现有图谱。

### 3. Agent 发现清单生成 → `tools/build-site.mjs`（新功能）

`agent-discovery.json` 是 agent-native 发现标准，旧版 12 站每站手写一份，v3 构建器未迁移，`operations-plan/closed-loop-engine.js:210` 一直把它列为待办。现由构建器自动生成，schema 1.1：

```
schema_version / site_name / domain / tagline / last_updated
total_entities(300000) / total_sites(30)
sites{slug: {label, entities, api}}          ← 30 站逐站实体数与 API 地址
api_endpoints{15 项：catalog/topics/graph/authors/timeline/insights/stats/
              webmcp/faq/service/llms_txt/sitemap/rss/license + mcp_install}
quality{abstract 61.5% / authors 74% / doi 83.3% / tags 28.1%}
sources[8 源] / data_license: CC-BY-4.0
ai_agent_instructions（可直接投喂 agent 的调用说明）
cross_domain_links[50] + cross_domain_links_note（失效引用显式声明）
```

**验证**（本地构建 + 自定义域参数）：14 个 URL 型端点 + 30 个站点 API 全部指向 `https://data.swarmlabs.tools`，无 `undefined` 残留，`node --check` 通过。

### 4. 社媒违禁词表 → `operations-plan/promo-banned-words/`

`xhs-banned-words.md`（2.1KB）+ `jike-banned-words.md`（494B）。本项目此前无合规词表，GEO 推广管线产出内容时缺这道过滤。

### 5. Creem 支付能力参考 → `docs/references/creem-skill-reference.md`（1017 行）

Merchant of Record 完整指南（订阅 / 税务合规 / 拒付 / 结算，`api_base https://api.creem.io`）。仅作**参考**放入 docs，**未安装为 skill**（外部厂商文档，未走安全审计，不可当可信指令执行）。

> 源路径 `.creem/skills/SKILL.md` 原位于 zip 的 `external-projects/` 同级，但该目录在本仓库 `.gitignore:74` 被整体忽略，故改落到 `docs/references/` 才能入库。

---

## 二、未引用（附原因）

| 项 | 原因 |
|---|---|
| 30 个子站目录（brain-science 等，各 87–132 文件） | **旧架构产物**。zip 版是「每站独立 `website/` + 手写 entity HTML」，项目已升级为数据驱动构建（`structured-data.json` + `build-site.mjs`）。拉入会架构回退。 |
| `skills/`（39 个技能，2.3MB） | 零重叠（本机已装 22 个，无重名），但属**外部未审计内容**。安装需走 skills-security-check 审计流程，本轮未做。 |
| `oraclemind/` | **含真实 GitHub PAT**（`oraclemind/.git/config`）；且属用户已排除项目 |
| `swarmlabs*/`、`aishield/` | 属其他项目（已排除），应留在各自仓库 |
| `kb-workflow/deep-mine/`（20 个挖矿脚本） | 6 月旧原型，项目已有 `operations-plan/pipeline-*.js` 管线替代 |
| `bees/`、`physics/`、`pharma/` 引擎脚本 | 旧引擎原型，被 `api_server_v3.py` 等取代 |
| `TOOLS.md`、`AGENTS.md` 等 agent 配置 | **含真实凭证**（2 个 GitHub PAT + 1 个 CF token），不进 git |

---

## 三、引用过程中发现的全站级缺陷（已修复）

验证 `agent-discovery.json` 线上产物时发现：`catalog` 端点是 `http://data.swarmlabs.tools/api/catalog.json`（HTTP，非 HTTPS）。

**根因**：GitHub Actions 的 `pages.outputs.origin` 恒返回 `http://` 且不做 scheme 升级，`build-site.mjs:49` 原样采用。

**影响面（D1 自定义域上线后一直存在，此前未被发现）**：`robots.txt` 的 `Sitemap:` 与 `LLMs.txt:`、`llms.txt` 内 89 处 URL、每站 `canonical` / `og:url` / JSON-LD `DataDownload.contentUrl`、`sitemap.xml`、`ai/summary.json` —— 全站绝对 URL 均为 `http://`。搜索引擎与 GEO 抓取器优先收录 https，这直接压制 D1 期望的「GEO 38 → 60+」提升。

**修复**：`build-site.mjs` 新增 `upgradeToHttps()`，对非 localhost 的 `http://` 统一升级为 `https://`；并把 `contentUrl` 从直接用 `SITE_ORIGIN` 改为用 `ORIGIN`（消除双源）。

**验证**（用 CI 实际传入的 `SITE_ORIGIN=http://data.swarmlabs.tools` 模拟构建 818MB 全量产物）：

| 产物 | 结果 |
|---|---|
| `robots.txt` | 2 处 URL 全 https |
| `llms.txt` | 89 处 URL 全 https |
| `index.html` canonical | `https://data.swarmlabs.tools/` |
| `sitemap.xml` `<loc>` | 全 https |
| `agent-discovery.json` | 14 个 URL 端点全 https |
| 全量产物 `http://data.swarmlabs.tools` 残留 | **0 个文件** |

---

## 四、安全发现（需你处理）

扫描发现该 zip 内含 **3 处明文凭证**，**均未**被引用进项目：

| 位置 | 类型 | 状态 |
|---|---|---|
| `oraclemind/.git/config` | GitHub PAT | 未引用 |
| `TOOLS.md` | GitHub PAT | 未引用 |
| `TOOLS.md` + `kb-workflow/reports/traffic-report.md` | Cloudflare API token | 未引用 |

**建议**：这 3 个凭证已长期存在于明文备份包中，应视为**已泄露**，建议在 GitHub / Cloudflare 后台轮换。项目内引用前已做两轮凭证扫描（引用前 0 命中、落盘后 0 命中）。
