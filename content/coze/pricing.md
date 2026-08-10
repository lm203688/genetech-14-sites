# 变现与定价方案（Coze 深度解读 Bot）

## 三层闭环
| 层级 | 载体 | 价格 | 内容 |
|---|---|---|---|
| 免费 | Coze Bot | ¥0 | 知识库基础问答、单篇解读 |
| Pro | genetech-license.61960005.workers.dev | **¥39.9** | 完整 47k 实体 API、MCP 接入、批量引用导出、跨域趋势 |
| 终身 | genetech-license.61960005.workers.dev | **¥199** | 上述全部 + 未来更新永久权 |

## Bot 内引导策略
1. 免费回答后，对"深入研究/接 API/批量"类诉求，自然插入升级链接。
2. Coze 商店可同时上架**技能包**（一次性 19–99 元）作为被动收入。
3. B 端定制（科研/投研知识库）单列报价 5k–5w/项目，不在 Bot 内自动成交。

## 支付
- 微信 / 支付宝 通过虎皮椒（Hupijiao）网关，回调已部署在 genetech-license.61960005.workers.dev。
- 许可证由 unified-license Worker 自动签发。
