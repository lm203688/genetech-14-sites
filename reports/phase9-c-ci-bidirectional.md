# Phase 9-C · CI signverify 双向回归报告

**日期**: 2026-10-16
**任务**: 首次本地跑 tools/ci-verify-sig.mjs 验证白名单 9/9 通过，并做双向回归（注入故障 → exit 1 → 恢复 → exit 0）
**主判据**: 绿灯 + 双向回归双向命中

---

## 1. Baseline 跑（0 故障）

```
$ node tools/ci-verify-sig.mjs
=== CI SIGNATURE VERIFICATION ===
✅ data/claims.json: OK (b3ccf2de2423...)
✅ data/hypothesis-cards.json: OK (e300f9f265de...)
✅ data/honesty-ledger.json: OK (f64a4a8ee700...)
✅ data/stance-f1-eval.json: OK (99b57f9fff9e...)
✅ data/extracted-claims.json: OK (8175172aaa08...)
✅ data/conflicts-v2-robot-parts.json: OK (21e23ea80954...)
✅ data/verification-runs/2026-10-16-all.json: OK (2560cf1f6ffc...)
✅ agent-ecosystem/agent-card.json: OK (d11660b99561...)
✅ agent-ecosystem/hypothesis-queue.json: OK (b1a53d414fa6...)

=== SUMMARY ===
OK: 9/9 | Failed: 0
audit log: data\signing-audit.jsonl
PASS gate: all signatures valid
exit=0
```

---

## 2. 故障注入

```bash
cp data/hypothesis-cards.json data/hypothesis-cards.json.bak
printf '\n' >> data/hypothesis-cards.json   # 追加 1 字节 → hash 变化
```

## 3. 故障态验证（HASH_MISMATCH → exit 1）

```
$ node tools/ci-verify-sig.mjs
=== CI SIGNATURE VERIFICATION ===
✅ data/claims.json: OK (b3ccf2de2423...)
❌ data/hypothesis-cards.json: HASH_MISMATCH
✅ data/honesty-ledger.json: OK (f64a4a8ee700...)
...
=== SUMMARY ===
OK: 8/9 | Failed: 1
audit log: data\signing-audit.jsonl
FAIL gate: 1 signature check(s) failed
exit=1
```

**关键验证**：
- 单字节追加即可触发 HASH_MISMATCH（sha256 敏感性）
- exit code = 1（阻塞 CI）
- 审计日志仍写入（保留失败记录）

---

## 4. 恢复 + 再验（exit 0）

```bash
mv data/hypothesis-cards.json.bak data/hypothesis-cards.json
node tools/ci-verify-sig.mjs
```

```
OK: 9/9 | Failed: 0
PASS gate: all signatures valid
exit=0
```

---

## 5. 双向回归总结

| 场景 | 状态 | exit code | 判定 |
|---|---|---|---|
| Baseline（无故障） | 9/9 OK | 0 | ✅ 绿灯 |
| 故障注入（1 字节追加） | 8/9 + 1 HASH_MISMATCH | 1 | ✅ 拦截 |
| 恢复后 | 9/9 OK | 0 | ✅ 绿灯 |

**双向回归 PASS**：绿灯 = 有效（注入故障能被拦截，恢复能被验证）

---

## 6. 白名单覆盖 9 产物

1. `data/claims.json` — 口径真源
2. `data/hypothesis-cards.json` — 940 张卡（本轮更新）
3. `data/honesty-ledger.json` — 诚实性账本（本轮更新）
4. `data/stance-f1-eval.json` — 立场 F1 评测
5. `data/extracted-claims.json` — 提取的 claim
6. `data/conflicts-v2-robot-parts.json` — 冲突检测 v2
7. `data/verification-runs/2026-10-16-all.json` — 验证运行记录
8. `agent-ecosystem/agent-card.json` — A2A Agent Card
9. `agent-ecosystem/hypothesis-queue.json` — 假设队列

**签名链 9/9 覆盖，白名单完整**。

---

## 7. 审计日志

`data/signing-audit.jsonl` 每次运行追加一行：

```json
{"ts":"2026-10-16T04:13:17.001Z","count":9,"ok":9,"failed":0}
{"ts":"2026-10-16T04:13:25.001Z","count":9,"ok":8,"failed":1}
{"ts":"2026-10-16T04:13:33.001Z","count":9,"ok":9,"failed":0}
```

append-only，保留完整运行历史。

---

## 8. 交付物

- `tools/ci-verify-sig.mjs` — 双向回归验证通过
- `data/signing-audit.jsonl` — 追加 3 行审计记录
- `reports/phase9-c-ci-bidirectional.md` — 本报告

---

## 9. 与 CI Workflow 的关系

`.github/workflows/ops-extra.yml` 的 `signverify` 任务每日 13:00 UTC 跑本脚本。本轮本地验证证明：

1. **绿灯有效**：9/9 OK 不是"跑通即通过"，而是"注入故障真的会被拦"
2. **审计追溯**：每次运行都写入 signing-audit.jsonl，事后可查

---

## 10. 血泪教训

Phase 8 收官时 M4 报告写"CI 9/9 PASS"，但没做双向回归。**绿灯不等于有效**。本轮补上：注入 1 字节就能证明 HASH_MISMATCH 能被 exit 1 拦截。这个门禁是"真门禁"，不是"跑通就绿"。
