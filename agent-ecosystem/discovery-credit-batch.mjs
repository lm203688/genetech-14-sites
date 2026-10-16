// agent-ecosystem/discovery-credit-batch.mjs
// Discovery Credit Batch - 发现信用批处理器
//
// 目标：把 P8-C 已 verified 的假设卡批量记入 honesty-ledger 的 discovery_credit
//       让「24 个真发现」从数据事实变成账本记录
//
// 使用：
//   node agent-ecosystem/discovery-credit-batch.mjs --apply
//   node agent-ecosystem/discovery-credit-batch.mjs --report

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CARDS_PATH = path.join(ROOT, 'data', 'hypothesis-cards.json');
const LEDGER_PATH = path.join(ROOT, 'data', 'honesty-ledger.json');

export function loadLedger() {
  if (fs.existsSync(LEDGER_PATH)) {
    try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8')); } catch {}
  }
  return null;
}

export function saveLedger(ledger) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

export function batchRecordVerified() {
  if (!fs.existsSync(CARDS_PATH)) return { error: 'hypothesis-cards.json not found' };
  const cards = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf-8'));
  const verifiedCards = cards.hypothesisCards.filter(c => c.status === 'verified');

  if (verifiedCards.length === 0) {
    return { applied: 0, note: 'no verified cards to record' };
  }

  let ledger = loadLedger();
  if (!ledger) {
    ledger = {
      version: '1.0.0',
      session_id: 'batch-' + Date.now().toString(36),
      session_started_at: new Date().toISOString(),
      abstention_stats: { total_queries: 0, abstained: 0, answered: 0, abstention_rate: 0 },
      hallucination_budget: { budget: 5, used: 0, remaining: 5, hard_cap: true, last_triggered_at: null },
      discovery_credit: { total_discoveries: 0, by_type: {}, verified_discoveries: 0 },
      claims_generated: 0, claims_verified: 0,
      events: [],
    };
  }

  const ts = new Date().toISOString();
  const recorded = [];

  for (const card of verifiedCards) {
    const event = {
      ts,
      event_type: 'discovery',
      tool: 'batch-discovery-credit',
      detail: `hypothesis-verified id=${card.id} conf=${card.confidence} type=${card.hypothesis_type}`,
      entity_id: null,
      claim_id: card.id,
    };
    ledger.events.push(event);

    // 记 discovery_credit
    ledger.discovery_credit.total_discoveries++;
    const type = card.hypothesis_type || 'general';
    ledger.discovery_credit.by_type[type] = (ledger.discovery_credit.by_type[type] || 0) + 1;

    // 已 verified 假设同时计入 verified_discoveries（保守：只算 verified 状态的卡）
    ledger.discovery_credit.verified_discoveries++;

    // claims_verified
    ledger.claims_verified++;

    recorded.push({ id: card.id, type, confidence: card.confidence });
  }

  if (ledger.events.length > 1000) ledger.events = ledger.events.slice(-1000);

  saveLedger(ledger);

  return {
    applied: recorded.length,
    discovered: ledger.discovery_credit.total_discoveries,
    verified: ledger.discovery_credit.verified_discoveries,
    byType: ledger.discovery_credit.by_type,
    recorded,
  };
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { cmd: 'report' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') opts.cmd = 'apply';
    else if (argv[i] === '--report') opts.cmd = 'report';
  }
  return opts;
}

function cmdApply() {
  const r = batchRecordVerified();
  if (r.error) { console.error('ERR', r.error); process.exit(1); }
  console.log('=== DISCOVERY CREDIT BATCH APPLY ===');
  console.log('applied: ' + r.applied);
  console.log('total_discoveries: ' + r.discovered);
  console.log('verified_discoveries: ' + r.verified);
  console.log('by_type: ' + JSON.stringify(r.byType));
}

function cmdReport() {
  const ledger = loadLedger();
  if (!ledger) { console.error('ledger not found'); process.exit(1); }
  const dc = ledger.discovery_credit || {};
  console.log('=== DISCOVERY CREDIT STATE ===');
  console.log('total_discoveries: ' + (dc.total_discoveries || 0));
  console.log('verified_discoveries: ' + (dc.verified_discoveries || 0));
  console.log('by_type: ' + JSON.stringify(dc.by_type || {}));
  console.log('claims_verified: ' + (ledger.claims_verified || 0));
  console.log('events count: ' + (ledger.events || []).length);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const opts = parseArgs();
  try {
    if (opts.cmd === 'apply') cmdApply();
    else cmdReport();
  } catch (e) {
    console.error('ERR', e.message);
    process.exit(1);
  }
}
