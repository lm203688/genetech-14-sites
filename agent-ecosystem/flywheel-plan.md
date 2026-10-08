# 飞轮扩域自主决策（编排层输出）

生成时间: 2026/10/8 08:19:32

## 生态位串联

| 层 | 资产 | 状态 |
|----|------|------|
| 认知 Cognition | AOCI (知识引擎14站, meta=true, code=true) | 就绪 |
| 工具/数据 Tools | data/citation-gaps.json (30站/101零引用对) | 就绪 |
| 治理 Governance | publish-guard v2 (default=deny) | 就绪 |
| 编排 Orchestration | 本文件 = 串联以上三层的决策管线 | 本次补全 |

## 决策摘要

- 零引用跨域对（研究空白候选）总数：**101**（gapRatio=0.1161）
- 经治理策略（白名单 allowed_sites）过滤后：**可放行 101** / 被拦截 0**
  - 其中非受管生态域对：0（不在 30 站白名单内）
  - 其中本地容量判定满容：0（注：本地 index 多报 10000 占位，真实填充以 CI 分片为准）

## Top-10 优先扩域（combinedSize 越大 = 潜在知识收益越高）

| # | 从→到 | 锚点站 | 容量提示 | 潜在收益 |
|---|------|--------|---------|---------|
| 1 | agent-ecosystem → low-altitude | agent-ecosystem | unknown-assumed-ok | 20000 |
| 2 | agent-ecosystem → neuromorphic | agent-ecosystem | unknown-assumed-ok | 20000 |
| 3 | agent-ecosystem → semiconductor | agent-ecosystem | unknown-assumed-ok | 20000 |
| 4 | biomed-ai → exo-science | biomed-ai | unknown-assumed-ok | 20000 |
| 5 | bionic-ai → exo-science | bionic-ai | unknown-assumed-ok | 20000 |
| 6 | bionic-ai → low-altitude | bionic-ai | unknown-assumed-ok | 20000 |
| 7 | bionic-ai → nuclear-energy | bionic-ai | unknown-assumed-ok | 20000 |
| 8 | brain-science → low-altitude | brain-science | unknown-assumed-ok | 20000 |
| 9 | brain-science → new-energy | brain-science | unknown-assumed-ok | 20000 |
| 10 | brain-science → nuclear-energy | brain-science | unknown-assumed-ok | 20000 |

## 被治理拦截（示例）

| 从→到 | 目标站 | 原因 |
|------|--------|------|

## 已强桥接（维持，不作为扩域目标）

- alien-minerals ⇄ exo-science : 2143 条边
- ai4science ⇄ biocomputing : 1204 条边
- ai-safety ⇄ biomed-ai : 1129 条边
- ai4science ⇄ biomed-ai : 766 条边
- ai-safety ⇄ biocomputing : 541 条边

---
由 agent-ecosystem/orchestrator.mjs 自动生成（编排层）
