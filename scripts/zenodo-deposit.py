#!/usr/bin/env python3
"""Zenodo deposition for GeneTech-30 repro package.

Steps:
  1. Create empty deposition (POST /deposit/depositions)
  2. Upload files (PUT {bucket_url}/{filename})
  3. Set metadata (PUT /deposit/depositions/{id})
  4. Publish (POST /deposit/depositions/{id}/actions/publish)
  5. Print DOI

Token is passed via env ZENODO_TOKEN.
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

TOKEN = os.environ.get("ZENODO_TOKEN", "")
if not TOKEN:
    print("ERROR: ZENODO_TOKEN env var not set")
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[1]
DEPOSIT_DIR = ROOT / "repro-package"
REPO_URL = "https://github.com/lm203688/genetech-14-sites"
BASE = "https://zenodo.org/api"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
JSON_HDR = {"Content-Type": "application/json", **AUTH}

FILES = [
    "README.md",
    "CITATION.md",
    "MANIFEST.json",
    "SHA256SUMS.txt",
    "SUBMISSION-METADATA.md",
    "USER-CHECKLIST.md",
    "ZENODO-SUBMIT.md",
    "RESEARCH-SQUARE-SUBMIT.md",
    "FIGSHARE-DATA-SUBMIT.md",
]


def req(method, url, headers=None, data=None, raw_data=None):
    h = dict(headers or {})
    body = raw_data
    if data is not None and raw_data is None:
        body = json.dumps(data).encode("utf-8")
        h.setdefault("Content-Type", "application/json")
    r = urllib.request.Request(url, method=method, headers=h, data=body)
    with urllib.request.urlopen(r, timeout=120) as resp:
        raw = resp.read()
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return raw


def main():
    t0 = time.time()
    print(f"[1/5] Creating deposition...", flush=True)
    resp = req("POST", f"{BASE}/deposit/depositions", headers=AUTH, data={})
    if isinstance(resp, dict):
        dep_id = resp.get("id") or resp.get("recid")
        bucket = resp.get("links", {}).get("bucket")
        print(f"    deposition id={dep_id}")
        print(f"    bucket={bucket}")
    else:
        print(f"    unexpected resp: {str(resp)[:200]}")
        sys.exit(1)

    # 2. Upload files
    print(f"\n[2/5] Uploading {len(FILES)} files to bucket...", flush=True)
    for fname in FILES:
        p = DEPOSIT_DIR / fname
        if not p.exists():
            print(f"    [skip] {fname} not found")
            continue
        size = p.stat().st_size
        with open(p, "rb") as fp:
            raw = fp.read()
        url = f"{bucket}/{fname}"
        h = dict(AUTH)
        h["Content-Type"] = "application/octet-stream"
        r = urllib.request.Request(url, method="PUT", headers=h, data=raw)
        with urllib.request.urlopen(r, timeout=120) as resp:
            out = resp.read().decode("utf-8", errors="replace")
        print(f"    [ok] {fname} ({size/1024:.1f} KB)", flush=True)

    # 3. Set metadata
    print(f"\n[3/5] Setting metadata...", flush=True)
    now = time.strftime("%Y-%m-%d", time.gmtime())
    metadata = {
        "title": "GeneTech-30: Cross-Domain Scholarly Knowledge Graph (294,330 entities, 30 domains)",
        "upload_type": "dataset",
        "publication_date": now,
        "version": "1.0.0",
        "description": (
            "<p>GeneTech-30 is a publicly accessible scholarly knowledge graph "
            "comprising 294,330 entities across 30 disjoint scientific domains, "
            "with 255,392 de-duplicated DOIs and 25,682 resolved cross-domain citation edges. "
            "This deposit contains the reproducibility package for the Data Descriptor paper: "
            "manifest, SHA-256 checksums, submission guides, and metadata for the research outputs.</p>"
            "<p>DOI coverage: 98.61%. Entity resolution: 276,960 canonical entries. "
            "The full dataset is available in the linked GitHub repository; this deposit "
            "anchors the metadata, checklist, and reproducibility claims.</p>"
        ),
        "creators": [
            {
                "name": "GeneTech Research",
                "affiliation": "independent",
            }
        ],
        "keywords": [
            "knowledge graph",
            "scholarly data",
            "entity resolution",
            "literature-based discovery",
            "cross-domain citation",
            "provenance tracking",
            "reproducibility",
            "data descriptor",
            "scientific data",
        ],
        "license": {"id": "cc-by-4.0"},
        "related_identifiers": [
            {
                "identifier": REPO_URL,
                "scheme": "url",
                "relation": "isSupplementTo",
            }
        ],
        "prereserve_doi": True,
        "additional_descriptions": [
            {
                "type": "version",
                "description": (
                    "v1.0.0 - Data Descriptor submission snapshot. "
                    "DOI coverage 98.61%, 294,330 entities, 255,392 unique DOIs. "
                    "See MANIFEST.json for full file inventory and SHA-256 checksums."
                ),
            }
        ],
    }
    url = f"{BASE}/deposit/depositions/{dep_id}"
    h = dict(AUTH)
    h["Content-Type"] = "application/json"
    body = json.dumps({"metadata": metadata}).encode("utf-8")
    r = urllib.request.Request(url, method="PUT", headers=h, data=body)
    with urllib.request.urlopen(r, timeout=60) as resp:
        out = json.loads(resp.read().decode("utf-8"))
    doi = out.get("metadata", {}).get("prereserve_doi", {}).get("doi") or out.get("doi")
    print(f"    [ok] metadata set, reserved DOI: {doi}", flush=True)

    # 4. Publish
    print(f"\n[4/5] Publishing...", flush=True)
    pub_url = f"{BASE}/deposit/depositions/{dep_id}/actions/publish"
    r = urllib.request.Request(pub_url, method="POST", headers=AUTH, data=b"{}")
    with urllib.request.urlopen(r, timeout=180) as resp:
        raw = resp.read()
    try:
        pub = json.loads(raw.decode("utf-8"))
    except Exception:
        pub = {"raw": raw.decode("utf-8", errors="replace")[:500]}
    print(f"    [ok] publish resp keys: {list(pub.keys()) if isinstance(pub, dict) else type(pub)}", flush=True)

    # 5. Get final DOI
    print(f"\n[5/5] Fetching final record...", flush=True)
    time.sleep(3)
    final = req("GET", f"{BASE}/deposit/depositions/{dep_id}", headers=AUTH)
    print(f"    final state: {final.get('state') if isinstance(final, dict) else '?'}")
    print(f"    final doi: {final.get('doi') if isinstance(final, dict) else '?'}")
    html = final.get("links", {}).get("html") if isinstance(final, dict) else None
    if html:
        print(f"    html: {html}")
    print(f"\nDONE in {time.time()-t0:.0f}s")
    print(f"DOI: {final.get('doi') if isinstance(final, dict) else '?'}")

    # Save
    (ROOT / "repro-package" / "ZENODO-DEPOSIT-RESULT.json").write_text(
        json.dumps({"dep_id": dep_id, "doi": final.get("doi") if isinstance(final, dict) else None, "published_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "files": FILES}, indent=2),
        encoding="utf-8"
    )


if __name__ == "__main__":
    main()
