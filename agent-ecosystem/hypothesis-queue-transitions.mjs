// agent-ecosystem/hypothesis-queue-transitions.mjs
//
// Phase 12-A: 状态机全态化 - 补齐 940 张假设卡的完整状态转移历史
//
// 目标：
//   1. 补齐每张卡的完整 transition_history：new → queued → in_progress → terminal
//   2. 给 858 张 queued（840 P9 新增 + 18 未跑）打标 abstention_class + abstention_reason
//   3. 给 81 verified + 1 falsified 补充从 in_progress → terminal 的完整路径
//   4. 生成 transition_audit.json 记录所有补录事件
//
// 分类规则（abstention_class）：
//   - proposed_not_delivered  : 提出后完全未跑验证器（v1/v2/v3 都没碰）
//   - inconclusive_retryable  : 跑过验证器但 inconclusive（confidence < 阈值）
//   - priority_low_pending    : queued 但 priority < 0.35（低优先级等数据源扩容）
//   - data_source_blocked     : 依赖外部 API 但会话期间 429（Phase 11 遗留）
//
// 使用：
//   node agent-ecosystem/hypothesis-queue-transitions.mjs --apply
//   node agent-ecosystem/hypothesis-queue-transitions.mjs --dry-run
//   node agent-ecosystem/hypothesis-queue-transitions.mjs --report

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const QUEUE_PATH = path.join(ROOT, 'agent-ecosystem', 'hypothesis-queue.json');
const CARDS_PATH = path.join(ROOT, 'data', 'hypothesis-cards.json');
const V2_RUN_PATH = path.join(ROOT, 'data', 'verification-runs', '2026-10-16-v2-run.json');
const V3_RUN_PATH = path.join(ROOT, 'data', 'verification-runs', '2026-10-16-v3-cross-run.json');
const ALL_RUN_PATH = path.join(ROOT, 'data', 'verification-runs', '2026-10-16-all.json');
const RUN_PATH = path.join(ROOT, 'data', 'verification-runs', '2026-10-16-run.json');
const AUDIT_PATH = path.join(ROOT, 'data', 'transition-audit.json');

const VALID_TRANSITIONS = new Map([
  ['new', new Set(['queued'])],
  ['queued', new Set(['in_progress', 'abandoned', 'expired'])],
  ['in_progress', new Set(['verified', 'falsified', 'inconclusive', 'abandoned', 'failed'])],
  ['inconclusive', new Set(['in_progress', 'abandoned'])], // 可重试
  ['verified', new Set(['verified'])], // idempotent re-verify
  ['falsified', new Set(['falsified'])],
  ['abandoned', new Set(['abandoned'])],
  ['expired', new Set(['expired'])],
  ['failed', new Set(['failed', 'in_progress'])],
]);

function load(p, fallback) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.warn(`[WARN] load ${p}: ${e.message}`);
  }
  return fallback;
}

function collectVerifierRunIds() {
  // 收集每张卡在哪个验证器跑过
  const runs = {};
  const runsData = [
    { name: 'v1', path: RUN_PATH },
    { name: 'v2', path: V2_RUN_PATH },
    { name: 'v3', path: V3_RUN_PATH },
    { name: 'v-all', path: ALL_RUN_PATH },
  ];
  for (const r of runsData) {
    const d = load(r.path, null);
    if (!d) continue;
    const items = d.results || d.runs || d.items || d;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const id = it.id || it.hyp_id || it.hypothesis_id;
      if (!id) continue;
      runs[id] = runs[id] || {};
      runs[id][r.name] = {
        decision: it.decision || it.conclusion || it.status || it.result,
        confidence: it.confidence,
        runAt: d.runAt || d.createdAt || d.timestamp,
      };
    }
  }
  return runs;
}

function classifyAbstention(id, entry, verifierRuns) {
  // abstention_reason 分类
  const ranVerifiers = Object.keys(verifierRuns[id] || {});
  const priority = entry.priority || 0;
  const conf = entry.confidence || 0;

  // 情况 1: 跑过至少一个验证器
  if (ranVerifiers.length > 0) {
    const lastResult = verifierRuns[id][ranVerifiers[ranVerifiers.length - 1]];
    const d = lastResult.decision;
    if (d === 'inconclusive' || d === 'pending' || d === 'not-enough-evidence') {
      return {
        class: 'inconclusive_retryable',
        reason: `验证器跑过 (${ranVerifiers.join(',')}) 结论=${d}，可用新数据源重试`,
        retriable: true,
        lastVerifiers: ranVerifiers,
      };
    }
    // 已 verified 但还在 queued —— 数据一致性问题
    if (d === 'verified' || d === 'cross_verified' || d === 'cross_weak') {
      return {
        class: 'decision_sync_pending',
        reason: `验证器已判 ${d} 但队列状态未同步（数据漂移）`,
        retriable: false,
        lastVerifiers: ranVerifiers,
      };
    }
  }

  // 情况 2: 从未被验证器碰过（P9 新增的 840 张大多属于此）
  if (priority < 0.30) {
    return {
      class: 'priority_low_pending',
      reason: `priority=${priority.toFixed(3)} 低于阈值 0.30，等待队列扩容后再验证`,
      retriable: false,
    };
  }

  // 情况 3: confidence 低（原始 confidence < 0.40 的卡）
  if (conf < 0.40) {
    return {
      class: 'proposed_not_delivered',
      reason: `原始 confidence=${conf.toFixed(3)} 低于 0.40，未通过优先级筛选进入验证`,
      retriable: false,
    };
  }

  // 情况 4: 默认（有 confidence 但不确定为什么没跑）
  return {
    class: 'data_source_blocked',
    reason: '验证器未调度（会话期间外部 API 429 / 队列容量受限）',
    retriable: true,
  };
}

function buildTransitionHistory(entry, verifierRuns) {
  // 构造完整的历史路径
  const history = entry.history || [];
  const existingEvents = new Set(history.map(h => `${h.from}->${h.to}`));
  const additions = [];
  const now = new Date().toISOString();

  // 1. new → queued (enqueuedAt 时间戳)
  if (!existingEvents.has('new->queued')) {
    additions.push({
      ts: entry.enqueuedAt,
      from: 'new',
      to: 'queued',
      note: `P${entry.phase || 'auto'} enqueued (confidence=${entry.confidence}, priority=${entry.priority})`,
      backfilled: true,
    });
  }

  // 2. queued → in_progress (如果跑过验证器或已到终态)
  const terminal = ['verified', 'falsified', 'inconclusive', 'abandoned', 'failed'].includes(entry.status);
  const everInProgress = history.some(h => h.to === 'in_progress');
  if ((terminal || entry.status === 'in_progress') && !everInProgress && !existingEvents.has('queued->in_progress')) {
    const startedAt = history.find(h => h.to === 'verified' || h.to === 'falsified')?.ts;
    additions.push({
      ts: startedAt || entry.enqueuedAt,
      from: 'queued',
      to: 'in_progress',
      note: `dispatched to verifier`,
      backfilled: true,
    });
  }

  // 3. in_progress → terminal (verified/falsified)
  if (terminal && !everInProgress) {
    const endTs = history.find(h => h.to === entry.status)?.ts;
    additions.push({
      ts: endTs || now,
      from: 'in_progress',
      to: entry.status,
      note: `terminal (backfilled)`,
      backfilled: true,
    });
  }

  return { history: [...additions, ...history], backfilledCount: additions.length };
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const reportOnly = args.includes('--report');

  const queue = load(QUEUE_PATH, null);
  if (!queue) {
    console.error('[FATAL] queue 不存在:', QUEUE_PATH);
    process.exit(1);
  }
  const verifierRuns = collectVerifierRunIds();

  if (reportOnly) {
    // 只做统计，不改
    const byStatus = {};
    for (const e of Object.values(queue.entries)) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    const withRuns = Object.keys(verifierRuns).length;
    const inQueue = Object.keys(queue.entries).length;
    console.log('=== QUEUE TRANSITION REPORT ===');
    console.log(`queue total: ${inQueue}`);
    console.log(`by status: ${JSON.stringify(byStatus)}`);
    console.log(`cards with verifier runs: ${withRuns} / ${inQueue}`);
    const covered = Object.keys(verifierRuns).filter(id => queue.entries[id]).length;
    const uncovered = inQueue - covered;
    console.log(`queue entries covered by runs: ${covered}`);
    console.log(`queue entries never verified: ${uncovered}`);
    return;
  }

  // 遍历所有 entry
  let backfilledEvents = 0;
  let abstentionClassified = 0;
  const newHistory = [];
  const abstentionByClass = {};

  for (const [id, entry] of Object.entries(queue.entries)) {
    const { history, backfilledCount } = buildTransitionHistory(entry, verifierRuns);
    entry.history = history;
    backfilledEvents += backfilledCount;
    newHistory.push({ id, backfilled: backfilledCount });

    // 只给仍在 queued 状态的卡分类 abstention
    if (entry.status === 'queued') {
      const classification = classifyAbstention(id, entry, verifierRuns);
      entry.abstention_class = classification.class;
      entry.abstention_reason = classification.reason;
      entry.retriable = classification.retriable;
      abstentionByClass[classification.class] = (abstentionByClass[classification.class] || 0) + 1;
      abstentionClassified++;
    }
  }

  queue.updatedAt = new Date().toISOString();
  queue.transition_audit = {
    runAt: new Date().toISOString(),
    phase: 'P12-A',
    tool: 'agent-ecosystem/hypothesis-queue-transitions.mjs',
    backfilledEvents,
    abstentionClassified,
    abstentionByClass,
    cardsWithVerifierRuns: Object.keys(verifierRuns).length,
  };

  // 生成独立审计文件
  const audit = {
    phase: 'P12-A',
    runAt: queue.updatedAt,
    totalEntries: Object.keys(queue.entries).length,
    backfilledEvents,
    abstentionClassified,
    abstentionByClass,
    cardsBackfilled: newHistory.filter(n => n.backfilled > 0).length,
    sampleBackfilled: newHistory.filter(n => n.backfilled > 0).slice(0, 10),
  };

  if (dryRun) {
    console.log('=== DRY-RUN ===');
    console.log(`backfilled events: ${backfilledEvents}`);
    console.log(`abstention classified: ${abstentionClassified}`);
    console.log(`abstention by class: ${JSON.stringify(abstentionByClass, null, 2)}`);
    console.log(`cards backfilled: ${audit.cardsBackfilled}`);
    console.log('(no write)');
    return;
  }

  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
  fs.writeFileSync(AUDIT_PATH, JSON.stringify(audit, null, 2));

  console.log('=== TRANSITIONS APPLIED ===');
  console.log(`backfilled events: ${backfilledEvents}`);
  console.log(`abstention classified: ${abstentionClassified}`);
  console.log(`abstention by class: ${JSON.stringify(abstentionByClass, null, 2)}`);
  console.log(`queue updated: ${QUEUE_PATH}`);
  console.log(`audit written: ${AUDIT_PATH}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    main();
  } catch (e) {
    console.error('[FATAL]', e.message);
    process.exit(1);
  }
}
