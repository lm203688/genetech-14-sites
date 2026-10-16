#!/usr/bin/env node
// tools/hallucination-budget.mjs — 诚实性层：幻觉预算账本 + 弃权统计
//
// 用途：给 AI Agent 提供一个可查询的账本，回答"我在这个 session 里已经用了多少幻觉预算"
//
// 用法:
//   node tools/hallucination-budget.mjs status                          # 查询当前状态
//   node tools/hallucination-budget.mjs record --type query|answer|abstain|hallucination_detected|discovery --detail "..."
//   node tools/hallucination-budget.mjs reset --budget 10               # 重置预算
//   node tools/hallucination-budget.mjs verify <claim-text>             # 用规则做一次 sanity check
//
// 三条硬原则：
//   1. 弃权优先：query 无充分证据 → 拒答，不消耗预算
//   2. 幻觉预算硬顶：超预算后必须拒答，硬顶不软化
//   3. 发现信用：每次真实发现（discovery）+1

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LEDGER_PATH = path.join(ROOT, 'data', 'honesty-ledger.json');
const DEFAULT_BUDGET = 5;

function loadLedger() {
  if (fs.existsSync(LEDGER_PATH)) {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8'));
  }
  return newLedger();
}

function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function newLedger(budget = DEFAULT_BUDGET) {
  return {
    version: '1.0.0',
    session_id: crypto.randomUUID().slice(0, 8),
    session_started_at: new Date().toISOString(),
    abstention_stats: { total_queries: 0, abstained: 0, answered: 0, abstention_rate: 0 },
    hallucination_budget: { budget, used: 0, remaining: budget, hard_cap: true, last_triggered_at: null },
    discovery_credit: { total_discoveries: 0, by_type: {}, verified_discoveries: 0 },
    claims_generated: 0,
    claims_verified: 0,
    events: [],
  };
}

function recordEvent(ledger, type, detail, entity_id, claim_id) {
  const ev = { ts: new Date().toISOString(), event_type: type, detail };
  if (entity_id) ev.entity_id = entity_id;
  if (claim_id) ev.claim_id = claim_id;
  ledger.events.push(ev);

  switch (type) {
    case 'query':
      ledger.abstention_stats.total_queries++;
      break;
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
        ledger.hallucination_budget.remaining--;
        ledger.hallucination_budget.last_triggered_at = ev.ts;
      } else {
        console.warn(`⚠ 幻觉预算已耗尽（${ledger.hallucination_budget.budget}），后续应拒答`);
      }
      break;
    case 'discovery':
      ledger.discovery_credit.total_discoveries++;
      const dt = ev.detail?.discoveryType || 'general';
      ledger.discovery_credit.by_type[dt] = (ledger.discovery_credit.by_type[dt] || 0) + 1;
      break;
    case 'verification_passed':
      ledger.claims_verified++;
      break;
  }

  ledger.abstention_stats.abstention_rate = ledger.abstention_stats.total_queries
    ? Math.round((ledger.abstention_stats.abstained / ledger.abstention_stats.total_queries) * 10000) / 10000
    : 0;
  ledger.honesty_score = Math.round((
    0.5 * ledger.abstention_stats.abstention_rate +
    0.3 * (1 - ledger.hallucination_budget.used / ledger.hallucination_budget.budget) +
    0.2 * (ledger.claims_generated ? ledger.claims_verified / ledger.claims_generated : 0)
  ) * 1000) / 1000;
  return ev;
}

function status(ledger) {
  const { abstention_stats, hallucination_budget, discovery_credit, honesty_score } = ledger;
  const budgetUsedPct = Math.round((hallucination_budget.used / hallucination_budget.budget) * 100);
  const output = {
    session_id: ledger.session_id,
    session_started_at: ledger.session_started_at,
    honesty_score,
    abstention: {
      total_queries: abstention_stats.total_queries,
      abstained: abstention_stats.abstained,
      answered: abstention_stats.answered,
      abstention_rate: abstention_stats.abstention_rate,
    },
    hallucination_budget: {
      budget: hallucination_budget.budget,
      used: hallucination_budget.used,
      remaining: hallucination_budget.remaining,
      used_pct: budgetUsedPct,
      hard_cap: hallucination_budget.hard_cap,
      exhausted: hallucination_budget.used >= hallucination_budget.budget,
    },
    discovery_credit: discovery_credit,
    claims: {
      generated: ledger.claims_generated,
      verified: ledger.claims_verified,
    },
    events_count: ledger.events.length,
    last_events: ledger.events.slice(-5),
  };
  return output;
}

function canAnswer(ledger) {
  return ledger.hallucination_budget.remaining > 0;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { cmd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'status') opts.cmd = 'status';
    else if (a === 'record') {
      opts.cmd = 'record';
      i++;
      const typeArg = argv[i];
      if (typeArg && typeArg.startsWith('--type=')) opts.type = typeArg.split('=')[1];
    } else if (a === '--type') opts.type = argv[++i];
    else if (a === '--detail') opts.detail = argv[++i];
    else if (a === '--entity') opts.entity = argv[++i];
    else if (a === 'reset') {
      opts.cmd = 'reset';
      i++;
      if (argv[i] && argv[i].startsWith('--budget=')) opts.budget = parseInt(argv[i].split('=')[1]);
    } else if (a === '--budget') opts.budget = parseInt(argv[++i]);
  }
  return opts;
}

const opts = parseArgs();
const ledger = loadLedger();

if (opts.cmd === 'status' || !opts.cmd) {
  console.log(JSON.stringify(status(ledger), null, 2));
} else if (opts.cmd === 'record') {
  if (!opts.type) {
    console.error('✗ 需要 --type=<query|answer|abstain|hallucination_detected|discovery|verification_passed>');
    process.exit(1);
  }
  const ev = recordEvent(ledger, opts.type, { detail: opts.detail, discoveryType: opts.detail }, opts.entity);
  saveLedger(ledger);
  console.log(JSON.stringify({
    recorded: ev,
    honesty_score: ledger.honesty_score,
    budget_remaining: ledger.hallucination_budget.remaining,
    can_answer: canAnswer(ledger),
  }, null, 2));
} else if (opts.cmd === 'reset') {
  const fresh = newLedger(opts.budget || DEFAULT_BUDGET);
  saveLedger(fresh);
  console.log(`✓ 已重置账本，session=${fresh.session_id}, budget=${fresh.hallucination_budget.budget}`);
} else {
  console.error(`未知命令: ${opts.cmd}`);
  process.exit(1);
}
