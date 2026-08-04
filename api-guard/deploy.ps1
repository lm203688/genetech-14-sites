# GeneTech API 鉴权 Worker 一键部署 (PowerShell)
# 前提（在你自己的机器上）：
#   1. npm install -g wrangler
#   2. wrangler login   （已登录 Cloudflare 账号）
# 运行：powershell -ExecutionPolicy Bypass -File deploy.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command wrangler -ErrorAction SilentlyContinue)) {
  Write-Error "未找到 wrangler，请先执行：npm install -g wrangler; wrangler login"
  exit 1
}

$secretFile = Join-Path $PSScriptRoot ".secrets/pro_secret.txt"
if (Test-Path $secretFile) {
  $PRO_SECRET = (Get-Content $secretFile -Raw).Trim()
} elseif ($env:PRO_SECRET) {
  $PRO_SECRET = $env:PRO_SECRET.Trim()
} else {
  Write-Error "未找到 PRO_SECRET。请先生成：node -e ""console.log(require('crypto').randomBytes(32).toString('hex'))"" > .secrets/pro_secret.txt"
  exit 1
}

$toml = Join-Path $PSScriptRoot "wrangler.toml"
if (Select-String -Path $toml -Pattern "REPLACE_WITH_YOUR_KV_NAMESPACE_ID" -Quiet) {
  Write-Host "→ 创建 PRO_KV 命名空间…"
  $out = (wrangler kv namespace create PRO_KV | Out-String)
  if ($out -match 'id\s*=\s*"([a-f0-9]{20,})"') {
    $kvId = $Matches[1]
  } else {
    Write-Error "无法解析 KV id。wrangler 输出：`n$out"
    exit 1
  }
  (Get-Content $toml) -replace "REPLACE_WITH_YOUR_KV_NAMESPACE_ID", $kvId | Set-Content $toml
  Write-Host "✓ 已注入 PRO_KV id: $kvId"
}

Write-Host "→ 注入 PRO_SECRET…"
$PRO_SECRET | wrangler secret put PRO_SECRET

Write-Host "→ 部署 genetech-api-guard…"
wrangler deploy
Write-Host "✓ 部署完成。Pro 端点 /api/pro/* 现在需要 Authorization: Bearer <ProKey>。"
