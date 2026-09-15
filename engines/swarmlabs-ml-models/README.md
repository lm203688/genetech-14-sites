# swarmlabs-ml-models — 训练完成的 ML 模型资产

来源：腾讯云工作机快照 `swarmlabs_ml_models/`（128MB / 57 个模型文件）。
本目录只收了**元数据 + 8 个工程模型 + 2 份可复现训练集**（共 11MB），大型模型未入库，原因见下。

## 目录结构

```
swarmlabs-ml-models/
├── meta.json                    13 维分子描述符模型总 meta
├── bio_meta.json                生化 6 数据集谱系（17,085 条）
├── qm9_meta.json                QM9 20,000 条子集
├── qm9_full_meta.json           QM9 全集 130,831 条 + 6 属性 MAE
├── gnn_meta.json / gnn_v2_meta.json / gnn_v3_meta.json   MPNN 三代谱系
├── engine_models/               8 个工程模型（物理基线 + ML 残差校正）
│   ├── adsorption|ammonia|battery|combustion|corrosion
│   ├── perovskite|photocatalysis|polymer
│   └── 每个：*_ml.pkl（GBR）+ *_meta.json（含 physics_mae / corrected_mae / improvement_pct）
├── datasets/
│   ├── training_data_large.json 9,536 分子 × 13 维描述符
│   └── qm9_data.json            20,000 分子 × QM9 DFT 属性
└── verify_models.py             加载 + 预测验证脚本
```

## 关键结果

### QM9 全集回归（130,831 分子，RF 100 trees / max_depth=15，训练 3s）

| 属性 | MAE | 相对误差 |
|---|---:|---:|
| dipole (Debye) | 0.950 | 3.21% |
| HOMO (eV) | 0.388 | 4.36% |
| LUMO (eV) | 0.742 | 7.40% |
| gap (eV) | 0.797 | 4.90% |
| alpha (Bohr³) | 2.023 | 1.06% |
| zpve (Hartree) | 0.0366 | 0.52% |

### GNN 谱系（MPNN，QM9 8,000 train + 2,000 test）

| 版本 | 结构 | 优势 |
|---|---|---|
| v1 | 3 层, hidden=64 | 基线 |
| v2 | 5 层, hidden=128, dropout=0.1 | 消息传递更深 |
| v3 | 5 层, hidden=128 + LayerNorm + dropout=0.15 | 训练更稳定 |

特征：atomic one-hot (H,C,N,O,F) + bond distance；目标 6 个（dipole / HOMO / LUMO / gap / alpha / zpve）。

### 8 个工程模型（物理方程基线 + ML 残差校正）

`GradientBoostingRegressor`，每个 100 样本训练。**ML 残差校正在 8/8 引擎上均优于纯物理方程**：

| 引擎 | 目标 | 特征 | 物理 MAE | 校正后 MAE | 改善 |
|---|---|---|---:|---:|---:|
| adsorption | capacity_mmol_g | surface_area, pressure | 0.5446 | 0.2734 | **49.8%** |
| corrosion | corrosion_rate_mmy | temperature, ph | 0.0183 | 0.0104 | **43.3%** |
| photocatalysis | quantum_efficiency | bandgap, surface_area | 0.0227 | 0.0131 | **42.3%** |
| polymer | tensile_MPa | mn, tacticity | 4.6854 | 2.7239 | **41.9%** |
| perovskite | efficiency_pct | bandgap | 1.4388 | 0.9133 | **36.5%** |
| ammonia | conversion_pct | temperature, pressure | 0.1618 | 0.1053 | **34.9%** |
| battery | energy_density_Whkg | voltage, capacity | 3.6653 | 2.4156 | **34.1%** |
| combustion | adiabatic_temp_C | equivalence_ratio | 138.1492 | 93.2847 | **32.5%** |

## ⚠️ 运行前置（硬性版本约束）

```bash
pip install "scikit-learn==1.5.2"
python verify_models.py
```

**原因**：pkl 内嵌 `sklearn_version = 1.5.2`，且引用 `sklearn._loss.link` / `sklearn._loss.loss` /
`sklearn.ensemble._gb`。`sklearn._loss` 在 sklearn ≥ 1.6 已搬迁为 `sklearn.metrics._loss`，
版本不符会直接 `ModuleNotFoundError: No module named '_loss'`。

### 本机实测（2026-09-15，Windows / Python 3.13）

| sklearn 版本 | 结果 |
|---|---|
| 1.9.0 + numpy 2.5.2 | 8/8 **加载失败**，`ModuleNotFoundError: No module named '_loss'` |
| **1.5.2** + numpy 2.5.3 + scipy 1.18.1 | **8/8 加载成功且可预测**，`n_estimators=50` |

numpy 2.x 与 sklearn 1.5.2 在此场景下兼容（`sklearn._loss` 纯 Python 模块不受 numpy 2 影响）。
注：Python 3.13 无 numpy 1.26.x 的 cp313 wheel，故此处用 numpy 2.5.3 验证通过；
如需完全对齐原始训练环境，用 Python 3.10–3.12 + numpy<2。

### 模型语义（重要）

`*_ml.pkl` 输出的是 **ML 残差**，不是最终物性值：

```python
final = physics_engine(features) + model.predict(features)
```

实测证据：corrosion / perovskite / photocatalysis 三个模型的 pred 为**负值**
（-0.0081 / -0.9979 / -0.0066），而腐蚀速率、效率、量子效率物理上不可能为负——
说明它们输出的是对物理方程基线的校正量。这与 meta.json 的
`"method": "物理方程基线 + ML残差校正"` 一致。

meta.json 里的 `training_samples: 100` 是**训练数据条数**，不是树的棵数（实测 `n_estimators=50`）。

## 未入库的大型模型（体积原因）

以下 122MB 留在原快照，未复制到本仓库（`_site/` 不参与构建，但仓库体积与 CI 拉取也要控）：

| 文件 | 体积 | 说明 |
|---|---:|---|
| `bio_*` ×10（morgan + rf） | 59MB | 生化 5 任务（logD / hydration / bace_pIC50 / Tox21 12 分类器） |
| `tox21_classifiers.pkl` | 17MB | 12 个 Tox21 毒性分类器 |
| `toxcast_regressors.pkl` | 2MB | ToxCast 回归 |
| `qm9_*_rf.pkl` ×6 + `_gbr.pkl` ×3 | 37MB | QM9 六属性 RF/GBR |
| `qm9_gnn_v2.pt` / `qm9_gnn_v3.pt` | 2.5MB | PyTorch MPNN 权重 |
| `ensemble/*_ensemble.pkl` ×3 | 7MB | 三属性集成模型 |
| `boiling_point_*` / `dipole_*` / `heat_of_formation_*` / `melting_point_gbr` | 7MB | 4 性质物性预测 |

## 数据集谱系（数据源真值）

| 数据集 | 条数 | 来源 |
|---|---:|---|
| QM9 全集 | 130,831 | DFT B3LYP/6-31G(2df,p) |
| Tox21 | 7,823 | ToxCast 项目 |
| ChEMBL Lipophilicity | 4,200 | ChEMBL |
| BACE | 1,513 | MoleculeNet |
| ClinTox | 1,480 | 临床毒性 |
| SIDER | 1,427 | 副作用 |
| FreeSolv | 642 | 水合自由能 |
| 合计（bio_chem_data） | 17,085 | — |
| NIST WebBook 真实实验值 | 271 | 物性模型训练集 |
| 13 维描述符分子集 | 9,536 | 见 `datasets/training_data_large.json` |

`datasets/` 里两份是**已入库的可复现训练集**（10.2MB）；`swarmlabs_bio_chem_data.json`(52M)、
`swarmlabs_toxcast_data.json`(47M)、`swarmlabs_qm9_full.json`(23M) 因体积未入库，谱系见上表。
