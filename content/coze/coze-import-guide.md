# Coze 知识库导入与变现指南（逐步）

## 一、准备知识包
本目录下的文件即为知识包：
- `00-INDEX.md` — 总览
- `<站点slug>.md` × 22 — 各站深度解读文档
- `bridging-report.md` — 跨域桥接报告（差异化卖点）
- `bot-prompt.md` — 直接复制为 Bot 系统提示词
- `pricing.md` — 定价与引导策略

## 二、创建知识库
1. 打开 🔗 https://www.coze.cn （国内）或 https://www.coze.com
2. 左侧「知识库」→「创建知识库」→ 命名「GeneTech 科技深度解读」
3. 「本地文档」上传：选中本目录全部 `.md` 文件 → 分段默认 → 完成

## 三、创建 Bot
1. 「Bot 商店」→「创建 Bot」→ 命名「GeneTech 科技深度解读助手」
2. 「人设与回复逻辑」粘贴 `bot-prompt.md` 全文
3. 「知识」→ 绑定刚才的知识库，开关「知识库回复」
4. 预览调试几条问题（如"量子计算最新进展？""AI 和合成生物有什么交叉？"）

## 四、变现开通
1. 🔗 https://www.coze.cn/store （扣子商店）→ 发布 Bot / 技能
2. 开启「付费订阅」或上架「技能包」（参考 pricing.md 档位）
3. 深度版 CTA 指向 🔗 https://license.genetech.tools （Pro ¥39.9 / 终身 ¥199，虎皮椒支付已就绪）

## 五、注意事项
- 知识库为公开学术元数据，无版权风险；可定期重跑 `tools/coze-exporter.mjs` 更新。
- 不要在任何地方粘贴 API Key / 源码；升级链接只放 license 端点。
