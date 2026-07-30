# 跨项目运营看板

> 最后更新：2026-07-30
> 维护方：TRAE 项目总指挥（自动同步定时任务结果）

## 定时任务总览（共24个，全部Active）

### GeneTech 14站知识引擎（3个任务）

| 任务 | 频率 | 报告路径 | 上次执行 | 状态 |
|------|------|---------|---------|------|
| 每日运营闭环 | 每天23:00 | operations-plan/reports/daily-ops-summary-*.json | 07-30 | ✅ 全部门禁通过 |
| 每周战略闭环 | 周一23:30 | operations-plan/reports/weekly-strategy-summary-*.json | 07-28 | ✅ 全部门禁通过 |
| 每月变现闭环 | 月1日23:30 | operations-plan/reports/monthly-monetization-*.json | 8月1日 | ⏳ 待执行 |

### AIShield（4个任务）

| 任务 | 频率 | 报告路径 | 上次执行 | 状态 |
|------|------|---------|---------|------|
| 每日闭环 | 每天02:00 | aishield/eco/reports/daily-*.md | 07-30 | 🔴 严重（7天不可达） |
| 每周综合闭环 | 周一02:00 | aishield/eco/reports/weekly-*.md | 07-28 | ⚠️ |
| 月度闭环 | 月1日03:00 | aishield/eco/reports/monthly-*.md | 8月1日 | ⏳ |
| 季度战略闭环 | 季初03:00 | aishield/eco/reports/quarterly-*.md | 10月1日 | ⏳ |

### RoboParts（3个任务）

| 任务 | 频率 | 报告路径 | 上次执行 | 状态 |
|------|------|---------|---------|------|
| 每日综合闭环 | 每天02:30 | robopart/reports/daily-comprehensive-*.md | 07-30 | ✅ 稳定（89分） |
| 每周综合运营 | 周一03:00 | robopart/reports/weekly-*.md | 07-28 | ✅ |
| 月度经营闭环 | 月1日02:00 | robopart/reports/monthly-*.md | 8月1日 | ⏳ |

### SwarmLabs（5个任务）

| 任务 | 频率 | 报告路径 | 上次执行 | 状态 |
|------|------|---------|---------|------|
| 外部情报与竞品 | 每天23:00 | swarmlabs/reports/daily-tech-*.html | 07-30 | 🟡 P0风险 |
| 健康检查+修复 | 每天23:45 | swarmlabs/reports/daily-health-*.md | 07-30 | ✅ |
| 用户增长与推广 | 每天00:30 | swarmlabs/reports/daily-growth-*.md | 07-30 | ✅ |
| 财务合规核对 | 每天01:15 | swarmlabs/reports/daily-finance-*.md | 07-30 | ✅ |
| 知识沉淀与汇总 | 每天01:45 | swarmlabs/reports/daily-summary-*.md | 07-30 | ✅ |

### OracleMind（3个任务）

| 任务 | 频率 | 报告路径 | 上次执行 | 状态 |
|------|------|---------|---------|------|
| 每日闭环 | 每天02:00 | oraclemind/reports/daily-*.md | 07-30 | ✅ |
| 每周综合闭环 | 周一03:00 | oraclemind/reports/weekly-*.md | 07-28 | ✅ |
| 月度闭环 | 月1日02:00 | oraclemind/reports/monthly-*.md | 8月1日 | ⏳ |

### HealthLens（4个任务）

| 任务 | 频率 | 报告路径 | 上次执行 | 状态 |
|------|------|---------|---------|------|
| 每周综合闭环 | 周一03:00 | healthlens/reports/weekly-*.md | 07-28 | ✅ |
| 每周内容生产 | 周五03:00 | healthlens/reports/content-*.md | 08-01 | ⏳ |
| 月度综合闭环 | 月1日03:00 | healthlens/reports/monthly-*.md | 8月1日 | ⏳ |
| 季度战略闭环 | 季初04:00 | healthlens/reports/quarterly-*.md | 10月1日 | ⏳ |

### 获客相关（2个任务）

| 任务 | 频率 | 报告路径 | 上次执行 | 状态 |
|------|------|---------|---------|------|
| 基础设施健康 | 每天02:10 | 获客/reports/daily-*.md | 07-30 | ✅ |
| 指标周报 | 周二04:00 | 获客/reports/weekly-*.md | 07-29 | ✅ |

---

## 各项目关键指标（07-30快照）

| 项目 | 数据量 | 健康度 | 闭环率 | 收入 | 关键风险 |
|------|--------|--------|--------|------|---------|
| GeneTech 14站 | 6,406实体 | ✅ 全通过 | 100% | 待Creem审核 | GitHub/HF采集失败 |
| AIShield | 1账户 | 🔴 不可达 | 0% | 0 | SSL/备案7天未修 |
| RoboParts | 450实体 | 89/100 | 100% | 支付链路通 | name_en覆盖率 |
| SwarmLabs | 9条情报 | 🟡 | - | - | f2方法学P0 |
| OracleMind | - | ✅ | - | - | - |
| HealthLens | - | ✅ | - | - | - |

---

## 已自动修复的问题

| 日期 | 项目 | 问题 | 修复方式 |
|------|------|------|---------|
| 07-30 | GeneTech | GitHub API 422错误 | 修改搜索语法，多词topic改用关键词搜索 |
| 07-30 | GeneTech | 340个实体缺失name字段 | 定时任务自动补充 |
| 07-27 | GeneTech | Creem URL双www错误 | 批量修复13个文件 |
| 07-27 | GeneTech | License Key GET传输 | 改为POST加密传输 |
| 07-27 | GeneTech | Webhook无签名验证 | 添加HMAC-SHA256 |
| 07-27 | GeneTech | CREDENTIALS.md明文凭证 | 已删除，改用环境变量 |

---

## 需要用户手动解决的问题

### 🔴 紧急（P0）

1. **AIShield SSL/备案问题**（连续7天）
   - 问题：aishield.tools 返回 SSL 525 错误 + 腾讯云备案拦截
   - 操作：Cloudflare → SSL/TLS → 改为 Flexible 或 Full；或完成腾讯云备案
   - 影响：AIShield 服务完全不可用，闭环率0%

2. **Creem 支付审核**（GeneTech 变现阻塞）
   - 问题：Creem 要求统一支持邮箱，当前 Creem 账户是 463102527@qq.com，网站是 contact@swarmlabs.tools
   - 操作：在 Creem 后台 → Settings → 修改支持邮箱为 contact@swarmlabs.tools → 提交重新审核
   - 影响：所有14站无法接收真实支付

3. **SwarmLabs f2 方法学风险**（P0技术决策）
   - 问题：EFSPI 明确不推荐 expected f2 用于溶出曲线比较
   - 操作：审查 BE 统计模块，切换至 bootstrap bias-corrected f2
   - 影响：BE 统计结果可信度

### 🟡 重要（P1）

4. **GeneTech 代码部署**
   - 问题：修复后的代码（支付模板、统一License Key、success.html）尚未部署到 Cloudflare Pages
   - 操作：用 Wrangler CLI 部署，或 Git push 触发自动部署
   - 影响：线上仍是旧代码，支付流程不完整

5. **GeneTech IndexNow 密钥**
   - 问题：推广闭环的索引提交为模拟模式（无API密钥）
   - 操作：在 Bing Webmaster Tools 获取 IndexNow API Key
   - 影响：新页面无法被搜索引擎快速索引

6. **AIShield Glama 提交**（7天未操作）
   - 问题：PR #10694 被要求先提交 Glama 平台
   - 操作：在 glama.ai 提交 AIShield MCP 产品
   - 影响：PR 无法合并

### 🟢 低优先级（P2）

7. **RoboParts name_en 覆盖率**（139个实体缺失英文名）
8. **RoboParts Google Search Console 验证**（placeholder未替换）
9. **GeneTech HuggingFace API 超时**（网络/DNS问题，非代码问题）
10. **GeneTech Git 仓库初始化**（当前无Git，部署靠手动）
