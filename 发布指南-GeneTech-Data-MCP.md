# GeneTech 数据引擎 MCP — npm 发布 & Glama 认证 分步指南

> 适用包：`@genetech/data-mcp`（本仓库 `mcp-server/`）
> 目标：让 `npx -y @genetech/data-mcp` 可用，并在 Glama 目录上线，拿到 agent-native 流量红利。
> 本指南只含**需要你手动操作**的步骤；代码侧（混合检索、搜索框、README、glama.json）已全部就绪。

---

## 前置：代码侧已就绪（无需你做）

- [x] `mcp-server/src/search.mjs` — BM25 + 字段加权 + RRF 真·混合检索（已单测 + stdio 冒烟通过）
- [x] `mcp-server/src/index.mjs` — `semantic_search` 已切换为混合检索
- [x] `mcp-server/glama.json` — 提交字段完整、版本 1.0.0、安装命令 `npx -y @genetech/data-mcp`
- [x] `mcp-server/README.md` — 含安装、环境变量、Claude/Cursor 客户端配置、5 个工具说明
- [x] `mcp-server/package.json` — `files: ["src","README.md","glama.json"]`，`bin: genetech-data-mcp`，`license: MIT`

---

## 第一步：发 npm 包（需你的 npm 账号，沙箱无 token）

1. 在终端进入目录：
   ```powershell
   cd C:\Users\xing\Desktop\知识引擎14站\mcp-server
   ```
2. 登录 npm（二选一）：
   - 交互登录：`npm login`（浏览器授权）
   - 或贴 token：`npm config set //registry.npmjs.org/:_authToken <你的npm token>`
   - 验证：`npm whoami` 应返回你的用户名
3. 本地预检（不实际上传，确认打包内容正确）：
   ```powershell
   npm pack --dry-run
   ```
   应只包含 `src/`、`README.md`、`glama.json`、`package.json`，总大小很小。
4. 发布（scoped 包必须 `--access public`，否则报 402）：
   ```powershell
   npm publish --access public
   ```
5. 验证：
   ```powershell
   npm view @genetech/data-mcp version
   npx -y @genetech/data-mcp
   ```
   第二个命令应启动 MCP server（stdio 监听，无报错即成功）。

> ⚠️ 若包名 `@genetech/data-mcp` 已被占用：`npm view @genetech/data-mcp` 看是否 404；若被占，改 `package.json` 的 `name` 为 `@genetech/knowledge-mcp` 之类再发。

---

## 第二步：Glama 认证提交（需你网页点击）

1. 打开 https://glama.ai/mcp/servers/new （先 GitHub 登录）
2. 按 `mcp-server/glama.json` 填表，关键字段：
   - **Server Name**：`GeneTech Data Engine`
   - **Install Command**：`npx -y @genetech/data-mcp`
   - **Transport**：`stdio`
   - **Repository URL**：`https://github.com/lm203688/genetech-14-sites`
   - **Homepage**：`https://lm203688.github.io/genetech-14-sites`
   - **License**：MIT
   - **Categories**：Knowledge Base / Research / Developer Tools / Data
   - **Tools**：5 个（list_sites / query_entities / get_entity / semantic_search / export_citation）
3. 提交 → 状态 `Pending → Under Review → Approved`（通常 1–7 天）
4. 通过后：在 README 加 Glama 徽章、分享收录链接拿 SEO 流量。

> 常见被拒原因：npm 包未发（npx 跑不起来）、仓库私有、缺 README/LICENSE、工具无法调用。
> 我们已规避：包发完即满足；仓库 public；README/LICENSE 齐全；5 工具冒烟已验证可用。

---

## 可选增强：开启真·向量语义（env 门控，默认关）

混合检索默认走 BM25+字段+RRF（零配置）。要上向量语义，在运行 server 时设：
```powershell
$env:GENETECH_EMBED_URL = "http://localhost:11434/v1/embeddings"   # 你的 Ollama 兼容端点
$env:GENETECH_EMBED_MODEL = "nomic-embed-text"                      # 或 text-embedding-3-small
# 可选：$env:GENETECH_EMBED_KEY = "<key>"
npx -y @genetech/data-mcp
```
首次检索会惰性对实体做嵌入并缓存到 `<DATA_DIR>/state/embed-cache.json`，之后 `semantic_search` 自动加入向量余弦一路做 RRF 融合。

---

## 第三步（发布后）：让自动化持续造势

- 提交后保持仓库活跃（ops 流水线已在每 30 分钟回填数据，仓库持续有 commit）。
- 后续版本：`npm version patch` → `npm publish --access public` → 同步更新 `mcp-server/glama.json` 的 `version`。
