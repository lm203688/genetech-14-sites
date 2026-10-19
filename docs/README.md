# docs/ — 文档目录与可见性说明

这个目录里**不是所有文件都是给人读的对外文档**。这里有一个公开/私有的分工，
由机器判据管理，不靠人记得。

## 公开文档（本目录中可直接引用）

| 文件 | 用途 |
|---|---|
| [`consumer-onboarding.md`](consumer-onboarding.md) | 消费方接入指南：拿到 key、调第一个端点、常见错误 |
| [`whitepaper.md`](whitepaper.md) | 项目白皮书：定位、四层架构、诚实口径、商业化路径 |
| [`tech-decisions.md`](tech-decisions.md) | 技术决策记录（ADR）：T1 双时间戳+tier / T2 引用边结构化 / T3 ID 规范化 |
| [`enterprise-data-license-kit.md`](enterprise-data-license-kit.md) | 企业数据授权套件：授权范围、切片、交付物 |
| [`ops-runbook.md`](ops-runbook.md) | 运维手册：手动步骤、故障处置、部署顺序 |
| [`citation-probe-questions.md`](citation-probe-questions.md) | AI 引述率测量题库（可复用的评测集） |
| [`attribution.md`](attribution.md) | **归因规范**：引用本知识库时必须注明什么 |
| [`domain-graph.html`](domain-graph.html) | 30 域关系图（可视化） |
| [`frontier-discoveries.md`](frontier-discoveries.md) | 前沿发现汇编 |

根目录另有一份 [`ai.txt`](../ai.txt)，给 AI 系统读的机器可读索引。

## 私有文档（本目录中仅存占位 stub）

这些文件**原文不在公开树里**，只留一个说明性 stub。它们包含战略、竞品、增长、
告警、审计、竞赛备战等内部内容。

识别方法：文件开头有这行标记——

```html
<!-- docs-visibility: stubbed -->
```

原文归档在本机 `.workbuddy/private-docs/`（该路径已在 `.gitignore`，不入仓）。

**为什么要这样做，而不是直接删掉**

删除会把历史取证链一起抹掉。v1/v2 两轮全量扫描的很多结论都引自
`ALERT-2026-08-*.md`、`strategy-weekly.md`、`audit-*.md`——那些文件是证据。
所以保留在本地私有目录，公开树只留指针。

**为什么当初会泄露**

`.gitignore` 只管「新增文件不入库」，管不了「已经入库的文件」。
`docs/audit-*.md` 早就被 .gitignore 挡住了，但 `docs/audit-2026-08-31.md`
仍然在公开树里——因为它在规则生效之前就已经提交。
2026-10-08 实测：`docs/` 下有 **42 份内部文档真内容在公开树里**
（`.gitignore` 只挡了 `docs/audit-*.md` 这一种模式，其余裸奔）。已全部归档。

## 判定由谁做

分类规则在 [`../guards/docs-visibility.policy.json`](../guards/docs-visibility.policy.json)，
扫描与判定在 [`../operations-plan/pipeline-docs-guard.js`](../operations-plan/pipeline-docs-guard.js)。

```bash
node operations-plan/pipeline-docs-guard.js          # 检查（退出码 0 放行 / 1 阻断）
node operations-plan/pipeline-docs-guard.js --fix    # 把泄露的内部文档归档 + 换成 stub
```

退出码语义：

- `0` 公开树无内部文档真内容
- `1` 仍有泄露（CI 应阻断）
- `2` 策略文件缺失或配置错误

**新增一份内部文档时**：不要把它放进 `docs/` 后指望它自动私有化。
要么按公开白名单的标准改写后显式加进 `public_allowlist`，
要么确认它命中 `internal_patterns` 后跑一次 `--fix` 归档。
未分类的文件会被点名单并告警（不阻断）——告警存在就是为了让你注意到它。

## 相关的两个护栏

| 护栏 | 管什么 |
|---|---|
| `pipeline-docs-guard.js` | 什么东西**可以被公开** |
| `pipeline-domain-claim-guard.js` | 公开面上**不能出现不存在的地址** |

第二条是针对一个具体事故的反向护栏：30 个站点子域
（`quantum-computing.swarmlabs.tools` 等）从未配置 DNS，
而同一二级域下的 `api.` / `data.` / `license.` 三个子域是能解析的——
这恰恰会让人误以为"这个域名没问题"于是又写回去。
所以"别再写"必须变成机器判据。
