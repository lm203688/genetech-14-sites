#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Deep Research 集成封装（GeneTech 14站 借鉴研发落地件）
=====================================================
封装 tarun7r/deep-research-agent（MIT, LangGraph 四智能体 + 可信度评分），
用**本地 Ollama** 跑零 API 成本的研究报告，产出带引用回溯与可信度评分的
markdown，接入运营闭环的「周日深度分支 / strategy-weekly.md 证据链」。

验证来源（2026-09-07 经 Contents API 取 main.py / README 确认）：
  - 入口：from src.graph import run_research
  - 调用：run_research(topic, verbose=True, use_cache=True) -> state
          state["final_report"] / state["quality_score"] / state["credibility_scores"]
  - 配置（.env）：MODEL_PROVIDER=ollama, MODEL_NAME=ornith-1.5:35b,
                  MIN_CREDIBILITY_SCORE=40（默认过滤阈值）

本机现状：Ollama 已加载 ornith-1.5:35b(22GB) 与 qwen3:8b(5.2GB)。
  - 35B 在 CPU 推理较慢但可用；8B 更快，适合 PoC。
  - Web 检索走 DuckDuckGo，依赖外网可达性（本环境对 github.com 直连超时，
    但对常规 HTTPS 站点一般可达；若检索失败，agent 仍能基于缓存/有限结果成稿）。

用法：
  python deep_research_harness.py --topic "2025-2026 前沿科学发现对知识引擎的启示" \
                                 --repo-path ../../tmp/opensource-poc/tarun7r \
                                 --out ../../docs/strategy-weekly-draft.md

依赖（在 tarun7r REPO_PATH 内安装）：
  cd <repo-path> && pip install -r requirements.txt
"""
import argparse
import os
import sys
import subprocess
from datetime import datetime, timezone


def ensure_ollama(model: str) -> bool:
    """检查 Ollama 是否就绪且模型已拉取。"""
    try:
        out = subprocess.run(["ollama", "list"], capture_output=True, text=True, timeout=20)
        return model.split(":")[0] in out.stdout
    except Exception:
        return False


def run(topic: str, repo_path: str, model: str, out_path: str, use_cache: bool = True):
    if not os.path.isdir(repo_path):
        return f"[deep-research] tarun7r 仓库未找到：{repo_path}\n请先克隆/解包 tarun7r/deep-research-agent 到该路径。"

    if not ensure_ollama(model):
        return (f"[deep-research] Ollama 未就绪或模型 {model} 未加载。\n"
                f"请先 `ollama pull {model}` 并确保 ollama serve 运行中。")

    # 注入 tarun7r 到 sys.path 并配置本地模型
    sys.path.insert(0, os.path.abspath(repo_path))
    os.environ["MODEL_PROVIDER"] = "ollama"
    os.environ["MODEL_NAME"] = model
    os.environ.setdefault("MIN_CREDIBILITY_SCORE", "40")

    try:
        from src.graph import run_research
    except Exception as e:
        return f"[deep-research] 导入 src.graph 失败：{e}"

    print(f"[deep-research] 启动研究：{topic!r}（model={model}）")
    try:
        state = run_research(topic, verbose=True, use_cache=use_cache)
    except Exception as e:
        return f"[deep-research] run_research 异常：{e}"

    report = state.get("final_report", "")
    quality = state.get("quality_score", {})
    cred = state.get("credibility_scores", [])

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    header = (
        f"\n## Deep Research 草稿 · {now}\n"
        f"- 主题：{topic}\n"
        f"- 模型：{model}（本地 Ollama，零 API 成本）\n"
        f"- 质量分：{quality.get('total_score') if isinstance(quality, dict) else quality}\n"
        f"- 来源可信度条目数：{len(cred)}\n\n"
    )
    full = header + report

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(full)
    return f"[deep-research] 已写入 {os.path.abspath(out_path)}（{len(full)} 字符）"


def main():
    ap = argparse.ArgumentParser(description="Deep Research 集成封装（本地 Ollama）")
    ap.add_argument("--topic", required=True, help="研究主题")
    ap.add_argument("--repo-path", default=os.path.join(HERE, "..", "..", "tmp", "opensource-poc", "tarun7r"))
    ap.add_argument("--model", default="ornith-1.5:35b", help="Ollama 模型（默认 35B；PoC 可用 qwen3:8b）")
    ap.add_argument("--out", default=os.path.join(HERE, "..", "..", "docs", "strategy-weekly-draft.md"))
    args = ap.parse_args()

    result = run(args.topic, args.repo_path, args.model, args.out)
    print(result)


if __name__ == "__main__":
    HERE = os.path.dirname(os.path.abspath(__file__))
    main()
