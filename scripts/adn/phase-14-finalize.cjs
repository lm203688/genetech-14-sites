#!/usr/bin/env node
/**
 * Phase 14.5 — 最终交付
 * ===================
 *
 * 从 hypotheses/v1 中筛出「所有引用 DOI 都真实在库里」的假设卡，
 * 作为「证据可复现」的最终交付版本。
 *
 * 严格口径：
 *   - 每张卡的 supportingEvidences + citedDoiInAbstract 中的 DOI
 *   - 必须全部在库（doi → 实体有映射）
 *   - 否则排除
 *
 * 这是 Phase 14 的诚实收敛：宁可少 64% 的卡（-1025），也不给一张没证据的。
 *
 * 输出：
 *   - ADN-hypotheses-v1-finalized.jsonl    (strict 版，699 张)
 *   - ADN-hypotheses-v1-finalized-summary.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'data');

const hypPath = path.join(OUT_DIR, 'hypotheses.jsonl');
const libPath = path.join(OUT_DIR, 'library-entries.json');

function loadLibraryIndex(lib) {
  const doiToEntity = new Map();
  for (const e of lib) {
    if (e.DOI) {
      const k = String(e.DOI).trim().toLowerCase();
      if (!doiToEntity.has(k)) doiToEntity.set(k, e.id);
    }
  }
  return doiToEntity;
}

function main() {
  console.log('Phase 14.5 — Finalize with evidence verification\n');
  console.log('Loading data...');
  const lib = JSON.parse(fs.readFileSync(libPath, 'utf8'));
  const doiToEntity = loadLibraryIndex(lib);
  console.log(`  library DOIs indexed: ${doiToEntity.size.toLocaleString()}`);

  const hyps = [];
  const lines = fs.readFileSync(hypPath, 'utf8').split(/\r?\n/).filter(l => l.trim());
  for (const l of lines) {
    try { hyps.push(JSON.parse(l)); } catch {}
  }
  console.log(`  hypotheses loaded: ${hyps.length.toLocaleString()}\n`);

  const kept = [];
  const dropped = { noEvidence: 0, evidenceNotInLibrary: 0, allMissing: 0 };
  const realDoiCount = new Set();

  for (const h of hyps) {
    const allDois = [
      ...(h.supportingEvidences || []).map(e => e.doi).filter(Boolean),
      ...(h.citedDoiInAbstract || [])
    ];

    if (allDois.length === 0) { dropped.noEvidence++; continue; }

    const inLib = allDois.filter(d => doiToEntity.has(String(d).trim().toLowerCase()));
    if (inLib.length === 0) { dropped.allMissing++; continue; }
    if (inLib.length < allDois.length) { dropped.evidenceNotInLibrary++; continue; }

    inLib.forEach(d => realDoiCount.add(String(d).trim().toLowerCase()));
    kept.push(h);
  }

  console.log('=== Kept (strict — all evidence in library) ===');
  console.log(`  hypotheses:     ${kept.length.toLocaleString()} / ${hyps.length.toLocaleString()}  (${(kept.length/hyps.length*100).toFixed(1)}%)`);
  console.log(`  unique real DOIs: ${realDoiCount.size.toLocaleString()} / ${doiToEntity.size.toLocaleString()}`);

  console.log('\n=== Dropped ===');
  console.log(`  no evidence:                ${dropped.noEvidence.toLocaleString()}`);
  console.log(`  evidence not in library:    ${dropped.evidenceNotInLibrary.toLocaleString()}`);
  console.log(`  all DOI missing from lib:   ${dropped.allMissing.toLocaleString()}`);

  // Write strict JSONL
  const outPath = path.join(OUT_DIR, 'hypotheses-v1-finalized.jsonl');
  const out = kept.map(h => JSON.stringify(h)).join('\n') + '\n';
  fs.writeFileSync(outPath, out);
  console.log(`\n✅ Wrote ${outPath}`);

  // Write summary
  const summary = {
    generatedAt: new Date().toISOString(),
    policy: 'strict-all-evidence-in-library',
    source: 'hypotheses.jsonl',
    totalHypotheses: hyps.length,
    kept: kept.length,
    dropped: {
      noEvidence: dropped.noEvidence,
      evidenceNotInLibrary: dropped.evidenceNotInLibrary,
      allMissing: dropped.allMissing,
    },
    realDoiCount: realDoiCount.size,
    libraryDoiCount: doiToEntity.size,
    libraryDoiCoveragePct: +(realDoiCount.size / doiToEntity.size * 100).toFixed(2),
    verification: {
      method: 'each hypothesis\'s DOIs all cross-checked against library-entries.json',
      rule: 'keep only if every DOI in supportingEvidences+citedDoiInAbstract exists in library',
      rationale: 'avoid presenting unverified claims as evidence-backed',
    },
  };
  const sumPath = path.join(OUT_DIR, 'hypotheses-v1-finalized-summary.json');
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2));
  console.log(`✅ Wrote ${sumPath}`);

  // Also copy as main deliverable (keep hypotheses.jsonl as full v1)
  const finalDeliverablePath = path.join(OUT_DIR, 'ADN-hypotheses-v1.jsonl');
  fs.writeFileSync(finalDeliverablePath, out);
  console.log(`✅ Wrote ${finalDeliverablePath} (final deliverable)`);

  console.log('\n=== Phase 14 最终交付 ===');
  console.log(`  ${kept.length} 张卡 · 每张证据真实 · ${realDoiCount.size} 个真 DOI`);
}

main();
