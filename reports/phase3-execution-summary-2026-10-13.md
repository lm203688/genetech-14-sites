# 10-13 报告执行总结（第六轮 N1/N2/N3 修复）

> 依据：[`reports/项目全面评估与国际化竞品对标提升报告-2026-10-13.md`](项目全面评估与国际化竞品对标提升报告-2026-10-13.md)
> 本轮定位：**复核 Phase 2 自述成果 + 修复三个新发现（两个 P0）**

---

## 1. 完成的项

| # | 报告条目 | 状态 | 交付物 |
|---|---|---|---|
| N1 | MCP "2026-07-28 规范"宣称不实 | ✅ **修复** | package.json description/keyword → 2025-11-25；http.mjs / worker.js / mcp-remote README 同步。不宣称未实现的 `_meta` envelope |
| N2 | 首调 23.0s | ✅ **修复** | 分片快路径 + list_sites 轻量化 + 启动 warmup + **isMain 隐性 bug**；实测 <0.5s |
| N3 | leaderboard 100% 循环基准 | ✅ **重建** | benchmark v2 四种非同源构造 + multi-relevant + 类型分解 |
| §3 | 引用边"解析率 50%"误导 | ✅ **口径分离** | claims 新增 `citationResolvedOfDeclarations`；README 锚注拆两行 |
| 连带 | 分片字段缺失 | ✅ **补全** | doi / quality_tier / addedAt 进分片投影 |

## 2. 关键实测数据

### N2 延迟（修复前后）

| 场景 | 修复前 | 修复后 |
|---|---:|---:|
| 首调 `list_sites`（stdio） | ~23,000ms | **198ms** |
| 首调 `list_sites`（HTTP，warmup 后） | 23,065ms | **19ms** |
| `semantic_search`（HTTP） | — | **427ms** |
| `verify_entity`（HTTP） | — | **201ms** |
| 启动 warmup（后台） | — | 1.4–5.7s |

分片 vs 全量：30 站并行读+parse **1.4s** vs 串行 entities.json **23s**（16×）。

### N3 评测（v1 vs v2）

| 指标 | v1 循环构造 | v2 非同源 |
|---|---:|---:|
| avg Recall@10 | 100%（恒等式） | **41.3%** |
| avg MRR | 92.6% | **37.2%** |
| avg NDCG@10 | 94.3% | **36.5%** |
| 完全未召回 | 0 | 15/30 |

按构造类型分解（暴露短板）：

| 类型 | n | Recall@10 | MRR | 判读 |
|---|---:|---:|---:|---|
| abstract-mid | 11 | 100% | 83.3% | BM25 强项 |
| cross-entity | 4 | 15% | 25% | 混合 tag 排序弱 |
| site-topic | 3 | 0% | 0% | 单 tag 泛化弱 |
| tags-inverse | 12 | 6.5% | 8.4% | **检索器依赖字面重合** |

### 冒烟测试

stdio 模式 **28/28 全部通过**（含 verify_entity 溯源链 3 段、snapshot_at 回放、domain_relatedness 零引用站对识别）。CI `mcp-smoke` dispatch 通过（run 38345138828 success）。

## 3. 提交清单

| Commit | 内容 |
|---|---|
| 1c948c6 | fix(mcp): N1 协议版本如实化 + N2 冷启动 + isMain 隐性 bug |
| 612fe60 | fix(eval): N3 benchmark v2 查询与答案不同源 + multi-relevant |
| 2be9d80 | fix(index): 分片补 doi/quality_tier/addedAt + claims 口径分离 |
| 0a6a544 | feat(index): search-index 30 分片重建（37.9MB） |

## 4. 本轮最大发现：isMain 守卫静默失效

**旧代码**：
```js
const isMain = argv[1] && import.meta.url === new URL(argv[1], 'file://').href;
```

**失效路径**：任何客户端 spawn `node src/index.mjs`（相对路径）时，
`new URL('src/index.mjs', 'file://').href` = `file:///src/index.mjs`（相对 file:// 根解析），
与 `import.meta.url`（`file:///C:/.../index.mjs`）**永不匹配** → stdio 永不启动 →
客户端拿到一个"连上却不说话"的死进程。

**新代码**：
```js
const __self = fileURLToPath(import.meta.url);
const isMain = argv[1] && path.resolve(argv[1]).toLowerCase() === path.resolve(__self).toLowerCase();
```

这与项目记忆中"被 import 复用的脚本 CLI 守卫"血泪条目同型，但方向相反：
那条是守卫**永不匹配**导致自检块静默跳过；本条是守卫**永不匹配**导致 stdio 静默不启动。
两者共同的根因：**用 URL 比较而不是路径比较**。

## 5. 遗留

- **N2 CI 门禁**：报告验收判据"P95 首次 tools/call < 2s 写入 CI"尚未做成断言（当前只有 smoke 连通性检查）。
- **沙箱代理干扰**：本机 curl 连 127.0.0.1 会被沙箱代理拦截（ECONNREFUSED 8788），需 `--noproxy "*"` 或 node fetch 直连——环境限制，非代码问题。
- **Tier 1 加工内核仍为零**：ER 模型 / 立场模型 / 向量检索均需外部依赖（报告明示）。
- **用户硬阻塞未变**：wrangler deploy（支付 + mcp-remote）、npm publish、Glama 上架、DNS 决策、PAT 轮换。
