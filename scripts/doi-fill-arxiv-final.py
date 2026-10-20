#!/usr/bin/env python3
"""Targeted DOI fill for the 2 sub-95% sites (ai-safety, alien-minerals).

Strategy: for each entity missing DOI/PMID, query OpenAlex by its
primary identifier (arxiv/openalex) to try to fetch a DOI. Also fall back
to Crossref title/abstract search.

Run: python scripts/doi-fill-arxiv-final.py
"""
import json
import re
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UA = "GeneTech-DOI-Fill/1.0 (mailto:lm203688@users.noreply.github.com)"
TARGETS = ["alien-minerals"]
OUT_LOG = ROOT / "data" / "arxiv-fill-log.json"

HTTP_TIMEOUT = 10


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def openalex_by_arxiv_id(ax_id):
    """Try to resolve arXiv ID → DOI via OpenAlex works/{doi}."""
    ax = re.sub(r"v\d+$", "", ax_id.lower())
    url = f"https://api.openalex.org/works/https://doi.org/10.48550/arxiv.{ax}"
    try:
        data = http_get(url)
        if data.get("doi") and data["doi"].startswith("https://doi.org/10."):
            return data["doi"].replace("https://doi.org/", "")
    except Exception:
        pass
    return None


def crossref_title_search(title):
    """Title-based DOI lookup via Crossref works API (no key)."""
    if not title or len(title) < 20:
        return None
    params = urllib.parse.urlencode({
        "query.bibliographic": title[:200],
        "rows": "3",
        "select": "DOI,title,author,issued",
    })
    url = f"https://api.crossref.org/works?{params}"
    try:
        data = http_get(url)
    except Exception:
        return None
    items = (data.get("message", {}) or {}).get("items", [])
    best = None
    for it in items:
        d = it.get("DOI")
        if not d or not d.startswith("10/"):
            continue
        t = (it.get("title") or [""])[0].lower()
        q = title.lower()
        # require decent overlap
        overlap = sum(1 for c in set(q.split()) if c in t)
        if overlap >= max(4, len(q.split()) * 0.5):
            best = d
            break
    return best


def openalex_by_title(title):
    if not title or len(title) < 20:
        return None
    params = urllib.parse.urlencode({
        "search": title[:200],
        "per-page": "3",
        "select": "doi,title",
    })
    url = f"https://api.openalex.org/works?{params}"
    try:
        data = http_get(url)
    except Exception:
        return None
    for w in data.get("results", []):
        if w.get("doi") and w["doi"].startswith("https://doi.org/10."):
            return w["doi"].replace("https://doi.org/", "")
    return None


def extract_title_proxy(abstract):
    """First sentence, capped at 200 chars, as a proxy title."""
    if not abstract:
        return None
    # Try sentence boundary
    m = re.match(r"([^.!?]{20,300}[.!?])", abstract.strip())
    if m:
        return m.group(1).strip()[:200]
    return abstract.strip()[:200]


def main():
    log = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    total_filled = 0
    per_site = {}

    for site in TARGETS:
        path = ROOT / site / "website" / "api" / "entities.json"
        d = json.loads(path.read_text(encoding="utf-8"))
        is_list = isinstance(d, list)
        ents = d if is_list else d.get("entities", [])
        filled_here = 0
        checked = 0
        for e in ents:
            if e.get("doi") or e.get("pmid"):
                continue
            if checked >= 400:  # per-site budget
                break
            checked += 1
            # 1) Try arxiv ID → openalex
            eid = e.get("id", "")
            doi = None
            if eid.startswith("arxiv:"):
                ax = eid[len("arxiv:"):]
                doi = openalex_by_arxiv_id(ax)
                time.sleep(0.25)
            # 2) Fall back to title proxy
            if not doi:
                proxy = extract_title_proxy(e.get("abstract", ""))
                if proxy:
                    doi = openalex_by_title(proxy)
                time.sleep(0.25)
            if not doi:
                proxy = extract_title_proxy(e.get("abstract", ""))
                if proxy:
                    doi = crossref_title_search(proxy)
            if doi:
                e["doi"] = doi
                filled_here += 1

        if not is_list:
            d["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        path.write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        per_site[site] = {"filled": filled_here, "checked": checked}
        total_filled += filled_here
        print(f"[{site}] checked={checked} filled={filled_here}", flush=True)

    log["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    log["totalFilled"] = total_filled
    log["perSite"] = per_site
    OUT_LOG.write_text(json.dumps(log, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"DONE total_filled={total_filled}")


if __name__ == "__main__":
    sys.exit(main())
