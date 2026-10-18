# Figshare 数据集提交指南（Data DOI）

**目标**：把 `repro-package/` 内的 38 个数据/代码文件发布为 Figshare 数据集，拿到 `10.6084/m9.PENDING` 或 `10.26155/figshare.PENDING` DOI。

- **费用**：0 元（Figshare 个人免费 20 GB 存储）
- **同行评议**：不做
- **需要内推 / endorsement**：❌ 不需要
- **响应时间**：即时（点击 Publish 立即分配 DOI）
- **DOI 前缀**：`10.6084/m9.xxxxxx` 或 `10.26155/figshare.xxxxxx`

**为什么需要 Figshare**：Research Square 只发论文 DOI，不发数据 DOI。学术引用规范建议 dataset 与 paper 各自独立 DOI。若你只想要一个 DOI（论文 DOI 即可），跳过本文档。

---

## 前置条件（用户一次性完成，约 5 分钟）

1. 访问 https://figshare.com → **Sign up**
2. 用邮箱注册（QQ / 163 / Gmail 都可）
3. 收到验证邮件后点击确认
4. 登录后进入 https://figshare.com

---

## 提交步骤（约 15 分钟）

### 步骤 1：新建 Item

- 点击左上角 `+ Create a new item`
- **Item type**: `Dataset`（或 `Preprint`，视用途）
- **Title**: `GeneTech-30: Cross-Domain Scholarly Knowledge Graph (30 domains, 294,330 entities)`
- **Category**: `Data science` 或 `Information systems`

### 步骤 2：添加作者

- 单作者：填用户名 + 邮箱
- ORCID: 可选，若已注册

### 步骤 3：上传文件

**必须上传的核心文件**（来自 `repro-package/MANIFEST.json`）：

| 优先级 | 文件 | 用途 |
|---|---|---|
| ⭐ 必传 | `repro-package/MANIFEST.json` | 清单 |
| ⭐ 必传 | `repro-package/SHA256SUMS.txt` | 校验 |
| ⭐ 必传 | `repro-package/README.md` | 总览 |
| ⭐ 必传 | `repro-package/CITATION.md` | 引用格式 |
| ⭐ 必传 | `reports/manuscript-data-descriptor.md` | 论文 |
| ⭐ 必传 | `data/metrics.json` | 唯一真源 |
| ⭐ 必传 | `data/identity-map.json`（**108 MB，GitHub 未托管，Figshare 直接上传**）| 跨源身份解析表 |
| ⭐ 必传 | `data/stance-sample.json` | 立场抽取样本 |
| ⭐ 必传 | `data/entity-resolution-sample.json` | 实体解析样本 |
| ⭐ 必传 | `data/gold.jsonl` | gold 集 |
| ⭐ 必传 | `data/known-discoveries.json` | 已知发现集 |
| ⭐ 必传 | `eval/results-2026-10-18.json` | 评测结果 |
| ⭐ 必传 | `reports/gap-baseline-crossref-2026-10-18.json` | Crossref 基线 |
| ⭐ 必传 | `reports/gap-baseline-openalex-2026-10-18.json` | OpenAlex 基线 |
| 可选 | `data/citation-edges.json`（15 MB） | 引用边 |
| 可选 | `data/knowledge-graph.json`（大文件） | KG |
| 可选 | `data/search-index.json`（大文件） | 索引 |
| 可选 | 30 个站点 `*/website/api/entities.json` | 站点数据 |

**总计 38 文件 / ~186 MB**，Figshare 20 GB 免费配额绰绰有余。

### 步骤 4：License

- **CC BY 4.0**（默认，可选）

### 步骤 5：Keywords

- knowledge graph
- bibliometrics
- citation analysis
- cross-domain
- provenance
- scientific data
- OpenAlex
- Crossref

### 步骤 6：Description（可复制论文 §Abstract）

参见 `reports/manuscript-data-descriptor.md` 前 300 词。

### 步骤 7：Publish

- 点击 `Publish` → 立即分配 DOI（形如 `10.6084/m9.abc123`）
- 弹出 DOI 对话框 → 复制保存

---

## 提交后需要回填

拿到 Figshare DOI 后（例如 `10.6084/m9.abc123`），回填：

| 文件 | 位置 |
|---|---|
| `repro-package/CITATION.md` | `doi = "10.6084/m9.abc123"` |
| `reports/manuscript-data-descriptor.md` | §Data Records §Access |
| `repro-package/SUBMISSION-METADATA.md` | §9 Data Availability statement |
| `README.md`（仓库根） | 顶部数据集链接 |

---

## 常见问题

**Q: 上传 108 MB 的 `data/identity-map.json` 会不会被拒？**
A: 不会。Figshare 免费个人账户单文件最大 20 GB，远超 108 MB。

**Q: 我 GitHub 上已经有这些数据了，为什么还要 Figshare？**
A: 因为 **GitHub 不给 DOI**（GitHub 无 DOI 服务），学术引用规范需要 dataset DOI。Figshare 免费提供且即时。

**Q: 只想发论文 DOI、不想发数据 DOI？**
A: 跳过本文档即可。Research Square 论文 DOI 已经是学术引用凭证。

---

## 相关文档

- `MANIFEST.json` — 38 文件清单与 SHA256
- `SHA256SUMS.txt` — 校验和
- `README.md` — 数据集总览
- `CITATION.md` — 引用格式模板
