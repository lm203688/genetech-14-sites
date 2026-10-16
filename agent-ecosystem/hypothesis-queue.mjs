// agent-ecosystem/hypothesis-queue.mjs
// Hypothesis Queue - 假设队列调度器
//
// 目标：把 data/hypothesis-cards.json 里的假设卡按优先级排队
//       状态机: new -> queued -> in_progress -> (verified | falsified | abandoned)
//
// 排序键：
//   priority = confidence * 0.5 + (falsification_time_horizon 短加分) + (shared_tags 多加分)
//
// 使用：
//   node agent-ecosystem/hypothesis-queue.mjs --status
//   node agent-ecosystem/hypothesis-queue.mjs --dequeue 5
//   node agent-ecosystem/hypothesis-queue.mjs --update <hyp-id> --to in_progress
//   node agent-ecosystem/hypothesis-queue.mjs --report

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CARDS_PATH = path.join(ROOT, 'data', 'hypothesis-cards.json');
const QUEUE_PATH = path.join(ROOT, 'agent-ecosym', 'hypothesis-queue.json');
const QUEUE_PATH2 = path.join(ROOT, 'agent-ecosystem', 'hypothesis-queue.json');

const VALID_STATUSES = ['new', 'queued', 'in_progress', 'verified', 'falsified', 'abandoned', 'expired'];
const TERMINAL = new Set(['verified', 'falsified', 'abandoned', 'expired']);

export function loadCards() {
  if (!fs.existsSync(CARDS_PATH)) return [];
  const d = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf-8'));
  return d.hypothesisCards || [];
}

export function loadQueue() {
  for (const p of [QUEUE_PATH2, QUEUE_PATH]) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
  return { version: '1.0.0', createdAt: new Date().toISOString(), entries: {}, history: [] };
}

export function saveQueue(queue) {
  fs.mkdirSync(path.dirname(QUEUE_PATH2), { recursive: true });
  queue.updatedAt = new Date().toISOString();
  fs.writeFileSync(QUEUE_PATH2, JSON.stringify(queue, null, 2));
}

export function computePriority(card) {
  // confidence 权重 0.5
  let p = (card.confidence || 0) * 0.5;

  // 证伪时间越短越优先（14 天 = 0.15 加分）
  const th = card.falsifiability?.falsification_time_horizon_days;
  if (th) {
    if (th <= 7) p += 0.15;
    else if (th <= 14) p += 0.10;
    else if (th <= 30) p += 0.05;
  }

  // 共享 tag 越多越优先
  const tagCount = (card.source_signals?.shared_tags || []).length;
  p += Math.min(0.15, tagCount * 0.03);

  // 类型加权：新兴主题略高
  const t = card.hypothesis_type;
  if (t === 'emerging_topic') p += 0.05;
  else if (t === 'conflict_detector') p += 0.08;

  return Math.min(1.0, Math.round(p * 1000) / 1000);
}

export function initQueue() {
  const cards = loadCards();
  const existing = loadQueue();
  for (const card of cards) {
    if (existing.entries[card.id]) continue;
    existing.entries[card.id] = {
      id: card.id,
      status: 'queued',
      priority: computePriority(card),
      enqueuedAt: new Date().toISOString(),
      type: card.hypothesis_type,
      confidence: card.confidence,
    };
    existing.history.push({ ts: new Date().toISOString(), event: 'enqueued', id: card.id });
  }
  saveQueue(existing);
  return existing;
}

export function statusSummary(queue) {
  const byStatus = {};
  const byType = {};
  for (const e of Object.values(queue.entries)) {
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    byType[e.type] = (byType[e.type] || 0) + 1;
  }
  return { total: Object.keys(queue.entries).length, byStatus, byType };
}

export function dequeue(queue, n = 5) {
  const sorted = Object.values(queue.entries)
    .filter(e => e.status === 'queued')
    .sort((a, b) => b.priority - a.priority)
    .slice(0, n);
  return sorted.map(e => ({ ...e }));
}

export function transition(queue, id, to, note = '') {
  if (!VALID_STATUSES.includes(to)) throw new Error('Invalid status: ' + to);
  const e = queue.entries[id];
  if (!e) throw new Error('Not found: ' + id);
  const from = e.status;
  e.status = to;
  e.transitionedAt = new Date().toISOString();
  if (to === 'in_progress') e.startedAt = e.transitionedAt;
  if (TERMINAL.has(to)) e.endedAt = e.transitionedAt;
  e.history = e.history || [];
  e.history.push({ ts: e.transitionedAt, from, to, note });
  queue.history.push({ ts: e.transitionedAt, event: 'transition', id, from, to, note });
  saveQueue(queue);
  return e;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { cmd: 'status', n: 5, id: null, to: null, note: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status') opts.cmd = 'status';
    else if (a === '--dequeue') opts.cmd = 'dequeue';
    else if (a === '--update') { opts.cmd = 'update'; opts.id = argv[++i]; }
    else if (a === '--to') opts.to = argv[++i];
    else if (a === '--note') opts.note = argv[++i];
    else if (a === '--n' || a === '--limit') opts.n = parseInt(argv[++i]);
    else if (a === '--init') opts.cmd = 'init';
    else if (a === '--report') opts.cmd = 'report';
  }
  return opts;
}

function cmdStatus(queue) {
  const s = statusSummary(queue);
  console.log('=== HYPOTHESIS QUEUE STATUS ===');
  console.log('total: ' + s.total);
  console.log('byStatus: ' + JSON.stringify(s.byStatus));
  console.log('byType: ' + JSON.stringify(s.byType));
}

function cmdDequeue(queue, n) {
  const items = dequeue(queue, n);
  console.log('Top ' + items.length + ' queued hypotheses:');
  for (const it of items) {
    console.log('  ' + it.id + ' priority=' + it.priority.toFixed(3) + ' type=' + it.type + ' conf=' + (it.confidence || 0).toFixed(3));
  }
}

function cmdInit() {
  const queue = initQueue();
  const s = statusSummary(queue);
  console.log('Initialized queue with ' + s.total + ' entries');
  console.log('byStatus: ' + JSON.stringify(s.byStatus));
}

function cmdUpdate(opts) {
  if (!opts.id || !opts.to) {
    console.error('Usage: --update <id> --to <status> [--note "text"]');
    process.exit(1);
  }
  const queue = loadQueue();
  const e = transition(queue, opts.id, opts.to, opts.note || '');
  console.log('OK ' + opts.id + ': ' + JSON.stringify({ status: e.status, transitionedAt: e.transitionedAt }));
}

function cmdReport(queue) {
  const s = statusSummary(queue);
  const byAge = {};
  for (const e of Object.values(queue.entries)) {
    const age = (new Date() - new Date(e.enqueuedAt)) / 86400000;
    const bucket = age < 1 ? '<1d' : age < 7 ? '1-7d' : age < 30 ? '7-30d' : '30d+';
    byAge[bucket] = (byAge[bucket] || 0) + 1;
  }
  console.log('=== WEEKLY HYPOTHESIS REPORT ===');
  console.log('generated_at: ' + new Date().toISOString());
  console.log('total: ' + s.total);
  console.log('byStatus: ' + JSON.stringify(s.byStatus));
  console.log('byType: ' + JSON.stringify(s.byType));
  console.log('byEnqueueAge: ' + JSON.stringify(byAge));

  const newCount = s.byStatus.new || 0;
  const verified = s.byStatus.verified || 0;
  const falsified = s.byStatus.falsified || 0;
  const closed = verified + falsified;
  console.log('');
  console.log('New this cycle: ' + newCount);
  console.log('Verified: ' + verified);
  console.log('Falsified: ' + falsified);
  console.log('Closed (verified+falsified): ' + closed);
  console.log('M3 gate: closed >= 20? ' + (closed >= 20 ? 'PASS' : 'PENDING (' + closed + '/20)'));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const opts = parseArgs();
  const queue = loadQueue();
  try {
    if (opts.cmd === 'init') cmdInit();
    else if (opts.cmd === 'dequeue') cmdDequeue(queue, opts.n);
    else if (opts.cmd === 'update') cmdUpdate(opts);
    else if (opts.cmd === 'report') cmdReport(queue);
    else cmdStatus(queue);
  } catch (e) {
    console.error('ERR', e.message);
    process.exit(1);
  }
}
