# AIShield MCP Server — npm 发布检查清单

> 适用包名：`@aishield/mcp-server`
> 目标文件：`mcp-server/package.json`
> 本清单用于在正式执行 `npm publish` 前逐项核对，确保发布顺利、内容完整、无常见错误。

---

## 一、包名可用性分析（发布前必读）

### 1.1 当前包名状态

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 包名 | `@aishield/mcp-server` | Scoped 包（带组织前缀） |
| npm 注册表查询 | **可用（未发布）** | `npm view @aishield/mcp-server` 返回 404，确认尚未被占用 |
| `@aishield` 组织 | **已存在（owner）** | `npm org ls aishield` 返回 `aishield - owner`，组织归属已确认 |

### 1.2 结论

- `@aishield/mcp-server` 当前可用，可直接发布。
- `@aishield` 组织已存在且你有 owner 权限，无需新建组织。
- **关键提醒**：Scoped 包默认为私有（private/restricted），发布时必须加 `--access public` 参数，否则会报 402 错误（需付费账号）。

### 1.3 备选包名（如遇冲突或需要调整时）

如果未来 `@aishield/mcp-server` 被他人抢占，或希望同时提供非 scoped 版本，可考虑以下备选：

| 备选名 | 类型 | 适用场景 |
|--------|------|----------|
| `aishield-mcp-server` | 非 scoped | 更易输入，兼容不支持 scope 的工具 |
| `aishield-mcp` | 非 scoped | 更简短 |
| `@aishield/security-scanner` | scoped | 更突出功能定位 |
| `@aishield/mcp` | scoped | 简化 scoped 名称 |

> 建议：优先使用 `@aishield/mcp-server`。如需兼顾旧版 MCP 客户端兼容性，可额外发布 `aishield-mcp-server` 作为别名包（内容相同）。

---

## 二、发布前检查（Pre-publish Checks）

### 2.1 package.json 字段核对

对照 `mcp-server/package.json`，确认以下字段均已正确填写：

- [x] `name` — `@aishield/mcp-server`（已确认可用）
- [x] `version` — `4.1.0`
  > ⚠️ 注意版本不一致：`package.json` 为 `4.1.0`，`mcp.json` 为 `4.2.0`。发布前请统一为同一版本号，建议以 `package.json` 为准。
- [x] `description` — 已填写安全扫描描述
- [x] `main` — `dist/index.js`
- [x] `types` — `dist/index.d.ts`
- [x] `bin` — `aishield-mcp: dist/index.js`（CLI 入口）
- [x] `license` — `MIT`
- [x] `author` — `AIShield Team`
- [x] `repository.url` — `https://github.com/lm203688/aishield`
- [x] `homepage` — `https://aishield.tools`
- [x] `keywords` — 已包含 11 个关键词
- [x] `scripts.build` — `tsc`
- [ ] **`files` — 缺失，必须补充**
  > 不指定 `files` 时，npm 会根据 `.npmignore` / `.gitignore` 决定打包内容，容易漏文件或多打包。建议显式指定。
- [ ] **`engines` — 缺失，建议补充**
  > 标明最低 Node.js 版本（项目用了 `fetch`、`AbortController`，需 Node >= 18）。
- [ ] **`publishConfig` — 缺失，必须补充**
  > Scoped 包需要 `"access": "public"` 才能公开发布。
- [ ] **`bugs` — 缺失，建议补充**
  > 提供问题反馈入口，npm 页面会显示。
- [ ] **`sideEffects` — 缺失，建议补充**
  > 设为 `false` 可帮助 tree-shaking。

#### 建议补充的 package.json 片段

```jsonc
{
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=18.0.0"
  },
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  },
  "bugs": {
    "url": "https://github.com/lm203688/aishield/issues"
  },
  "sideEffects": false
}
```

### 2.2 README 文件检查

- [ ] `mcp-server/README.md` 存在
- [ ] 包含项目简介与功能说明
- [ ] 包含安装方法（`npx @aishield/mcp-server`）
- [ ] 包含客户端配置示例（Claude Desktop / Cursor 的 `mcpServers` JSON）
- [ ] 包含环境变量说明（`AISHIELD_API_URL`、`AISHIELD_API_KEY`）
- [ ] 包含工具列表与简介（8 个工具）
- [ ] 包含 License 声明

> README 会直接显示在 npm 包页面，是用户了解包的首要入口，务必完整。

### 2.3 LICENSE 文件检查

- [ ] `mcp-server/LICENSE` 或项目根目录 `LICENSE` 存在
- [ ] 内容为 MIT 许可证全文
- [ ] 包含版权年份与持有者名称

### 2.4 入口文件检查

- [ ] `dist/index.js` 存在 shebang 行 `#!/usr/bin/env node`（已确认在 `src/index.ts` 第 1 行）
- [ ] `dist/index.js` 具有可执行权限（CLI bin 入口需要）
- [ ] `dist/index.d.ts` 类型声明文件存在

### 2.5 敏感信息检查

- [ ] 代码中无硬编码的 API Key / 密码 / Token
- [ ] `.npmignore` 或 `files` 字段排除了 `node_modules`、`.env`、测试数据等
- [ ] 确认不会把 `.env`、`*.log`、`.git` 等发布上去

---

## 三、构建步骤（Build Steps）

### 3.1 安装依赖

```powershell
cd mcp-server
npm install
```

### 3.2 执行 TypeScript 编译

```powershell
npm run build
```

- 确认 `tsc` 无报错
- 确认 `dist/` 目录已生成 `index.js` 和 `index.d.ts`

### 3.3 本地验证（dry run）

```powershell
# 模拟发布，查看最终打包内容，不实际上传
npm pack --dry-run
```

- 检查输出文件列表是否只包含 `dist/`、`README.md`、`LICENSE`、`package.json`
- 确认文件总大小合理（通常 < 100KB，无意外大文件）

### 3.4 本地功能验证

```powershell
# 测试 CLI 能否正常启动
node dist/index.js
# 应输出: AIShield MCP Server v3.0 — OWASP MCP Top 10 aligned
```

---

## 四、npm 登录与发布命令

### 4.1 登录 npm

```powershell
# 登录（使用 @aishield 组织所属的 npm 账号）
npm login

# 验证登录身份
npm whoami
# 确认输出的用户名是 @aishield 组织的 owner 成员

# 验证组织权限
npm org ls aishield
# 应显示: aishield - owner
```

### 4.2 首次发布

```powershell
cd mcp-server

# Scoped 包必须加 --access public
npm publish --access public
```

> **重要**：首次发布 scoped 包时，如果不加 `--access public`，npm 会尝试发布为私有包并报 402 Payment Required 错误。
> 如果已在 `package.json` 的 `publishConfig` 中配置了 `"access": "public"`，则命令行可省略该参数。

### 4.3 后续版本发布

```powershell
# 更新版本号（会自动修改 package.json 并创建 git tag）
npm version patch   # 4.1.0 -> 4.1.1（修复）
npm version minor   # 4.1.0 -> 4.2.0（新功能）
npm version major   # 4.1.0 -> 5.0.0（破坏性变更）

# 重新构建并发布
npm run build
npm publish
```

---

## 五、版本管理（Version Management）

### 5.1 语义化版本规范（SemVer）

| 版本类型 | 命令 | 适用场景 | 示例 |
|----------|------|----------|------|
| Patch | `npm version patch` | Bug 修复、小改动 | `4.1.0` → `4.1.1` |
| Minor | `npm version minor` | 新增功能，向后兼容 | `4.1.0` → `4.2.0` |
| Major | `npm version major` | 破坏性变更 | `4.1.0` → `5.0.0` |

### 5.2 版本同步要求

项目中存在多处版本号，发布前必须统一：

| 文件 | 当前版本 | 说明 |
|------|----------|------|
| `mcp-server/package.json` | `4.1.0` | npm 发布的实际版本（权威） |
| `mcp-server/mcp.json` | `4.2.0` | MCP 清单版本 |
| `mcp-server/src/index.ts` | `3.0.0`（Server version） | 运行时打印版本 |
| `registry/glama.json` | `4.1.0` | Glama 提交版本 |

> **建议**：发布前将 `mcp.json`、`index.ts` 中的版本号统一为 `package.json` 的值，避免版本号混乱。

### 5.3 预发布版本（可选）

```powershell
# 发布 beta 版本
npm version prerelease --preid=beta
# 4.1.0 -> 4.1.1-beta.0
npm publish --tag beta

# 用户安装 beta 版: npm install @aishield/mcp-server@beta
```

### 5.4 版本标签管理

```powershell
# 查看所有标签
npm dist-tag ls @aishield/mcp-server

# 设置 latest 标签指向稳定版
npm dist-tag add @aishield/mcp-server@4.1.0 latest
```

---

## 六、发布后验证（Post-publish Verification）

### 6.1 在线验证

- [ ] 访问 `https://www.npmjs.com/package/@aishield/mcp-server` 确认页面正常显示
- [ ] 确认 README 渲染正确（无 markdown 语法错误）
- [ ] 确认 License 显示为 MIT
- [ ] 确认版本号正确
- [ ] 确认关键词（keywords）显示完整
- [ ] 确认 Repository / Homepage 链接可点击跳转

### 6.2 命令验证

```powershell
# 验证包已发布
npm view @aishield/mcp-server

# 验证最新版本
npm view @aishield/mcp-server version

# 验证可以全局安装并运行
npx @aishield/mcp-server
# 应输出: AIShield MCP Server v3.0 — OWASP MCP Top 10 aligned
```

### 6.3 MCP 客户端集成验证

在 Claude Desktop / Cursor 中配置后验证：

```json
{
  "mcpServers": {
    "aishield": {
      "command": "npx",
      "args": ["-y", "@aishield/mcp-server"]
    }
  }
}
```

- [ ] 客户端能正常启动 AIShield MCP Server
- [ ] 工具列表中显示 8 个 aishield 工具
- [ ] 调用 `aishield_scan` 工具能返回扫描结果
- [ ] 调用 `aishield_guardrail` 工具能返回 pass/block 判定

### 6.4 撤回与下线（如需）

```powershell
# 撤销发布（仅在发布 72 小时内可用，且该版本将永久不可重新发布）
npm unpublish @aishield/mcp-server@4.1.0

# 弃用版本（推荐，不删除但标记弃用）
npm deprecate @aishield/mcp-server@4.1.0 "请升级到最新版本"
```

> npm 规定：发布超过 72 小时无法 unpublish。建议使用 `deprecate` 标记旧版本而非删除。

---

## 七、发布检查总览（快速 Checklist）

发布前逐项打勾，全部通过后执行 `npm publish --access public`：

```
□ package.json 字段完整（name/version/description/main/bin/license/keywords）
□ package.json 已补充 files/engines/publishConfig/bugs 字段
□ README.md 存在且内容完整
□ LICENSE 文件存在（MIT）
□ mcp.json 与 package.json 版本号一致
□ index.ts 中 Server version 已更新
□ npm run build 编译成功，dist/ 已生成
□ npm pack --dry-run 打包内容正确
□ node dist/index.js 能正常启动
□ npm login 已登录正确账号
□ npm org ls aishield 确认 owner 权限
□ 代码中无敏感信息泄露
□ 执行 npm publish --access public
□ 发布后访问 npmjs.com 确认页面正常
□ npx @aishield/mcp-server 能正常运行
□ MCP 客户端集成验证通过
```

---

## 附：当前项目待修复项汇总

| 序号 | 待修复项 | 优先级 | 位置 |
|------|----------|--------|------|
| 1 | package.json 缺少 `files` 字段 | 高 | `mcp-server/package.json` |
| 2 | package.json 缺少 `engines` 字段 | 高 | `mcp-server/package.json` |
| 3 | package.json 缺少 `publishConfig.access: public` | 高 | `mcp-server/package.json` |
| 4 | package.json 缺少 `bugs` 字段 | 中 | `mcp-server/package.json` |
| 5 | 版本号不一致（package.json 4.1.0 / mcp.json 4.2.0 / index.ts 3.0.0） | 高 | 多文件 |
| 6 | index.ts 注释写"6 tools"但 mcp.json 声明 8 个工具 | 中 | `mcp-server/src/index.ts` |
| 7 | 需确认 README.md 和 LICENSE 文件存在 | 高 | `mcp-server/` |
```
