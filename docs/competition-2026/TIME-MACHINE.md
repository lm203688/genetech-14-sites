# 时间机器 / 知识溯源（Time Machine & Provenance）

> 母题来源：AsoulAI ChronosFix「时间机器（回放 / 重算）」
> 对应评审维度：开放探索赛题「可检查性与可延续性（15%）」+ 算法赛题「科学意义（30%）」

数据飞轮默认是**单向追加**，一旦归一逻辑变更或上游修正，历史快照无法复现。时间机器让任意时间点的知识状态可被**精确重放**，是「知识累积」方向区别于「缓存」的关键。

---

## 1. 核心数据契约：Provenance

每个实体（`entities.json` 中的一条记录）强制携带 `provenance` 字段：

```json
{
  "id": "trend:ai4s:2026-q2-0042",
  "type": "trend",
  "title": "神经形态计算在材料发现中的跨域桥接",
  "provenance": {
    "sources": [
      { "url": "https://arxiv.org/abs/2503.12345", "fetched_at": "2026-03-12T08:21:00Z", "sha256": "a1b2...", "confidence": 0.91 },
      { "url": "https://api.openalex.org/works/Wxxxx", "fetched_at": "2026-03-12T08:22:10Z", "sha256": "c3d4...", "confidence": 0.88 }
    ],
    "transform_version": "normalizer@2026.3.1",
    "derived_from": ["entity:raw:arxiv:2503.12345", "entity:raw:openalex:Wxxxx"],
    "valid_at": "2026-03-12T08:30:00Z",
    "superseded_by": null
  }
}
```

字段含义：

| 字段 | 作用 |
|------|------|
| `sources[].url + fetched_at + sha256` | 精确到字节的抓取锚点，支持重抓验证 |
| `transform_version` | 归一逻辑版本，逻辑变更即新版本，旧版可重放 |
| `derived_from` | 上游原始实体引用，构成 DAG |
| `valid_at` | 该快照生效时刻 |
| `superseded_by` | 被哪条新快照取代（形成版本链） |

## 2. 重放接口

```
GET /api/time-machine?entity=<id>&as_of=<ISO8601>
  → 返回该实体在 as_of 时刻的有效快照（沿 superseded_by 链回溯）
```

- 不修改当前数据，纯只读查询。
- `as_of` 缺省返回最新。
- 失败回退：若 `as_of` 无快照，返回最近的前驱快照并标注 `approx=true`。

## 3. 技术实现（参考路径，不破坏现有 6 源 backfill）

1. **采集层**：Collector Agent 落盘原始记录到 `raw/<source>/<date>/<id>.json`（已隐含，补 `sha256` 即可）。
2. **归一层**：Normalizer 输出时写入 `provenance.transform_version`（取自 `package.json` 或 commit sha）。
3. **存储层**：`entities.json` 每条带 `provenance`；新增 `entities@<date>.snapshot.json` 每日全量快照（冷区归档）。
4. **查询层**：`tools/time-machine.mjs`（独立 CLI，opt-in）实现 `as_of` 回溯，不接入 CI。

## 4. 与 SwarmLabs 47k 实体的复用

SwarmLabs 的「科学发现溯源」叙事直接受益于时间机器：
- 「2025→2026 前沿科学发现扩展」可量化为**带时间戳的实体增量曲线**，而非静态总数。
- 评审可现场指定 `as_of=2025-09-01` 验证当时知识状态，证明累积真实发生、非事后编造。

## 5. 评审可检查性

- `GET /api/time-machine?entity=...&as_of=2025-09-01` 现场演示。
- `audit/provenance-YYYY-MM-DD.jsonl` 记录每日 provenance 写入量。
- 本文件 `policy_version: 2026.1` 版本化。
