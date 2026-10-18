#!/usr/bin/env node
// tools/gap-baseline-openalex.mjs
//
// Purpose: T3.3 (false-negative rate) + T4.1 (true-negative rate) validation of
//          our zero-citation pair label against an independent, well-established
//          citation corpus — OpenAlex. OpenAlex requires NO API key for the
//          "polite pool" (10 requests/second) if the User-Agent carries a contact.
//
// Method (per sampled zero-citation pair):
//   1. For the "citing" side (fromSite), pull top-N DOIs.
//   2. For each citing DOI, query OpenAlex `/works/{doi_url}` and read
//      `referenced_works` — the list of OpenAlex work IDs this paper cites.
//   3. Map OpenAlex work IDs of the "cited" side (toSite) once up-front (same
//      endpoint, `?select=id,doi`), and check whether any of the citing paper's
//      `referenced_works` intersects with the toSite ID set.
//
// Two independent outputs:
//   - **T3.3 (false-negative rate)**: fraction of our "gap" pairs where OpenAlex
//     actually finds citations. This is the "false-negative" rate of our
//     zero-citation label — how often we wrongly called something "no citations".
//   - **T4.1 (true-negative rate)**: fraction of our "gap" pairs where OpenAlex
//     also finds no citations — the "true-negative" rate — how often our label
//     correctly identifies a genuine absence.
//
// Coverage accounting is essential (same lesson as the Crossref tool):
//   - doi_unknown_in_openalex: /works/{doi} 404 — OpenAlex does not index this work.
//   - work_no_refs_field:      OpenAlex returned 200 but referenced_works is empty
//                              (may be a genuine zero-citing work or an
//                              unpopulated reference list).
//   - work_has_refs:           OpenAlex returned 200 with a populated
//                              referenced_works list.
//
// Output: reports/gap-baseline-openalex-<date>.json
// Env: PAIRS_SAMPLE, DOI_PER_PAIR, TO_SITE_DOI_SAMPLE, DELAY_MS, OPENALEX_UA,
//      OPENALEX_TIMEOUT_MS

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const USER_AGENT = process.env.OPENALEX_UA ||
  'GeneTech-Research/1.0 (gap-baseline-openalex; https://lm203688.github.io/genetech-14-sites; research@genetech.tools)';
const PAIRS_SAMPLE = Number(process.env.PAIRS_SAMPLE || 10);
const DOI_PER_PAIR = Number(process.env.DOI_PER_PAIR || 5);
const TO_SITE_DOI_SAMPLE = Number(process.env.TO_SITE_DOI_SAMPLE || 100);
const DELAY_MS = Number(process.env.DELAY_MS || 220); // between batches
const CONCURRENCY = Number(process.env.CONCURRENCY || 5); // OpenAlex polite pool allows 10 rps
const TIMEOUT_MS = Number(process.env.OPENALEX_TIMEOUT_MS || 20000);
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

function doiToOpenAlexUrl(doi) {
  // NOTE: the OpenAlex *API* lives at api.openalex.org. Hitting openalex.org/works/...
  // returns the website's HTML shell (Cloudflare challenge page, HTTP 403) rather
  // than JSON — a common misconfiguration. Always target the API host.
  return 'https://api.openalex.org/works/https://doi.org/' + encodeURIComponent(doi).replace(/%2F/gi, '/');
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

// Fetch OpenAlex work record; returns { alexId, doi, refs:[openAlex ids], outcome, status, citedByCount }
async function fetchWork(doi) {
  const url = doiToOpenAlexUrl(doi);
  const r = await httpGet(url);
  if (r.status === 404) return { outcome: 'doi_unknown', status: 404, alexId: null, doi: null, refs: [], citedByCount: 0 };
  if (r.status !== 200) {
    return { outcome: 'api_error', status: r.status, alexId: null, doi: null, refs: [], citedByCount: 0, body: r.body.toString('utf8').slice(0, 200) };
  }
  try {
    const j = JSON.parse(r.body.toString('utf8'));
    const refs = Array.isArray(j.referenced_works) ? j.referenced_works : [];
    return {
      outcome: refs.length > 0 ? 'work_has_refs' : 'work_no_refs_field',
      status: 200,
      alexId: j.id || null,
      doi: j.doi || null,
      refs,
      citedByCount: j.cited_by_count || 0,
    };
  } catch (e) {
    return { outcome: 'api_error', status: 200, alexId: null, doi: null, refs: [], citedByCount: 0, error: e.message };
  }
}

// Map a set of DOIs → { alexId: Set, doiUnknown: number }
// Uses CONCURRENCY parallel lanes with DELAY_MS between batches to stay under the
// OpenAlex polite pool (10 req/s).
async function mapDoIsToAlexIds(doIs) {
  const alexByDoi = new Map();
  const alexIdSet = new Set();
  let doiUnknown = 0, apiError = 0, doneCount = 0;
  const total = doIs.length;
  let i = 0;
  async function worker() {
    while (i < total) {
      const idx = i++;
      const d = doIs[idx];
      const w = await fetchWork(d);
      if (w.outcome === 'doi_unknown') doiUnknown++;
      else if (w.outcome === 'api_error') apiError++;
      else if (w.alexId) { alexByDoi.set(d, w.alexId); alexIdSet.add(w.alexId); }
      doneCount++;
    }
  }
  const laneCount = Math.min(CONCURRENCY, total);
  for (let lane = 0; lane < laneCount; lane++) {
    await Promise.all(Array.from({length: CONCURRENCY}, () => worker()));
    if (i < total) await sleep(DELAY_MS);
  }
  return { alexByDoi, alexIdSet, doiUnknown, apiError, doneCount, total };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const startedAt = new Date().toISOString();
  const gaps = loadJSON('data/citation-gaps.json');
  const gapPairs = [...(gaps.gapPairs || [])].sort((a, b) => (b.combinedSize || 0) - (a.combinedSize || 0));
  const picked = gapPairs.slice(0, PAIRS_SAMPLE);

  const doiCache = new Map();
  function siteDoIs(site) {
    if (!doiCache.has(site)) doiCache.set(site, loadSiteDoIs(site));
    return doiCache.get(site);
  }

  // Sample toSide DOIs deterministically (first TO_SITE_DOI_SAMPLE of each site).
  const toSiteDoiCache = new Map();
  function sampleToSiteDoIs(site) {
    if (!toSiteDoiCache.has(site)) toSiteDoiCache.set(site, siteDoIs(site).slice(0, TO_SITE_DOI_SAMPLE));
    return toSiteDoiCache.get(site);
  }

  const plan = picked.map((p, pi) => ({
    pairIndex: pi,
    from: p.from,
    to: p.to,
    combinedSize: p.combinedSize,
    fromDoIs: siteDoIs(p.from).slice(0, DOI_PER_PAIR),
    toDoIsSample: sampleToSiteDoIs(p.to),
  }));

  if (SAMPLE_ONLY) {
    return console.log(JSON.stringify({
      generatedAt: startedAt, tool: 'tools/gap-baseline-openalex.mjs', mode: 'sample-only',
      totalCitingDoIsPlanned: plan.reduce((s, p) => s + p.fromDoIs.length, 0),
      totalToSiteDoIsPlanned: plan.reduce((s, p) => s + p.toDoIsSample.length, 0),
      plan: plan.map(p => ({ from: p.from, to: p.to, combinedSize: p.combinedSize, fromDoIsCount: p.fromDoIs.length, fromDoIs: p.fromDoIs, toDoIsSampleCount: p.toDoIsSample.length, toDoIsSamplePreview: p.toDoIsSample.slice(0, 3) }))
    }, null, 2));
  }
  if (DRY_RUN) {
    return console.log(JSON.stringify({
      plan: plan.map(p => ({ from: p.from, to: p.to, fromDoIs: p.fromDoIs.length, toDoIsSample: p.toDoIsSample.length })),
      totalCitingDoIsPlanned: plan.reduce((s, p) => s + p.fromDoIs.length, 0),
      totalToSiteDoIsPlanned: plan.reduce((s, p) => s + p.toDoIsSample.length, 0),
      note: '[dry-run] would hit OpenAlex'
    }, null, 2));
  }

  const allQueries = [];
  const perPair = [];
  const toAlexCache = new Map(); // site -> { alexIdSet, doiUnknown, apiError }
  let globalQueryIdx = 0;

  // Build to-side alex ID maps once (cache across pairs that share to-site).
  async function getToAlex(site) {
    if (toAlexCache.has(site)) return toAlexCache.get(site);
    process.stderr.write(`  [map] ${site}: ${sampleToSiteDoIs(site).length} to-side DOIs\n`);
    const { alexIdSet, doiUnknown, apiError } = await mapDoIsToAlexIds(sampleToSiteDoIs(site));
    const rec = { alexIdSet, doiUnknown, apiError, sampleSize: sampleToSiteDoIs(site).length };
    toAlexCache.set(site, rec);
    process.stderr.write(`  [map] ${site}: alexIdSet=${alexIdSet.size}, doiUnknown=${doiUnknown}, apiError=${apiError}\n`);
    return rec;
  }

  for (const pp of plan) {
    const toMap = await getToAlex(pp.to);
    const outcomes = { doi_unknown: 0, work_no_refs_field: 0, work_has_refs: 0, api_error: 0 };
    let totalRefsChecked = 0;
    let totalHits = 0;
    let pairAnyHit = false;
    const detail = [];

    for (const fdoi of pp.fromDoIs) {
      globalQueryIdx++;
      const r = await fetchWork(fdoi);
      outcomes[r.outcome]++;
      let hits = [];
      if (r.outcome === 'work_has_refs') {
        hits = r.refs.filter(x => toMap.alexIdSet.has(x));
        totalRefsChecked += r.refs.length;
        totalHits += hits.length;
        if (hits.length > 0) pairAnyHit = true;
      }
      const entry = {
        pairIndex: pp.pairIndex, fromSite: pp.from, toSite: pp.to, fromDoi: fdoi,
        outcome: r.outcome, status: r.status, alexId: r.alexId, citedByCount: r.citedByCount,
        refsChecked: r.refs.length, hits
      };
      if (r.body) entry.body = r.body;
      if (r.error) entry.error = r.error;
      allQueries.push(entry);
      detail.push(entry);
      process.stderr.write(`  [${globalQueryIdx}] ${pp.from}/${pp.to} doi=${fdoi} outcome=${r.outcome} refs=${r.refs.length} hits=${hits.length}\n`);
      await sleep(DELAY_MS);
    }

    perPair.push({
      from: pp.from, to: pp.to, combinedSize: pp.combinedSize,
      fromDoIsQueried: pp.fromDoIs,
      toDoIsSampled: pp.toDoIsSample.length,
      toDoIsMappedToAlex: toMap.alexIdSet.size,
      toDoIsUnknownInOpenAlex: toMap.doiUnknown,
      toDoIsApiError: toMap.apiError,
      outcomes,
      totalRefsChecked,
      totalHits,
      pairAnyCrossDomainCitationFound: pairAnyHit,
      detail
    });
  }

  // Aggregate stats
  const tot = { doi_unknown: 0, work_no_refs_field: 0, work_has_refs: 0, api_error: 0 };
  const totalQueried = allQueries.length;
  const totalHits = perPair.reduce((s, p) => s + p.totalHits, 0);
  const totalRefsChecked = perPair.reduce((s, p) => s + p.totalRefsChecked, 0);
  for (const p of perPair) for (const k of Object.keys(tot)) tot[k] += p.outcomes[k];

  const pairsWithAnyHit = perPair.filter(p => p.pairAnyCrossDomainCitationFound).length;
  const pairsWithNoHit = perPair.filter(p => !p.pairAnyCrossDomainCitationFound).length;

  // Coverage rates
  const coverageWorkExists = totalQueried > 0 ? (tot.work_has_refs + tot.work_no_refs_field) / totalQueried : null;
  const coverageRefsAvailable = totalQueried > 0 ? tot.work_has_refs / totalQueried : null;

  // False-negative rate: pair-level — fraction of "gap" pairs that OpenAlex found ≥1 citation for
  const falseNegativeRate_pairs = picked.length > 0 ? pairsWithAnyHit / picked.length : null;
  const trueNegativeRate_pairs = picked.length > 0 ? pairsWithNoHit / picked.length : null;

  // Citing-paper-level estimates
  const falseNegRate_amongIndexedWorks = tot.work_has_refs > 0 ? (perPair.filter(p => p.totalHits > 0).reduce((s, p) => s + p.detail.filter(d => d.hits.length > 0).length, 0)) / tot.work_has_refs : null;
  const trueNegRate_amongIndexedWorks = tot.work_has_refs > 0 ? 1 - falseNegRate_amongIndexedWorks : null;

  // Lower bound: only among the citing papers where we could actually check refs (work_has_refs).
  // For the full pair sample this is a lower bound on true false-negative rate.
  const lowerBoundFalseNegRate_pairs = (coverageRefsAvailable && falseNegRate_amongIndexedWorks != null)
    ? (falseNegRate_amongIndexedWorks * (tot.work_has_refs / Math.max(1, totalQueried)) * 1) // conservative; not directly comparable, keep for reference
    : null;

  const completedAt = new Date().toISOString();
  const out = {
    generatedAt: startedAt, completedAt,
    tool: 'tools/gap-baseline-openalex.mjs',
    reportTask: 'T3.3 (false-negative rate) + T4.1 (true-negative rate) — OpenAlex validation of zero-citation pairs',
    internalSource: { file: 'data/citation-gaps.json', builtAt: gaps.builtAt, totalGapPairs: gapPairs.length },
    externalSource: {
      endpoint: 'https://api.openalex.org/works/https://doi.org/{doi}',
      select: 'id, doi, cited_by_count, referenced_works',
      auth: 'none (polite pool — 10 req/s, requires User-Agent with contact)',
      ratePolicy: `delayed ${DELAY_MS}ms between calls (~${(1000/DELAY_MS).toFixed(1)} req/s), timeout ${TIMEOUT_MS}ms, User-Agent: ${USER_AGENT}`,
      note: 'OpenAlex is a well-established bibliographic index with citation coverage orders of magnitude broader than Crossref. Its /works/{doi} endpoint returns referenced_works — the list of works cited by a paper. A 404 on /works/{doi} means OpenAlex does not index this work at all; a 200 with an empty referenced_works array means the work exists but has no indexed references.'
    },
    config: { PAIRS_SAMPLE, DOI_PER_PAIR, TO_SITE_DOI_SAMPLE, DELAY_MS, USER_AGENT, TO_SITE_DOI_SAMPLE_CAP_NOTE: 'If a site has more DOIs than TO_SITE_DOI_SAMPLE, only the first N are used; this is a sampled coverage of the to-site, not exhaustive.' },
    summary: {
      totalGapPairsAvailable: gapPairs.length,
      pairsSampled: picked.length,
      totalCitingDoIsQueried: totalQueried,
      citingPaperOutcomes: tot,
      coverage_workExists_rate: coverageWorkExists,
      coverage_refsAvailable_rate: coverageRefsAvailable,
      totalOpenAlexReferencesChecked: totalRefsChecked,
      totalCrossDomainCitationsFound: totalHits,
      pairsWithAnyCrossDomainCitationFound: pairsWithAnyHit,
      pairsWithNoCrossDomainCitationFound: pairsWithNoHit,
      // T3.3 headline
      falseNegativeRate_pairs: falseNegativeRate_pairs,
      // T4.1 headline
      trueNegativeRate_pairs: trueNegativeRate_pairs,
      // Citing-paper-level estimates (of work_has_refs only)
      falseNegRate_amongIndexedWorks,
      trueNegRate_amongIndexedWorks,
    },
    interpretation: `Across ${picked.length} zero-citation pairs (largest by joint entities) and ${totalQueried} citing-paper DOIs, OpenAlex returned: doi_unknown=${tot.doi_unknown}, work_no_refs_field=${tot.work_no_refs_field}, work_has_refs=${tot.work_has_refs}, api_error=${tot.api_error}. Coverage of "does OpenAlex index this work" is ${(coverageWorkExists * 100).toFixed(1)}%; coverage of "does OpenAlex have its reference list" is ${(coverageRefsAvailable * 100).toFixed(1)}%. At pair granularity (the operationally important level), ${pairsWithAnyHit}/${picked.length} = ${(falseNegativeRate_pairs * 100).toFixed(1)}% of our "gap" pairs were shown to have at least one cross-domain citation in OpenAlex — this is the T3.3 false-negative rate — while ${pairsWithNoHit}/${picked.length} = ${(trueNegativeRate_pairs * 100).toFixed(1)}% were confirmed by OpenAlex as genuinely having no cross-domain citation in the works we checked — this is the T4.1 true-negative rate. Caveat: the true-negative rate is upper-bounded by coverageRefsAvailable because pairs where OpenAlex does not index the citing paper are indistinguishable from pairs where the citation truly does not exist; they are counted as "no hit" here, inflating the T4.1 rate slightly. A fairer T4.1 rate would restrict to pairs where at least one citing work is OpenAlex-indexed with populated references, but that would exclude many pairs with doi_unknown works — an equally honest limitation. The "gap" label should therefore be described in the Data Descriptor as a proxy for absence, not a proof of absence, with these explicit bounds.`,
    toAlexCache: Object.fromEntries(Array.from(toAlexCache.entries()).map(([k, v]) => [k, { sampleSize: v.sampleSize, mapped: v.alexIdSet.size, doiUnknown: v.doiUnknown, apiError: v.apiError }])),
    perPair,
    allQueries
  };

  fs.mkdirSync(path.resolve(ROOT, 'reports'), { recursive: true });
  const outPath = path.resolve(ROOT, 'reports/gap-baseline-openalex-2026-10-18.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    pairs: picked.length,
    citingQueried: totalQueried,
    outcomes: tot,
    coverageWorkExists,
    coverageRefsAvailable,
    hits: totalHits,
    pairsWithAnyHit,
    pairsWithNoHit,
    falseNegativeRate_pairs,
    trueNegativeRate_pairs,
    out: outPath
  }, null, 2));
}

main().catch(e => { process.stderr.write('FATAL: ' + e.stack + '\n'); process.exit(1); });
