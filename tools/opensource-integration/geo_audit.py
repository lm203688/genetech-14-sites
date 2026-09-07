#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GEO 双引擎审计封装（GeneTech 14站 借鉴研发落地件）
=================================================
封装两个开源 GEO 工具，对站点做"AI 引擎可引用性"体检，
输出合并 markdown 报告，可接入运营闭环的 GEO 博客产出分支。

  - auriti-labs/geo-optimizer-skill  (MIT, pip 包)  -> 0-100 八类评分
  - shadowresearch/auto-geo         (MIT, npm 包)  -> 七段式架构 doctor 检查

零 API 成本：两个工具的核心审计/doctor 均无需任何 API key。
（auto-geo 的 `check` 真实引用覆盖测量需 1 个引擎 key，可选，本脚本默认不调用。）

用法：
  python geo_audit.py --url https://lm203688.github.io/genetech-14-sites/ \
                      --out ../../docs/geo-promotion-tracker.md

依赖：
  geo venv:   C:/Users/xing/.workbuddy/binaries/python/envs/geo-poc/Scripts/geo.exe
  auto-geo:   npm i -g auto-geo  (全局命令 auto-geo)
可用环境变量覆盖：
  GEO_OPT_BIN   指向 geo.exe
  AUTO_GEO_BIN  指向 auto-geo 命令（默认 'auto-geo'，需在 PATH）
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_GEO_BIN = r"C:/Users/xing/.workbuddy/binaries/python/envs/geo-poc/Scripts/geo.exe"
DEFAULT_AUTO_GEO_BIN = r"C:/Users/xing/.workbuddy/binaries/node/versions/22.22.2-2/auto-geo.cmd"


def run_geo_optimizer(url: str, timeout: int = 180) -> dict:
    """运行 geo-optimizer-skill audit，返回解析后的 dict（含 score/breakdown/recommendations）。"""
    bin_path = os.environ.get("GEO_OPT_BIN", DEFAULT_GEO_BIN)
    if not os.path.exists(bin_path):
        return {"error": f"geo-optimizer 未安装：{bin_path}（先 pip install geo-optimizer-skill）"}
    try:
        proc = subprocess.run(
            [bin_path, "audit", "--url", url, "--format", "json"],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"error": f"geo-optimizer 审计超时（>{timeout}s），站点网络拉取可能受限"}
    raw = proc.stdout
    i = raw.find("{")
    if i < 0:
        return {"error": "geo-optimizer 未返回 JSON", "raw": raw[:500]}
    try:
        return json.loads(raw[i:])
    except json.JSONDecodeError as e:
        return {"error": f"JSON 解析失败: {e}", "raw": raw[i:i + 500]}


def run_auto_geo_doctor(url: str, timeout: int = 120) -> str:
    """运行 auto-geo doctor，返回文本输出（七段式架构合规检查）。"""
    import shutil
    bin_name = os.environ.get("AUTO_GEO_BIN")
    if not bin_name:
        cand = shutil.which("auto-geo")
        if cand:
            bin_name = cand
        elif os.path.exists(DEFAULT_AUTO_GEO_BIN):
            bin_name = DEFAULT_AUTO_GEO_BIN
        else:
            bin_name = "auto-geo"
    try:
        proc = subprocess.run(
            [bin_name, "doctor", url],
            capture_output=True, text=True, timeout=timeout,
        )
        return proc.stdout.strip()
    except FileNotFoundError:
        return "AUTO_GEO_MISSING: 未找到 auto-geo 命令（先 npm i -g auto-geo）"
    except subprocess.TimeoutExpired:
        return "AUTO_GEO_TIMEOUT: doctor 超时"


def build_report(url: str, opt: dict, doc: str) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = []
    lines.append(f"\n## GEO 双引擎审计 · {now}")
    lines.append(f"- 目标站点：{url}")
    lines.append("")

    # ---- geo-optimizer-skill ----
    lines.append("### 1) auriti-labs/geo-optimizer-skill（0–100 八类评分）")
    if opt.get("error"):
        lines.append(f"  ⚠️ 运行失败：{opt['error']}")
    else:
        score = opt.get("score")
        band = opt.get("band")
        lines.append(f"  - **总分：{score}/100 · band = {band}**")
        bd = opt.get("score_breakdown", {})
        if bd:
            lines.append("  - 八类分项（score）：")
            for k, v in bd.items():
                lines.append(f"    - {k}: {v}")
        recs = opt.get("recommendations", [])[:10]
        if recs:
            lines.append("  - 优先级修复：")
            for r in recs:
                lines.append(f"    - {r}")
    lines.append("")

    # ---- auto-geo doctor ----
    lines.append("### 2) shadowresearch/auto-geo（七段式架构 doctor）")
    if doc.startswith("AUTO_GEO"):
        lines.append(f"  ⚠️ {doc}")
    else:
        # 只摘录 Score 行与 Top fixes
        for line in doc.splitlines():
            if line.strip().startswith(("Score:", "[FAIL]", "[OK]", "Top 3", "1.", "2.", "3.")):
                lines.append(f"  {line.strip()}")
    lines.append("")
    lines.append("---")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="GEO 双引擎审计封装")
    ap.add_argument("--url", default="https://lm203688.github.io/genetech-14-sites/")
    ap.add_argument("--out", default=os.path.join(HERE, "..", "..", "docs", "geo-promotion-tracker.md"))
    ap.add_argument("--no-append", action="store_true", help="只打印，不写入文件")
    args = ap.parse_args()

    print(f"[geo-audit] 审计 {args.url} ...")
    opt = run_geo_optimizer(args.url)
    doc = run_auto_geo_doctor(args.url)
    report = build_report(args.url, opt, doc)
    print(report)

    if not args.no_append:
        out_path = os.path.abspath(args.out)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "a", encoding="utf-8") as f:
            f.write(report + "\n")
        print(f"\n[geo-audit] 已追加到 {out_path}")


if __name__ == "__main__":
    main()
