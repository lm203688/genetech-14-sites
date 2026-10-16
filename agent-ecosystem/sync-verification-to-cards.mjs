#!/usr/bin/env node
// agent-ecosystem/sync-verification-to-cards.mjs — Phase 10 验证结果回写
//
// 目的：把最新 verification-runs/ 里的验证结果同步回 hypothesis-cards.json
//       让 discovery-credit-batch 能读到新 verified/falsified 状态
//
// 输入：data/verification-runs/YYYY-MM-DD-v2-run.json（最新一份）
// 输出：更新 data/hypothesis-cards.json 中的 status / evidence_status / verified_at / verifier
//
// 使用：
//   node agent-ecosystem/sync-verification-to-cards.mjs
//   node agent-ecosystem/sync-verification-to-cards.mjs --from <path>

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CARDS_PATH = path.join(ROOT, 'data', 'hypothesis-cards.json');
const RUNS_DIR = path.join(ROOT, 'data', 'verification-runs');

function findLatestRun() {
  if (!fs.existsSync(RUNS_DIR)) return null;
  const files = fs.readdirSync(RUNS_DIR)
    .filter(f => f.includes('-v2-run.json'))
    .sort();
  return files.length ? path.join(RUNS_DIR, files[files.length - 1]) : null;
}

function sync({ fromPath } = {}) {
  const runPath = fromPath || findLatestRun();
  if (!runPath || !fs.existsSync(runPath)) {
    return { error: 'no verification run found', checked: findLatestRun() };
  }

  const run = JSON.parse(fs.readFileSync(runPath, 'utf-8'));
  const results = run.results || [];
  if (results.length === 0) return { error: 'run has no results', runPath };

  if (!fs.existsSync(CARDS_PATH)) return { error: 'hypothesis-cards.json not found' };
  const cardsFile = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf-8'));
  const byId = new Map(cardsFile.hypothesisCards.map(c => [c.id, c]));

  let updated = 0;
  const newVerified = [];
  const newFalsified = [];
  const unchanged = [];

  for (const r of results) {
    const card = byId.get(r.id);
    if (!card) continue;
    const prev = card.status || 'new';

    if (r.decision === 'verified') {
      if (prev !== 'verified') {
        card.status = 'verified';
        card.evidence_status = 'supported';
        card.confidence = Math.max(card.confidence || 0, r.confidence);
        card.confidence_calibration = r.confidence_calibration || 'statistical-signal';
        card.verified_at = r.verifiedAt;
        card.verifier = r.verifier;
        card.evidence = r.evidence || [];
        newVerified.push(r.id);
        updated++;
      }
    } else if (r.decision === 'falsified') {
      if (prev !== 'falsified') {
        card.status = 'falsified';
        card.evidence_status = 'contradicted';
        card.falsified_at = r.verifiedAt;
        card.verifier = r.verifier;
        card.evidence = r.evidence || [];
        newFalsified.push(r.id);
        updated++;
      }
    } else {
      // inconclusive：保持原状（不覆盖 evidence_status）
      unchanged.push(r.id);
    }
  }

  // 更新 stats
  const byStatus = {};
  const byEvidence = {};
  for (const c of cardsFile.hypothesisCards) {
    byStatus[c.status || 'new'] = (byStatus[c.status || 'new'] || 0) + 1;
    byEvidence[c.evidence_status || 'hypothesis_only'] = (byEvidence[c.evidence_status || 'hypothesis_only'] || 0) + 1;
  }
  cardsFile.stats = cardsFile.stats || {};
  cardsFile.stats.byStatus = byStatus;
  cardsFile.stats.byEvidenceStatus = byEvidence;
  cardsFile.stats.lastVerifiedAt = new Date().toISOString();
  cardsFile.stats.verificationRunPath = path.relative(ROOT, runPath);
  cardsFile.stats.verified = byStatus.verified || 0;
  cardsFile.stats.falsified = byStatus.falsified || 0;

  fs.writeFileSync(CARDS_PATH, JSON.stringify(cardsFile, null, 2));

  return {
    runPath,
    targetsProcessed: results.length,
    updated,
    newVerified: newVerified.length,
    newFalsified: newFalsified.length,
    unchanged: unchanged.length,
    byStatus,
    byEvidenceStatus: byEvidence,
  };
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { fromPath: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') opts.fromPath = argv[++i];
  }
  return opts;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const opts = parseArgs();
  try {
    const r = sync(opts);
    if (r.error) { console.error('ERR', r.error, r.checked ? `checked=${r.checked}` : ''); process.exit(1); }
    console.log('=== SYNC VERIFICATION TO CARDS ===');
    console.log('run:', path.relative(ROOT, r.runPath));
    console.log('targets:', r.targetsProcessed);
    console.log('updated:', r.updated);
    console.log('  newVerified:', r.newVerified);
    console.log('  newFalsified:', r.newFalsified);
    console.log('  unchanged (inconclusive):', r.unchanged);
    console.log('byStatus:', JSON.stringify(r.byStatus));
    console.log('byEvidenceStatus:', JSON.stringify(r.byEvidenceStatus));
  } catch (e) {
    console.error('ERR', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}
