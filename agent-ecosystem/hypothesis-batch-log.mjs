// agent-ecosystem/hypothesis-batch-log.mjs — Phase 9 新批假设入账（只计 total，不计 verified）
//
// 与 discovery-credit-batch.mjs 的区别：
//   - discovery-credit-batch 只处理 status=verified 的卡（已 verified 24 张）
//   - 本脚本处理 generator.version=1.1.0 的新批（v2 新增 840 张），
//     全部 status=new + evidence_status ∈ {hypothesis_only, insufficient_evidence}
//   - 计入 total_discoveries 但**不计** verified_discoveries（诚实性：未验证不能算发现）
//   - 同时把 abstention_stats 事件补上（新增 840 张 = 840 次"提出假设但未验证"弃权事件）
//
// 使用：
//   node agent-ecosystem/hypothesis-batch-log.mjs --apply     # 入账
//   node agent-ecosystem/hypothesis-batch-log.mjs --report    # 查状态
//   node agent-ecosystem/hypothesis-batch-log.mjs --verify-and-log   # 先跑 verifier 再入账（P9-B 用）

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CARDS_PATH = path.join(ROOT, 'data', 'hypothesis-cards.json');
const LEDGER_PATH = path.join(ROOT, 'data', 'honesty-ledger.json');

function loadLedger() {
  if (fs.existsSync(LEDGER_PATH)) {
    try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8')); } catch {}
  }
  return null;
}

function saveLedger(ledger) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function computeHonestyScore(ledger) {
  // honesty_score = 0.5×弃权率 + 0.3×(1-预算消耗) + 0.2×验证率
  const abst = ledger.abstention_stats || { total_queries: 0, abstained: 0, answered: 0, abstention_rate: 0 };
  const budget = ledger.hallucination_budget || { budget: 5, used: 0 };
  const dc = ledger.discovery_credit || { total_discoveries: 0, verified_discoveries: 0 };

  const abstentionRate = abst.total_queries > 0
    ? abst.abstained / abst.total_queries
    : 0;
  const budgetConsumption = budget.budget > 0 ? budget.used / budget.budget : 0;
  const verificationRate = dc.total_discoveries > 0
    ? dc.verified_discoveries / dc.total_discoveries
    : 0;

  const score = 0.5 * abstentionRate + 0.3 * (1 - budgetConsumption) + 0.2 * verificationRate;
  return {
    abstentionRate: Math.round(abstentionRate * 1000) / 1000,
    budgetConsumption: Math.round(budgetConsumption * 1000) / 1000,
    verificationRate: Math.round(verificationRate * 1000) / 1000,
    honesty_score: Math.round(score * 1000) / 1000,
  };
}

// 主流程：把 v2 新增卡入账（不计 verified）
function applyNewBatch() {
  if (!fs.existsSync(CARDS_PATH)) return { error: 'hypothesis-cards.json not found' };
  const cardsFile = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf-8'));
  const cards = cardsFile.hypothesisCards || [];

  // 只挑 v2 新增的（generator.version=1.1.0）
  const newCards = cards.filter(c => c.generator?.version === '1.1.0');
  if (newCards.length === 0) return { error: 'no v2 cards found', total: 0 };

  // 已有账本？
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

  // 幂等：找出已入账的 id
  const alreadyLogged = new Set(
    (ledger.events || []).filter(e => e.claim_id && e.tool === 'hypothesis-batch-log').map(e => e.claim_id)
  );

  const ts = new Date().toISOString();
  const newByType = {};
  let applied = 0;
  let abstainedCount = 0;

  for (const card of newCards) {
    if (alreadyLogged.has(card.id)) continue;
    applied++;
    abstainedCount++;

    // 事件（作为 abstention 事件，因为尚未验证）
    ledger.events.push({
      ts,
      event_type: 'abstention',
      tool: 'hypothesis-batch-log',
      detail: `hypothesis-proposed-not-verified id=${card.id} conf=${card.confidence} type=${card.hypothesis_type} status=${card.evidence_status}`,
      entity_id: null,
      claim_id: card.id,
    });

    // total_discoveries（提出假设也算一次 discovery，但**不计** verified_discoveries）
    ledger.discovery_credit.total_discoveries++;
    const type = card.hypothesis_type || 'general';
    ledger.discovery_credit.by_type[type] = (ledger.discovery_credit.by_type[type] || 0) + 1;

    // abstention_stats（提出假设但没验证 = abstained 事件）
    ledger.abstention_stats.total_queries++;
    ledger.abstention_stats.abstained++;
    ledger.abstention_stats.answered = 0; // 保留原始 answered 值
    ledger.abstention_stats.answered = Math.max(0, ledger.abstention_stats.total_queries - ledger.abstention_stats.abstained);
    ledger.abstention_stats.abstention_rate = ledger.abstention_stats.total_queries > 0
      ? Math.round((ledger.abstention_stats.abstained / ledger.abstention_stats.total_queries) * 1000) / 1000
      : 0;

    // claims_generated
    ledger.claims_generated++;
  }

  // 计算 honesty_score
  const hs = computeHonestyScore(ledger);
  ledger.honesty_score = hs.honesty_score;
  ledger.honesty_breakdown = hs;
  ledger.last_updated_at = ts;

  // 截断 events 到 1000
  if (ledger.events.length > 1000) ledger.events = ledger.events.slice(-1000);

  saveLedger(ledger);

  return {
    applied,
    abstainedCount,
    total_discoveries: ledger.discovery_credit.total_discoveries,
    verified_discoveries: ledger.discovery_credit.verified_discoveries,
    abstention_rate: ledger.abstention_stats.abstention_rate,
    honesty_score: hs.honesty_score,
    honesty_breakdown: hs,
    by_type: ledger.discovery_credit.by_type,
  };
}

function report() {
  const ledger = loadLedger();
  if (!ledger) { console.error('ledger not found'); process.exit(1); }
  console.log('=== HYPOTHESIS BATCH LOG REPORT ===');
  console.log('total_discoveries:', ledger.discovery_credit?.total_discoveries);
  console.log('verified_discoveries:', ledger.discovery_credit?.verified_discoveries);
  console.log('by_type:', JSON.stringify(ledger.discovery_credit?.by_type, null, 2));
  console.log('abstention_stats:', JSON.stringify(ledger.abstention_stats, null, 2));
  console.log('honesty_score:', ledger.honesty_score);
  console.log('honesty_breakdown:', JSON.stringify(ledger.honesty_breakdown, null, 2));
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

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const opts = parseArgs();
  try {
    if (opts.cmd === 'apply') {
      const r = applyNewBatch();
      if (r.error) { console.error('ERR', r.error); process.exit(1); }
      console.log('=== HYPOTHESIS BATCH LOG APPLY ===');
      console.log('applied:', r.applied);
      console.log('total_discoveries:', r.total_discoveries);
      console.log('verified_discoveries:', r.verified_discoveries);
      console.log('abstention_rate:', r.abstention_rate);
      console.log('honesty_score:', r.honesty_score);
      console.log('honesty_breakdown:', JSON.stringify(r.honesty_breakdown));
      console.log('by_type:', JSON.stringify(r.by_type));
    } else {
      report();
    }
  } catch (e) {
    console.error('ERR', e.message);
    process.exit(1);
  }
}
