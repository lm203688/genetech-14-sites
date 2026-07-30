# 需人工解决问题清单

生成时间: 2026-07-30 05:30 (北京时间)
来源: 跨项目指挥中心自动聚合

---

## P0 - 紧急（必须尽快处理）

### 1. GeneTech: Creem支付未启用Live Payments
- **现象**: 支付页面显示 "This store is not currently accepting payments"
- **影响**: 所有付费产品无法收款，直接阻断变现
- **操作**:
  1. 登录 https://www.creem.io 后台
  2. 进入 Settings > Payment Settings
  3. 启用 Live Payments 模式
  4. 确认支持邮箱已从 contact@swarmlabs.tools 改为 463102527@qq.com
  5. 验证：访问任一产品支付链接确认可进入结账页

### 2. AIShield: aishield.tools SSL/备案拦截（连续7天）
- **现象**: Health API 连续7天不可达，腾讯云备案拦截
- **影响**: AIShield服务完全不可用，所有功能瘫痪
- **操作**（三选一）:
  - 方案A（最快）: Cloudflare控制台将SSL模式从 Full(Strict) 改为 Flexible
  - 方案B: 在源站(150.158.119.19)配置有效SSL证书（Let's Encrypt）
  - 方案C: 完成腾讯云ICP备案流程
- **验证**: 修复后访问 https://aishield.tools/api/v1/health 确认返回200

### 3. AIShield: MCP无状态协议兼容性评估
- **现象**: MCP协议07-28发布无状态化大版本修订，scanner可能不兼容
- **影响**: AIShield的MCP Server可能无法正常工作
- **操作**: 用Beta SDK测试 scanner/handshake.py 兼容性，产出兼容性报告

---

## P1 - 高优先级（本周内处理）

### 4. GeneTech: GitHub Token未配置
- **现象**: API采集限60次/小时，严重影响数据采集效率
- **操作**:
  1. 访问 https://github.com/settings/tokens
  2. 创建 Personal Access Token (classic)，勾选 public_repo
  3. 在 Cloudflare Pages 项目设置 > Variables and secrets 中添加环境变量 GITHUB_TOKEN

### 5. GeneTech: Git仓库未初始化
- **现象**: 无法自动Git部署，代码更新需手动wrangler部署
- **操作**:
  1. 在项目目录执行 `git init`
  2. 关联GitHub远程仓库
  3. 在Cloudflare Pages配置Git自动部署

### 6. AIShield: Glama平台提交（阻塞7天）
- **现象**: awesome-mcp-servers PR #10694被阻塞，维护者要求先提交Glama
- **影响**: MCP生态曝光受阻
- **操作**: 前往 https://glama.ai/mcp/servers 提交 lm203688/aishield

### 7. AIShield: npm包发布
- **现象**: npm包未发布，Smithery无法部署
- **操作**: `npm publish` 发布 @aishield/mcp-server

---

## P2 - 中等优先级（有空处理）

### 8. GeneTech: HuggingFace API连接超时
- **现象**: connect ETIMEDOUT，可能是网络/DNS问题
- **操作**: 检查网络连接，或考虑使用HuggingFace镜像站

### 9. GeneTech: IndexNow API密钥未配置
- **现象**: SEO索引提交为模拟模式（simulated_no_key）
- **操作**: 在 https://www.bing.com/webmasters 注册站点，获取IndexNow API密钥

### 10. RoboParts: Google站点验证placeholder未替换（连续7天）
- **操作**: 在 https://search.google.com/search-console 添加站点并获取验证码

### 11. RoboParts: Email明文存储在KV中
- **操作**: 重构 register.js 和 webhook.js，对email进行SHA-256哈希存储

### 12. RoboParts: HuggingFace数据集未发布
- **操作**: 在 https://huggingface.co/settings/tokens 创建token，配置到GitHub Secrets的HF_TOKEN

### 13. RoboParts: 139个实体缺失name_en字段
- **状态**: 可自动修复，需AI批量翻译中文名称为英文
- **影响**: 国际化覆盖率仅21.9%

---

## 已自动修复的问题（本次）

| 项目 | 问题 | 修复方式 |
|------|------|----------|
| GeneTech | GitHub API 422错误 | 搜索语法改为单topic查询 |
| RoboParts | 本地分类文件不一致(435≠450) | 从entities.json重建分类文件 |
| RoboParts | robot_ai_models缺失release_date | 补充release_date字段 |
| GeneTech | 3站点340个实体缺失name字段 | 已由每日任务自动补充 |

---

## 项目健康度总览

| 项目 | 健康度 | 关键状态 | 定时任务数 |
|------|--------|---------|-----------|
| GeneTech 14站 | 正常 | 6406实体, 门禁14/14通过 | 3 |
| RoboParts | 89/100 | 450实体稳定, 支付链路100% | 3 |
| AIShield | 异常 | 服务7天不可达, 闭环率0% | 4 |
| HealthLens | 未知 | 报告路径待确认 | 4 |
| OracleMind | 未知 | 报告路径待确认 | 3 |
| SwarmLabs | 未知 | 报告目录为空 | 5 |

**定时任务总数**: 22个 (跨6个项目)

---

*本报告由跨项目指挥中心自动生成，每日更新*
