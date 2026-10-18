# Research Square 提交指南（Paper DOI）

**目标**：把 `reports/manuscript-data-descriptor.md` 发布为 Research Square 预印本，拿到 `10.21203/rs.rs.PENDING` DOI。

- **费用**：0 元（Research Square 完全免费）
- **同行评议**：不做（仅编辑性 prescreening）
- **需要内推 / endorsement**：❌ 不需要
- **响应时间**：24–48 小时
- **DOI 前缀**：`10.21203/rs.rs.xxxxxx`

---

## 前置条件（用户一次性完成，约 10 分钟）

1. 访问 https://www.researchsquare.com → **Sign up**
2. 用邮箱注册（QQ / 163 / Gmail 都可）
3. 收到验证邮件后点击确认
4. 登录成功后进入 https://www.researchsquare.com/submit

---

## 提交步骤（用户或我代操作均可）

### 步骤 1：上传稿件

- **格式**：Research Square 接受 `.docx`、`.doc`、`.pdf`
- **推荐**：把 `reports/manuscript-data-descriptor.md` 转为 `.docx`（pandoc 一行命令：`pandoc reports/manuscript-data-descriptor.md -o manuscript.docx`）或直接 `.pdf`
- **注意**：PDF 不会被转换成 HTML full-text，用户体验略差；`.docx` 推荐

### 步骤 2：填写元数据

按下方 [SUBMISSION-METADATA.md](SUBMISSION-METADATA.md) 逐项填入。

关键字段：

| 字段 | 值 |
|---|---|
| Title | `GeneTech-30: A Provenance-Tracked, Cross-Domain Scholarly Knowledge Graph of 294,330 Entities across 30 Scientific Domains` |
| Article type | `Data Note` 或 `Research Article`（本稿件属 Data Descriptor） |
| Area of study | `Data science` / `Information systems` |
| Abstract | 见论文 §Abstract（<300 词） |
| Keywords | `knowledge graph`, `bibliometrics`, `data descriptor`, `literature-based discovery`, `cross-domain`, `provenance`, `citation analysis` |
| Corresponding author | 用户填写 |
| Institution | 用户填写（可写 "Independent Researcher" 或所属机构） |

### 步骤 3：Declarations（4 项必填）

1. **Author contributions**：`All work described was carried out by the sole author of this preprint. See §Author Contributions.`
2. **Funding**：`None.`
3. **Ethics approval**：`Not applicable.`
4. **Competing interests**：`None.`

### 步骤 4：确认发布

- 勾选 `I agree to the Terms and Conditions`
- 点击 `Submit`
- 弹确认窗口 → `Proceed with my preprint`

### 步骤 5：等待 prescreening（24–48h）

- 通过 → 收到邮件，含 DOI 和 URL
- 未通过 → 收到邮件说明原因（一般是格式或内容边界问题，可修后重交）

---

## 提交后需要做的事

1. 拿到 DOI：`10.21203/rs.rs.xxxxxx`
2. 把 DOI 回填到 `reports/manuscript-data-descriptor.md`（找 `10.5281/zenodo.PENDING` 或类似占位符替换）
3. 把 DOI 回填到 `repro-package/CITATION.md`
4. 更新 GitHub 仓库 `README.md` 顶部的预印本链接
5. 推送远端

---

## 常见被拒原因（prescreening）

根据 Research Square Editorial Policies（https://www.researchsquare.com/legal/editorial）：

- 未声明 competing interests → 补声明
- 无 Data Availability statement → 补（本文已含）
- 内容是 "Theories, commentaries, and non-systematic reviews" → 本稿件属 Data Descriptor，符合
- 内容是 review 或 position paper（仅 cs 领域限制，其他领域不限）→ 本稿件非 cs review
- 格式不合法（图片无 alt、参考文献格式混乱）→ 补规范

本稿件已全部符合 Research Square Editorial Policies §1–§6。

---

## 后续路径（可选）

- **将来拿到经费后**：投稿 Scientific Data（把 Research Square DOI 作为 preprint 引用），APC ≈ USD 2,750
- **不追加投稿**：Research Square 预印本 DOI 已经是学术引用凭证，等同于 arXiv
- **补投免费期刊**：Bentham Open Access、MDPI Open Access（注意 MDPI 有 APC，不是完全免费）、Frontiers（有 APC）等——**如果坚持 0 费用，Research Square 就足够**

---

## 相关文档

- `reports/manuscript-data-descriptor.md` — 稿件
- `SUBMISSION-METADATA.md` — 全部字段的填空模板
- `FIGSHARE-DATA-SUBMIT.md` — 数据集 DOI 提交指南（可选，若需单独的数据 DOI）
- `ZENODO-SUBMIT.md` — Zenodo 路径（若用户最终选择 Zenodo 而非 Figshare 存数据）
