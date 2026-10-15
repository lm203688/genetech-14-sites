# audit/

**本目录定位**：CLI / 本地测试的审计日志归档，**不承载生产发证 / 支付审计**。

生产审计在 **Cloudflare R2 + Logpush**（不可变审计源），配置见 [`LOGPUSH-SETUP.md`](LOGPUSH-SETUP.md)。

## 目录内容

| 文件 | 说明 |
|------|------|
| `README.md` | 本文件，说明定位 |
| `LOGPUSH-SETUP.md` | Cloudflare Logpush → R2 不可变审计配置指南（Phase 5，2026-10-15 新增） |
| `2026-09-29.jsonl` | CLI 测试的审计样例（6 行，历史保留，非生产） |

## 为什么生产审计不放在这里

Git 是**可改写**的（`git push --force` / amend），不满足合规审计的"不可变"要求。
Logpush → R2 Object Lock 是合规要求下的唯一正确答案：写入后强制保留期，任何人都改不了。

## 生产审计查询入口

```bash
# 拉 R2 最新审计日志（需先 rclone 配好 R2 后端）
rclone sync r2:genetech-audit-logs ./local-audit/ --include "*.jsonl.gz"

# 查最近 24 小时的所有发证事件
find local-audit/genetech-license -name "*.jsonl.gz" -mmin -1440 | \
  xargs gunzip -c | jq 'select(.type == "audit" and .event_type == "issue")'
```

## 报告锚点

`reports/项目分板块深度评估报告-2026-10-14.md` §13b：
> **audit**（审计）：仅 1 个 6 行 jsonl，actor 全是 cli_test，无一条真实发证/支付审计记录。
> 完整度 15 / 可用度 20 / 成熟度 5。这是尽调红旗：无法回答"哪张许可证发给了谁"。
> 融合：Cloudflare Logpush→R2 不可变审计 + OPA 决策日志。

Phase 5（2026-10-15）交付：配置指南 [`LOGPUSH-SETUP.md`](LOGPUSH-SETUP.md) 已到位；
Cloudflare Dashboard 配置由维护者执行（10 分钟），Worker 侧埋点补丁见指南 §二。
