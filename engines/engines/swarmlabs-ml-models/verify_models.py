#!/usr/bin/env python3
"""
验证 engine_models/ 下 8 个物理基线+ML残差校正模型可加载并可预测。

运行前置（硬性版本约束，见 README）：
    pip install "scikit-learn==1.5.2" "numpy<2"
pkl 内嵌 sklearn_version=1.5.2，且引用 sklearn._loss / sklearn.ensemble._gb
（这两个模块在 sklearn>=1.6 已重命名/搬迁），版本不符会直接 ModuleNotFoundError。
"""
import json
import os
import pickle
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENG = os.path.join(HERE, "engine_models")

# 每个引擎的最小可行输入（与 meta.json 的 features 字段一一对应）
SAMPLE_INPUT = {
    "adsorption":      [850.0, 5.0],        # surface_area, pressure
    "ammonia":         [523.0, 200.0],      # temperature, pressure
    "battery":         [3.7, 150.0],        # voltage, capacity
    "combustion":      [1.0],               # equivalence_ratio
    "corrosion":       [60.0, 7.0],         # temperature, ph
    "perovskite":      [1.6],               # bandgap
    "photocatalysis":  [2.2, 900.0],        # bandgap, surface_area
    "polymer":         [120000.0, 0.8],     # mn, tacticity
}


def main():
    ok = fail = 0
    rows = []
    for meta_name in sorted(os.listdir(ENG)):
        if not meta_name.endswith("_meta.json"):
            continue
        engine_id = meta_name[:-len("_meta.json")]
        pkl_name = engine_id + "_ml.pkl"
        pkl_path = os.path.join(ENG, pkl_name)
        meta = json.load(open(os.path.join(ENG, meta_name), encoding="utf-8"))

        try:
            with open(pkl_path, "rb") as fh:
                model = pickle.load(fh)
            params = model.get_params()
            pred = float(model.predict([SAMPLE_INPUT[engine_id]])[0])
        except Exception as exc:  # noqa: BLE001
            rows.append((engine_id, "FAIL", type(exc).__name__, str(exc)[:70]))
            fail += 1
            continue

        rows.append((engine_id, "OK", params.get("n_estimators"), round(pred, 4)))
        ok += 1

    print(f"{'engine_id':16s} {'status':6s} {'n_estimators':>12s} {'pred':>10s}  note")
    print("-" * 74)
    for engine_id, a, b, c in rows:
        print(f"{engine_id:16s} {a:6s} {str(b):>12s} {str(c):>10s}")
    print("-" * 74)
    print(f"OK={ok}  FAIL={fail}  total={ok + fail}")

    if ok:
        print("\n[语义提示] pred 是 **ML 残差**，不是最终物性值。")
        print("  正确用法：final = physics_engine(features) + model.predict(features)")
        print("  实测证据：corrosion/perovskite/photocatalysis 的 pred 为负值")
        print("  （腐蚀速率/效率/量子效率不可能为负），说明模型输出的是校正量。")

    if ok == 0 and fail:
        print("\n[诊断] 全部加载失败通常是 sklearn 版本不符。")
        print("  本机 sklearn 版本：", end="")
        try:
            import sklearn
            print(sklearn.__version__)
        except ImportError:
            print("未安装")
        print("  需要：scikit-learn==1.5.2 + numpy<2")
        sys.exit(2)
    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()
