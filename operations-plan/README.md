# GeneTech 14站知识引擎 — 自动化运营系统

本目录包含 GeneTech 14站知识引擎的完整自动化运营方案，通过 **5 个核心闭环** 实现持续的内容积累、领域开拓、技术迭代、推广优化和情报分析。

---

## 目录结构

```
operations-plan/
├── overview.md                    # 运营方案总览与架构图
├── pipeline-data-accumulation.js  # 闭环一：数据积累流水线
├── pipeline-domain-expansion.js   # 闭环二：领域开拓机制
├── pipeline-tech-adoption.js      # 闭环三：技术采纳闭环
├── pipeline-promotion.js          # 闭环四：推广技术应用
├── pipeline-intelligence.js       # 闭环五：竞品情报收集分析
├── scheduler.js                   # 定时任务编排器
├── github-actions-ops.yml         # GitHub Actions 自动化配置（需移至 .github/workflows/）
└── README.md                      # 本文件
```

---

## 快速开始

### 1. 环境准备

确保已安装 **Node.js 18+**。

```bash
node -v  # v18.0.0 或更高
```

### 2. 配置文件

在项目根目录创建 `.env` 文件，填入必要的 API 密钥：

```bash
cp .env.example .env
```

`.env` 示例：

```env
# GitHub API Token（用于采集 GitHub 仓库数据，必需）
GITHUB_TOKEN=<你的_GITHUB_TOKEN_仅_contents_write_最小权限>

# IndexNow 配置（用于 SEO 自动提交，可选）
INDEXNOW_KEY=your-indexnow-key
INDEXNOW_KEY_LOCATION=https://your-site.com/indexnow-key.txt
SITE_BASE_URL=https://genetech.example
```

### 3. 首次运行（Dry-Run 模式）

所有 pipeline 均支持 `--dry-run` 参数，仅模拟执行，不写入任何数据。

```bash
# 测试数据积累流水线
node operations-plan/pipeline-data-accumulation.js --dry-run

# 测试领域开拓机制
node operations-plan/pipeline-domain-expansion.js --dry-run

# 测试技术采纳闭环
node operations-plan/pipeline-tech-adoption.js --dry-run

# 测试推广技术应用
node operations-plan/pipeline-promotion.js --dry-run

# 测试竞品情报收集
node operations-plan/pipeline-intelligence.js --dry-run
```

### 4. 启动定时调度器

```bash
# 单次模式：检查并执行当前到期的任务
node operations-plan/scheduler.js

# 守护模式：持续运行，按 cron 计划自动触发
node operations-plan/scheduler.js --daemon

# 手动立即运行某个 pipeline
node operations-plan/scheduler.js --run-now=data-accumulation

# 守护模式 + Dry-Run
node operations-plan/scheduler.js --daemon --dry-run
```

### 5. GitHub Actions 自动化

将 `github-actions-ops.yml` 复制到仓库的 `.github/workflows/` 目录：

```bash
mkdir -p .github/workflows
cp operations-plan/github-actions-ops.yml .github/workflows/ops.yml
git add .github/workflows/ops.yml
git commit -m "Add operations automation workflow"
git push
```

推送后，GitHub 将自动按设定的时间表运行各 pipeline。也可在 GitHub 仓库页面的 **Actions** 标签中手动触发。

---

## 五个核心闭环

### 闭环一：数据积累流水线

**脚本**: `pipeline-data-accumulation.js`

**功能**:
- 从 PubMed、arXiv、OpenAlex、Crossref、GitHub、HuggingFace 定时采集数据
- 自动清洗、去重、结构化
- 增量更新 14 站实体数据
- 生成 changelog 和 `report-data-*.json`

**频率**: 每日 02:00 (UTC+8)

**输出**:
- `sites/<site>/_data/entities.json` — 各站点实体数据
- `reports/report-data-*.json` — 执行报告（供其他闭环消费）
- `logs/changelog-data-*.md` — 变更日志

---

### 闭环二：领域开拓机制

**脚本**: `pipeline-domain-expansion.js`

**功能**:
- 监测 arXiv 新分类增长、GitHub 新兴仓库趋势
- 评估新领域价值（论文量、仓库增速、社区热度、搜索趋势）
- 达到阈值后自动生成新站点脚手架
- 将新领域加入数据预填充队列

**频率**: 每周一 06:00 (UTC+8)

**输出**:
- `sites/<new-site>/` — 新站点目录、配置文件、模板
- `reports/report-domain-*.json` — 执行报告
- `state/prefill-queue.json` — 数据预填充队列

---

### 闭环三：技术采纳闭环

**脚本**: `pipeline-tech-adoption.js`

**功能**:
- 从 arXiv 论文、GitHub 新仓库发现数据处理/分析新技术
- 自动分类和初步评分
- 在隔离目录执行 PoC（Proof of Concept）测试
- 效果达标后生成 patch 文件，记录到采纳清单

**频率**: 每周三 04:00 (UTC+8)

**输出**:
- `poc/poc-*/` — PoC 隔离目录（含测试脚本和结果）
- `logs/integration-*.patch` — 生产集成 patch
- `state/adopted-technologies.json` — 已采纳技术清单
- `reports/report-tech-*.json` — 执行报告

---

### 闭环四：推广技术应用

**脚本**: `pipeline-promotion.js`

**功能**:
- 监测 SEO 算法更新（RSS）
- 自动更新结构化数据（JSON-LD）
- 生成 Sitemap
- 通过 IndexNow 提交新页面
- 自动生成 Twitter/LinkedIn/微信推广内容
- A/B 测试推广文案变体

**频率**: 每日 08:00、18:00 (UTC+8)

**输出**:
- `sites/<site>/structured-data.json` — Schema.org 结构化数据
- `sitemap.xml` — 站点地图
- `promotion-assets/social-contents-*.json` — 社交媒体内容
- `promotion-assets/ab-tests-*.json` — A/B 测试变体
- `reports/report-promotion-*.json` — 执行报告

---

### 闭环五：竞品情报收集

**脚本**: `pipeline-intelligence.js`

**功能**:
- 监测 PapersWithCode、HuggingFace 等竞品动态
- 采集 Reddit、Hacker News 社区热点
- 读取内部闭环报告进行综合分析
- 生成竞品评分矩阵和市场空白识别
- 输出策略调整建议

**频率**: 每周五 05:00 (UTC+8)

**输出**:
- `logs/intelligence-analysis-*.md` — Markdown 竞品分析报告
- `reports/report-intelligence-*.json` — 执行报告（含策略指令）

---

## 闭环协作与数据流

```
闭环一 (数据积累)  ──report-data──>  闭环二 (领域开拓)
     |                                   |
     |<──技术改进──report-tech───────闭环三 (技术采纳)
     |
     ├──内容素材──> 闭环四 (推广) ──report-promotion──> 闭环五 (情报)
                                                          |
                                闭环二 <──市场空白/策略建议──┘
                                闭环四 <──SEO/推广优化建议──┘
```

所有闭环通过 `reports/report-*.json` 文件进行状态传递。

---

## 命令行参数

所有 pipeline 脚本和 scheduler 均支持以下参数：

| 参数 | 说明 |
|------|------|
| `--dry-run` | 模拟执行，不写入任何文件或数据 |

scheduler.js 额外支持：

| 参数 | 说明 |
|------|------|
| `--daemon` | 守护模式，持续按 cron 计划运行 |
| `--run-now=<id>` | 立即运行指定 pipeline |

---

## 状态与日志

| 目录 | 用途 |
|------|------|
| `state/` | 各 pipeline 的执行状态、进度、队列 |
| `logs/` | 执行日志、changelog、分析报告 |
| `reports/` | JSON 格式执行报告（闭环间传递） |
| `data/` | 采集的原始数据（可选） |
| `poc/` | 技术采纳的 PoC 隔离目录 |
| `promotion-assets/` | 生成的推广内容和 A/B 测试变体 |

---

## 定时任务时间表（UTC+8）

| Pipeline | 频率 | 执行时间 |
|----------|------|----------|
| 数据积累 | 每日 | 02:00 |
| 领域开拓 | 每周 | 周一 06:00 |
| 技术采纳 | 每周 | 周三 04:00 |
| 推广应用 | 每日 | 08:00, 18:00 |
| 竞品情报 | 每周 | 周五 05:00 |

---

## 错误处理

- **指数退避重试**: 所有 HTTP 请求失败时自动重试 3 次
- **超时保护**: scheduler 为每个 pipeline 设置独立超时（15~40 分钟）
- **部分失败容错**: 单个数据源失败不影响整体流程（`Promise.allSettled`）
- **GitHub Actions 失败通知**: pipeline 失败时自动创建 Issue 告警

---

## 扩展与定制

### 添加新的数据源

编辑 `pipeline-data-accumulation.js` 中的 `DATA_SOURCES` 配置对象，新增数据源并实现对应的 `fetchXxx` 函数。

### 调整领域评估阈值

编辑 `pipeline-domain-expansion.js` 中的 `EVALUATION_CONFIG`，修改权重和阈值。

### 新增推广平台

编辑 `pipeline-promotion.js` 中的 `PROMOTION_CONFIG.socialMedia.platforms`，添加新的平台模板。

### 扩展竞品列表

编辑 `pipeline-intelligence.js` 中的 `COMPETITORS` 数组，新增监测对象。

---

## 依赖说明

本方案使用 **Node.js 原生模块** 编写，无外部 npm 依赖，可直接运行：

- `fs` / `path` — 文件系统操作
- `https` / `http` — HTTP 请求
- `child_process` — 子进程执行

如需增强功能，可额外安装：

```bash
# 如需更精准的 cron 调度（替代 scheduler.js 的简易实现）
npm install node-cron

# 如需更完善的 RSS 解析
npm install fast-xml-parser

# 如需 Google Trends 数据采集
npm install google-trends-api
```

---

## 许可证

MIT License — 仅供 GeneTech 知识引擎内部使用。

---

*文档版本: v1.0*  
*更新日期: 2026-07-27*
