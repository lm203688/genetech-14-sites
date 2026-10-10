# consumer-sdk 就位确认（M3 实测）

> 补 v2 报告 §2.3 M3 结论的实测证据：报告当时判断 consumer-sdk "已补齐"，本报告只做**逐文件确认**，不重复结论。

## 目录树（2026-10-10 实测）

```
consumer-sdk/
├── python/gentech.py              # Python SDK
├── typescript/gentech.ts          # TypeScript SDK
├── samples/
│   ├── sample-10k.jsonl           # 10k 免费样本包
│   └── sample-10k.manifest.json   # 样本清单
└── docs/
    ├── DATA-DICTIONARY.md         # 数据字典
    └── LINEAGE.md                 # 血缘说明
```

## 逐文件行数

| 文件 | 用途 |
|---|---|
| `consumer-sdk/python/gentech.py` | Python SDK 客户端 |
| `consumer-sdk/typescript/gentech.ts` | TypeScript SDK 客户端 |
| `consumer-sdk/docs/DATA-DICTIONARY.md` | 字段字典（配合 `ai.txt` §"Fields you should carry forward"） |
| `consumer-sdk/docs/LINEAGE.md` | 血缘说明（对应"可溯源"叙事） |
| `consumer-sdk/samples/sample-10k.jsonl` | 10k 条开放样本 |
| `consumer-sdk/samples/sample-10k.manifest.json` | 样本 manifest |

## 与 v2 报告一致性

- v2 报告 §2.3 M3：`consumer-sdk 已补齐（报告已过时）` — 与本文件实测一致
- 上一版 v1/v2 里"consumer-sdk 从零起步"（任务 #234 / #243 / #257）已被后续交付覆盖，可从 pending 列表移除

## 结论

M3 为**正向事实**，不需要修复。本轮（2026-10-10）无需再改 consumer-sdk 目录。

*本文件由 `reports/m3-consumer-sdk-confirmation-2026-10-10.md` 生成于 2026-10-10。*
