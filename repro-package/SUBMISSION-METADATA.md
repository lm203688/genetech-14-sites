# Research Square 提交元数据模板

复制本文件到本地，把尖括号 `<>` 占位符替换为真实值，然后在 https://www.researchsquare.com/submit 逐项填入。

---

## 1. Manuscript 基本信息

- **Title**: GeneTech-30: A Provenance-Tracked, Cross-Domain Scholarly Knowledge Graph of 294,330 Entities across 30 Scientific Domains
- **Article type**: Data Note
- **Area of study**: Data science
- **Keywords**（每个后按 Enter）:
  - knowledge graph
  - bibliometrics
  - data descriptor
  - literature-based discovery
  - cross-domain
  - provenance
  - citation analysis
  - scientific data

## 2. Authors

- **Corresponding author**: <填用户名>
  - Email: <填邮箱>
  - Institution: <填机构或 Independent Researcher>
- **Additional authors**: none（单作者）

## 3. Institution

- Name: <填机构名称或 Independent Researcher>
- Department: <填系/部门或 N/A>
- Country: China
- City: <填城市>

## 4. Funder

- Funding statement: `This work was not funded by any external grant.`

## 5. Abstract（<300 词，直接复制论文 §Abstract）

> We present GeneTech-30, a publicly accessible scholarly knowledge graph comprising 294,330 entities spanning 30 disjoint scientific domains, with 255,392 de-duplicated DOIs and 25,682 resolved cross-domain citation edges. The resource is distinguished by three design commitments: (i) cross-source entity resolution by DOI and normalized title into 276,960 canonical identifiers; (ii) a provable provenance and signature scheme that records, for every assertion, its source, retrieval time, and an Ed25519 signature chain, enabling third-party recomputation; and (iii) a transparent evaluation harness that reports retrieval quality, a computational retrospective (Swanson-style) validation of literature-based-discovery (LBD) bridging, and a known-discovery reproduction benchmark. We report results honestly, including where our LBD bridging signal does not beat a random baseline (retrospective topic-specific lift = 0.30–0.35) and where overall retrieval recall is moderate (mean Recall@10 = 0.44 on a 300-query, 30-site benchmark). GeneTech-30 is released as a composable building block — not a full replacement for comprehensive indices such as OpenAlex (>240M works, 2024) — intended for researchers studying cross-domain knowledge structure, reproducible scholarly-data engineering, and LBD tooling.

## 6. Figures

- <上传 paper 中的图（如果 `.docx` 内嵌则不需额外上传）>
- 若无独立图文件：`Not applicable. All figures are embedded in the manuscript document.`

## 7. Supplementary files

- <可选：上传 `reports/gap-baseline-crossref-2026-10-18.json`、`reports/gap-baseline-openalex-2026-10-18.json`、`eval/results-2026-10-18.json` 作为补充材料>
- 或直接说：`Not applicable. Supplementary data is available in the cited GitHub repository.`

## 8. Declarations

### 8.1 Author contributions
> All work described in this manuscript was carried out by the sole author of this preprint. The dataset, all evaluation scripts, all reported figures, and all limitations were generated and audited by a single research pipeline with no co-investigators, industry sponsors, or external consultants.

### 8.2 Funding
> None. This work was not funded by any external grant.

### 8.3 Ethics approval
> Not applicable. This is a data descriptor of publicly accessible scholarly metadata.

### 8.4 Competing interests
> None.

## 9. Data Availability statement（**必填**）

> The complete GeneTech-30 dataset, evaluation artifacts, and reproducibility scripts are deposited in the public GitHub repository at `https://github.com/lm203688/genetech-14-sites`. Aggregate metrics are pinned in `data/metrics.json` (single source of truth). The signed reproducibility package is hosted at `repro-package/` and contains the manifest, SHA-256 checksums, and deposition instructions. A persistent dataset DOI is available at `10.5281/zenodo.PENDING` (Zenodo) or `10.26155/figshare.PENDING` (Figshare). The GitHub repository URL serves as the primary access point while the persistent DOI is registered.

## 10. Conflicts of Interest declaration（**必填**）

> The author declares no competing interests.

## 11. License

- Creative Commons: **CC BY 4.0**（默认）

## 12. Consent to Post

- [x] I agree that the manuscript and all associated data will be publicly posted on Research Square.
- [x] I confirm that all co-authors (n/a, single author) have consented to the posting.

---

## 提交后回填清单

拿到 Research Square DOI 后（例如 `10.21203/rs.rs.1234567`），回填以下文件：

| 文件 | 位置 |
|---|---|
| `reports/manuscript-data-descriptor.md` | 顶部 venue note |
| `repro-package/CITATION.md` | `doi = ...` 字段 |
| `README.md`（仓库根） | 顶部预印本链接 |
| `.workbuddy/probe/push-new-files.mjs` | 无需改 |
