# 大数据与模型包扫描与引用报告（2026-09-15）

扫描对象：`C:\Users\xing\Desktop\大数据与模型包_20260915.zip`（350MB / 1,296 文件 / 1,506 条目）

性质：腾讯云工作机 `/home/z/my-project` 在 2026-09-15 重置前的快照，只含**未推送到 GitHub 的增量产出**。
包内附《交接包说明（2026-09-15）》，自称 1,700+ 文件——实际 1,296 文件，缺 `git状态快照.txt` 与 `差异文件清单.txt`（清单说有，包里没有）。

**结论：3 项已引用（共 11.9MB），其余为体积超限、明文凭证、或与前一个成果包重复，未引用。**

---

## 一、已引用（3 项）

### 1. 蜂群科研计算引擎源码 → `engines/swarmlabs-compute-engines/`（最高价值）

7 文件 / **5,352 行** Python / 680KB。此前本项目**完全没有**的计算引擎层。

| 文件 | 行 | 内容 |
|---|---:|---|
| `bees/compute_engines.py` | 535 | `ExperimentCache` / `QuantumEngine`（xTB→DFT→CCSD 三级分层 + 经验降级）/ `MDEngine` / `VirtualScreening`（4 层管道）/ `ParallelScheduler` |
| `bees/colony.py` | 770 | 11 种分工蜂类 + `SwarmColony` 编排 |
| `physics/physics_engine_v2.py` | 1,405 | 物理规则引擎 |
| `api_server_v3.py` | 2,255 | 运营版 API，27 条 `/api/v1/*` 路由 |
| `bees/db_connectors.py` | 142 | PubMed / ChEMBL / PubChem / DOI 四源 + `verify_citation` |
| `benchmark.py` | 133 | 引擎基准 |
| `bees/sandbox.py` | 112 | Docker 沙箱 |

**处理**：`api_server_v3.py` 第 36 行明文 Resend 密钥 `re_JA8cCFTJ_...` 已剥离为 `os.environ.get("RESEND_API_KEY", "")`。
7 文件全部通过 `py_compile` 语法校验（1 条无关的 JS 转义序列 SyntaxWarning）。
已知断链：`from main import SwarmResearch` 的 `main.py` 未随包提供。

### 2. ML 模型资产 → `engines/swarmlabs-ml-models/`

原 128MB / 57 模型，入库 **11MB**：全部 12 份 meta + 8 个工程模型 + 2 份可复现训练集 + 验证脚本。

**8 个工程模型全部由"物理方程基线 + ML 残差校正"训练，8/8 引擎 ML 校正后优于纯物理方程**（32.5%–49.8% 改善，最高 adsorption 49.8%）。

**QM9 全集 130,831 分子 RF 回归**：dipole 相对误差 3.21%、HOMO 4.36%、zpve 0.52%，训练耗时 3s。
**MPNN 三代谱系** v1(3层64) → v2(5层128+dropout) → v3(+LayerNorm)。

**⚠️ 硬约束**：pkl 内嵌 `sklearn_version=1.5.2` 且引用 `sklearn._loss` / `sklearn.ensemble._gb`，
`sklearn._loss` 在 sklearn ≥1.6 已搬迁为 `sklearn.metrics._loss`。
本机实测对比：**sklearn 1.9.0 → 8/8 加载失败**（`ModuleNotFoundError: No module named '_loss'`）；
**sklearn 1.5.2 → 8/8 加载成功且全部可预测**（`n_estimators=50`），验证脚本 `verify_models.py` 已入库。

**发现一个语义坑**：三个模型 pred 为负值（corrosion -0.0081 / perovskite -0.9979 /
photocatalysis -0.0066），而这些量物理上不可能为负 → **pkl 输出的是 ML 残差，不是最终物性值**，
正确用法 `final = physics_engine(features) + model.predict(features)`。
另外 meta.json 的 `training_samples:100` 是数据条数，不是树棵数（实测 50 棵）。

### 3. 数据集谱系（元数据）→ 同上 README

7 个数据源共 17,085 条生化记录（Tox21 7,823 / ChEMBL-Lipophilicity 4,200 / BACE 1,513 / ClinTox 1,480 / SIDER 1,427 / FreeSolv 642）+ NIST WebBook 271 条实验真值，
谱系完整记录但 122MB 原始数据未入库。

---

## 二、未引用（含原因）

| 项 | 体积 | 原因 |
|---|---:|---|
| `swarmlabs_ml_models/` 大型模型 46 个 | 122MB | 仓库体积 + CI 拉取成本。谱系与 MAE 已全记录 |
| `swarmlabs_bio_chem_data.json` | 52MB | 体积。谱系已记录 |
| `swarmlabs_toxcast_data.json` | 47MB | 体积。谱系已记录 |
| `swarmlabs_qm9_full.json` | 23MB | 体积。`qm9_data.json`(20k 子集, 6.8M) 已入库 |
| `git-unpushed.bundle` | 22MB | **无法导入**：前置提交 `4b8639ab` 在本仓库不存在。且包说明第 3 条明确"文件改动已以当前文件内容形式包含在核心包内"→ bundle 冗余 |
| `backup/06_专利_DMTL化学实验优化` | — | **与前一个成果包重复**，已引用至 `docs/patent/`（14 文件） |
| `backup/01–08_*.zip` 全套 | 34MB | 目录版已展开，zip 是副本 |
| `backup/04_OracleMind` / `backup/07_HealthLens` / `backup/08_宠虫识别_农业` | 2.6MB+ | 用户已明确排除的项目（OracleMind / HealthLens / RoboParts） |
| `backup/05_专业Agent系统` | 348KB | 6 个 agent（builder/devops/guardian/operator/scout/tech_writer）+ `eve_scheduler.py` 常驻调度。属旧工作区架构，无本项目对应物，暂不引用 |
| `projects-review/agent-trust` | 1.4MB | 独立 monorepo（Next.js + 小程序 + x402 + 微信支付）。含 `MARKETING_*.md` 四渠道文案、`docs/scoring-algorithm.md`——可作为推广方法论参考，但属独立产品，不做资产合并 |
| `projects-review/all-projects/extracted/roboparts` | — | RoboParts，已排除 |
| `projects-review/healthlens` / `nongshitong` | — | 已排除项目 |
| `genetech-13sites-full.tar.gz` | 7.7MB | 2026-07 旧快照。含 `website/data.js` + `entities/*.json`，但当前仓库已是 30 站 ×10k 实体，全面领先 |
| `kb-ecosystem-full-20260622.tar.gz` ×2 | 11.6MB | 2026-06-22 旧快照，同上 |

---

## 三、⚠️ 明文凭证（未入库，须视为已泄露）

全包扫描命中 3 类活跃凭证，**均已从引用文件中剥离或整体不引用**：

| 凭证 | 位置 | 状态 |
|---|---|---|
| GitHub PAT `github_pat_11A7ADXTQ0...` | `backup/01–05/08_*/项目信息.md`、`TOOLS.md`、`全局配置_TOOLS.md`、`secrets-summary.md`、`交接包*.txt`（8 处） | 未引用。与 memory 中记录为同一枚 → **建议轮换** |
| Cloudflare `cfut_j3cJdlzdFbPI2DdV…（44 字符，已脱敏）` | 同上 8 处 | 未引用。即 D1 根部署用的那枚已提权 token → **权限过大，建议收敛为只读或轮换** |
| Resend `re_JA8cCFTJ_5sPd7WmF…（已脱敏）` | `backup/03_*/code/api_server_v3.py:36` | **已剥离**（改为环境变量读取），原文件未入库 |
| AGNES `sk-KBSFxJBTWxZtA8G4…（已脱敏）` | `projects-review/agent-trust/.env`、`BACKUP_README.md`、roboparts 部署文档（5 处） | 未引用。agent-trust 整体不引用 |

另外 `projects-review/healthlens/credentials/CREDENTIALS_AND_CONTEXT.md` 整份是凭证清单——
HealthLens 已排除，整体未引用。

---

## 四、体积影响

`engines/` **不参与** `tools/build-site.mjs` 构建（实测 `_site/` 下无该目录），
因此本次 11.9MB **不占用** Pages ~1014.7MB 容量，与既有 `deep-research-agent-main` 同处理方式。

仓库新增文件：

```
engines/swarmlabs-compute-engines/   7 py + README.md          680KB
engines/swarmlabs-ml-models/          12 meta + 8 pkl + 2 json + 2 脚本   11MB
docs/pullin-report-2026-09-15-bigdata-models.md                                    本文件
```
