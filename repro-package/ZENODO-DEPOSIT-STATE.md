# Zenodo Deposition State — GeneTech-30

> **Status**: BLOCKED by Zenodo API outage (HTTP 500, 2026-10-21 14:XXZ – present)
> **Deposition ID**: 23527675
> **Reserved DOI**: 10.5281/zenodo.23527675
> **Bucket URL**: https://zenodo.org/api/files/fc46ba62-19f7-4af3-b86d-e5bdb12a3be5

## What succeeded
- [x] Deposition created (POST /api/deposit/depositions)
- [x] 9 files uploaded to bucket:
  - README.md, CITATION.md, MANIFEST.json, SHA256SUMS.txt
  - SUBMISSION-METADATA.md, USER-CHECKLIST.md, ZENODO-SUBMIT.md
  - RESEARCH-SQUARE-SUBMIT.md, FIGSHARE-DATA-SUBMIT.md
- [x] Reserved DOI assigned: 10.5281/zenodo.23527675
- [x] Initial metadata set (title, upload_type, description, creators, keywords, license, related_identifiers)

## What is pending
- [ ] Full metadata with `additional_descriptions` (PUT returned HTTP 500 during outage)
- [ ] Publish action (POST /deposit/depositions/23527675/actions/publish)

## Recovery instructions (once Zenodo API returns HTTP 200)

```bash
# 1. Check current state
curl -H "Authorization: Bearer $TOKEN" \
  "https://zenodo.org/api/deposit/depositions/23527675"

# 2. Set/refresh metadata (scripted)
ZENODO_TOKEN=$TOKEN python scripts/zenodo-deposit.py  # note: this creates a NEW deposition; for existing one, use PUT manually

# 3. Manual metadata refresh if needed
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "metadata": {
      "title": "GeneTech-30: Cross-Domain Scholarly Knowledge Graph (294330 entities, 30 domains)",
      "upload_type": "dataset",
      "publication_date": "2026-10-21",
      "version": "1.0.0",
      "description": "<p>GeneTech-30 is a publicly accessible scholarly knowledge graph...</p>",
      "creators": [{"name": "GeneTech Research", "affiliation": "independent"}],
      "keywords": ["knowledge graph","scholarly data","entity resolution","literature-based discovery","cross-domain citation","provenance tracking","reproducibility","data descriptor","scientific data"],
      "license": "cc-by-4.0",
      "related_identifiers": [{"identifier":"https://github.com/lm203688/genetech-14-sites","relation":"isSupplementTo","scheme":"url"}],
      "additional_descriptions": [{"type":"version","description":"v1.0.0 Data Descriptor submission snapshot. DOI coverage 98.61%, 294330 entities, 255392 unique DOIs."}]
    }
  }' \
  "https://zenodo.org/api/deposit/depositions/23527675"

# 4. Publish
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{}' \
  "https://zenodo.org/api/deposit/depositions/23527675/actions/publish"
```

## Token rotation note
The token used (AK4U1Fg...) was shared in chat history. Recommend revoking via
https://zenodo.org/settings/applications/tokens and generating a fresh one before
any re-publish attempts.

## Alternative if API stays down >48h
1. **Manual upload via web UI** — go to https://zenodo.org/deposit/new, follow
   `ZENODO-SUBMIT.md`. ~10 min, gets real DOI, but not scripted.
2. **Figshare** — same DataCite infrastructure, sometimes up when Zenodo is down.
   See `FIGSHARE-DATA-SUBMIT.md`.
3. **Research Square dataset** — deposit as preprint's supplementary dataset.
   See `RESEARCH-SQUARE-SUBMIT.md`.
