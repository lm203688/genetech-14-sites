# GeneTech 30-Sites Knowledge Graph - Reproduction Package

**Version**: 1.0.0
**Generated**: 2026-10-18T05:15:57.967Z
**Repository**: https://github.com/lm203688/genetech-14-sites (branch: master)

## What this is

This package is the local staging area for the Research Square preprint + Figshare/Zenodo data deposition referenced in the Data Descriptor draft. It collects every artefact needed to reproduce the reported numbers:

- **Data core**: metrics, knowledge graph, citation edges, hypothesis cards.
- **Data gold**: sampled annotation subsets (stance, entity-resolution, gold retrieval, known discoveries).
- **Evaluation**: full 30-site leaderboard, per-type breakdowns.
- **Validation**: retrospective LBD cuts (3 cut-points), known-discovery benchmark, Crossref false-negative baseline, OpenAlex zero-citation-pair true/false-negative baseline.
- **Tooling**: every script that produced the artefacts above.
- **Review package**: hypothesis-card sampling + annotation template.
- **Governance**: signing-audit log.

## Deposition path (2026-10-18 update)

Zero-APC path selected (no funded APC budget, no arXiv endorsement resources available):

| Purpose | Platform | Status | Docs |
|---|---|---|---|
| Paper DOI | **Research Square** (free, no endorsement) | pending user registration | `RESEARCH-SQUARE-SUBMIT.md` |
| Data DOI (optional) | **Figshare** (free 20 GB, no endorsement) | pending user registration | `FIGSHARE-DATA-SUBMIT.md` |
| Data DOI (fallback) | **Zenodo** (free, requires 5-min registration) | not started | `ZENODO-SUBMIT.md` |

Full user-action checklist: `USER-CHECKLIST.md`. Submission metadata template: `SUBMISSION-METADATA.md`.

## Key numbers (single source of truth)

All headline numbers are anchored to **data/metrics.json**. Do not re-derive from individual files - the metrics recomputation tool is tools/recompute-metrics.mjs.

| Metric | Value | Source |
|---|---|---|
| Sites | 30 | data/metrics.json |
| Total entities | 294,330 | data/metrics.json |
| Unique DOIs | 255,392 | data/metrics.json |
| DOI coverage | 92.11% | data/metrics.json |

## Package summary

- Total files: **38**
- Present at build time: **38**
- Missing at build time: **0**
- Total bytes: **195.83 MB**
- Large files (> 1 MB, need Zenodo direct upload or Git LFS): **6** totalling **194.69 MB**

## Checksum verification

    cd repro-package
    sha256sum -c SHA256SUMS.txt

## Contents

See MANIFEST.json for the authoritative file listing with roles, categories, sizes and SHA256 hashes.

## Citation template

See CITATION.md for a BibTeX stub - replace the placeholder DOI once Zenodo deposition is complete.
