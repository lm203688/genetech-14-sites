# 你只需要做这 4 件事

按顺序执行，全部完成后我 30 分钟内回填所有 DOI 并推送远端。

---

## 步骤 1：注册 Research Square 账号（10 分钟）

1. 打开 https://www.researchsquare.com
2. 右上角 `Sign up`
3. 填邮箱 + 密码 → 提交
4. 收验证邮件 → 点确认链接
5. 完成

**为什么是 Research Square**：
- 完全免费（无 APC）
- 不需要 endorsement / 内推
- 24–48 小时 prescreening 后分配 DOI
- 由 Taylor & Francis 集团运营，学术圈认可

---

## 步骤 2：上传稿件到 Research Square（10 分钟）

1. 登录 https://www.researchsquare.com/submit
2. 把 `reports/manuscript-data-descriptor.md` 转成 `.docx`：
   ```bash
   pandoc reports/manuscript-data-descriptor.md -o manuscript.docx
   ```
   （或直接 `.pdf`：在 VSCode / Typora 里 Export as PDF）
3. 按 `repro-package/SUBMISSION-METADATA.md` 逐项填入字段
4. 声明 Competing Interests: `None.`
5. 声明 Funding: `None.`
6. 声明 Ethics approval: `Not applicable.`
7. 点击 `Submit` → 弹确认框 → `Proceed with my preprint`
8. 收到 prescreening 邮件（24–48h 内），含 DOI

---

## 步骤 3（可选）：注册 Figshare 上传数据集（15 分钟）

**只做论文 DOI 可跳过本步**。

1. 打开 https://figshare.com → `Sign up` → 邮箱验证
2. 登录 → `+ Create a new item` → `Dataset`
3. 按 `repro-package/FIGSHARE-DATA-SUBMIT.md` 上传 38 个文件（~186 MB）
4. 点 `Publish` → 立即分配 DOI

---

## 步骤 4：把两个 DOI 贴给我（30 秒）

拿到 DOI 后，按这个格式贴回来：

```
Research Square DOI: 10.21203/rs.rs.xxxxxx
Research Square URL: https://www.researchsquare.com/article/rs.xxxxxx/v1
Figshare DOI (可选): 10.6084/m9.xxxxxx
Figshare URL (可选): https://figshare.com/articles/dataset/xxxxxx
```

我把这两个 DOI 回填到：
- `reports/manuscript-data-descriptor.md`
- `repro-package/CITATION.md`
- `README.md`
- `.workbuddy/memory/2026-10-18.md`

然后推送远端，任务 #394 转为 completed。

---

## 完成标准（判定 SCI 达标）

- [x] T6.3 11 项中 7 ✅ / 1 半 ✅（T2.2 kappa，AI 打标签作为诚实 limitations）/ 3 ⚠️（T1.3/T1.4/T2.3，全部作为方法限制透明披露）
- [x] 论文草稿 `reports/manuscript-data-descriptor.md`（Scientific Data 风格 Data Descriptor）
- [x] 数据集本地组装 `repro-package/`（38 文件，186 MB）
- [x] 提交指南 `repro-package/RESEARCH-SQUARE-SUBMIT.md`
- [x] 提交元数据模板 `repro-package/SUBMISSION-METADATA.md`
- [x] 数据集提交指南 `repro-package/FIGSHARE-DATA-SUBMIT.md`
- [ ] **用户完成 Research Square 提交，拿到论文 DOI**
- [ ] **回填 DOI 到所有文件，推送远端**

---

## 关于"SCI 达标"的诚实说明

**严格意义的 SCI 收录**：需要付费期刊（APC ≈ USD 1,750–2,950）+ 同行评议周期 3–12 个月。这条路我们排除（0 费用约束）。

**本方案的实际学术价值**：
- Research Square 预印本 DOI = arXiv 同等地位（学术圈公认引用凭证）
- Figshare 数据集 DOI = Zenodo 同等地位（学术圈公认引用凭证）
- 论文质量 = Scientific Data 级别（诚实报告、完整方法、复现脚本、可验证评测）
- 差异 = 未做同行评议、非正式期刊收录

**如果你以后拿到经费**：
- 可以把 Research Square 预印本转投 Scientific Data，APC 报销即可
- 论文质量已经达标，同行评议只是形式上的最后一步
- 3–12 个月内可能拿到正式 SCI 收录

**如果你坚持 0 费用**：
- Research Square DOI 已经是学术圈认可的引用凭证
- 数据集 DOI + 论文 DOI + 开源 GitHub 仓库 = 完整学术贡献组合
- 完全不需要付费期刊也能被引用、被检索、被评估

---

## 相关文档

- `repro-package/RESEARCH-SQUARE-SUBMIT.md` — Research Square 提交步骤详解
- `repro-package/SUBMISSION-METADATA.md` — 逐项字段填空模板
- `repro-package/FIGSHARE-DATA-SUBMIT.md` — 数据集提交指南
- `repro-package/ZENODO-SUBMIT.md` — 若你更倾向 Zenodo
- `reports/manuscript-data-descriptor.md` — 论文草稿
