# swarmlabs-compute-engines — 蜂群科研计算引擎（源码）

来源：腾讯云工作机 `/home/z/my-project` 快照（2026-09-15 重置前），路径 `backup/03_蜂群科研swarmlabs/code/`。
性质：本项目此前**完全没有**的后端计算引擎层——纯 Python、零第三方依赖即可读懂，7 个文件 / 5,352 行。

## 文件清单

| 文件 | 行数 | 内容 |
|---|---:|---|
| `bees/compute_engines.py` | 535 | 量子化学 / 分子动力学 / 虚拟筛选 / 实验缓存 / Agent 并行调度 |
| `bees/colony.py` | 770 | 11 种分工蜂类 + `SwarmColony` 编排器 |
| `physics/physics_engine_v2.py` | 1,405 | 物理规则引擎 v2 |
| `api_server_v3.py` | 2,255 | 正式运营版 API v3.0（27 条 `/api/v1/*` 路由） |
| `bees/db_connectors.py` | 142 | PubMed / ChEMBL / PubChem / DOI 四源检索 + 引文核验 |
| `benchmark.py` | 133 | 引擎基准测试 |
| `bees/sandbox.py` | 112 | Docker 沙箱执行 |

## 核心能力

### `compute_engines.py` — 五个模块

- **`ExperimentCache`**：MD5(参数) 实验结果缓存，命中即复用，返回带 `_cached` / `_cache_age` 标记。这是"重复实验不重算"的成本闸门。
- **`QuantumEngine`**：三级分层量子化学——`fast`（xTB，秒级）→ `standard`（PySCF DFT，分钟级）→ `precise`（CCSD，小时级）。查缓存 → 尝试真引擎 → **经验公式降级**兜底，任何一级失败都不会让请求失败。
- **`MDEngine`**：OpenMM 分子动力学（速度 Verlet），不可用时降级为 Langevin 近似。
- **`VirtualScreening`**：4 层过滤管道——Lipinski 五规则 → 溶解度 → pIC50 预测 → PAINS 黑名单，每层输出存活分子数，便于定位瓶颈。
- **`ParallelScheduler`**：`ThreadPoolExecutor` Agent 并行调度，按优先级队列提交实验任务。

### `colony.py` — 蜂群分工

`SwarmBee` 基类 + 10 个子类：`CollectBee`（采集）/ `AnalyzeBee`（分析）/ `MineBee`（挖掘）/ `ValidateBee`（验证）/ `WriteBee`（写作）/ `ReviewBee`（评审）/ `PublishBee`（发布）/ `SafetyBee`（安全）/ `ReviewerBee`（复审）/ `ManageBee`（管理），`SwarmColony` 负责生命周期编排。
→ 与本项目 Tech Radar 的 `signal→candidate→promote→effect` 闭环可直接对齐。

### `api_server_v3.py` — 27 条路由

`/api/v1/quantum/` `/md/` `/predict` `/screening` `/sandbox/exec` `/physics/rules` `/physics/evaluate` `/material/predict` `/design_carrier` `/reagent/` `/patent/` `/benchmark` `/cache/` `/rank_pathways` `/dashboard` `/experiments/history` `/experiment/submit` `/report/` `/export/` `/artifact/` `/share/` `/assistant` `/health` + 邮箱验证码注册登录三件套。

## ⚠️ 导入时的两处处理

1. **明文 Resend 密钥已剥离**。原文件第 36 行为 `RESEND_API_KEY = "re_JA8cCFTJ..."`（硬编码）。
   已改为 `os.environ.get("RESEND_API_KEY", "")`。该密钥须视为已泄露并轮换。
2. **`import main` 断链**。`api_server_v3.py` 顶部 `from main import SwarmResearch`，而快照里 `main.py` 未随包提供。
   单独运行 API 前需补齐 `main.py`，或直接只用 `bees/` + `physics/` 两个模块。

## 运行方式

```bash
# 单独验证计算引擎（零依赖）
python -c "
from bees.compute_engines import QuantumEngine, VirtualScreening
print(QuantumEngine().calculate('CCO', accuracy='fast')['gap'])
print(VirtualScreening().screen(['CCO','c1ccccc1'])['summary'])
"
```

## 与本项目关系

`engines/` 目录不参与 `tools/build-site.mjs` 构建，**不会**进入 `_site/` 与 Pages 产物，
因此不占用 Pages ~1014.7MB 容量上限。这里作为引擎层源码资产留存，供后续 Worker / MCP 工具实现参照。
