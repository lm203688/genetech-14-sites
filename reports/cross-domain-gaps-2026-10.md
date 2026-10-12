# 跨域研究空白报告 · 2026-10

> 由 `operations-plan/pipeline-citation-gaps-briefing.js` 自动生成。
> 数据来源：`data/citation-gaps.json`（`pipeline-citation-gaps.js` 产出）。
> 端点：`GET https://api.swarmlabs.tools/v1/citation/gaps`

---

## 0. 读前须知

"研究空白"是**有向站对**——A 站没引用过 B 站的任何实体。它**不等于**真实世界级空白，
因为存在两种可能：

1. **真实空白**：两域在人类知识里真的没打通（我们想卖的资产）
2. **语料不足**：本项目在这两个域覆盖太浅，抓不到实际存在的引用

每条 gap 附**反驳关键词 + 阈值**——拿去 Google Scholar 复核，若引用 < 阈值则本假设成立。
**这份报告是候选清单，不是结论。**

---

## 1. 与上月对比

- 新增空白：**30** 条
- 消失空白：**0** 条（可能已通过补数据桥接）

### 新增空白
- `biomed-ai` ⇄ `exo-science` (combinedSize=20000)
- `bionic-ai` ⇄ `exo-science` (combinedSize=20000)
- `carbon-neutral` ⇄ `sat-6g` (combinedSize=20000)
- `embodied-ai` ⇄ `carbon-neutral` (combinedSize=20000)
- `exo-science` ⇄ `edge-ai` (combinedSize=20000)
- `exo-science` ⇄ `sat-6g` (combinedSize=20000)
- `genetech-tools` ⇄ `embodied-ai` (combinedSize=20000)
- `genetech-tools` ⇄ `neuromorphic` (combinedSize=20000)
- `genetech-tools` ⇄ `robot-parts` (combinedSize=20000)
- `genetech-tools` ⇄ `sat-6g` (combinedSize=20000)

---

## 2. 总体分布

| 指标 | 值 |
|---|---:|
| 有向站对总数 | 870 |
| 有引用边 | 769 (88.4%) |
| **零引用站对** | **101** (11.6%) |
| 跨域桥 | 30 |

## 3. Top 30 空白假设

### 1. `biomed-ai` ⇄ `exo-science`

- **优先级**：🟢 高
- **假设**：生物医学 AI 与地外环境医学尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `biomed-ai` in=2398 out=542
  - `exo-science` in=2233 out=520
- **反驳条件**：查 Google Scholar / arXiv，关键词 [space medicine AI / martian biology machine learning / space radiation cancer AI]，若近 5 年引用 < **100** 篇则本假设成立

### 2. `bionic-ai` ⇄ `exo-science`

- **优先级**：🟢 高
- **假设**：生物启发 AI 与地外生命探测尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `bionic-ai` in=2104 out=550
  - `exo-science` in=2233 out=520
- **反驳条件**：查 Google Scholar / arXiv，关键词 [astrobiology bio-inspired search / exo-life detection AI]，若近 5 年引用 < **50** 篇则本假设成立

### 3. `carbon-neutral` ⇄ `sat-6g`

- **优先级**：🟢 高
- **假设**：carbon-neutral 与 sat-6g 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `carbon-neutral` in=563 out=429
  - `sat-6g` in=310 out=369
- **反驳条件**：查 Google Scholar / arXiv，关键词 [carbon neutral sat 6g / sat 6g carbon neutral]，若近 5 年引用 < **30** 篇则本假设成立

### 4. `embodied-ai` ⇄ `carbon-neutral`

- **优先级**：🟢 高
- **假设**：carbon-neutral 与 embodied-ai 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `embodied-ai` in=1120 out=312
  - `carbon-neutral` in=563 out=429
- **反驳条件**：查 Google Scholar / arXiv，关键词 [carbon neutral embodied ai / embodied ai carbon neutral]，若近 5 年引用 < **30** 篇则本假设成立

### 5. `exo-science` ⇄ `edge-ai`

- **优先级**：🟢 高
- **假设**：edge-ai 与 exo-science 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `exo-science` in=2233 out=520
  - `edge-ai` in=489 out=350
- **反驳条件**：查 Google Scholar / arXiv，关键词 [edge ai exo science / exo science edge ai]，若近 5 年引用 < **30** 篇则本假设成立

### 6. `exo-science` ⇄ `sat-6g`

- **优先级**：🟢 高
- **假设**：exo-science 与 sat-6g 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `exo-science` in=2233 out=520
  - `sat-6g` in=310 out=369
- **反驳条件**：查 Google Scholar / arXiv，关键词 [exo science sat 6g / sat 6g exo science]，若近 5 年引用 < **30** 篇则本假设成立

### 7. `genetech-tools` ⇄ `embodied-ai`

- **优先级**：🟢 高
- **假设**：embodied-ai 与 genetech-tools 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `genetech-tools` in=563 out=376
  - `embodied-ai` in=1120 out=312
- **反驳条件**：查 Google Scholar / arXiv，关键词 [embodied ai genetech tools / genetech tools embodied ai]，若近 5 年引用 < **30** 篇则本假设成立

### 8. `genetech-tools` ⇄ `neuromorphic`

- **优先级**：🟢 高
- **假设**：genetech-tools 与 neuromorphic 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `genetech-tools` in=563 out=376
  - `neuromorphic` in=337 out=855
- **反驳条件**：查 Google Scholar / arXiv，关键词 [genetech tools neuromorphic / neuromorphic genetech tools]，若近 5 年引用 < **30** 篇则本假设成立

### 9. `genetech-tools` ⇄ `robot-parts`

- **优先级**：🟢 高
- **假设**：genetech-tools 与 robot-parts 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `genetech-tools` in=563 out=376
  - `robot-parts` in=905 out=479
- **反驳条件**：查 Google Scholar / arXiv，关键词 [genetech tools robot parts / robot parts genetech tools]，若近 5 年引用 < **30** 篇则本假设成立

### 10. `genetech-tools` ⇄ `sat-6g`

- **优先级**：🟢 高
- **假设**：genetech-tools 与 sat-6g 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `genetech-tools` in=563 out=376
  - `sat-6g` in=310 out=369
- **反驳条件**：查 Google Scholar / arXiv，关键词 [genetech tools sat 6g / sat 6g genetech tools]，若近 5 年引用 < **30** 篇则本假设成立

### 11. `neuromorphic` ⇄ `alien-minerals`

- **优先级**：🟢 高
- **假设**：alien-minerals 与 neuromorphic 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `neuromorphic` in=337 out=855
  - `alien-minerals` in=854 out=3178
- **反驳条件**：查 Google Scholar / arXiv，关键词 [alien minerals neuromorphic / neuromorphic alien minerals]，若近 5 年引用 < **30** 篇则本假设成立

### 12. `neuromorphic` ⇄ `synbio-manufacturing`

- **优先级**：🟢 高
- **假设**：neuromorphic 与 synbio-manufacturing 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `neuromorphic` in=337 out=855
  - `synbio-manufacturing` in=574 out=590
- **反驳条件**：查 Google Scholar / arXiv，关键词 [neuromorphic synbio manufacturing / synbio manufacturing neuromorphic]，若近 5 年引用 < **30** 篇则本假设成立

### 13. `privacy-computing` ⇄ `synbio-manufacturing`

- **优先级**：🟢 高
- **假设**：privacy-computing 与 synbio-manufacturing 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `privacy-computing` in=571 out=342
  - `synbio-manufacturing` in=574 out=590
- **反驳条件**：查 Google Scholar / arXiv，关键词 [privacy computing synbio manufacturing / synbio manufacturing privacy computing]，若近 5 年引用 < **30** 篇则本假设成立

### 14. `quantum-computing` ⇄ `alien-minerals`

- **优先级**：🟢 高
- **假设**：alien-minerals 与 quantum-computing 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `quantum-computing` in=1460 out=336
  - `alien-minerals` in=854 out=3178
- **反驳条件**：查 Google Scholar / arXiv，关键词 [alien minerals quantum computing / quantum computing alien minerals]，若近 5 年引用 < **30** 篇则本假设成立

### 15. `quantum-computing` ⇄ `robot-parts`

- **优先级**：🟢 高
- **假设**：quantum-computing 与 robot-parts 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `quantum-computing` in=1460 out=336
  - `robot-parts` in=905 out=479
- **反驳条件**：查 Google Scholar / arXiv，关键词 [quantum computing robot parts / robot parts quantum computing]，若近 5 年引用 < **30** 篇则本假设成立

### 16. `quantum-computing` ⇄ `synbio-manufacturing`

- **优先级**：🟢 高
- **假设**：quantum-computing 与 synbio-manufacturing 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `quantum-computing` in=1460 out=336
  - `synbio-manufacturing` in=574 out=590
- **反驳条件**：查 Google Scholar / arXiv，关键词 [quantum computing synbio manufacturing / synbio manufacturing quantum computing]，若近 5 年引用 < **30** 篇则本假设成立

### 17. `quantum-materials` ⇄ `edge-ai`

- **优先级**：🟢 高
- **假设**：edge-ai 与 quantum-materials 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `quantum-materials` in=932 out=749
  - `edge-ai` in=489 out=350
- **反驳条件**：查 Google Scholar / arXiv，关键词 [edge ai quantum materials / quantum materials edge ai]，若近 5 年引用 < **30** 篇则本假设成立

### 18. `quantum-materials` ⇄ `exo-science`

- **优先级**：🟢 高
- **假设**：exo-science 与 quantum-materials 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `quantum-materials` in=932 out=749
  - `exo-science` in=2233 out=520
- **反驳条件**：查 Google Scholar / arXiv，关键词 [exo science quantum materials / quantum materials exo science]，若近 5 年引用 < **30** 篇则本假设成立

### 19. `robot-parts` ⇄ `alien-minerals`

- **优先级**：🟢 高
- **假设**：alien-minerals 与 robot-parts 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `robot-parts` in=905 out=479
  - `alien-minerals` in=854 out=3178
- **反驳条件**：查 Google Scholar / arXiv，关键词 [alien minerals robot parts / robot parts alien minerals]，若近 5 年引用 < **30** 篇则本假设成立

### 20. `robot-parts` ⇄ `exo-science`

- **优先级**：🟢 高
- **假设**：exo-science 与 robot-parts 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `robot-parts` in=905 out=479
  - `exo-science` in=2233 out=520
- **反驳条件**：查 Google Scholar / arXiv，关键词 [exo science robot parts / robot parts exo science]，若近 5 年引用 < **30** 篇则本假设成立

### 21. `robot-parts` ⇄ `genetech-tools`

- **优先级**：🟢 高
- **假设**：genetech-tools 与 robot-parts 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `robot-parts` in=905 out=479
  - `genetech-tools` in=563 out=376
- **反驳条件**：查 Google Scholar / arXiv，关键词 [genetech tools robot parts / robot parts genetech tools]，若近 5 年引用 < **30** 篇则本假设成立

### 22. `robot-parts` ⇄ `quantum-computing`

- **优先级**：🟢 高
- **假设**：quantum-computing 与 robot-parts 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `robot-parts` in=905 out=479
  - `quantum-computing` in=1460 out=336
- **反驳条件**：查 Google Scholar / arXiv，关键词 [quantum computing robot parts / robot parts quantum computing]，若近 5 年引用 < **30** 篇则本假设成立

### 23. `sat-6g` ⇄ `genetech-tools`

- **优先级**：🟢 高
- **假设**：genetech-tools 与 sat-6g 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `sat-6g` in=310 out=369
  - `genetech-tools` in=563 out=376
- **反驳条件**：查 Google Scholar / arXiv，关键词 [genetech tools sat 6g / sat 6g genetech tools]，若近 5 年引用 < **30** 篇则本假设成立

### 24. `agent-ecosystem` ⇄ `low-altitude`

- **优先级**：🟡 中
- **假设**：agent-ecosystem 与 low-altitude 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `agent-ecosystem` in=864 out=282
  - `low-altitude` in=125 out=140
- **反驳条件**：查 Google Scholar / arXiv，关键词 [agent ecosystem low altitude / low altitude agent ecosystem]，若近 5 年引用 < **30** 篇则本假设成立

### 25. `agent-ecosystem` ⇄ `neuromorphic`

- **优先级**：🟡 中
- **假设**：神经形态硬件上的多智能体系统尚无系统工作
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `agent-ecosystem` in=864 out=282
  - `neuromorphic` in=337 out=855
- **反驳条件**：查 Google Scholar / arXiv，关键词 [neuromorphic multi-agent / spiking neural swarm]，若近 5 年引用 < **50** 篇则本假设成立

### 26. `agent-ecosystem` ⇄ `semiconductor`

- **优先级**：🟡 中
- **假设**：面向智能体的定制半导体在两个域内几乎无引用
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `agent-ecosystem` in=864 out=282
  - `semiconductor` in=246 out=335
- **反驳条件**：查 Google Scholar / arXiv，关键词 [chiplet LLM accelerator agent / agent-specific accelerator]，若近 5 年引用 < **30** 篇则本假设成立

### 27. `bionic-ai` ⇄ `low-altitude`

- **优先级**：🟡 中
- **假设**：bionic-ai 与 low-altitude 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `bionic-ai` in=2104 out=550
  - `low-altitude` in=125 out=140
- **反驳条件**：查 Google Scholar / arXiv，关键词 [bionic ai low altitude / low altitude bionic ai]，若近 5 年引用 < **30** 篇则本假设成立

### 28. `bionic-ai` ⇄ `nuclear-energy`

- **优先级**：🟡 中
- **假设**：bionic-ai 与 nuclear-energy 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `bionic-ai` in=2104 out=550
  - `nuclear-energy` in=123 out=150
- **反驳条件**：查 Google Scholar / arXiv，关键词 [bionic ai nuclear energy / nuclear energy bionic ai]，若近 5 年引用 < **30** 篇则本假设成立

### 29. `brain-science` ⇄ `low-altitude`

- **优先级**：🟡 中
- **假设**：brain-science 与 low-altitude 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `brain-science` in=1149 out=206
  - `low-altitude` in=125 out=140
- **反驳条件**：查 Google Scholar / arXiv，关键词 [brain science low altitude / low altitude brain science]，若近 5 年引用 < **30** 篇则本假设成立

### 30. `brain-science` ⇄ `new-energy`

- **优先级**：🟡 中
- **假设**：brain-science 与 new-energy 之间尚未形成跨域引用工作尚未打通
- **规模**：combinedSize=20000
- **两站活跃度**：
  - `brain-science` in=1149 out=206
  - `new-energy` in=782 out=182
- **反驳条件**：查 Google Scholar / arXiv，关键词 [brain science new energy / new energy brain science]，若近 5 年引用 < **30** 篇则本假设成立

---

## 4. 汇总判读

- 🟢 高优先级：**23**（两侧都活跃，值得优先复核）
- 🟡 中优先级：**7**（一侧边缘，需先补数据）
- ⚪ 低优先级：**0**

---

## 5. 使用方式

1. 挑一个 🟢 高优先级空白假设
2. 用「反驳条件」里的关键词去 Google Scholar / arXiv 复核
3. 若外部引用 < 阈值 → 本假设成立，可发布
4. 若外部引用 ≥ 阈值 → 本假设不成立，是本项目语料不足
5. 每月发布一次，累积形成"跨域空白演化史"

---

## 6. 复现命令

```bash
node operations-plan/pipeline-citation-gaps.js                    # 重建 gapPairs
node operations-plan/pipeline-citation-gaps-briefing.js           # 重建本报告
```

---

_本报告由 `operations-plan/pipeline-citation-gaps-briefing.js` 生成，2026-10-09T06:40:04.347Z_
