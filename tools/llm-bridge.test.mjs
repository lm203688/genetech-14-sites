#!/usr/bin/env node
/**
 * llm-bridge 冒烟测试
 * ----------------------------------------------------------------------------
 * 用法：
 *   node tools/llm-bridge.test.mjs                          # 配置缺失时报错退出
 *   LLM_BRIDGE_BASE=https://... LLM_BRIDGE_KEY=sk-... node tools/llm-bridge.test.mjs
 *   LLM_BRIDGE_BASE=... node tools/llm-bridge.test.mjs --json
 *
 * 行为：
 *   1. 校验配置（缺 base 直接退出 2）
 *   2. 调一次 chat() 问一个简单问题
 *   3. 打印模型输出、token 用量、耗时
 *   4. exit 0（成功）/ 1（HTTP 错误）/ 3（配置缺失）
 *
 * 注意：本脚本只用于本地/CI 验证是否接通，不写仓库，不会被生产路径调用。
 */
import process from 'node:process';
import path from 'node:path';
import { chat, complete, embed, jsonOut, isConfigured, loadConfig } from './lib/llm-bridge.mjs';

const wantJson = process.argv.includes('--json');
function out(obj) {
  if (wantJson) console.log(JSON.stringify(obj, null, 2));
  else console.log(obj);
}

const cfg = loadConfig();
if (!isConfigured(cfg)) {
  out({ ok: false, error: 'LLM_BRIDGE_BASE 未配置' });
  out({
    hint: '请设置环境变量或在 config/llm-bridge.local.json 中填入：',
    env: 'LLM_BRIDGE_BASE=https://your-llm-gateway.example.com/v1',
    file: path.join(process.cwd(), 'config', 'llm-bridge.local.json'),
  });
  process.exit(2);
}

out({ ok: true, step: 'config', base: cfg.base, model: cfg.model, embedModel: cfg.embedModel });

const t0 = Date.now();
const r = await chat(
  [
    { role: 'system', content: '你是测试机器人，用一句话简短回答。' },
    { role: 'user', content: '用一句话介绍 GeneTech 14 站知识引擎。' },
  ],
  { maxTokens: 120, temperature: 0.3 }
);
const dt = Date.now() - t0;

if (!r.ok) {
  out({ ok: false, step: 'chat', ms: dt, error: r.error, status: r.status });
  process.exit(1);
}
out({
  ok: true,
  step: 'chat',
  ms: dt,
  model: r.model,
  text: r.text,
  usage: r.usage,
});

// 嵌入冒烟（可选，失败不中断）
try {
  const e = await embed('GeneTech knowledge engine');
  if (e.ok) {
    out({
      ok: true,
      step: 'embed',
      dim: Array.isArray(e.vectors) ? e.vectors.length : (e.vectors?.length ?? 0),
      ms: e.ms,
    });
  } else {
    out({ ok: false, step: 'embed', error: e.error });
  }
} catch (e) {
  out({ ok: false, step: 'embed', error: String(e.message || e) });
}

out({ ok: true, step: 'done', totalMs: dt });
process.exit(0);