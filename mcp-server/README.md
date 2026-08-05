# GeneTech 数据引擎 MCP Server

让任何外部 AI Agent（Claude / Cursor / LangChain / 自研 Agent）实时查询、检索、引用
GeneTech 14 站知识引擎的实体数据。这是项目从"给人看的内容站"升级为"给 Agent 消费的
知识 API"的**核心护城河**——别人无法一键复制的实时知识接口。

## 数据契约

每个站点通过以下静态 JSON 暴露数据（与线上站点完全一致）：

- `<site>/website/api/index.json` → `{ site, totalEntities, lastUpdated, categories }`
- `<site>/website/api/entities.json` → 实体数组
  `{ id, name, source, abstract, url, authors[], tags[], confidence, sites[], publishedDate, addedAt }`

## 快速开始（本地 / 自托管）

```bash
cd mcp-server
npm install
node src/index.mjs
```

默认读取**仓库根目录**下的各站点数据。可用环境变量覆盖：

| 变量 | 说明 |
|------|------|
| `GENETECH_DATA_DIR` | 本地数据根目录（默认：仓库根） |
| `GENETECH_API_BASE` | 已部署站点 URL，如 `https://lm203688.github.io/genetech-14-sites`（设置后改为远程拉取） |
| `GENETECH_API_KEY` | 设置后要求客户端 Bearer 鉴权（付费墙） |
| `GENETECH_REQUIRE_AUTH` | 设为 `true` 强制校验 API Key |

## 接入 Claude Desktop / Cursor

`claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "genetech-data": {
      "command": "node",
      "args": ["/绝对路径/genetech-14-sites/mcp-server/src/index.mjs"],
      "env": { "GENETECH_DATA_DIR": "/绝对路径/genetech-14-sites" }
    }
  }
}
```

## 提供的工具

| 工具 | 作用 |
|------|------|
| `list_sites` | 列出全部站点及实体数 / 更新时间 |
| `query_entities` | 按站点 / 数据源 / 标签 / 关键词 / 置信度过滤 |
| `get_entity` | 按 ID 取详情并可导出引用 |
| `semantic_search` | 关键词相关性检索（标题/标签加权 + 置信度加权） |
| `export_citation` | 导出 BibTeX / APA / RIS 引用 |

## 已注册的 Glama 清单

`mcp-server/glama.json`（与 `glama.json` 中的 AIShield 安全 MCP 并列，构成"数据 + 安全"双生态位）。

## 自动化发布

由 `.github/workflows/ops-extra.yml` 的 `mcp-publish` job 定期校验并（在版本变更时）提交
`glama.json` 与 `package.json`，随仓库推送自动上线。
