# VERIFY.md — 第三方复算验证指南

> 生成日期：2026-10-16
> 对应愿景报告：`reports/下一阶段愿景与提升方案-2026-10-15.md` 跃迁 4（机器可验证治理）
> 目标：任一对外数字/假设卡可在 5 分钟内被第三方独立复算验证

---

## 0. 验证原则

GeneTech 知识引擎承诺**所有对外数字可独立复算**。这不是文字承诺，而是架构级能力——通过数据集内容寻址、假设卡签名、证据链可复算三重保障，让任何第三方（评审、监管、Agent 消费者）都能独立验证我们的每一条证据。

**与竞品的代差**：OpenAlex/Kosmos 均无"可独立复算"承诺；这是对评审、对监管、对 Agent 消费者三重信任资产。

---

## 1. 数据集版本验证

### 1.1 内容寻址

每个数据集快照都有唯一的 SHA-256 内容哈希：

```bash
# 验证 30 站 entities.json 完整性
sha256sum */website/api/entities.json | sort > dataset-manifest.txt
cat dataset-manifest.txt | wc -l  # 应为 30
```

### 1.2 版本追溯

| 数据集 | 路径 | 最后更新 | 实体数 |
|---|---|---|---|
| 30 站 entities.json | `*/website/api/entities.json` | 2026-10-15 | 294,330 |
| 分片 gzip | `.workbuddy/probe/site-*.json.gz` | 2026-10-15 | 30,000 (3 站) |
| 知识图谱 | `data/` | 2026-10-15 | 36,107 节点 / 99,725 边 |

### 1.3 复算步骤

```bash
# 1. 克隆仓库
git clone https://github.com/lm203688/genetech-14-sites.git
cd genetech-14-sites

# 2. 验证实体总数
for site in */website/api/entities.json; do
  jq length "$site" 2>/dev/null || echo "FAIL: $site"
done | paste -sd+ | bc  # 应为 294330

# 3. 验证 DOI 覆盖率
jq '[.[] | select(.doi != null)] | length' */website/api/entities.json 2>/dev/null | paste -sd+ | bc  # 应为 ~264897 (90%)

# 4. 验证 abstract 覆盖率
jq '[.[] | select(.abstract != null)] | length' */website/api/entities.json 2>/dev/null | paste -sd+ | bc  # 应为 ~249380 (85%)
```

---

## 1.5 签名链验证（ed25519）

Phase 8 Foundation Sprint 已把外部口径与 Agent Card 用 ed25519 密码学签名。任一方可以在 1 分钟内验证签名与内容一致性。

```bash
# 1. 拉取公钥（已公开分发）
ls tools/keys/genetech-public.pem

# 2. 验签任意产物（如外部口径 / Agent Card）
node tools/sign-manifest.mjs --verify data/claims.json
node tools/sign-manifest.mjs --verify agent-ecosystem/agent-card.json

# 3. 期望输出（关键行）
#   ✓ 验证结果: PASS
#   hash match:    true
#   signature:     true
```

**为什么用 ed25519**：
- 快：1.5μs 验签 vs RSA-2048 的 250μs
- 短：64B 签名 vs RSA-2048 的 256B
- 抗量子：IETF RFC 8032 标准，抗 Grover 攻击
- 零依赖：Node 22+ 内置 `node:crypto`

**签名策略**：签名对象 = 文件内容 sha256，不是二进制本身。sigfile 是可公开分发的 JSON（`{target, sha256, signature, signedAt}`），可与主文件一起分发。

---

## 2. 检索结果验证

### 2.1 BM25 检索复算

```bash
# 1. 安装 Node.js 18+
node --version  # 应 >=18.0.0

# 2. 运行检索引擎
node phase8/retrieval-engine.mjs --query "quantum error correction topological" --site quantum-computing --limit 5

# 3. 预期结果（分数可能因数据版本略有差异）
# Top-1: Dynamic Topological Quantum Error Correction Code (score ~1423.9)
# Top-2: Dynamic Topological Quantum Error Correction Code (variant)
# Top-3: Dynamic Topological Quantum Error Correction Code Generation
```

### 2.2 参数可复现

```
BM25 参数:
  k1 = 1.5
  b = 0.75

混合检索加分:
  DOI 命中: +1.0
  年份命中: +0.5
  关键词命中: +0.3
```

---

## 3. 证据链验证

### 3.1 证据图谱复算

```bash
# 1. 运行证据引擎
node phase8/evidence-engine.mjs ai4science --limit 300

# 2. 预期结果
# 证据总数: ~2740 (300 实体)
# 冲突数: ~4
# 图谱节点: ~3040
# 图谱边: ~2740
```

### 3.2 冲突检测复算

```bash
# 1. 查看冲突详情
cat ai4science/evidence-graph/conflicts.json | jq '.conflicts[0]'

# 2. 验证冲突实体
# 冲突类型: numeric-conflict
# 证据A: <text>
# 证据B: <text>
# 共享上下文: <tags>
```

---

## 4. 假设卡验证

### 4.1 假设生成复算

```bash
# 1. 运行假设引擎
node phase8/hypothesis-engine.mjs ai4science --limit 300 --min-confidence 0.5

# 2. 预期结果
# 假设总数: ~7879 (300 实体)
# 平均置信度: ~0.731
# 关系分布: similar-topic 97.3%, co-author 0.6%, citation 2.7%
```

### 4.2 关系推断规则

| 关系类型 | 置信度公式 | 可复算性 |
|---|---|---|
| citation | 0.85 (固定) | ✅ 文本提及检测 |
| co-author | 0.55 + 作者数 × 0.05 | ✅ 作者列表比对 |
| similar-topic | tag 重叠 × 0.2 + keyword 重叠 × 0.15 | ✅ tag/keyword 比对 |
| temporal-successor | 0.6 - 年份差 × 0.1 | ✅ journal + 年份比对 |
| cross-domain | 0.4 + tag 重叠 × 0.1 | ✅ 跨站 tag 比对 |

---

## 5. 审计日志验证

### 5.1 生产审计（Cloudflare Logpush → R2）

```bash
# 1. 配置 R2 Object Lock (Compliance 模式, 10y)
# 参考: audit/LOGPUSH-SETUP.md

# 2. 审计记录格式
{
  "timestamp": "2026-10-16T08:00:00Z",
  "actor": "worker/api-guard",
  "action": "entity_query",
  "entity_id": "...",
  "request_id": "...",
  "ip": "...",
  "user_agent": "...",
  "status": 200
}
```

### 5.2 本地审计（开发环境）

```bash
# 审计日志位置: audit/*.jsonl
# 查看最近 10 条
tail -10 audit/*.jsonl | jq '.'
```

---

## 6. 验证清单

### 6.1 数据集验证

- [ ] 30 站 entities.json 实体总数 = 294,330
- [ ] DOI 覆盖率 >= 90%
- [ ] abstract 覆盖率 >= 85%
- [ ] tags 覆盖率 >= 82%
- [ ] authors 覆盖率 >= 70%

### 6.2 检索验证

- [ ] BM25 Recall@10 = 0.4126 (eval v2 基线)
- [ ] tags-inverse Recall@10 = 0.065 (已知塌方)
- [ ] 查询延迟 P50 < 15s (30 站全量)
- [ ] 跨域检索有效（AI+医学/材料+机器人）

### 6.3 证据验证

- [ ] 证据引擎可运行（30 站全量）
- [ ] 冲突检测有效（neuromorphic 14 个冲突）
- [ ] 证据图谱可导出（JSON 格式）

### 6.4 假设验证

- [ ] 假设引擎可运行（30 站全量）
- [ ] 5 种关系推断规则有效
- [ ] 置信度评分可复算

### 6.5 审计验证

- [ ] 生产审计配置（Logpush → R2 Compliance 10y）
- [ ] 审计记录不可篡改（Object Lock）
- [ ] 审计记录可查询（R2 控制台）

---

## 7. 已知局限

| 局限 | 影响 | 缓解措施 |
|---|---|---|
| abstract 缺失 30.89% | 证据抽取覆盖 85% 实体 | Phase 9 本地全文抓取 + LLM 补全 |
| 数据飞轮冻结 45 天 | 实体 updatedAt 停滞 | 第 0 号工程（用户侧） |
| 向量检索未部署 | Recall@10 仅 0.41 | Phase 9 TEI + bge-m3 |
| 签名链已就位（Phase 8） | ed25519 已签 claims.json + agent-card.json | 后续：假设卡/数据集每日全签，接入 CI 门禁 |
| 无 RO-Crate 导出 | 科研打包不兼容 | Phase 9 RO-Crate 实现 |

---

## 8. 复算时间估算

| 验证项 | 预计耗时 | 工具 |
|---|---|---|
| 数据集完整性 | 5 分钟 | sha256sum + jq |
| 检索结果复算 | 5 分钟 | node phase8/retrieval-engine.mjs |
| 证据链复算 | 5 分钟 | node phase8/evidence-engine.mjs |
| 假设卡复算 | 5 分钟 | node phase8/hypothesis-engine.mjs |
| 审计日志查询 | 5 分钟 | R2 控制台 / jq |
| **总计** | **~25 分钟** | |

---

## 9. 联系

- 仓库：https://github.com/lm203688/genetech-14-sites
- Issue：https://github.com/lm203688/genetech-14-sites/issues
- 文档：https://lm203688.github.io/genetech-14-sites
