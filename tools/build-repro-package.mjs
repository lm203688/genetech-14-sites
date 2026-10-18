#!/usr/bin/env node
// tools/build-repro-package.mjs
//
// Purpose: T6.2 assemble the local Zenodo reproduction package. This does NOT
//          upload to Zenodo — it produces the manifest, checksums and the
//          submission instructions so that the Zenodo deposit itself becomes
//          a one-command operation once a Zenodo account is available.
//
// Output: repro-package/
//   ├── MANIFEST.json         — all critical files: path, size, sha256, role
//   ├── SHA256SUMS.txt        — checksum file (sha256sum -c compatible)
//   ├── README.md             — package overview + citation template
//   ├── ZENODO-SUBMIT.md      — Zenodo deposition guide + metadata template
//   └── CITATION.md           — BibTeX / plain-text citation suggestions
//
// Notes:
//   - Files that exceed 1MB (e.g. data/identity-map.json) are still listed in
//     the manifest with category='data-core-large' so a reader knows where to
//     find them — but they are NOT expected to be pushed through the GitHub
//     Data API (which caps at 1MB). They must be uploaded directly to Zenodo
//     or mirrored to a separate data repository (e.g. Git LFS).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const OUT = path.resolve(ROOT, 'repro-package');

// All files that constitute the reproduction package.
const CATALOG = [
  { role: 'metrics',           path: 'data/metrics.json',                          category: 'data-core' },
  { role: 'identity-map',      path: 'data/identity-map.json',                     category: 'data-core-large' },
  { role: 'knowledge-graph',   path: 'data/knowledge-graph.json',                  category: 'data-core-large' },
  { role: 'kg-entities',       path: 'data/knowledge-graph-entities.json',         category: 'data-core-large' },
  { role: 'citation-edges',    path: 'data/citation-edges.json',                   category: 'data-core' },
  { role: 'citation-gaps',     path: 'data/citation-gaps.json',                    category: 'data-core' },
  { role: 'search-index',      path: 'data/search-index.json',                     category: 'data-core-large' },
  { role: 'hypothesis-cards',  path: 'data/hypothesis-cards.json',                 category: 'data-core' },
  { role: 'known-discoveries', path: 'data/known-discoveries.json',                category: 'data-gold' },
  { role: 'gold-sample',       path: 'data/gold.jsonl',                            category: 'data-gold' },
  { role: 'stance-sample',     path: 'data/stance-sample.json',                    category: 'data-gold' },
  { role: 'entity-resolution-sample', path: 'data/entity-resolution-sample.json',  category: 'data-gold' },
  { role: 'signing-audit',     path: 'data/signing-audit.jsonl',                   category: 'data-governance' },

  { role: 'eval-results',      path: 'eval/results-2026-10-18.json',               category: 'eval' },
  { role: 'eval-leaderboard',  path: 'eval/leaderboard-2026-10-18.html',           category: 'eval' },

  { role: 'retro-2021',        path: 'reports/retro-validation-2021-01-01.json',  category: 'validation' },
  { role: 'retro-2022',        path: 'reports/retro-validation-2022-01-01.json',  category: 'validation' },
  { role: 'retro-2023',        path: 'reports/retro-validation-2023-01-01.json',  category: 'validation' },
  { role: 'known-disc-2021',   path: 'reports/known-discovery-benchmark-2021-01-01.json', category: 'validation' },
  { role: 'known-disc-2022',   path: 'reports/known-discovery-benchmark-2022-01-01.json', category: 'validation' },
  { role: 'known-disc-2023',   path: 'reports/known-discovery-benchmark-2023-01-01.json', category: 'validation' },
  { role: 'stance-extract-report', path: 'reports/stance-extraction-report.md',    category: 'validation' },
  { role: 'entity-resolution-report', path: 'reports/entity-resolution-report.md', category: 'validation' },
  { role: 'crossref-gap-baseline', path: 'reports/gap-baseline-crossref-2026-10-18.json', category: 'validation' },
  { role: 'manuscript-draft', path: 'reports/manuscript-data-descriptor.md',       category: 'manuscript' },
  { role: 'sci-improvement-plan', path: 'reports/SCI达标提升方案-2026-10-18.md',    category: 'plan' },

  { role: 'tool-recompute-metrics',        path: 'tools/recompute-metrics.mjs',                category: 'tool' },
  { role: 'tool-validate-hypotheses-retro', path: 'tools/validate-hypotheses-retro.mjs',       category: 'tool' },
  { role: 'tool-benchmark-known-discoveries', path: 'tools/benchmark-known-discoveries.mjs',   category: 'tool' },
  { role: 'tool-stance-extract',             path: 'tools/stance-extract.mjs',                 category: 'tool' },
  { role: 'tool-analyze-entity-resolution',  path: 'tools/analyze-entity-resolution.mjs',      category: 'tool' },
  { role: 'tool-build-gold-sample',          path: 'tools/build-gold-sample.mjs',              category: 'tool' },
  { role: 'tool-gold-kappa',                 path: 'tools/gold-kappa.mjs',                     category: 'tool' },
  { role: 'tool-gap-baseline-crossref',      path: 'tools/gap-baseline-crossref.mjs',          category: 'tool' },
  { role: 'tool-build-repro-package',        path: 'tools/build-repro-package.mjs',            category: 'tool' },

  { role: 'review-package',    path: 'review-pkg/review-package.json',   category: 'review' },
  { role: 'review-sheet',      path: 'review-pkg/review-sheet.csv',      category: 'review' },
  { role: 'review-template',   path: 'review-pkg/reviews/_TEMPLATE.json', category: 'review' },
];

function sha256File(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function relFromRoot(rel) { return path.resolve(ROOT, rel); }

function buildManifest() {
  const manifest = {
    package: 'GeneTech-30-sites-knowledge-graph-repro',
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    description: 'Reproduction package for the Scientific Data Data Descriptor draft on the GeneTech 30-site cross-domain knowledge graph. Contains all data snapshots, evaluation artefacts, validation reports and tooling needed to reproduce the reported numbers.',
    repository: 'https://github.com/lm203688/genetech-14-sites',
    repositoryBranch: 'master',
    metricsSingleSource: 'data/metrics.json',
    keyNumbers: {
      siteCount: 30,
      totalEntities: 294330,
      entitiesWithDoiOrPmid: 271099,
      doiCoverageRate: 0.9211,
      uniqueDoi: 255392,
      identityEntries: 276960,
      source: 'data/metrics.json'
    },
    totalFiles: 0,
    totalBytes: 0,
    files: []
  };

  let totalBytes = 0;
  for (const entry of CATALOG) {
    const abs = relFromRoot(entry.path);
    if (!fs.existsSync(abs)) {
      manifest.files.push({
        role: entry.role,
        category: entry.category,
        path: entry.path,
        status: 'missing',
        note: 'listed in catalog but not present at manifest build time'
      });
      continue;
    }
    const st = fs.statSync(abs);
    const sha256 = sha256File(abs);
    totalBytes += st.size;
    manifest.files.push({
      role: entry.role,
      category: entry.category,
      path: entry.path,
      status: 'present',
      size: st.size,
      sha256,
      modified: st.mtime.toISOString(),
      large: st.size > 1_000_000
    });
  }
  manifest.totalFiles = manifest.files.length;
  manifest.totalBytes = totalBytes;
  manifest.categories = [...new Set(manifest.files.map(f => f.category))];
  manifest.largeFileCount = manifest.files.filter(f => f.large).length;
  manifest.largeFileTotalBytes = manifest.files.filter(f => f.large).reduce((s, f) => s + (f.size || 0), 0);
  manifest.presentCount = manifest.files.filter(f => f.status === 'present').length;
  manifest.missingCount = manifest.files.filter(f => f.status === 'missing').length;

  return manifest;
}

function buildSumLines(manifest) {
  return manifest.files
    .filter(f => f.status === 'present')
    .map(f => f.sha256 + '  ' + f.path);
}

// ---- Readme / Zenodo / Citation templates ---------------------------------
// Written as arrays of lines joined by \n to avoid template-literal backtick
// conflicts with markdown inline code.

function buildReadme(m) {
  const lines = [];
  lines.push('# GeneTech 30-Sites Knowledge Graph - Reproduction Package');
  lines.push('');
  lines.push('**Version**: ' + m.version);
  lines.push('**Generated**: ' + m.generatedAt);
  lines.push('**Repository**: ' + m.repository + ' (branch: ' + m.repositoryBranch + ')');
  lines.push('');
  lines.push('## What this is');
  lines.push('');
  lines.push('This package is the local staging area for the Zenodo deposition referenced in the Data Descriptor draft. It collects every artefact needed to reproduce the reported numbers:');
  lines.push('');
  lines.push('- **Data core**: metrics, knowledge graph, citation edges, hypothesis cards.');
  lines.push('- **Data gold**: sampled annotation subsets (stance, entity-resolution, gold retrieval, known discoveries).');
  lines.push('- **Evaluation**: full 30-site leaderboard, per-type breakdowns.');
  lines.push('- **Validation**: retrospective LBD cuts (3 cut-points), known-discovery benchmark, Crossref false-negative baseline.');
  lines.push('- **Tooling**: every script that produced the artefacts above.');
  lines.push('- **Review package**: hypothesis-card sampling + annotation template.');
  lines.push('- **Governance**: signing-audit log.');
  lines.push('');
  lines.push('## Key numbers (single source of truth)');
  lines.push('');
  lines.push('All headline numbers are anchored to **data/metrics.json**. Do not re-derive from individual files - the metrics recomputation tool is tools/recompute-metrics.mjs.');
  lines.push('');
  lines.push('| Metric | Value | Source |');
  lines.push('|---|---|---|');
  lines.push('| Sites | ' + m.keyNumbers.siteCount + ' | data/metrics.json |');
  lines.push('| Total entities | ' + m.keyNumbers.totalEntities.toLocaleString() + ' | data/metrics.json |');
  lines.push('| Unique DOIs | ' + m.keyNumbers.uniqueDoi.toLocaleString() + ' | data/metrics.json |');
  lines.push('| DOI coverage | ' + (m.keyNumbers.doiCoverageRate * 100).toFixed(2) + '% | data/metrics.json |');
  lines.push('');
  lines.push('## Package summary');
  lines.push('');
  lines.push('- Total files: **' + m.totalFiles + '**');
  lines.push('- Present at build time: **' + m.presentCount + '**');
  lines.push('- Missing at build time: **' + m.missingCount + '**');
  lines.push('- Total bytes: **' + (m.totalBytes / 1e6).toFixed(2) + ' MB**');
  lines.push('- Large files (> 1 MB, need Zenodo direct upload or Git LFS): **' + m.largeFileCount + '** totalling **' + (m.largeFileTotalBytes / 1e6).toFixed(2) + ' MB**');
  lines.push('');
  lines.push('## Checksum verification');
  lines.push('');
  lines.push('    cd repro-package');
  lines.push('    sha256sum -c SHA256SUMS.txt');
  lines.push('');
  lines.push('## Contents');
  lines.push('');
  lines.push('See MANIFEST.json for the authoritative file listing with roles, categories, sizes and SHA256 hashes.');
  lines.push('');
  lines.push('## Citation template');
  lines.push('');
  lines.push('See CITATION.md for a BibTeX stub - replace the placeholder DOI once Zenodo deposition is complete.');
  lines.push('');
  return lines.join('\n');
}

function buildZenodoGuide(m) {
  const largeFiles = m.files.filter(f => f.large && f.status === 'present');
  const idmap = m.files.find(f => f.role === 'identity-map');
  const lines = [];
  lines.push('# Zenodo Deposition Guide - GeneTech 30-Sites Knowledge Graph');
  lines.push('');
  lines.push('> **Status**: This is a runbook. The Zenodo account action is a user-level hard blocker');
  lines.push('> (task #394). Once an account is available, the deposition itself is a bounded');
  lines.push('> scripted sequence.');
  lines.push('');
  lines.push('## 1. Prerequisites');
  lines.push('');
  lines.push('1. **Zenodo account** - sign up at https://zenodo.org/login; free for ORCID-linked accounts.');
  lines.push('2. **ORCID** - required by Zenodo; use your personal ORCID.');
  lines.push('3. **Local Node.js >= 18** - for re-running any of the tools in this package.');
  lines.push('');
  lines.push('## 2. Deposit strategy');
  lines.push('');
  lines.push('Zenodo allows up to **20 GB per deposit** across any number of files. Our');
  lines.push('package totals **~' + (m.totalBytes / 1e6).toFixed(1) + ' MB**. The largest single file');
  lines.push('(data/identity-map.json, ' + ((idmap?.size || 0) / 1e6).toFixed(1) + ' MB) is within Zenodo\'s');
  lines.push('limits but too large for the GitHub Data API blob endpoint (1 MB cap),');
  lines.push('so it must be uploaded directly.');
  lines.push('');
  lines.push('**Large files to upload directly to Zenodo (not through Git):**');
  lines.push('');
  lines.push('| Role | Path | Size |');
  lines.push('|---|---|---|');
  for (const f of largeFiles) {
    lines.push('| ' + f.role + ' | ' + f.path + ' | ' + (f.size / 1e6).toFixed(2) + ' MB |');
  }
  lines.push('');
  lines.push('The rest of the files (< 1 MB each) are already committed to the GitHub repository.');
  lines.push('');
  lines.push('## 3. Recommended deposition workflow');
  lines.push('');
  lines.push('### 3.1 Create a new deposit');
  lines.push('');
  lines.push('1. Go to https://zenodo.org/deposit/new');
  lines.push('2. **Title**: GeneTech 30-Site Cross-Domain Knowledge Graph v1.0');
  lines.push('3. **Upload type**: Dataset');
  lines.push('4. **Language**: English');
  lines.push('5. **Subjects** (up to 20): Life Sciences, Physical Sciences, Engineering, Computer Science, Artificial Intelligence, Robotics, Nanotechnology, Quantum Computing, Neuroscience, Environmental Sciences.');
  lines.push('6. **Contributors**: add yourself + anyone who helped produce the artefacts.');
  lines.push('7. **Related identifiers**: link to the GitHub repository and to the Data Descriptor manuscript DOI once accepted.');
  lines.push('8. **License**: CC BY 4.0 for the data + Apache 2.0 for the code.');
  lines.push('9. **Description**: paste the Data Descriptor abstract.');
  lines.push('10. **Version note**: v1.0.0 - Data Descriptor submission snapshot');
  lines.push('');
  lines.push('### 3.2 Upload files');
  lines.push('');
  lines.push('For small files, drag-and-drop directly. For large files use the Zenodo REST API:');
  lines.push('');
  lines.push('    # Get a Zenodo token from your account page.');
  lines.push('    # Replace YOUR_TOKEN and DEPOSIT_ID (created by step 3.1).');
  lines.push('    curl -L -H "Authorization: Bearer YOUR_TOKEN" \\');
  lines.push('      -F "file=@$(pwd)/../data/identity-map.json" \\');
  lines.push('      "https://zenodo.org/api/files/DEPOSIT_ID/"');
  lines.push('');
  lines.push('### 3.3 Publish and record the DOI');
  lines.push('');
  lines.push('1. Click Publish at the top right of the deposit.');
  lines.push('2. Zenodo will assign a DOI (looks like 10.5281/zenodo.XXXXXXXX).');
  lines.push('3. Update:');
  lines.push('   - repro-package/CITATION.md with the actual DOI.');
  lines.push('   - reports/manuscript-data-descriptor.md section "Code availability".');
  lines.push('   - data/metrics.json: add a deposit.doi field.');
  lines.push('');
  lines.push('## 4. Post-deposition checklist');
  lines.push('');
  lines.push('- [ ] Deposit DOI recorded in CITATION.md');
  lines.push('- [ ] Manuscript updated with Zenodo DOI');
  lines.push('- [ ] metrics.json points at the deposit');
  lines.push('- [ ] GitHub repo README links to the Zenodo deposit');
  lines.push('- [ ] Task #394 marked completed');
  lines.push('');
  lines.push('## 5. What is intentionally NOT in the deposit');
  lines.push('');
  lines.push('- **Live API endpoints** - these are running services, not versioned artefacts.');
  lines.push('- **Cloudflare Workers, KV buckets, GitHub Actions secrets** - infrastructure, not scientific data.');
  lines.push('- **Internal planning documents** (.workbuddy/, .workbuddy-ai/, archive/) - engineering logs, not research artefacts.');
  lines.push('');
  return lines.join('\n');
}

function buildCitation(m) {
  const lines = [];
  lines.push('# Citation Template - GeneTech 30-Sites Knowledge Graph');
  lines.push('');
  lines.push('> **Placeholder**: Replace 10.5281/zenodo.PENDING with the actual Zenodo DOI once');
  lines.push('> deposition is complete (see ZENODO-SUBMIT.md).');
  lines.push('');
  lines.push('## BibTeX (dataset)');
  lines.push('');
  lines.push('```bibtex');
  lines.push('@dataset{genetech30sites2026,');
  lines.push('  title = {GeneTech 30-Site Cross-Domain Knowledge Graph},');
  lines.push('  author = {Li, Xing},');
  lines.push('  year = {2026},');
  lines.push('  publisher = {Zenodo},');
  lines.push('  doi = {10.5281/zenodo.PENDING},');
  lines.push('  url = {https://doi.org/10.5281/zenodo.PENDING},');
  lines.push('  version = {' + m.version + '},');
  lines.push('  note = {30 sites, ' + m.keyNumbers.totalEntities.toLocaleString() + ' entities, ' + m.keyNumbers.uniqueDoi.toLocaleString() + ' unique DOIs, DOI coverage ' + (m.keyNumbers.doiCoverageRate * 100).toFixed(2) + '%.},');
  lines.push('  license = {CC BY 4.0}');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('## Plain-text');
  lines.push('');
  lines.push('> Li X. GeneTech 30-Site Cross-Domain Knowledge Graph. Zenodo. 2026.');
  lines.push('> DOI: 10.5281/zenodo.PENDING. License: CC BY 4.0.');
  lines.push('');
  lines.push('## Data Descriptor (in preparation)');
  lines.push('');
  lines.push('Once the Data Descriptor manuscript is accepted, cite it as the primary');
  lines.push('publication and this dataset as the supplementary resource.');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const manifest = buildManifest();
  fs.mkdirSync(OUT, { recursive: true });

  fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), buildSumLines(manifest).join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'README.md'), buildReadme(manifest));
  fs.writeFileSync(path.join(OUT, 'ZENODO-SUBMIT.md'), buildZenodoGuide(manifest));
  fs.writeFileSync(path.join(OUT, 'CITATION.md'), buildCitation(manifest));

  const summary = {
    out: OUT,
    totalFiles: manifest.totalFiles,
    totalBytes: manifest.totalBytes,
    presentFiles: manifest.presentCount,
    missingFiles: manifest.missingCount,
    missingPaths: manifest.files.filter(f => f.status === 'missing').map(f => f.path),
    largeFiles: manifest.largeFileCount,
    largeFileTotalBytes: manifest.largeFileTotalBytes,
    sha256Lines: buildSumLines(manifest).length
  };
  console.log(JSON.stringify(summary, null, 2));
}

main();
