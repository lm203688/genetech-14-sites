# 更新纪律：Patch-never-regenerate（增量修补，禁止整体重写）

> 生效日期：2026-09-15 · 借鉴来源：HyperResearch（`jordan-gibbs/hyperresearch`，MIT）的 "patch, never regenerate" 原则
> 适用范围：本仓所有飞轮 pipeline 对**既有内容**的更新动作

## 一、为什么要这条纪律

飞轮是**复利系统**：`content/blog/*.md`、`reports/*`、实体库的既有产物，其价值在于"越用越厚"。
一旦某个 pipeline 对既有文件做**整篇重写**，就会：

1. **静默丢失已验证内容** —— 上一轮人工/AI 审阅过的段落、已核验的引文，被新版覆盖后无从找回。
2. **破坏引用完整性** —— 下游（GEO 博客门禁、`cite-checker`、IndexNow 推送 URL）依赖文件稳定；整篇重写会让"同一 URL 内容漂移"，搜索权重与可信度受损。
3. **放大错误** —— 重写是一次性大改，出错面积大且难以二分定位；增量修补的 diff 小、可 review、可回退。

HyperResearch 的做法是用工具锁**在机制层**禁止 patcher 重新生成整篇，只允许外科式 Edit hunk。
我们不做工具锁（本地模型栈），改为**规范 + 代码级守卫**两层落地。

## 二、硬性规则

| 场景 | 允许 | 禁止 |
|---|---|---|
| 文件**不存在** | 新建写入 | — |
| 文件**已存在**，需追加 | 追加段落 / 新增条目 / 更新字段 | 整篇重写 |
| 文件**已存在**，需修正某段 | 定点替换（read → 定位 → 替换 → 写回） | `writeFile` 覆盖全文 |
| 文件**已存在**，同批重跑 | 跳过（skip-if-exists） | 覆盖为相同/相似内容 |
| 批量清理/归档 | 移动到 `archive/` 子目录 | 直接删除 |

**一句话**：`fs.writeFile` 只在"文件不存在"时使用；文件已存在时必须走"读-定位-改-写回"或"跳过"。

## 三、判定标准（怎么算违规）

违规特征（三者命中其一即需修正）：

1. **无存在性检查的盲写** —— `writeFile(path, content)` 前没有 `existsSync(path)` / `stat` 分支。
2. **路径按时间生成 + 盲写** —— slug/filename 由 `date` 派生（如 `geo-roundup-2026-09-15.md`），同日多次运行会命中同一路径，盲写即覆盖。这是本仓已知的最高危形态。
3. **幂等标记缺失** —— 更新动作没有游标 / 已处理集合 / 版本戳，无法判断"这条是否已经处理过"。

合规基线（本仓已做到，作为参考实现）：

| 脚本 | 机制 |
|---|---|
| `pipeline-abstract-backfill.js` | 游标 `state/abstract-backfill-cursor.json` + 幂等跳过已回填实体 |
| `pipeline-geo-promotion.js` | **2026-09-15 起**：`existsSync` 守卫，同日重跑 skip-if-exists（此前为盲覆盖） |
| `pipeline-intelligence.js` / `pipeline-geo-promotion.js` 报告 | 文件名含时间戳 `report-*-<timestamp>.json`，天然不覆盖 |
| `data/entities.json` 聚合 | 读-合并-去重-写回，非整篇重建 |

## 四、新增/修改 pipeline 时的检查清单

- [ ] 写入既有文件前，是否有存在性检查？
- [ ] 文件名是否含日期/时间戳（避免同日覆盖）？若不含，是否有游标防重？
- [ ] 更新是否为定点替换而非整篇重建？
- [ ] 是否有幂等标记（游标 / 已处理集合 / 版本戳）？
- [ ] 失败路径是否 fail-closed（写入失败不静默继续）？
- [ ] 删除/归档是否走 `archive/` 而非直接删除？

## 五、与 cite-checker 的关系

`pipeline-cite-check.js`（闭环六）只核验**对外/对内的 Markdown 报告**的引文完整性，
它回答"这份报告出厂前，引用是不是经得起查"。
本纪律回答"更新既有内容时，会不会静默毁掉已有的可信内容"。
两者构成出厂前双关：**内容稳定（本文件）+ 引文可信（cite-checker）**。

门禁强度：`STRICT_CITE=1` 时 `pipeline-cite-check.js` 在存在 `dead`（404/410）或 `retracted` 时 exit 1；
默认 flag 模式仅提示不阻断。注意 **403/401/429/451 归为 `blocked`（出版商拦截），不等于死链，不阻断门禁** ——
误杀代价高于漏报，这是刻意的口径选择。
