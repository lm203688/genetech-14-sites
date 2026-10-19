# Schema 强制点核对表（G11 交付）

> 对应报告 §3.3 G11：round9 F4 要求 "ingest 出口 / sync-live 入口 / MCP 工具出口**三处强制**"。
> 本表逐点确认每处校验已实际接入，若新增出口必须补进本表并加测试。

## 单一真源

- Schema 定义：`data/schemas/*.json`（5 个：entity / citation-edges / knowledge-graph / station-tags / crop-adapt-db）
- 校验器：`lib/schema-validator.cjs`（validate / validateEntities / loadSchema）
- 测试：`tests/schema-validator.test.mjs`（10 条断言，node --test 门禁）

## 三处强制校验点（全部已接入）

| # | 出口 | 位置 | 校验时机 | 校验对象 | 失败行为 | 已接入 |
|---|---|---|---|---|---|---|
| 1 | **Ingest 出口 · 数据回填** | `operations-plan/pipeline-data-backfill.js:1126` | 落盘前 | 全量 all[] 实体 | exit 1（阻断落盘） | ✅ |
| 2 | **Ingest 出口 · 数据累积** | `operations-plan/pipeline-data-accumulation.js:834` | 合并后落盘前 | merged[] 增量实体 | exit 1 | ✅ |
| 3 | **Sync-live 入口** | `operations-plan/pipeline-sync-live.js:97` | 上游拉取后落盘前 | all[] 同步实体 | exit 1 | ✅ |
| 4 | **MCP 工具出口** | `mcp-server/src/index.mjs:398` | query_entities 分页返回前 | page[] 分页实体 | 返回 { errors, dropped } 并截断 | ✅ |

> 注：4 处比报告原写的"三处"多 1 处——ingest 有两个独立入口（backfill / accumulation），都接入才算真强制。

## 接入规范

新增任何"实体落盘 / 实体对外"的出口必须：

1. `import { validateEntities } = from '../lib/schema-validator.cjs'`（CJS 走 createRequire 桥接）
2. 在**落盘 / 返回前**调用 `validateEntities(arr, 'entity')`
3. 校验失败必须 exit 1 或返回错误，禁止静默吞错
4. 在本表新增一行并补测试断言

## 门禁覆盖

- `npm test` / `npm run test:schema-validator` → 10 条 SV* 断言
- `npm test` → 27/27 全部通过（2026-10-17 实测）
- CI：`.github/workflows/ops.yml` 含 test job

## 已知边界

- 当前是 **JSON Schema draft-07**（`data/schemas/*.json`），非 round9 措辞的 zod；`package.json` 声明 `zod ^4.6.7` 但未实际使用，避免双轨。
- `validateEntities` 有错误上限（默认 500 条），大量错误会截断以避免日志爆炸。
