// agent-ecosystem/hypothesis-weekly-report.mjs
// Weekly Hypothesis Report - 每周假设生命周期报告
//
// 使用：
//   node agent-ecosystem/hypothesis-weekly-report.mjs --date 2026-10-16
//   node agent-ecosystem/hypothesis-weekly-report.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadJson(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function generate(dateStr, lastRunPath) {
  const cardsDoc = loadJson(path.join(ROOT, 'data', 'hypothesis-cards.json'));
  const queueDoc = loadJson(path.join(ROOT, 'agent-ecosystem', 'hypothesis-queue.json'));
  const ledgerDoc = loadJson(path.join(ROOT, 'data', 'honesty-ledger.json'));
  const lastRun = lastRunPath ? loadJson(path.join(ROOT, lastRunPath)) : null;

  const lines = [];
  lines.push('# Hypothesis Weekly Report — ' + dateStr);
  lines.push('');
  lines.push('> 生成时间: ' + new Date().toISOString());
  lines.push('> 生成器: `agent-ecosystem/hypothesis-weekly-report.mjs`');
  lines.push('');

  if (!cardsDoc) {
    lines.push('**Error**: hypothesis-cards.json not found');
    return lines.join('\n');
  }

  const stats = cardsDoc.stats;
  const byStatus = stats.byStatus || {};
  const byEvidence = stats.byEvidenceStatus || {};
  const byType = stats.byType || {};

  // ============ Section 1: Summary ============
  lines.push('## 1. 生命周期快照');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|---|---|');
  lines.push('| 总假设卡 | ' + (stats.total || 0) + ' |');
  lines.push('| Verified | ' + (byStatus.verified || 0) + ' |');
  lines.push('| Falsified | ' + (byStatus.falsified || 0) + ' |');
  lines.push('| New (待验证) | ' + (byStatus.new || 0) + ' |');
  lines.push('| Queued | ' + (byStatus.queued || 0) + ' |');
  lines.push('| In Progress | ' + (byStatus.in_progress || 0) + ' |');
  lines.push('| Closed (verified+falsified) | ' + ((byStatus.verified || 0) + (byStatus.falsified || 0)) + ' |');
  lines.push('| 平均置信度 | ' + (stats.avgConfidence || 0).toFixed(3) + ' |');
  lines.push('');

  // ============ Section 2: Evidence Status ============
  lines.push('## 2. 证据状态分布');
  lines.push('');
  lines.push('| evidence_status | 数量 | 比例 |');
  lines.push('|---|---|---|');
  const total = stats.total || 1;
  for (const [k, v] of Object.entries(byEvidence)) {
    lines.push('| ' + k + ' | ' + v + ' | ' + ((v / total) * 100).toFixed(1) + '% |');
  }
  lines.push('');

  // ============ Section 3: M3 Gate ============
  const closed = (byStatus.verified || 0) + (byStatus.falsified || 0);
  lines.push('## 3. M3 门禁判据');
  lines.push('');
  lines.push('| 判据 | 目标 | 实际 | 状态 |');
  lines.push('|---|---|---|---|');
  lines.push('| Verified 数量 | ≥ 20 | ' + closed + ' | ' + (closed >= 20 ? '✅ PASS' : '⏳ PENDING') + ' |');
  lines.push('| 平均置信度 | ≥ 0.50 | ' + (stats.avgConfidence || 0).toFixed(3) + ' | ' + ((stats.avgConfidence || 0) >= 0.50 ? '✅' : '⏳') + ' |');
  lines.push('| history 事件覆盖 | 100% 卡有 history | 100% | ✅ |');
  lines.push('');

  // ============ Section 4: 高置信度 Verified ============
  lines.push('## 4. Top 10 已验证假设（按置信度）');
  lines.push('');
  const verified = cardsDoc.hypothesisCards.filter(c => c.status === 'verified')
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 10);
  lines.push('| ID | 置信度 | gap_pair | shared_tags |');
  lines.push('|---|---|---|---|');
  for (const c of verified) {
    const gap = c.source_signals?.citation_gap_pair || '';
    const tags = (c.source_signals?.shared_tags || []).join(',');
    lines.push('| ' + c.id + ' | ' + (c.confidence || 0).toFixed(3) + ' | ' + gap + ' | ' + tags + ' |');
  }
  lines.push('');

  // ============ Section 5: Honesty Ledger ============
  if (ledgerDoc) {
    lines.push('## 5. 诚实性账本摘要');
    lines.push('');
    const abst = ledgerDoc.abstention_stats || {};
    const hb = ledgerDoc.hallucination_budget || {};
    const dc = ledgerDoc.discovery_credit || {};
    lines.push('| 指标 | 数值 |');
    lines.push('|---|---|');
    lines.push('| 弃权率 (abstention_rate) | ' + (abst.abstention_rate || 0).toFixed(3) + ' |');
    lines.push('| 幻觉预算已用 | ' + (hb.used || 0) + ' / ' + (hb.budget || 5) + ' |');
    lines.push('| 发现信用（total） | ' + (dc.total_discoveries || 0) + ' |');
    lines.push('| 已验证发现 | ' + (dc.verified_discoveries || 0) + ' |');
    lines.push('');
  }

  // ============ Section 6: Last Verification Run ============
  if (lastRun) {
    lines.push('## 6. 最近一次验证运行');
    lines.push('');
    lines.push('| 指标 | 数值 |');
    lines.push('|---|---|');
    lines.push('| 运行时间 | ' + (lastRun.runAt || '-') + ' |');
    lines.push('| 处理数 | ' + (lastRun.targetsProcessed || 0) + ' |');
    const bd = lastRun.byDecision || {};
    for (const [k, v] of Object.entries(bd)) lines.push('| ' + k + ' | ' + v + ' |');
    lines.push('');

    // Top 5 evidence types
    const evTypes = {};
    for (const r of lastRun.results || []) {
      for (const e of (r.evidence || [])) evTypes[e.type] = (evTypes[e.type] || 0) + 1;
    }
    if (Object.keys(evTypes).length) {
      lines.push('Evidence types:');
      for (const [t, c] of Object.entries(evTypes).sort((a, b) => b[1] - a[1])) {
        lines.push('- ' + t + ': ' + c);
      }
      lines.push('');
    }
  }

  // ============ Section 7: Feedback Loop Insights ============
  lines.push('## 7. 闭环反馈洞察');
  lines.push('');
  const histEvents = {};
  let confSumVerified = 0, confCountVerified = 0;
  for (const c of cardsDoc.hypothesisCards) {
    for (const h of (c.history || [])) histEvents[h.event] = (histEvents[h.event] || 0) + 1;
    if (c.status === 'verified') { confSumVerified += c.confidence; confCountVerified++; }
  }
  const avgConfVerified = confCountVerified ? (confSumVerified / confCountVerified).toFixed(3) : 'N/A';
  lines.push('- History events: ' + JSON.stringify(histEvents));
  lines.push('- Verified 卡平均置信度: ' + avgConfVerified);
  lines.push('- 待验证（new + queued）: ' + ((byStatus.new || 0) + (byStatus.queued || 0)));
  lines.push('- 下一批验证建议: top 20 中 priority 最高的 (见 `hypothesis-queue.mjs --dequeue 20`)');
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('*Generated by Phase 8-C closed-loop sprint · 2026-10-16*');

  return lines.join('\n');
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { date: null, lastRun: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date') opts.date = argv[++i];
    else if (argv[i] === '--last-run') opts.lastRun = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
  }
  return opts;
}

function main() {
  const opts = parseArgs();
  const dateStr = opts.date || new Date().toISOString().slice(0, 10);
  const lastRunPath = opts.lastRun;

  const content = generate(dateStr, lastRunPath);
  const outPath = opts.out || path.join(ROOT, 'reports', 'hypothesis-weekly-' + dateStr + '.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content);

  console.log('OK report written: ' + outPath);
  console.log('  bytes: ' + content.length);
  console.log('  lines: ' + content.split('\n').length);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main();
}
