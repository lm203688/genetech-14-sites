#!/usr/bin/env bash
# GeneTech API 鉴权 Worker 一键部署
# 前提（在你自己的机器上）：
#   1. npm install -g wrangler
#   2. wrangler login   （已登录 Cloudflare 账号）
# 运行：bash deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

# 1. 检查 wrangler
if ! command -v wrangler >/dev/null 2>&1; then
  echo "✗ 未找到 wrangler，请先执行：npm install -g wrangler && wrangler login"
  exit 1
fi

# 2. 读取 PRO_SECRET：优先 .secrets/pro_secret.txt，其次环境变量
SECRET_FILE=".secrets/pro_secret.txt"
if [ -f "$SECRET_FILE" ]; then
  PRO_SECRET="$(cat "$SECRET_FILE")"
elif [ -n "${PRO_SECRET:-}" ]; then
  : # 使用环境变量
else
  echo "✗ 未找到 PRO_SECRET。请先生成：node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" > .secrets/pro_secret.txt"
  exit 1
fi

# 3. 若 wrangler.toml 仍是占位符，则创建 KV 命名空间并注入 id
if grep -q "REPLACE_WITH_YOUR_KV_NAMESPACE_ID" wrangler.toml; then
  echo "→ 创建 PRO_KV 命名空间…"
  OUT="$(wrangler kv namespace create PRO_KV)"
  KV_ID="$(printf '%s' "$OUT" | grep -oE 'id[[:space:]]*=[[:space:]]*"[a-f0-9]+"' | head -1 | grep -oE '[a-f0-9]{20,}')"
  if [ -z "$KV_ID" ]; then
    echo "✗ 无法解析 KV id，请手动在 Cloudflare 控制台创建 KV 命名空间，并把 id 填入 wrangler.toml。wrangler 输出："
    echo "$OUT"
    exit 1
  fi
  sed -i "s/REPLACE_WITH_YOUR_KV_NAMESPACE_ID/$KV_ID/" wrangler.toml
  echo "✓ 已注入 PRO_KV id: $KV_ID"
fi

# 4. 注入 PRO_SECRET（从 stdin 读取，不落盘）
printf '%s' "$PRO_SECRET" | wrangler secret put PRO_SECRET

# 5. 部署
echo "→ 部署 genetech-api-guard…"
wrangler deploy
echo "✓ 部署完成。Pro 端点 /api/pro/* 现在需要 Authorization: Bearer <ProKey>。"
