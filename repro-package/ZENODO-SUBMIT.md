# Zenodo Deposition Guide - GeneTech 30-Sites Knowledge Graph

> **Status**: This is a runbook. The Zenodo account action is a user-level hard blocker
> (task #394). Once an account is available, the deposition itself is a bounded
> scripted sequence.

## 1. Prerequisites

1. **Zenodo account** - sign up at https://zenodo.org/login; free for ORCID-linked accounts.
2. **ORCID** - required by Zenodo; use your personal ORCID.
3. **Local Node.js >= 18** - for re-running any of the tools in this package.

## 2. Deposit strategy

Zenodo allows up to **20 GB per deposit** across any number of files. Our
package totals **~195.8 MB**. The largest single file
(data/identity-map.json, 108.1 MB) is within Zenodo's
limits but too large for the GitHub Data API blob endpoint (1 MB cap),
so it must be uploaded directly.

**Large files to upload directly to Zenodo (not through Git):**

| Role | Path | Size |
|---|---|---|
| identity-map | data/identity-map.json | 108.14 MB |
| knowledge-graph | data/knowledge-graph.json | 31.20 MB |
| kg-entities | data/knowledge-graph-entities.json | 31.20 MB |
| citation-edges | data/citation-edges.json | 8.51 MB |
| search-index | data/search-index.json | 13.05 MB |
| hypothesis-cards | data/hypothesis-cards.json | 2.59 MB |

The rest of the files (< 1 MB each) are already committed to the GitHub repository.

## 3. Recommended deposition workflow

### 3.1 Create a new deposit

1. Go to https://zenodo.org/deposit/new
2. **Title**: GeneTech 30-Site Cross-Domain Knowledge Graph v1.0
3. **Upload type**: Dataset
4. **Language**: English
5. **Subjects** (up to 20): Life Sciences, Physical Sciences, Engineering, Computer Science, Artificial Intelligence, Robotics, Nanotechnology, Quantum Computing, Neuroscience, Environmental Sciences.
6. **Contributors**: add yourself + anyone who helped produce the artefacts.
7. **Related identifiers**: link to the GitHub repository and to the Data Descriptor manuscript DOI once accepted.
8. **License**: CC BY 4.0 for the data + Apache 2.0 for the code.
9. **Description**: paste the Data Descriptor abstract.
10. **Version note**: v1.0.0 - Data Descriptor submission snapshot

### 3.2 Upload files

For small files, drag-and-drop directly. For large files use the Zenodo REST API:

    # Get a Zenodo token from your account page.
    # Replace YOUR_TOKEN and DEPOSIT_ID (created by step 3.1).
    curl -L -H "Authorization: Bearer YOUR_TOKEN" \
      -F "file=@$(pwd)/../data/identity-map.json" \
      "https://zenodo.org/api/files/DEPOSIT_ID/"

### 3.3 Publish and record the DOI

1. Click Publish at the top right of the deposit.
2. Zenodo will assign a DOI (looks like 10.5281/zenodo.XXXXXXXX).
3. Update:
   - repro-package/CITATION.md with the actual DOI.
   - reports/manuscript-data-descriptor.md section "Code availability".
   - data/metrics.json: add a deposit.doi field.

## 4. Post-deposition checklist

- [ ] Deposit DOI recorded in CITATION.md
- [ ] Manuscript updated with Zenodo DOI
- [ ] metrics.json points at the deposit
- [ ] GitHub repo README links to the Zenodo deposit
- [ ] Task #394 marked completed

## 5. What is intentionally NOT in the deposit

- **Live API endpoints** - these are running services, not versioned artefacts.
- **Cloudflare Workers, KV buckets, GitHub Actions secrets** - infrastructure, not scientific data.
- **Internal planning documents** (.workbuddy/, .workbuddy-ai/, archive/) - engineering logs, not research artefacts.
