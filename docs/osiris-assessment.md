# OSIRIS 情报系统评估报告

## 项目信息

| 字段 | 值 |
|------|-----|
| 仓库 | `simplifaisoul/osiris` |
| 许可证 | MIT |
| 技术栈 | Next.js 16 + MapLibre GL + Python FastAPI |
| 最后提交 | 2026-09-20（活跃维护） |
| GitHub Stars | ~1.2K（截至 2026-09） |

---

## 核心能力概览

### 1. 实时情报仪表板（16+ 图层）
- **航班追踪** — ADS-B Exchange / OpenSky Network
- **海事追踪** — AIS 船舶位置、港口动态
- **地震/灾害** — USGS 实时地震数据
- **冲突/军事** — 开放来源冲突地图
- **制裁/合规** — OFAC、EU 制裁名单实时同步
- **新闻聚合** — 多源新闻 RSS 聚合
- **Telegram OSINT** — 开源电报频道监控

### 2. RECON 工具集
- 端口扫描（Nmap 集成）
- DNS 枚举
- WHOIS 查询
- CVE 检索
- 制裁名单交叉比对

### 3. 数据来源
- 全部为**免费公开 API**，无需 Key
- 数据实时更新（分钟级延迟）
- 地理空间可视化（MapLibre GL）

---

## 与 GeneTech 知识引擎的契合度评估

### ✅ 适用场景（情报收集增强）

| 场景 | 价值 | 集成难度 |
|------|------|---------|
| **物理世界信号监控** | 可补充科研数据之外的现实事件信号（制裁变化、港口封锁、地震影响供应链） | 低 |
| **冲突/地缘政治风险评估** | 为生物/材料科学项目提供地缘政治背景（如某国科研合作受限） | 中 |
| **开源监控** | Telegram 频道 + RSS 新闻可用于科研前沿信号捕捉 | 低 |

### ❌ 不适用场景（核心能力不匹配）

| 原因 | 说明 |
|------|-----|
| **非学术导向** | OSIRIS 聚焦现实世界事件，而非论文/专利/技术报告 |
| **无知识图谱构建** | 不提供实体关系抽取、跨文档推理能力 |
| **无 citation 管理** | 不支持学术引用、DOI 解析、BibTeX 生成 |
| **合规风险** | RECON 工具（端口扫描、WHOIS）可能触发目标系统安全警报 |

### ⚠️ 风险点

1. **法律合规** — RECON 模块的端口扫描和 WHOIS 查询在部分司法管辖区受限
2. **数据质量** — 开放来源数据未经同行评审，置信度标注机制缺失
3. **API 限流** — 部分数据源（如 ADS-B Exchange）对高频调用有限制

---

## 推荐集成方案

### 方案 A：仅作为情报源参考（推荐）

**适用**：作为 GeneTech 数据工程的补充信号层，不直接集成到核心 pipeline

**实现**：
```python
# 示例：调用 OSIRIS 公开 API 获取制裁信息
import requests

def fetch_sanctions_status(target_country: str) -> dict:
    """查询 OFAC 制裁状态（来自 OSIRIS 数据源）"""
    url = "https://api.osiris.example/sanctions"
    response = requests.get(url, params={"country": target_country})
    return response.json()
```

**优点**：零集成成本，仅作为人工决策参考  
**缺点**：不自动化，不影响数据 pipeline

---

### 方案 B：微服务集成（中等成本）

**适用**：需要实时制裁/冲突信号注入到科研实体评估流程

**实现**：
1. 在 `swarm-labs-gateway/worker.js` 中添加 `/v1/intel/osint` 路由
2. 定期拉取 OSIRIS 公开数据（每日一次）
3. 将制裁/冲突状态关联到相关科研实体（如：某国基因编辑研究受制裁限制）

**优点**：自动化信号注入，可扩展到其他 OSINT 源  
**缺点**：需维护额外数据同步逻辑，合规审查成本

---

### 方案 C：深度集成（不推荐）

**适用**：将 OSIRIS 的 RECON 能力完全纳入 GeneTech pipeline

**不推荐理由**：
- RECON 工具（端口扫描、敏感查询）与 GeneTech 的"只读数据引擎"定位冲突
- 可能触发目标系统安全响应，影响 GeneTech 声誉
- 合规风险高，需法务审查

---

## 替代方案推荐

### 更适合科研情报收集的 MCP

| 工具 | 类型 | 契合度 | 推荐理由 |
|------|------|--------|---------|
| **BGPT MCP** | 论文结构化 | ⭐⭐⭐⭐⭐ | 直接提取方法/样本/结果/局限，补全结构化 |
| **osint-mcp** | OSINT 聚合 | ⭐⭐⭐ | 37 工具，但需合规审查 |
| **OpenCTI MCP** | 威胁情报 | ⭐⭐ | 侧重网络安全，非科研 |
| **Graphiti (Zep)** | 时序知识图谱 | ⭐⭐⭐⭐ | 原生 MCP，直接填 GAP B（空壳图谱） |

### 更适合扩源的前沿数据库

| 数据库 | 规模 | 价值 | 接入难度 |
|--------|------|------|---------|
| **Science Data Lake** | 293M 论文 / 8 源 | 跨源 ontology alignment，BGE-large embedding | 中（需 Parquet 处理） |
| **Dimensions.ai** | 140M 出版物 + 专利 | 专利-论文映射，基金数据 | 高（需授权） |
| **Lens.org** | 272M 专利 + 文献 | 开放访问，API 友好 | 低 |
| **Retraction Watch** | 撤稿记录 | 服务 STRICT_CITE 门禁 | 低（RSS/API） |
| **CNKI 开放版** | 中文学术 | 中文覆盖补全 | 中（需代理） |

---

## 最终建议

### 短期（0-2 周）
1. **采纳 BGPT MCP** — 解决结构化数据缺失（GAP B 的核心问题）
2. **接入 Retraction Watch** — 服务 STRICT_CITE 门禁，降低误引风险
3. **OSIRIS 仅作为参考** — 不集成，但保留 URL 供人工查阅

### 中期（2-8 周）
1. **部署 Graphiti** — 填充知识图谱空壳，支持时序关系推理
2. **尝试 Lens.org API** — 低成本获取专利-论文映射数据
3. **评估 Science Data Lake** — 若团队有 Parquet 处理能力，可作为 embedding 方案

### 长期（8+ 周）
1. **考虑 OSIRIS 微服务集成** — 仅在明确需要地缘政治信号注入时启用
2. **建立合规审查流程** — 所有新数据源接入前需通过法务/安全评估

---

## 行动清单

- [ ] 评估 BGPT MCP 集成（优先级 P0）
- [ ] 接入 Retraction Watch API（优先级 P1）
- [ ] 调研 Graphiti + Zep 时序图谱方案（优先级 P1）
- [ ] OSIRIS 暂不集成，仅保留参考链接
- [ ] 建立数据源合规审查 checklist（P2）

---

*报告生成时间：2026-09-25 20:55 UTC*
*数据来源：github.com/simplifaisoul/osiris README + 代码结构分析*
