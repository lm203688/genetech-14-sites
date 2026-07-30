# GeneTech 14站知识引擎 — 修复工具包

> 基于"自动化、生态化、盈利化"三准则审核产出的修复方案集合，一键执行安全加固、API 治理、数据修复、UX 优化、自动化流水线、监控告警。

## 快速开始

```bash
# 1. 预览所有修复（不实际修改文件）
node apply-all.js --dry-run

# 2. 执行全部修复
node apply-all.js

# 3. 只执行某个模块
node apply-all.js --only=security
node apply-all.js --only=data
node apply-all.js --only=ux

# 4. 运行健康检查
node monitoring/health-check.js --all
```

## 模块总览

| 模块 | 目录 | 解决的问题 |
|------|------|-----------|
| 安全修复 | `security/` | 硬编码凭证、密钥泄漏、CREDENTIALS.md 暴露 |
| API 网关 | `api-gateway/` | 数据端点无认证、无限流、无分级访问 |
| 数据一致性 | `data-integrity/` | 实体计数不一致、缺少置信度与溯源 |
| UX 修复 | `ux-fixes/` | 反爬虫误伤用户、定价 URL 错误、缺时间戳 |
| 自动化 | `automation/` | 硬编码路径、无 CI/CD、无安全扫描 |
| 监控 | `monitoring/` | 无健康检查、无告警、无可用性追踪 |

## 各模块详解

### 1. 安全修复（security/）

**问题**：`CREDENTIALS.md` 在 Git 仓库中明文存储 API Key、Token 等敏感凭证。

**方案**：
- `.env.example` — 环境变量模板，列出所有需要的变量名但不包含实际值
- `.gitignore` — 防止 `.env`、`CREDENTIALS.md` 等敏感文件被提交
- `rotate-credentials.md` — 凭证轮换指南，包含 Git 历史清理步骤
- `CREDENTIALS.md.template` — 安全的凭证文档模板

**关键命令**：
```bash
# 清理 Git 历史中的 CREDENTIALS.md
git filter-repo --path CREDENTIALS.md --invert-paths
git push origin --force --all
```

### 2. API 网关（api-gateway/）

**问题**：数据 API 端点公开可访问，无认证、无限流，存在数据被抓取风险。

**方案**：Cloudflare Worker 实现的 API 网关，提供：
- Bearer Token 认证
- 基于 IP 的速率限制（免费 10 req/min，付费 100 req/min）
- 分级数据访问控制（免费层仅返回摘要，付费层返回完整数据）
- CORS 配置

**部署**：
```bash
cd api-gateway
npm install wrangler --save-dev
npx wrangler deploy
```

### 3. 数据一致性（data-integrity/）

**问题**：各领域 `index.json` 中声明的实体数与实际文件数不一致。

**方案**：`fix-data-consistency.js` 脚本：
- 扫描所有领域目录，比对声明数与实际文件数
- 自动修正 `index.json` 中的计数
- 为每个实体添加 `confidence`（置信度）和 `provenance`（溯源）字段
- 生成一致性验证报告

```bash
node data-integrity/fix-data-consistency.js --all
```

### 4. UX 修复（ux-fixes/）

**问题**：
- 反爬虫措施过于激进，使用 `debugger` 陷阱误伤正常用户
- 定价页 URL 错误（`www.www.creem.io`）
- 实体页面缺少数据更新时间戳

**方案**：
- `anti-scrape.js` — 轻量级反爬虫：蜜罐链接 + headless 浏览器特征检测，不影响正常用户
- `fix-ux.js` — 修复 URL、添加时间戳、统一定价信息

### 5. 自动化（automation/）

**问题**：
- 脚本中硬编码 `/home/z/my-project` 路径，无法跨环境运行
- 无 CI/CD 流水线，无安全扫描

**方案**：
- `fix-portability.js` — 将硬编码路径替换为环境变量解析
- `ci-cd.yml` — GitHub Actions 流水线：安全扫描 → 数据一致性检查 → 构建 → 部署
- `security-scan.yml` — PR 专项安全扫描（TruffleHog + detect-secrets）

### 6. 监控（monitoring/）

**问题**：14 个站点和 API 无可用性监控，故障无法及时发现。

**方案**：`health-check.js` 提供：
- 14 站点 HTTP 可用性检查（状态码 + 响应时间）
- API 端点健康检查
- 数据完整性验证
- 安全状态扫描
- JSON + HTML 双格式报告
- Webhook 告警（飞书/钉钉）

```bash
# 完整检查
node monitoring/health-check.js --all

# 带告警
ALERT_WEBHOOK=https://open.feishu.cn/... node monitoring/health-check.js --all --alert

# 仅检查站点
node monitoring/health-check.js --sites
```

**定时运行**（crontab）：
```bash
# 每小时检查一次
0 * * * * cd /path/to/project && node scripts/monitoring/health-check.js --all --alert >> /var/log/genetech-health.log 2>&1
```

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PROJECT_ROOT` | 项目根目录 | 自动推断 |
| `SITES_BASE_URL` | 站点根 URL | `https://genetech14.pages.dev` |
| `API_BASE_URL` | API 根 URL | 同 `SITES_BASE_URL` |
| `ALERT_WEBHOOK` | 告警 webhook 地址 | 空（不告警） |
| `API_KEY` | API 认证密钥 | 用于健康检查 |

## 修复优先级

按紧急程度分三批执行：

**第一批（立即执行）**：
1. 安全修复 — 防止凭证继续泄漏
2. 数据一致性 — 保证数据可信

**第二批（本周内）**：
3. API 网关 — 上线认证与限流
4. UX 修复 — 改善用户体验

**第三批（持续迭代）**：
5. 自动化 — 建立 CI/CD
6. 监控 — 上线健康检查

## 验证修复

执行完所有修复后，运行验证：

```bash
# 1. 安全验证：确认 CREDENTIALS.md 不存在
test ! -f CREDENTIALS.md && echo "OK" || echo "FAIL"

# 2. 数据一致性验证
node data-integrity/fix-data-consistency.js --validate-only

# 3. 健康检查
node monitoring/health-check.js --all

# 4. 路径可移植性验证
grep -r "/home/z/my-project" src/ && echo "FAIL" || echo "OK"
```

## 目录结构

```
genetech14-fixes/
├── apply-all.js                 # 主应用脚本（一键执行）
├── README.md                    # 本文档
├── security/                    # 安全修复
│   ├── .env.example
│   ├── .gitignore
│   ├── rotate-credentials.md
│   └── CREDENTIALS.md.template
├── api-gateway/                 # API 网关
│   ├── worker.js
│   ├── wrangler.toml
│   └── README.md
├── data-integrity/              # 数据一致性
│   └── fix-data-consistency.js
├── ux-fixes/                    # UX 修复
│   ├── anti-scrape.js
│   └── fix-ux.js
├── automation/                  # 自动化
│   ├── fix-portability.js
│   ├── ci-cd.yml
│   └── security-scan.yml
└── monitoring/                  # 监控
    ├── health-check.js
    └── reports/                 # 自动生成的报告
```
