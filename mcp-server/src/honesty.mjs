// mcp-server/src/honesty.mjs
// Honesty Ledger Bridge - 幻觉预算接入 MCP
//
// 目标：MCP 每次工具调用 → 记 honesty-ledger 账本
//       预算耗尽时提供结构化 abstention_response
//
// 设计：不侵入现有 registerTool 的 13 处调用点，提供装饰器 withLedger()
//       让上层按需包裹工具 handler；未包裹的路径保持原样，不影响现有 MCP 兼容性。
//
// 使用：
//   import { withLedger, checkBudget, getLedger } from './honesty.mjs';
//   server.registerTool('name', { ... }, withLedger('name', async (args) => { ... }));
//
// 使用示例（CLI）：
//   node mcp-server/src/honesty.mjs --check
//   node mcp-server/src/honesty.mjs --record query
//   node mcp-server/src/honesty.mjs --reset-budget

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const LEDGER_PATH = path.join(ROOT, 'data', 'honesty-ledger.json');

const TOOL_NAMES = new Set([
  'list_sites', 'list_entities', 'search_entities', 'get_entity',
  'get_related', 'get_citations', 'analyze_gaps', 'generate_hypothesis',
  'ask', 'run_pipeline', 'get_health', 'export_citations', 'submit_request',
  'request_status',
]);

export function loadLedger() {
  if (fs.existsSync(LEDGER_PATH)) {
    try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8')); } catch {}
  }
  return {
    version: '1.0.0',
    session_id: 'mcp-' + Date.now().toString(36),
    session_started_at: new Date().toISOString(),
    abstention_stats: { total_queries: 0, abstained: 0, answered: 0, abstention_rate: 0 },
    hallucination_budget: { budget: 5, used: 0, remaining: 5, hard_cap: true, last_triggered_at: null },
    discovery_credit: { total_discoveries: 0, by_type: {}, verified_discoveries: 0 },
    claims_generated: 0,
    claims_verified: 0,
    events: [],
  };
}

export function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function recomputeStats(ledger) {
  const a = ledger.abstention_stats;
  a.abstention_rate = a.total_queries > 0 ? Math.round((a.abstained / a.total_queries) * 1000) / 1000 : 0;
  const h = ledger.hallucination_budget;
  h.remaining = h.budget - h.used;
}

export function recordEvent(type, { tool = null, detail = null, entity_id = null, claim_id = null } = {}) {
  const ledger = loadLedger();
  const ts = new Date().toISOString();
  ledger.events.push({ ts, event_type: type, tool, detail, entity_id, claim_id });
  if (ledger.events.length > 1000) ledger.events = ledger.events.slice(-1000);

  switch (type) {
    case 'query': ledger.abstention_stats.total_queries++; break;
    case 'answer':
      ledger.abstention_stats.answered++;
      ledger.claims_generated++;
      break;
    case 'abstain':
      ledger.abstention_stats.abstained++;
      break;
    case 'hallucination_detected':
      if (ledger.hallucination_budget.used < ledger.hallucination_budget.budget) {
        ledger.hallucination_budget.used++;
        ledger.hallucination_budget.last_triggered_at = ts;
      }
      break;
    case 'discovery':
      ledger.discovery_credit.total_discoveries++;
      if (tool) ledger.discovery_credit.by_type[tool] = (ledger.discovery_credit.by_type[tool] || 0) + 1;
      break;
    case 'verification_passed':
      ledger.claims_verified++;
      ledger.discovery_credit.verified_discoveries++;
      break;
    case 'verification_failed': break;
    case 'budget_reset':
      ledger.hallucination_budget.used = 0;
      ledger.hallucination_budget.last_triggered_at = null;
      break;
  }
  recomputeStats(ledger);
  saveLedger(ledger);
  return ledger;
}

export function checkBudget() {
  const ledger = loadLedger();
  const remaining = ledger.hallucination_budget.remaining;
  const hardCap = ledger.hallucination_budget.hard_cap;
  return {
    remaining,
    hardCap,
    exhausted: hardCap && remaining <= 0,
    abstentionRate: ledger.abstention_stats.abstention_rate,
    budget: ledger.hallucination_budget.budget,
    used: ledger.hallucination_budget.used,
  };
}

export function abstentionResponse(reason = 'hallucination_budget_exhausted') {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'abstained',
        reason,
        message: 'GeneTech MCP 已达到本轮幻觉预算上限（5 次）。为保证诚实性，本轮不再回答。请重置预算或等待人工审阅。',
        abstention_code: 'BUDGET_EXHAUSTED',
        honesty_ledger: 'data/honesty-ledger.json',
      }),
    }],
    _abstained: true,
    _reason: reason,
  };
}

/**
 * 装饰器：把 MCP 工具 handler 包一层诚实性记账。
 * @param {string} toolName  工具名
 * @param {(args:any) => any} handler  原始 handler
 * @returns {(args:any) => Promise<any>}  包装后的 handler
 */
export function withLedger(toolName, handler) {
  return async function wrappedHandler(args) {
    // 预算耗尽时拒答
    const budget = checkBudget();
    if (budget.exhausted) {
      recordEvent('abstain', { tool: toolName, detail: 'budget-exhausted' });
      return abstentionResponse('hallucination_budget_exhausted');
    }

    // 记账：query
    recordEvent('query', { tool: toolName });

    // 执行原始 handler
    const t0 = Date.now();
    try {
      const result = await handler(args);
      const ms = Date.now() - t0;
      recordEvent('answer', { tool: toolName, detail: `ms=${ms}` });
      return result;
    } catch (err) {
      const ms = Date.now() - t0;
      recordEvent('abstain', { tool: toolName, detail: `error=${err.message.slice(0, 100)}` });
      throw err;
    }
  };
}

// ============== CLI ==============

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'check';
  if (cmd === 'check' || argv.includes('--check')) {
    const b = checkBudget();
    console.log(JSON.stringify({
      ledger: 'data/honesty-ledger.json',
      budget: b.budget, used: b.used, remaining: b.remaining,
      exhausted: b.exhausted, hardCap: b.hardCap,
      abstentionRate: b.abstentionRate,
      toolSet: [...TOOL_NAMES],
    }, null, 2));
  } else if (cmd === 'record' || argv.includes('--record')) {
    const type = argv[argv.indexOf('--record') + 1] || 'query';
    const ledger = recordEvent(type, {});
    console.log('recorded: ' + type);
    console.log('remaining: ' + ledger.hallucination_budget.remaining);
  } else if (cmd === 'reset-budget' || argv.includes('--reset-budget')) {
    const ledger = recordEvent('budget_reset', {});
    console.log('budget reset: remaining=' + ledger.hallucination_budget.remaining);
  } else {
    console.error('Usage: node mcp-server/src/honesty.mjs [--check|--record <type>|--reset-budget]');
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
