# AIShield — Glama MCP 平台提交指南

> 目标：将 AIShield Security Scanner 提交至 Glama MCP Servers 目录（https://glama.ai/mcp/servers）
> 对应配置文件：`registry/glama.json`
> 本指南为中文逐步操作说明，包含字段填写值、审核流程说明及常见拒绝原因。

---

## 一、提交前准备

### 1.1 前置条件

在提交 Glama 之前，请确保以下条件已满足：

- [ ] npm 包已发布（`@aishield/mcp-server` 可通过 `npx -y @aishield/mcp-server` 安装运行）
  > Glama 会验证 npx 安装命令能否正常工作。如果包未发布，提交后审核会被拒绝。
- [ ] GitHub 仓库公开可访问（https://github.com/lm203688/aishield）
- [ ] 仓库根目录或 `mcp-server/` 下有 `README.md`
- [ ] `package.json` 中 `bin` 字段配置正确，`npx` 能启动 MCP Server
- [ ] `registry/glama.json` 已按完整字段更新（见本指南第二节）
- [ ] MCP Server 至少有 1 个可正常调用的工具
- [ ] 仓库有 LICENSE 文件（MIT）

### 1.2 了解 Glama 的两种收录方式

Glama 收录 MCP Server 有两种途径：

| 方式 | 说明 | 适用情况 |
|------|------|----------|
| **自动索引** | Glama 会定期爬取 GitHub 上的 MCP Server 仓库（检测 `package.json` 中的 MCP 关键字、`mcp.json` 等），自动收录 | 无需手动操作，但收录慢、信息可能不全 |
| **手动提交** | 通过 Glama 官网提交表单主动收录 | 推荐，信息可控、收录更快 |

> **建议**：使用手动提交方式，可确保展示信息准确完整。

---

## 二、glama.json 字段填写对照表

提交时表单字段应与 `registry/glama.json` 中的值保持一致。以下是各字段的精确填写值：

### 2.1 基础信息

| 表单字段 | 填写值 | 对应 glama.json 字段 |
|----------|--------|----------------------|
| Server Name（名称） | `AIShield Security Scanner` | `name` |
| Display Name（显示名） | `AIShield — MCP & AI Agent Security Scanner` | `displayName` |
| Short Description（简短描述） | `OWASP MCP Top 10 security scanner — tool poisoning, prompt injection & supply chain detection.` | `shortDescription` |
| Description（完整描述） | `OWASP MCP Top 10 aligned security scanner for MCP servers and AI tools. 82+ detection rules across 10 risk categories with 5-dimension scoring. Detects tool poisoning, prompt injection, rug pulls, supply chain risks, and sensitive data leakage. Provides pre-install guardrails and real-time prompt safety checks (Chinese + English).` | `description` |
| Version（版本） | `4.1.0` | `version` |
| License（许可证） | `MIT` | `license` |
| Homepage（主页） | `https://aishield.tools` | `homepage` |
| Documentation（文档） | `https://aishield.tools/docs` | `documentation` |
| Repository URL（仓库地址） | `https://github.com/lm203688/aishield` | `repository.url` |
| Issues / Bugs（问题反馈） | `https://github.com/lm203688/aishield/issues` | `bugs.url` |

### 2.2 分类与标签

| 表单字段 | 填写值 |
|----------|--------|
| Categories（分类） | `Security`, `Developer Tools` |
| Tags（标签） | `security`, `mcp`, `owasp`, `scanner`, `tool-poisoning`, `prompt-injection`, `supply-chain`, `ai-safety`, `agent-security`, `rug-pull` |

> 分类建议优先选择 `Security`（安全类），这是 Glama 上安全类 MCP Server 的标准分类。

### 2.3 安装与部署信息

| 表单字段 | 填写值 |
|----------|--------|
| Install Command（安装命令） | `npx -y @aishield/mcp-server` |
| Transport（传输方式） | `stdio` |
| Docker Image（Docker 镜像） | `aishield/mcp-server:latest` |
| Docker Command | `docker run --rm -i -e AISHIELD_API_KEY=$AISHIELD_API_KEY aishield/mcp-server:latest` |
| HTTP Endpoint | `https://aishield.tools/api/v1/mcp`（streamable-http） |
| Environment Variables | `AISHIELD_API_URL`（默认 `https://api.aishield.tools`）、`AISHIELD_API_KEY`（可选） |

### 2.4 认证信息

| 表单字段 | 填写值 |
|----------|--------|
| Authentication Type | `API Key`（可选） |
| Required（是否必需） | `否`（Free tier 无需认证） |
| Environment Variable | `AISHIELD_API_KEY` |
| Header Format | `Authorization: Bearer <AISHIELD_API_KEY>` |
| Setup URL | `https://aishield.tools/api/v1/agent/setup` |

### 2.5 定价信息

| Tier | Price | Scans/Day | Rate Limit | Key Features |
|------|-------|-----------|------------|--------------|
| Free | $0 | 50 | 10 req/min | 全部 8 个工具、OWASP 覆盖、社区支持 |
| Pro | $29/月 | 1,000 | 60 req/min | 扫描历史、CI/CD 集成、邮件支持 |
| Enterprise | 定制 | 无限 | 定制 | SSO/RBAC、SLA、私有部署、合规报告 |

### 2.6 工具列表（8 个工具）

提交时需列出所有工具及其描述：

| # | 工具名 | 简述 |
|---|--------|------|
| 1 | `aishield_scan` | 完整安全扫描，OWASP MCP Top 10，82+ 规则，5 维评分 |
| 2 | `aishield_guardrail` | 安装前安全检查，返回 pass/warn/block 判定 |
| 3 | `aishield_prompt_check` | Prompt 注入检测（中英文），越狱/数据外传/零宽字符 |
| 4 | `aishield_banned_words` | 中文违禁词检测，覆盖 6 大平台 |
| 5 | `aishield_rug_pull` | Rug Pull 检测，对比 commit diff 发现安全代码删除 |
| 6 | `aishield_handshake` | MCP 握手验证，配置分析，npx 风险检测 |
| 7 | `agent_register` | 注册 Agent 获取 API Key |
| 8 | `agent_quick_scan` | 快速轻量安全检查，实时安装决策 |

---

## 三、逐步提交操作

### 步骤 1：访问 Glama MCP Servers 页面

打开浏览器，访问：

```
https://glama.ai/mcp/servers
```

> 该页面展示 Glama 收录的所有 MCP Server（当前 66,000+）。页面顶部有搜索栏和分类筛选。

### 步骤 2：进入提交页面

在页面右上角或顶部导航栏，点击 **"Submit Server"** 按钮（或直接访问 `https://glama.ai/mcp/servers/new`）。

> 如果没有看到按钮，可能需要先登录 Glama 账号（支持 GitHub / Google 登录）。

### 步骤 3：填写基础信息

在提交表单中，按第二节对照表填写以下字段：

1. **Server Name**：填入 `AIShield Security Scanner`
2. **Description**：填入完整描述（建议直接复制 `glama.json` 中的 `description` 字段值）
3. **Repository URL**：填入 `https://github.com/lm203688/aishield`
4. **Homepage**：填入 `https://aishield.tools`
5. **License**：选择 `MIT`

### 步骤 4：填写安装与部署信息

1. **Install Command**：填入 `npx -y @aishield/mcp-server`
2. **Transport**：选择 `stdio`
3. **Environment Variables**：
   - 添加 `AISHIELD_API_URL`，默认值 `https://api.aishield.tools`
   - 添加 `AISHIELD_API_KEY`，标注为可选
4. **HTTP Endpoint**（如有此字段）：填入 `https://aishield.tools/api/v1/mcp`

### 步骤 5：填写分类与标签

1. **Category**：选择 `Security`（可多选时加选 `Developer Tools`）
2. **Tags**：依次添加以下标签：
   `security` `mcp` `owasp` `scanner` `tool-poisoning` `prompt-injection` `supply-chain` `ai-safety`

### 步骤 6：填写认证信息

1. **Authentication**：选择 `API Key`
2. **Required**：选择 `No`（可选认证）
3. 填写环境变量名 `AISHIELD_API_KEY` 和 Header 格式 `Authorization: Bearer <key>`

### 步骤 7：上传配置文件（如需）

如果表单支持上传 `glama.json` 文件，直接上传 `registry/glama.json`。

如果表单为纯文本填写，则按第二节对照表逐字段手动填入。

### 步骤 8：提交并确认

1. 检查所有字段填写无误
2. 点击 **"Submit"** / **"Publish"** 按钮
3. 提交成功后，页面会显示提交确认信息或 pending 状态

### 步骤 9：上传 Logo / 图标（可选但推荐）

提交后，如支持上传图标，建议上传 AIShield 品牌图标（建议 256x256 PNG），有助于在目录中脱颖而出。

---

## 四、审核流程说明

### 4.1 审核时间

| 阶段 | 预计时间 | 说明 |
|------|----------|------|
| 自动验证 | 即时 | Glama 自动验证仓库可访问性、npx 命令可执行性 |
| 人工审核 | 1-7 个工作日 | Glama 团队人工审核内容完整性与质量 |
| 收录上线 | 审核通过后即时 | Server 出现在 Glama 目录中 |

### 4.2 审核状态查询

- 提交后可在 Glama 账号的 Dashboard / My Servers 页面查看审核状态
- 状态流转：`Pending` → `Under Review` → `Approved` / `Rejected`

### 4.3 审核通过后的效果

- Server 在 Glama 目录中获得独立页面（`https://glama.ai/mcp/servers/<author>/aishield`）
- 显示 Glama 质量评分（license / quality / maintenance 三个维度，A-F 等级）
- 用户可直接复制 Claude Desktop / Cursor 配置 JSON
- 被 Glama 搜索引擎索引，获得 SEO 流量

---

## 五、常见拒绝原因及避免方法

### 5.1 高频拒绝原因

| 序号 | 拒绝原因 | 说明 | 避免方法 |
|------|----------|------|----------|
| 1 | **npx 命令无法运行** | Glama 会实际执行 `npx -y @aishield/mcp-server` 验证 | 确保 npm 包已发布且可正常启动；先本地 `npx` 测试通过再提交 |
| 2 | **仓库不可访问或为空** | 私有仓库或 404 | 确保仓库为 public，且有实际代码和 README |
| 3 | **缺少 README** | 仓库无 README 或内容过于简陋 | 编写完整 README，包含安装、配置、工具列表、使用示例 |
| 4 | **缺少 LICENSE** | 无开源许可证 | 添加 MIT LICENSE 文件 |
| 5 | **描述过于简单** | 一句话描述，无法体现功能 | 提供详细描述，说明功能、规则数、覆盖范围 |
| 6 | **工具无法调用** | 工具定义存在但实际调用报错 | 确保所有声明的工具都能正常工作；后端 API 可用 |
| 7 | **重复提交** | 同一 Server 被多次提交 | 提交前在 Glama 搜索是否已收录 |
| 8 | **恶意/欺诈内容** | 检测到隐藏指令、数据窃取 | 确保工具描述无隐藏 prompt injection，代码无恶意行为 |
| 9 | **版本不一致** | package.json / mcp.json / README 版本号冲突 | 统一所有文件的版本号 |
| 10 | **无实际功能** | Server 定义了工具但无实际逻辑 | 确保每个工具连接真实后端，返回有效结果 |

### 5.2 质量评分影响因素

Glama 会从三个维度评分（A-F），影响展示排名：

| 维度 | 评分依据 | AIShield 当前状态 | 优化建议 |
|------|----------|-------------------|----------|
| **License** | 是否有明确开源许可证 | 有 MIT | 已达标 |
| **Quality** | README 质量、代码规范、文档完整度 | 待完善 | 补充完整 README，添加使用示例和截图 |
| **Maintenance** | 最近更新时间、提交频率、Issue 响应 | 取决于仓库活跃度 | 保持定期提交，及时响应 Issue |

### 5.3 提升通过率的额外建议

1. **在 README 中嵌入 MCP 配置示例**：Glama 会读取 README 提取配置信息，完整的配置示例有助于自动填充
2. **确保 `package.json` 的 `keywords` 包含 `mcp` 和 `mcp-server`**：有助于 Glama 自动识别
3. **添加 `mcp.json` 清单文件**：Glama 会读取仓库中的 MCP 清单
4. **保持仓库近期活跃**：Maintenance 评分与最近更新时间直接相关
5. **提供截图/GIF**：README 中嵌入工具运行截图，提升 Quality 评分
6. **声明 OWASP 对标**：在描述中强调 "OWASP MCP Top 10 aligned"，这是差异化亮点

---

## 六、提交后维护

### 6.1 更新已收录的 Server

当 AIShield 发布新版本时：

1. 更新 `registry/glama.json` 中的 `version` 字段
2. 在 Glama Dashboard 中找到已收录的 Server
3. 点击 "Edit" / "Update" 更新版本号和变更说明
4. Glama 会重新抓取仓库并更新展示信息

### 6.2 监控评分

- 定期查看 Glama 上的质量评分变化
- 响应用户在 Glama 上的反馈和评价
- 维护仓库活跃度以保持 Maintenance 评分

### 6.3 利用 Glama 流量

- 在项目 README 中添加 Glama 徽章：
  ```markdown
  [![Glama](https://glama.ai/mcp/servers/badge)](https://glama.ai/mcp/servers/<author>/aishield)
  ```
- 在社交媒体分享 Glama 收录链接
- Glama 的 SEO 权重较高，收录后可显著提升搜索可见性

---

## 七、快速提交 Checklist

提交前逐项确认：

```
□ npm 包 @aishield/mcp-server 已发布且 npx 可正常运行
□ GitHub 仓库公开可访问
□ README.md 完整（含安装、配置、工具列表）
□ LICENSE 文件存在（MIT）
□ registry/glama.json 已按完整字段更新
□ 所有版本号已统一（package.json / mcp.json / index.ts）
□ 工具可实际调用并返回结果
□ 已注册 Glama 账号并登录
□ 按第二节对照表填写表单字段
□ 提交后查看审核状态
```

---

## 附：相关链接

| 资源 | 链接 |
|------|------|
| Glama MCP Servers 目录 | https://glama.ai/mcp/servers |
| Glama 提交页面 | https://glama.ai/mcp/servers/new |
| AIShield GitHub 仓库 | https://github.com/lm203688/aishield |
| AIShield 官网 | https://aishield.tools |
| AIShield 文档 | https://aishield.tools/docs |
| npm 包页面 | https://www.npmjs.com/package/@aishield/mcp-server |
| Glama 配置文件 | `registry/glama.json` |
| npm 发布清单 | `registry/npm-publish-checklist.md` |
