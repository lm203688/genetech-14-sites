// agent-ecosystem/hypothesis-feedback.mjs
// Hypothesis Feedback - 反馈回写器
//
// 目标：把 verifier 的判定回写到 hypothesis-cards.json 的 history + status
//       让假设卡从"生成的快照"升级为"有生命周期的对象"
//
// 使用：
//   node agent-ecosystem/hypothesis-feedback.mjs --apply data/verification-runs/2026-10-16-all.json
//   node agent-ecosystem/hypothesis-feedback.mjs --report

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CARDS_PATH = path.join(ROOT, 'data', 'hypothesis-cards.json');

const CARD_STATUS_MAP = {
  verified: 'verified',
  falsified: 'falsified',
  inconclusive: 'new', // inconclusive 保持 new（诚实弃权）
};

export function applyVerification(cardsPath, runPath) {
  if (!fs.existsSync(cardsPath)) return { error: 'cards not found: ' + cardsPath };
  if (!fs.existsSync(runPath)) return { error: 'run not found: ' + runPath };

  const cardsDoc = JSON.parse(fs.readFileSync(cardsPath, 'utf-8'));
  const run = JSON.parse(fs.readFileSync(runPath, 'utf-8'));

  const updated = [];
  const unchanged = [];
  const notFound = [];

  for (const r of run.results || []) {
    const card = cardsDoc.hypothesisCards.find(c => c.id === r.id);
    if (!card) { notFound.push(r.id); continue; }

    const newStatus = CARD_STATUS_MAP[r.decision] || card.status;
    const statusChanged = card.status !== newStatus;

    // 更新 evidence_status（只在 verified 时升级）
    let evidenceStatusChanged = false;
    if (r.decision === 'verified' && card.evidence_status !== 'supported') {
      card.evidence_status = 'supported';
      evidenceStatusChanged = true;
    } else if (r.decision === 'falsified' && card.evidence_status !== 'falsified') {
      card.evidence_status = 'falsified';
      evidenceStatusChanged = true;
    }

    // 更新 confidence（verified 提升，falsified 拉低）
    let confidenceChanged = false;
    const oldConf = card.confidence;
    if (r.decision === 'verified' && r.confidence > card.confidence) {
      card.confidence = Math.round(r.confidence * 1000) / 1000;
      confidenceChanged = true;
    } else if (r.decision === 'falsified') {
      card.confidence = Math.min(card.confidence, 0.2);
      confidenceChanged = true;
    }

    // 追加 history
    card.history = card.history || [];
    card.history.push({
      ts: r.verifiedAt,
      event: r.decision === 'verified' ? 'verified' : r.decision === 'falsified' ? 'falsified' : 'verification_inconclusive',
      actor: r.verifier,
      note: `decision=${r.decision} conf=${r.confidence} evidence=${(r.evidence || []).map(e => e.type).join(',')}`,
      verification_result: {
        decision: r.decision,
        confidence: r.confidence,
        calibration: r.confidence_calibration,
        evidence_types: (r.evidence || []).map(e => e.type),
        signals: r.signals,
      },
    });

    if (statusChanged) card.status = newStatus;

    if (statusChanged || confidenceChanged || evidenceStatusChanged) {
      updated.push({
        id: r.id,
        oldStatus: card.status,
        newStatus: newStatus,
        decision: r.decision,
        confidence: r.confidence,
        confidenceChanged: confidenceChanged,
        confidenceDelta: confidenceChanged ? card.confidence - oldConf : 0,
        evidenceStatusChanged,
      });
    } else {
      unchanged.push(r.id);
    }
  }

  // 更新 stats
  const byStatus = {};
  const byEvidenceStatus = {};
  let confSum = 0;
  for (const c of cardsDoc.hypothesisCards) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    byEvidenceStatus[c.evidence_status] = (byEvidenceStatus[c.evidence_status] || 0) + 1;
    confSum += c.confidence || 0;
  }
  cardsDoc.stats.byStatus = byStatus;
  cardsDoc.stats.byEvidenceStatus = byEvidenceStatus;
  cardsDoc.stats.avgConfidence = Math.round((confSum / cardsDoc.hypothesisCards.length) * 1000) / 1000;
  cardsDoc.stats.lastVerifiedAt = new Date().toISOString();
  cardsDoc.stats.verificationRunPath = runPath;

  fs.writeFileSync(cardsPath, JSON.stringify(cardsDoc, null, 2));

  return {
    applied: updated.length,
    unchanged: unchanged.length,
    notFound: notFound.length,
    updated,
    stats: cardsDoc.stats,
  };
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { cmd: 'report', run: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') { opts.cmd = 'apply'; opts.run = argv[++i]; }
    else if (argv[i] === '--report') opts.cmd = 'report';
  }
  return opts;
}

function cmdApply(runPath) {
  const result = applyVerification(CARDS_PATH, runPath);
  if (result.error) { console.error('ERR', result.error); process.exit(1); }
  console.log('=== FEEDBACK APPLY ===');
  console.log('applied: ' + result.applied + ' | unchanged: ' + result.unchanged + ' | notFound: ' + result.notFound);
  console.log('');
  console.log('Updated cards:');
  for (const u of result.updated.slice(0, 30)) {
    console.log('  ' + u.id + ' decision=' + u.decision + ' conf=' + u.confidence + (u.confidenceChanged ? ' (delta=' + u.confidenceDelta.toFixed(3) + ')' : ''));
  }
  console.log('');
  console.log('Stats after apply:');
  console.log('  byStatus: ' + JSON.stringify(result.stats.byStatus));
  console.log('  byEvidenceStatus: ' + JSON.stringify(result.stats.byEvidenceStatus));
  console.log('  avgConfidence: ' + result.stats.avgConfidence);
}

function cmdReport() {
  const cards = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf-8'));
  console.log('=== HYPOTHESIS CARDS STATE ===');
  console.log('total: ' + cards.stats.total);
  console.log('byStatus: ' + JSON.stringify(cards.stats.byStatus || {}));
  console.log('byEvidenceStatus: ' + JSON.stringify(cards.stats.byEvidenceStatus || {}));
  console.log('avgConfidence: ' + cards.stats.avgConfidence);
  if (cards.stats.lastVerifiedAt) console.log('lastVerifiedAt: ' + cards.stats.lastVerifiedAt);

  // history events 汇总
  const histEvents = {};
  for (const c of cards.hypothesisCards) {
    for (const h of (c.history || [])) {
      histEvents[h.event] = (histEvents[h.event] || 0) + 1;
    }
  }
  console.log('');
  console.log('History events: ' + JSON.stringify(histEvents));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const opts = parseArgs();
  try {
    if (opts.cmd === 'apply' && opts.run) cmdApply(opts.run);
    else cmdReport();
  } catch (e) {
    console.error('ERR', e.message);
    process.exit(1);
  }
}
