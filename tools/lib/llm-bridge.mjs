#!/usr/bin/env node
/**
 * llm-bridge.mjs — 14 站 AI 推理桥接层
 * ============================================================================
 * 把任意 OpenAI 兼容 LLM 端点封装成统一的 chat()/complete()/embed() 三个方法，
 * 供本仓库内的所有 AI 调用方使用（MCP ask、GEO 博客自动导读、静态页 chat、
 * 引用率探针等）。
 *
 * 设计原则
 * --------
 * 1. **接口中性**：本模块不依赖任何特定厂商/项目/域名。调用者只关心
 *    base / api key / model；底层用哪个端点由配置决定。
 * 2. **零硬编码**：所有可变项（base、key、model、超时、重试次数）都走
 *    loadConfig()，环境变量优先，配置文件兜底，默认值最末。
 * 3. **轻依赖**：仅用 Node 内置 fetch；不引入 OpenAI/Anthropic SDK。
 * 4. **可降级**：调用失败时返回结构化错误而非抛出，便于上层决定回退策略
 *    （例如 GEO 导读失败时回到模板字符串，MCP ask 失败时提示用户改用
 *    semantic_search）。
 * 5. **可观测**：每次调用都打印一行结构化日志（base 末段、model、耗时、
 *    token 数、是否降级），便于排查调用情况而不暴露敏感信息。
 *
 * 配置（优先级：env > config/llm-bridge.local.json > config/llm-bridge.json）
 *   LLM_BRIDGE_BASE         必填，OpenAI 兼容端点根 URL，例如 https://api.openai.com/v1
 *                           注意：路径需包含 /v1（或兼容端点等价前缀）
 *   LLM_BRIDGE_KEY          可选；本地/无鉴权端点可留空
 *   LLM_BRIDGE_MODEL        默��模型名（chat 模型）
 *   LLM_BRIDGE_EMBED_MODEL  默认嵌入模型名（向量检索用，可选）
 *   LLM_BRIDGE_TIMEOUT_MS   单次请求超时，默认 30000
 *   LLM_BRIDGE_RETRIES      失败重试次数，默认 2
 *
 * 使用示例
 *   import { chat, loadConfig, isConfigured } from './lib/llm-bridge.mjs';
 *   if (!isConfigured()) return { content: [{ type: 'text', text: 'AI 推理未配置' }] };
 *   const r = await chat([{ role: 'user', content: '用一句话介绍量子纠缠' }]);
 *   if (r.ok) console.log(r.text); else console.error(r.error);
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// ============================================================================
// 配置加载（env > local > 默认）
// ============================================================================

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

export function loadConfig(overrides = {}) {
  const localCfg = readJsonSafe(path.join(PROJECT_ROOT, 'config', 'llm-bridge.local.json'));
  const repoCfg = readJsonSafe(path.join(PROJECT_ROOT, 'config', 'llm-bridge.json'));
  const cfg = {
    base: process.env.LLM_BRIDGE_BASE || localCfg.base || repoCfg.base || '',
    apiKey: process.env.LLM_BRIDGE_KEY || localCfg.apiKey || repoCfg.apiKey || '',
    model: process.env.LLM_BRIDGE_MODEL || localCfg.model || repoCfg.model || 'gpt-4o-mini',
    embedModel:
      process.env.LLM_BRIDGE_EMBED_MODEL ||
      localCfg.embedModel ||
      repoCfg.embedModel ||
      'text-embedding-3-small',
    timeoutMs: parseInt(
      process.env.LLM_BRIDGE_TIMEOUT_MS || localCfg.timeoutMs || repoCfg.timeoutMs || '30000',
      10
    ),
    retries: parseInt(
      process.env.LLM_BRIDGE_RETRIES || localCfg.retries || repoCfg.retries || '2',
      10
    ),
    ...overrides,
  };
  return cfg;
}

export function isConfigured(cfg = loadConfig()) {
  return Boolean(cfg.base);
}

// ============================================================================
// 内部：HTTP 调用（带超时、重试、日志）
// ============================================================================

function logLine(obj) {
  const safe = { ...obj };
  if (safe.apiKey) safe.apiKey = '***';
  console.error('[llm-bridge]', JSON.stringify(safe));
}

function baseFor(pathname) {
  const cfg = loadConfig();
  const base = (cfg.base || '').replace(/\/+$/, '');
  if (!base) throw new Error('LLM_BRIDGE_BASE 未配置');
  return base + pathname;
}

async function callWithRetry(method, pathname, body, cfg) {
  let lastErr = null;
  const tries = Math.max(1, cfg.retries + 1);
  for (let i = 0; i < tries; i += 1) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      const res = await fetch(baseFor(pathname), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const dt = Date.now() - t0;
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        lastErr = { ok: false, status: res.status, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
        logLine({ method, pathname, attempt: i + 1, ms: dt, status: res.status, error: 'non_2xx' });
        // 4xx 不重试；5xx 重试
        if (res.status >= 400 && res.status < 500) return lastErr;
      } else {
        const json = await res.json().catch(() => ({}));
        logLine({
          method,
          pathname,
          attempt: i + 1,
          ms: dt,
          status: 200,
          tokens: json.usage?.total_tokens || null,
        });
        return { ok: true, status: 200, data: json, ms: dt };
      }
    } catch (e) {
      clearTimeout(timer);
      const dt = Date.now() - t0;
      lastErr = { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
      logLine({ method, pathname, attempt: i + 1, ms: dt, error: lastErr.error });
    }
  }
  return lastErr;
}

// ============================================================================
// 对外 API：chat() / embed()
// ============================================================================

/**
 * 通用对话补全。
 * @param {Array<{role:'system'|'user'|'assistant', content:string}>} messages
 * @param {object} opts
 *   - model: 覆盖默认模型
 *   - temperature: 0-1
 *   - maxTokens: 单次最大输出 token
 *   - stop: 停止词
 *   - responseFormat: 'text' | 'json_object'
 *   - cfg: 直接传入 loadConfig() 结果
 * @returns {Promise<{ok:true, text:string, usage:object, ms:number} | {ok:false, status:number, error:string}>}
 */
export async function chat(messages, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  if (!isConfigured(cfg)) {
    return { ok: false, status: 0, error: 'LLM_BRIDGE_BASE 未配置，请在环境变量或 config/llm-bridge.local.json 中设置。' };
  }
  const body = {
    model: opts.model || cfg.model,
    messages,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.4,
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...(opts.stop ? { stop: opts.stop } : {}),
    ...(opts.responseFormat ? { response_format: { type: opts.responseFormat } } : {}),
  };
  const r = await callWithRetry('POST', '/chat/completions', body, cfg);
  if (!r.ok) return r;
  const choice = r.data.choices?.[0];
  return {
    ok: true,
    text: choice?.message?.content || '',
    usage: r.data.usage || {},
    ms: r.ms,
    model: r.data.model || body.model,
  };
}

/**
 * 便捷方法：单轮 user → assistant。
 * @param {string} userPrompt
 * @param {string} systemPrompt
 */
export async function complete(userPrompt, systemPrompt = '', opts = {}) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });
  return chat(messages, opts);
}

/**
 * 文本嵌入（OpenAI 兼容端点的 /embeddings）。
 * @param {string|string[]} input
 * @param {object} opts
 */
export async function embed(input, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  if (!isConfigured(cfg)) {
    return { ok: false, status: 0, error: 'LLM_BRIDGE_BASE 未配置' };
  }
  const body = {
    model: opts.model || cfg.embedModel,
    input: Array.isArray(input) ? input : [input],
  };
  const r = await callWithRetry('POST', '/embeddings', body, cfg);
  if (!r.ok) return r;
  const vectors = (r.data.data || []).map((d) => d.embedding);
  return {
    ok: true,
    vectors: Array.isArray(input) ? vectors : vectors[0],
    usage: r.data.usage || {},
    ms: r.ms,
  };
}

/**
 * 结构化输出便捷方法：强制模型返回 JSON，附带 Zod-like 兜底解析。
 * @param {string} userPrompt
 * @param {object} schema  简易 schema 描述，仅用于日志与提示
 * @param {string} systemPrompt
 */
export async function jsonOut(userPrompt, schema = {}, systemPrompt = '') {
  const sys = [
    systemPrompt,
    '严格输出合法 JSON 对象。不要用 markdown 代码块包裹，不要加任何解释文字。',
    schema.description ? `字段说明：${schema.description}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const r = await complete(userPrompt, sys, { responseFormat: 'json_object', temperature: 0.2 });
  if (!r.ok) return r;
  let parsed;
  try {
    // 兼容模型偶尔包 ```json ... ``` 的小毛病
    const m = r.text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : r.text);
  } catch (e) {
    return { ok: false, status: 0, error: 'json_parse_failed', raw: r.text };
  }
  return { ok: true, data: parsed, ms: r.ms, usage: r.usage };
}

// ============================================================================
// 默认导出（兼容 require('llm-bridge') 的写法）
// ============================================================================

export default { loadConfig, isConfigured, chat, complete, embed, jsonOut };