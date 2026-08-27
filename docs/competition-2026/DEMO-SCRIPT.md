# 60-90 秒全链路录屏脚本

> 目的：让评审人在 90 秒内看到「多 Agent 协作 + Guard 矩阵 + 可信交付」完整跑通一次。
> 受众：goai_2026 评审人 + 投资者 + 潜在企业客户。
> 时长：60-90 秒，建议录 90 秒剪到 60 秒。

---

## 录屏结构（90 秒）

| 时间 | 屏幕 | 旁白 | 关键画面 |
|------|------|------|----------|
| 0-10s | ask.html | "用户问了一个真问题：'2025-2026 哪些 AI for Science 突破有商业化潜力？'" | 搜索框输入 query |
| 10-25s | 终端/控制台 | "6 个 Agent 开始协作" | 6 个 agent 卡片依次亮起，标 Collector→Normalizer→Validator→Publisher→Repair→KnowledgeGuard |
| 25-40s | 数据流 | "Collector 从 6 源拉数据，Normalizer 跨源归一" | 屏幕显示 6 个数据源 logo 飞入，entity 数实时增长 |
| 40-55s | 评分面板 | "Validator 评分，0-100" | 实时显示 entity 评分条形图，过滤掉 < 70 的 |
| 55-70s | 14 站 | "Publisher 发布到 14 站" | 14 个站点的 favicon 依次亮起 |
| 70-80s | audit log | "KnowledgeGuard 全程留痕" | 滚动 `audit/2026-08-24.jsonl` 高亮每一步 |
| 80-90s | 答案页 | "1.5 秒出答案，每个引用可追溯" | 答案 + 引用 + 「Time Machine」按钮（可点击回放到任意时间点） |

---

## 关键画面清单（每帧截图）

### Frame 1: ask.html（0-10s）
- 搜索框输入 query
- 右侧实时显示「预计耗时」「预计 entity 数」
- CTA 按钮：「开始全链路检索」

### Frame 2: 6 Agent 协作图（10-25s）
- 中央 6 个 agent 卡片（图标 + 名字）
- 依次亮起：Collector（拉）→ Normalizer（归一）→ Validator（验）→ Publisher（发）→ Repair（修）→ KnowledgeGuard（守）
- 每个亮起时显示当前 action + cost_ms

### Frame 3: 数据流（25-40s）
- 左上角 6 个源 logo（OpenAlex/arXiv/Crossref/PubMed/SemScholar/Europe PMC）
- 飞入右侧 entity pool
- 实时计数器：「已归一：2345 entity / 失败：12」

### Frame 4: 评分面板（40-55s）
- 横条图：entity 评分分布（0-100）
- 阈值线：70
- 红色（< 70）被踢出；绿色（≥ 70）进入下一阶段

### Frame 5: 14 站发布（55-70s）
- 14 个站点的 favicon 矩阵
- 依次亮起，每个亮起时显示「已更新：23 entity」

### Frame 6: audit log（70-80s）
- 滚动 `audit/2026-08-24.jsonl`
- 高亮 6 个不同 action 的条目
- 时间线：UTC 时间精确到毫秒

### Frame 7: 答案页（80-90s）
- 顶部 query 回显
- 主体：分点答案（3-5 条）
- 每条答案下方：引用列表（DOI/arXiv ID/源 URL）
- 右上角：「Time Machine」按钮（点击可弹窗选择历史时间点重放）

---

## 录屏技术细节

### 工具
- **OBS Studio**（开源录屏，跨平台）
- 或 **Windows Game Bar**（Win+G，零成本）

### 录屏参数
- 分辨率：1920×1080
- 帧率：30fps（够用，省空间）
- 编码：H.264
- 输出：90 秒约 50-80 MB

### 后期
- 用 **剪映**或 **CapCut Desktop**剪辑到 60 秒
- 加字幕（中文 + 英文双语字幕，可选）
- 背景音乐：CC0 协议（如 YouTube Audio Library）

---

## 演示数据准备（录之前必须先跑一遍）

1. **清空演示环境**：
   - 用 staging 环境的 ask.html（不要用线上）
   - 清空 `audit/2026-08-24.jsonl`

2. **准备 1 个真问题**：
   - 建议：「2025-2026 哪些 AI for Science 突破有商业化潜力？」
   - 避免太宽（会超时）或太窄（找不到 entity）

3. **预热 6 源**：
   - 提前 5 分钟跑一次 `pipeline-data-accumulation.js`，确保缓存热
   - 避免演示时第一次拉数据超时

4. **准备备用画面**：
   - 如果演示失败，立刻切到录好的 fallback 视频
   - 录 2-3 遍选最好的

---

## 录屏完成后怎么用

| 用途 | 渠道 | 时长 | 链接策略 |
|------|------|------|----------|
| goai_2026 提交材料 | 官方提交系统 | 60 秒 | 必传 |
| 投资者 BP | 路演视频 | 60 秒 | 嵌入 Notion / 飞书 |
| 官网首页 | 14 站根页 | 60 秒 | 自动播放（静音）|
| GitHub README | `lm203688/genetech-14-sites` | GIF 30 秒 | 嵌入 README 顶部 |
| 推特/X | 海外推广 | 30 秒 | 单独剪一版 |

---

## 当前状态

- [ ] 录屏脚本：本文件已写完 ✅
- [ ] 演示数据预热：未做
- [ ] 实际录屏：未做
- [ ] 后期剪辑：未做
- [ ] 多版本剪裁：未做

**P1 工作**：需要 1 个 90 分钟完整时段，按本脚本录一遍。
