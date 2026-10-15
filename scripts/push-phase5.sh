#!/usr/bin/env bash
# Phase 5 推送清单（一次性脚本）
#
# 用法（在仓库根目录）：
#   GITHUB_TOKEN=ghp_xxx bash scripts/push-phase5.sh
#
# 或 PowerShell：
#   $env:GITHUB_TOKEN="ghp_xxx"; bash scripts/push-phase5.sh

set -euo pipefail

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "❌ 缺少 GITHUB_TOKEN。用法：GITHUB_TOKEN=ghp_xxx bash $0"
  exit 1
fi

FILES=(
  ".gitignore"
  "README.md"
  "docs/competition-2026/INDEX.md"
  "audit/LOGPUSH-SETUP.md"
  "audit/README.md"
  "scripts/verify-online.sh"
  "reports/verify-online.md"
  "tools/build-pagefind.mjs"
  "docs/PAGEFIND-INTEGRATION.md"
  "reports/phase5-execution-summary-2026-10-15.md"
)

MSG="phase5: P3 清理 + 断链修复 + Logpush审计 + verify-online月度刷新 + Pagefind工具链"

node .workbuddy/probe/push-new-files.mjs -m "$MSG" "${FILES[@]}"

echo ""
echo "📌 Phase 5 已推送到 master。以下 2 个删除项需通过 delete-old.mjs 或 GitHub Web UI 单独处理："
echo "  - sites/        （空目录，本地已删）"
echo "  - external-projects/dra.zip  （8.6MB vendor 重复，本地已删）"
echo ""
echo "检查远端状态：git fetch && git log --oneline -3"
