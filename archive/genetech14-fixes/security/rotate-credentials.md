# 凭证轮换操作指南

本指南用于指导如何彻底清理泄露的凭证并重新配置所有密钥。

## 第一步：立即轮换所有凭证（按优先级）

### 1. Cloudflare API Token
1. 登录 https://dash.cloudflare.com/profile/api-tokens
2. 定位到泄露的 Token（以 `cfut_` 开头），点击 "Roll" 或 "Delete"
3. 创建新 Token，权限范围：
   - Account > Cloudflare Pages > Edit
   - Zone > DNS > Edit
   - Zone > Zone Settings > Edit
4. 限制 IP 范围为你常用的开发环境
5. 将新 Token 写入 `.env` 文件，**不要写入任何代码或文档**

### 2. GitHub Personal Access Token
1. 访问 https://github.com/settings/tokens
2. 删除泄露的 PAT（以 `github_pat_` 开头）
3. 创建新 PAT，仅勾选必需 scope：
   - `repo` (如果需要私有仓库)
   - `workflow` (如果需要触发 Actions)
4. 设置过期时间为 90 天
5. 将新 PAT 写入 `.env`

### 3. Creem 支付 API Key
1. 登录 Creem 商家后台
2. 在 API 设置中重新生成 API Key
3. 旧 Key 自动失效
4. 将新 Key 写入 `.env`
5. 同时检查交易记录，确认无异常订单

### 4. ECS 服务器部署 Token
1. SSH 登录到 ECS 服务器
2. 修改部署服务的认证 Token
3. 更新服务器防火墙规则，限制端口 8420-8480 的访问来源
4. 将新 Token 写入 `.env`

### 5. 其它密钥
- IndexNow Key: https://www.bing.com/indexnow 重新生成
- Bark Token: 在 Bark App 中重新生成
- 小乌 AI API Key: 联系服务提供方重新签发

## 第二步：从 Git 历史中彻底删除 CREDENTIALS.md

仅用 `git rm` 删除文件是不够的，因为文件仍然存在于历史记录中。必须使用 `git filter-repo` 彻底抹除：

```powershell
# 安装 git-filter-repo（一次性）
pip install git-filter-repo

# 进入仓库根目录
cd <仓库路径>

# 备份当前分支
git branch backup-$(date +%Y%m%d)

# 彻底删除 CREDENTIALS.md 的所有历史痕迹
git filter-repo --path CREDENTIALS.md --invert-paths

# 强制推送到远程（危险操作，确认无误后执行）
git push origin --force --all
git push origin --force --tags

# 通知所有协作者：必须重新 clone 仓库，旧的 clone 已失效
```

如果无法使用 `git filter-repo`，备选方案是使用 BFG Repo-Cleaner：
```powershell
# 下载 bfg.jar: https://rtyley.github.io/bfg-repo-cleaner/
java -jar bfg.jar --delete-files CREDENTIALS.md
git reflog expire --expire=now --all
git gc --prune=now --aggressive
git push origin --force --all
```

## 第三步：审查服务器日志

检查 ECS 服务器过去 30 天的访问日志，寻找入侵迹象：

```bash
# 检查异常登录
last -30
grep "Failed password" /var/log/auth.log | tail -50

# 检查异常进程
ps aux | grep -v "USER.*\bsystemd\b"
crontab -l

# 检查异常网络连接
netstat -tulpn | grep LISTEN
ss -tulpn
```

如果发现任何可疑活动：
1. 立即断开服务器网络
2. 创建磁盘快照用于取证
3. 重装操作系统或恢复到已知干净的快照
4. 重新部署所有服务

## 第四步：配置密钥管理

推荐使用以下方案之一：

### 方案 A：本地 .env 文件（简单）
- 创建 `.env` 文件（已加入 `.gitignore`）
- 在代码中通过 `process.env.VAR_NAME` 读取
- 团队成员各自维护本地 `.env`

### 方案 B：Cloudflare Secrets（推荐用于 Workers）
```bash
wrangler secret put CLOUDFLARE_API_TOKEN
wrangler secret put CREEM_API_KEY
```

### 方案 C：GitHub Actions Secrets（用于 CI/CD）
- 在 GitHub 仓库 Settings > Secrets and variables > Actions 中添加
- 在 workflow 中通过 `${{ secrets.VAR_NAME }}` 引用

## 第五步：验证修复

> ⚠️ 安全：本步原示例含真实 `cfut_` token，已脱敏为占位符。若该 token 曾真实可用，请立即到 Cloudflare 后台吊销并轮换（旧 token 泄露 = 账户接管风险）。

1. 确认旧凭证已失效：
   ```powershell
   # 用旧 Token 测试 Cloudflare API（应返回 401）
   curl -H "Authorization: Bearer <OLD_CF_TOKEN_REDACTED>" `
     "https://api.cloudflare.com/client/v4/user/tokens/verify"
   ```

2. 确认新凭证工作正常：
   ```powershell
   # 用新 Token 测试
   curl -H "Authorization: Bearer $env:CLOUDFLARE_API_TOKEN" `
     "https://api.cloudflare.com/client/v4/user/tokens/verify"
   ```

3. 确认 Git 历史已清理：
   ```powershell
   git log --all --full-history -- CREDENTIALS.md
   # 应该返回空
   ```

## 第六步：建立长效机制

1. **定期轮换**：每 90 天轮换一次所有 API Token
2. **最小权限**：每个 Token 只赋予完成其功能所需的最小权限
3. **审计日志**：启用 Cloudflare 和 GitHub 的 Audit Log
4. **预提交钩子**：安装 `pre-commit` 并配置密钥扫描：
   ```yaml
   # .pre-commit-config.yaml
   repos:
     - repo: https://github.com/Yelp/detect-secrets
       rev: v1.4.0
       hooks:
         - id: detect-secrets
           args: ['--baseline', '.secrets.baseline']
   ```
