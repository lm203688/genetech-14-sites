#!/usr/bin/env node
// tools/gap-baseline-crossref.mjs
//
// Purpose: T3.3 zero-citation pair false-negative baseline against an external,
//          independent corpus — implemented with Crossref REST API, which
//          requires NO API key (report §4 explicitly permits this fallback when
//          OpenAlex key is unavailable).
//
// Two-step probe per citing DOI:
//   1. /works/{doi}           → is the DOI known to Crossref at all?
//   2. /works/{doi}/references → does Crossref have the paper's reference list?
//
// This matters because a 404 on /references means "DOI exists but its
// reference list is not indexed", NOT "citation does not exist". Conflating
// those two produces a false impression of validation success. The output
// reports coverage at each layer separately.
//
// Output: reports/gap-baseline-crossref-<date>.json
// Env: PAIRS_SAMPLE, DOI_PER_PAIR, DELAY_MS, CROSSREF_UA, CROSSREF_TIMEOUT_MS

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const USER_AGENT = process.env.CROSSREF_UA ||
  'GeneTech-Research/1.0 (gap-baseline-crossref; https://lm203688.github.io/genetech-14-sites; research@genetech.tools)';
const PAIRS_SAMPLE = Number(process.env.PAIRS_SAMPLE || 10);
const DOI_PER_PAIR = Number(process.env.DOI_PER_PAIR || 5);
const DELAY_MS = Number(process.env.DELAY_MS || 250);
const TIMEOUT_MS = Number(process.env.CROSSREF_TIMEOUT_MS || 30000);
const SAMPLE_ONLY = process.argv.includes('--sample-only');
const DRY_RUN = process.argv.includes('--dry-run');

function loadJSON(rel) { return JSON.parse(fs.readFileSync(path.resolve(ROOT, rel), 'utf8')); }
function exists(rel) { return fs.existsSync(path.resolve(ROOT, rel)); }

function loadSiteDoIs(site) {
  const rel = `${site}/website/api/entities.json`;
  if (!exists(rel)) return [];
  const arr = loadJSON(rel);
  const entities = Array.isArray(arr) ? arr : (arr.entities || []);
  const out = [];
  for (const e of entities) {
    const d = (e && (e.doi || e.DOI) || '').toString().toLowerCase().trim();
    if (d && /^10\./.test(d)) out.push(d);
  }
  return out;
}

function httpGet(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      timeout: TIMEOUT_MS
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', e => resolve({ status: 0, body: Buffer.from(JSON.stringify({ error: e.message })), netError: e.message }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ status: 0, body: Buffer.from(JSON.stringify({ error: 'timeout' })), netError: 'timeout' }); });
  });
}

// Outcome values:
//   'doi_unknown'        — /works/{doi} returned 404; Crossref has no record of this DOI.
//   'refs_not_indexed'   — /works/{doi} returned 200 but /works/{doi}/references returned 404;
//                          the paper exists in Crossref but its reference list is not populated.
//   'refs_indexed'       — /works/{doi}/references returned 200 with a list of cited DOIs.
//   'api_error'          — any other status, network error, timeout, or JSON parse failure.
async function probe(doi) {
  const doiEnc = encodeURIComponent(doi).replace(/%2F/gi, '/');
  const work = await httpGet(`https://api.crossref.org/works/${doiEnc}`);
  if (work.status === 404) return { outcome: 'doi_unknown', status: 404, refs: [], doiExists: false };
  if (work.status !== 200) return { outcome: 'api_error', status: work.status, refs: [], doiExists: null, body: work.body.toString('utf8').slice(0, 200) };

  const ref = await httpGet(`https://api.crossref.org/works/${doiEnc}/references`);
  if (ref.status === 200) {
    try {
      const j = JSON.parse(ref.body.toString('utf8'));
      const items = (j.message?.items || []).map(it => (it.DOI || '').toString().toLowerCase().trim()).filter(Boolean);
      return { outcome: 'refs_indexed', status: 200, refs: items, doiExists: true, reportedTotal: j.message?.total-results ?? items.length };
    } catch (e) {
      return { outcome: 'api_error', status: 200, refs: [], doiExists: true, error: e.message };
    }
  }
  if (ref.status === 404) return { outcome: 'refs_not_indexed', status: 404, refs: [], doiExists: true };
  return { outcome: 'api_error', status: ref.status, refs: [], doiExists: true, body: ref.body.toString('utf8').slice(0, 200) };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const startedAt = new Date().toISOString();
  const gaps = loadJSON('data/citation-gaps.json');
  const gapPairs = [...(gaps.gapPairs || [])].sort((a, b) => (b.combinedSize || 0) - (a.combinedSize || 0));
  const picked = gapPairs.slice(0, PAIRS_SAMPLE);

  const doiCache = new Map();
  function toDoIs(site) {
    if (!doiCache.has(site)) doiCache.set(site, new Set(loadSiteDoIs(site)));
    return doiCache.get(site);
  }

  const plan = picked.map((p, pi) => {
    const fromDoIs = loadSiteDoIs(p.from).slice(0, DOI_PER_PAIR);
    return { pairIndex: pi, from: p.from, to: p.to, combinedSize: p.combinedSize, fromDoIs, toDoiSetSize: toDoIs(p.to).size };
  });

  if (SAMPLE_ONLY) {
    return console.log(JSON.stringify({ generatedAt: startedAt, tool: 'tools/gap-baseline-crossref.mjs', mode: 'sample-only', plan, totalQueriesPlanned: plan.reduce((s, p) => s + p.fromDoIs.length, 0) }, null, 2));
  }
  if (DRY_RUN) {
    return console.log(JSON.stringify({ plan, totalQueriesPlanned: plan.reduce((s, p) => s + p.fromDoIs.length, 0), note: '[dry-run] would hit Crossref' }, null, 2));
  }

  const allQueries = [];
  const perPair = [];
  let queryIdx = 0;

  for (const pp of plan) {
    const toSet = toDoIs(pp.to);
    const outcomes = { doi_unknown: 0, refs_not_indexed: 0, refs_indexed: 0, api_error: 0 };
    let totalRefsChecked = 0;
    let totalHits = 0;
    const detail = [];

    for (const fdoi of pp.fromDoIs) {
      queryIdx++;
      const r = await probe(fdoi);
      outcomes[r.outcome]++;
      let hits = [];
      if (r.outcome === 'refs_indexed') {
        hits = r.refs.filter(rd => toSet.has(rd));
        totalRefsChecked += r.refs.length;
        totalHits += hits.length;
      }
      const entry = {
        pairIndex: pp.pairIndex, fromSite: pp.from, toSite: pp.to, fromDoi: fdoi,
        outcome: r.outcome, status: r.status, refsChecked: r.refs.length, hits
      };
      if (r.body) entry.body = r.body;
      if (r.error) entry.error = r.error;
      if (r.reportedTotal != null) entry.reportedTotal = r.reportedTotal;
      allQueries.push(entry);
      detail.push(entry);
      process.stderr.write(`  [${queryIdx}/${plan.reduce((s,p)=>s+p.fromDoIs.length,0)}] ${pp.from}/${pp.to} doi=${fdoi} outcome=${r.outcome} refs=${r.refs.length} hits=${hits.length}\n`);
      await sleep(DELAY_MS);
    }

    perPair.push({
      from: pp.from, to: pp.to, combinedSize: pp.combinedSize,
      fromDoIsQueried: pp.fromDoIs, toDoiSetSize: pp.toDoiSetSize,
      outcomes, totalRefsChecked, totalHits,
      falseNegRateAmongIndexed: outcomes.refs_indexed > 0 ? totalHits / outcomes.refs_indexed : null,
      detail
    });
  }

  const tot = { doi_unknown: 0, refs_not_indexed: 0, refs_indexed: 0, api_error: 0 };
  const totalQueried = allQueries.length;
  const totalHits = perPair.reduce((s, p) => s + p.totalHits, 0);
  const totalRefsChecked = perPair.reduce((s, p) => s + p.totalRefsChecked, 0);
  for (const p of perPair) for (const k of Object.keys(tot)) tot[k] += p.outcomes[k];

  const coverageWorkExists = totalQueried > 0 ? (tot.refs_indexed + tot.refs_not_indexed) / totalQueried : null;
  const coverageRefsAvailable = totalQueried > 0 ? tot.refs_indexed / totalQueried : null;
  const falseNegRateAmongIndexed = tot.refs_indexed > 0 ? totalHits / tot.refs_indexed : null;
  const lowerBoundFalseNegRate = coverageRefsAvailable && falseNegRateAmongIndexed ? falseNegRateAmongIndexed * coverageRefsAvailable : null;

  const completedAt = new Date().toISOString();
  const out = {
    generatedAt: startedAt, completedAt,
    tool: 'tools/gap-baseline-crossref.mjs',
    reportTask: 'T3.3 / Phase 4 OpenAlex fallback to Crossref (no key required)',
    internalSource: { file: 'data/citation-gaps.json', builtAt: gaps.builtAt, totalGapPairs: gapPairs.length },
    externalSource: {
      endpointWorks: 'https://api.crossref.org/works/{doi}',
      endpointRefs: 'https://api.crossref.org/works/{doi}/references',
      auth: 'none (public REST API; Crossref requires User-Agent with contact)',
      ratePolicy: `delayed ${DELAY_MS}ms between calls, timeout ${TIMEOUT_MS}ms, User-Agent: ${USER_AGENT}`,
      note: 'Crossref is an independent, well-established bibliographic index. Its /works/{doi}/references endpoint returns the works a given paper cites, providing a valid independent check on whether a citation exists between two works. However, crossref is known to have uneven reference-list coverage across publishers and years, so a 404 on /references must be interpreted as "not indexed" rather than "citation does not exist".'
    },
    config: { PAIRS_SAMPLE, DOI_PER_PAIR, DELAY_MS, USER_AGENT },
    summary: {
      totalGapPairsAvailable: gapPairs.length,
      pairsSampled: picked.length,
      totalCitingDoIsQueried: totalQueried,
      outcomes: tot,
      coverage_workExists_rate: coverageWorkExists,
      coverage_refsAvailable_rate: coverageRefsAvailable,
      totalCrossrefReferencesChecked: totalRefsChecked,
      totalFalsePositiveCitationFindings: totalHits,
      falseNegativeRate_amongIndexed: falseNegRateAmongIndexed,
      lowerBoundFalseNegativeRate: lowerBoundFalseNegRate,
      pairsWithAnyCrossrefEvidence: perPair.filter(p => p.totalHits > 0).length
    },
    interpretation: `Across ${picked.length} zero-citation pairs (largest by joint entities) and ${totalQueried} citing-paper DOIs, Crossref's independent corpus returned: doi_unknown=${tot.doi_unknown}, refs_not_indexed=${tot.refs_not_indexed}, refs_indexed=${tot.refs_indexed}, api_error=${tot.api_error}. Coverage of the "does Crossref know this DOI" layer is ${(coverageWorkExists * 100).toFixed(1)}%; coverage of the "does Crossref have its reference list" layer is ${(coverageRefsAvailable * 100).toFixed(1)}%. Among the ${tot.refs_indexed} citing papers whose reference list Crossref indexed, ${totalHits} cross-domain citations were confirmed (${falseNegRateAmongIndexed === null ? 'N/A' : (falseNegRateAmongIndexed * 100).toFixed(2) + '%'} at citing-paper granularity), giving a lower-bound false-negative rate of ${lowerBoundFalseNegRate === null ? 'N/A' : (lowerBoundFalseNegRate * 100).toFixed(3) + '%'} against the full sample of ${totalQueried} citing DOIs. ${coverageRefsAvailable === null || coverageRefsAvailable < 0.05 ? 'The Crossref reference-list coverage on this sample is too thin to draw a stable estimate — this validation is directionally informative but not statistically decisive. If OpenAlex key becomes available, the same probe against OpenAlex\'s citation-indexed corpus will yield a much higher coverage and a tighter bound.' : 'Crossref coverage on this sample is adequate; the estimate above can be reported as a strict lower bound on the true false-negative rate of our "gap" label.'} The "gap" label should be described in the Data Descriptor as a *proxy* for absence, not a proof of absence, with this explicit caveat.`
    ,
    perPair,
    allQueries
  };

  fs.mkdirSync(path.resolve(ROOT, 'reports'), { recursive: true });
  const outPath = path.resolve(ROOT, 'reports/gap-baseline-crossref-2026-10-18.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    pairs: picked.length,
    citingQueried: totalQueried,
    outcomes: tot,
    coverageWorkExists: coverageWorkExists,
    coverageRefsAvailable: coverageRefsAvailable,
    hits: totalHits,
    falseNegRate_amongIndexed: falseNegRateAmongIndexed,
    lowerBoundFalseNegRate,
    out: outPath
  }, null, 2));
}

main().catch(e => { process.stderr.write('FATAL: ' + e.stack + '\n'); process.exit(1); });
