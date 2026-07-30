# GeneTech 14站知识引擎 — 闭环运营方案

> 每项工作都形成完整闭环：收集 → 分析 → 决策 → 开发 → 测试 → 部署 → 验证反馈

## 七阶段闭环框架

所有工作均遵循统一的七阶段闭环，确保从信息采集到部署上线再到效果确认的完整链路：

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  收集   │ →  │  分析   │ →  │  决策   │ →  │  开发   │ →  │  测试   │ →  │  部署   │ →  │  验证   │
│ Collect │    │ Analyze │    │ Decide  │    │ Develop │    │  Test   │    │ Deploy  │    │ Verify  │
└─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘
  多源采集      结构化处理     明确采纳       执行开发       自动验证       上线发布       效果确认
  原始信号      价值评估       生成任务       代码/内容      效果校验       监控告警       回退修正
                                                                      ↑ 不达标则回退到对应阶段
```

## 六大闭环概览

| 闭环 | 目标 | 定时 | 脚本 |
|------|------|------|------|
| 数据积累 | 增加数据量 | 每日 23:00 | `closed-loop-engine.js --loop=data-accumulation` |
| 领域开拓 | 增加板块 | 每周一 23:30 | `closed-loop-engine.js --loop=domain-expansion` |
| 技术提升 | 能力提升 | 每周一 23:30 | `closed-loop-engine.js --loop=tech-adoption` |
| 推广增长 | 指导方向 | 每日 23:00 | `closed-loop-engine.js --loop=promotion` |
| 竞品情报 | 指导方向 | 每周一 23:30 | `closed-loop-engine.js --loop=intelligence` |
| 变现拓展 | 增加变现 | 每月 1 日 23:30 | `closed-loop-engine.js --loop=monetization` |

## 闭环飞轮

```
                    ┌──────────────┐
                    │  数据积累    │ 增加数据量
                    │  每日 23:00  │
                    └──────┬───────┘
                           │ 新内容
                    ┌──────▼───────┐
                    │  推广增长    │ 指导方向
                    │  每日 23:00  │
                    └──────┬───────┘
                           │ 流量/反馈
                    ┌──────▼───────┐
                    │  竞品情报    │ 指导方向
                    │ 周一 23:30   │
                    └──┬───┬───┬───┘
                       │   │   │
          ┌────────────┘   │   └────────────┐
          │                │                │
   ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
   │  领域开拓   │  │  技术提升   │  │  变现拓展   │
   │  增加板块   │  │  能力提升   │  │  增加变现   │
   │ 周一 23:30  │  │ 周一 23:30  │  │ 1日 23:30   │
   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
          │                │                │
          └────────────────┼────────────────┘
                           │
                    回到数据积累（新数据/新能力/新渠道）
```

## 各闭环六阶段详解

### 闭环一：数据积累（增加数据量）

| 阶段 | 动作 |
|------|------|
| 收集 | arXiv 论文、PubMed 文献、GitHub 仓库、HuggingFace 模型、OpenAlex 引用 |
| 分析 | 去重（DOI/arXiv ID）、字段标准化、分类到14站、质量评分 |
| 决策 | 筛选置信度≥0.7、识别增量项、生成更新清单、标记热点 |
| 开发 | 更新 entities JSON、更新 index.json、生成详情页、更新 data.js |
| 测试 | 校验计数一致性、验证 JSON 格式、检查必填字段、运行一致性脚本 |
| 部署 | Git 提交、Cloudflare 部署、IndexNow 提交、更新 changelog |

### 闭环二：领域开拓（增加板块）

| 阶段 | 动作 |
|------|------|
| 收集 | arXiv 新分类、GitHub Trending topics、Google Trends、市场空白信号 |
| 分析 | 论文增速、仓库增速、搜索趋势、社区热度、关联度 → 综合得分 |
| 决策 | 筛选得分≥0.75、生成站点定义、确定配置、创建任务清单 |
| 开发 | 创建目录结构、生成配置文件、复制模板、预填充数据、生成 llms.txt |
| 测试 | 验证目录结构、检查配置、验证页面可访问、测试数据加载 |
| 部署 | 配置 Cloudflare Pages、设置 DNS、Git 提交、触发部署、提交索引 |

### 闭环三：技术能力提升（能力提升）

| 阶段 | 动作 |
|------|------|
| 收集 | NLP/KG/数据分析新论文、GitHub 新工具、技术博客、HuggingFace 新模型 |
| 分析 | 评估改进潜力、计算性能提升、评估集成复杂度、检查许可证 |
| 决策 | 筛选改进≥20%、生成 PoC 任务、分配优先级、确定方案 |
| 开发 | 隔离环境 PoC、A/B 测试、对比性能、生成集成 patch |
| 测试 | 准确率/召回率、处理速度、资源占用、回归测试 |
| 部署 | 提交 PR、更新配置、触发 CI/CD、监控性能、记录日志 |

### 闭环四：推广增长（指导工作方向）

| 阶段 | 动作 |
|------|------|
| 收集 | Google 算法更新、社媒热点、新内容信号、竞品策略、流量数据 |
| 分析 | 识别高价值话题、最佳发布时间、渠道效果、A/B 方案、预期增长 |
| 决策 | 确定内容清单、选择渠道、设定 A/B 变体、分配资源 |
| 开发 | SEO 标题描述、Schema.org 数据、多平台文案、推广素材、sitemap |
| 测试 | SEO 标签有效性、结构化数据格式、链接可达性、A/B 效果对比 |
| 部署 | IndexNow 提交、社媒发布、SEO 更新、sitemap 部署、记录基线 |

### 闭环五：竞品情报（指导工作方向）

| 阶段 | 动作 |
|------|------|
| 收集 | PapersWithCode/HuggingFace 动态、Google Scholar 新功能、Reddit/HN 热帖、竞品更新 |
| 分析 | 功能对比矩阵、市场趋势、空白识别、技术方向、用户痛点 |
| 决策 | 差异化建议→闭环二、技术改进→闭环三、推广调整→闭环四、变现建议→闭环六 |
| 开发 | 竞品分析报告、趋势可视化、路线图更新、各闭环调整指令 |
| 测试 | 建议可行性、策略一致性、资源需求评估、数据支撑验证 |
| 部署 | 发布报告、分发指令、更新策略文档、通知团队、归档数据 |

### 闭环六：变现拓展（增加变现渠道）

| 阶段 | 动作 |
|------|------|
| 收集 | 竞品定价变化、用户付费意愿、收入数据、行业新模式、市场机会 |
| 分析 | 收入潜力评估、转化漏斗、LTV/CAC、高价值机会、成本 ROI |
| 决策 | 选择开发功能、定价调整、新产品定义、任务清单 |
| 开发 | API 认证计费、付费墙校验、产品页面、支付集成、订阅管理 |
| 测试 | 支付端到端、付费墙防绕过、订阅升降级、账单发票、A/B 定价 |
| 部署 | 生产部署、定价更新、webhook 配置、用户通知、效果监控 |

## 定时任务配置

### 方式一：TRAE 定时任务（AI 驱动，已部署 ✓）

通过 TRAE 的 Schedule 工具创建了 3 个融合型定时任务，每个任务内含完整六阶段闭环：

| 任务名 | 任务 ID | 频率 | 融合闭环 | 下次执行 |
|--------|---------|------|---------|---------|
| GeneTech 每日运营闭环 | `6e208d24` | 每日 23:00 | 数据积累 + 推广增长 | 次日 23:00 |
| GeneTech 每周战略闭环 | `c223b50f` | 每周一 23:30 | 竞品情报 → 领域开拓 + 技术提升 | 下周一 23:30 |
| GeneTech 每月变现闭环 | `f3e0bd56` | 每月 1 日 23:30 | 变现拓展（8种模式评估） | 下月 1 日 23:30 |

**三层闭环协作关系**：
- **日层**（数据+推广）：每日采集最新数据并推广，形成日常运营飞轮
- **周层**（情报+领域+技术）：每周一基于竞品情报指导领域开拓和技术提升，形成战略迭代
- **月层**（变现）：每月评估8种变现模式，开发新变现渠道，形成商业闭环
- 三层之间通过 JSON 报告传递信号：日层产出→周层消费→月层决策→反哺日层

### 方式二：本地调度器（代码驱动）

```bash
# 启动守护进程，按 cron 自动执行
node operations-plan/scheduler-v2.js --daemon

# 查看所有闭环和时间表
node operations-plan/scheduler-v2.js --list

# 立即执行指定闭环
node operations-plan/scheduler-v2.js --run-now=data-accumulation

# 预览模式
node operations-plan/closed-loop-engine.js --loop=monetization --dry-run
```

### 方式三：GitHub Actions（云端驱动）

将 `github-actions-ops.yml` 推送到 GitHub 仓库，自动按计划执行。

## 闭环间数据传递

各闭环通过 JSON 报告文件传递状态：

```
operations-plan/
├── reports/                          # 各阶段报告
│   ├── data-accumulation-collect-*.json
│   ├── data-accumulation-analyze-*.json
│   ├── data-accumulation-summary-*.json
│   ├── promotion-collect-*.json
│   ├── intelligence-strategy-*.json
│   └── monetization-deploy-*.json
├── state/                            # 闭环状态
│   ├── data-accumulation-state.json
│   ├── transfer-data-accumulation-to-promotion.json
│   └── transfer-intelligence-to-monetization.json
└── logs/                             # 执行日志
    └── 2026-07-27.log
```

## 快速开始

```bash
# 1. 预览所有闭环
node operations-plan/closed-loop-engine.js --loop=data-accumulation --dry-run
node operations-plan/closed-loop-engine.js --loop=monetization --dry-run

# 2. 查看闭环时间表
node operations-plan/scheduler-v2.js --list

# 3. 启动守护调度器
node operations-plan/scheduler-v2.js --daemon

# 4. 手动执行单个闭环
node operations-plan/closed-loop-engine.js --loop=promotion

# 5. 只执行某个阶段
node operations-plan/closed-loop-engine.js --loop=data-accumulation --stage=analyze
```

## 文件清单

| 文件 | 说明 |
|------|------|
| `closed-loop-engine.js` | 统一闭环执行引擎（六阶段框架） |
| `scheduler-v2.js` | 闭环调度器 v2.0（6 闭环编排） |
| `pipeline-data-accumulation.js` | 数据积累 pipeline |
| `pipeline-domain-expansion.js` | 领域开拓 pipeline |
| `pipeline-tech-adoption.js` | 技术采纳 pipeline |
| `pipeline-promotion.js` | 推广增长 pipeline |
| `pipeline-intelligence.js` | 竞品情报 pipeline |
| `pipeline-monetization.js` | 变现拓展 pipeline |
| `github-actions-ops.yml` | GitHub Actions 配置 |
| `overview.md` | 运营方案总览 |
| `closed-loop-operations.md` | 本文档 |
