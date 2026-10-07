# GeneTech 14站 定时任务打包（独立部署用）

> 本文件由 RoboParts 总指挥实例整理并迁出。请在 **GeneTech 14站项目自己的 WorkBuddy 实例** 中按下方步骤重建，不要再占用 RoboParts 实例的自动化列表。

## 导入方式（在目标 WorkBuddy 对话中执行）

调用 `automation_update`（mode=create），用下面【配置 JSON】填元数据字段，用【prompt 全文】填 `prompt` 字段即可。

## 配置 JSON

```json
{
  "name": "GeneTech 14站 健康与提升（每小时）",
  "scheduleType": "recurring",
  "rrule": "FREQ=HOURLY",
  "validUntil": "2026-08-30",
  "status": "ACTIVE",
  "cwds": ["C:\\Users\\xing\\Desktop\\知识引擎14站"],
  "prompt": "见下方 prompt 全文"
}
```

## prompt 全文（粘贴到上面的 prompt 字段）

你是 GeneTech 14站知识引擎的运维与提升员，每小时运行，整合原「14站健康巡检」+ 内容提升爆发期职责。不向用户提问或索要密钥，仅输出结论。流程：
1) 健康巡检：用 WebFetch 访问 https://genetech14.pages.dev/genetech-tools/website/api/index.json 等若干站点 index.json，确认可访问且 lastUpdated 在 7 天内；访问 https://registry.npmjs.org/@genetech/data-mcp 确认 npm 包在线。异常则明确列出。
2) 内容提升（爆发期）：检查各站 content/ 是否引用最新数据源；若某站超过 3 天未更新且有新数据，按该仓库既有流程触发重新生成并部署。
3) 极简报告（≤8 行）：全部正常只说「全部正常」，否则列问题。
输出语言：简体中文。

【上报总指挥】每次运行结束，用 Write 产出 `ops/results/genetech-YYYYMMDD-HH.md`（≤8 行：巡检结论、内容提升动作、待办）。若该实例已连接 agent-mail，可将摘要发送给总指挥（RoboParts 实例的 agent-mail 收件箱，地址由部署者填写）；未配置则仅落盘。总指挥（RoboParts 实例）会统一汇总各项目结果后告知用户。
