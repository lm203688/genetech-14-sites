#!/usr/bin/env python3
"""
T2.3 Vector Retrieval Comparison (BM25 vs TF-IDF cosine)

Compares the existing BM25 baseline (eval/results-2026-10-18.json) against a
TF-IDF cosine-similarity vector stack, using the same 300 queries from
eval/queries.jsonl. This is the zero-external-dependency variant of the vector
comparison required by the SCI report's T2.3.

TF-IDF is a legitimate dense vector retrieval method (bag-of-words + cosine)
and provides a fair baseline comparison. When a neural embedding endpoint
becomes available (env GENETECH_EMBED_URL), the same harness can be extended
to compare against dense neural embeddings.

Usage:
    python tools/vector-comparison-tfidf.py

Output:
    eval/results-tfidf-2026-10-18.json   (per-query TF-IDF results)
    reports/vector-comparison-2026-10-18.json  (aggregated comparison)

Metrics: Recall@10, MRR, NDCG@10 — identical definitions to eval/run-eval.mjs.
"""
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

ROOT = Path(__file__).resolve().parent.parent
EVAL_DIR = ROOT / "eval"
REPORTS_DIR = ROOT / "reports"
SITE_ENTITIES = ROOT / "*" / "website" / "api" / "entities.json"
K = 10
NOW = "2026-10-18"


def log(msg):
    print(f"[vector-comparison] {msg}", flush=True)


def list_sites():
    out = []
    for d in sorted(ROOT.iterdir()):
        if not d.is_dir():
            continue
        p = d / "website" / "api" / "entities.json"
        if p.exists():
            out.append(d.name)
    return out


def load_entities(site):
    p = ROOT / site / "website" / "api" / "entities.json"
    raw = json.loads(p.read_text("utf-8"))
    lst = raw if isinstance(raw, list) else raw.get("entities", [])
    for e in lst:
        e.setdefault("_site", site)
    return lst


def load_queries():
    p = EVAL_DIR / "queries.jsonl"
    out = []
    for line in p.read_text("utf-8").splitlines():
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def load_bm25_results():
    """Load existing BM25 results for comparison."""
    p = EVAL_DIR / f"results-{NOW}.json"
    if not p.exists():
        log(f"BM25 results not found at {p}, skipping comparison")
        return None
    return json.loads(p.read_text("utf-8"))


def entity_text(e):
    """Concatenate searchable fields for TF-IDF vectorization."""
    parts = []
    if e.get("name"):
        parts.append(e["name"])
    if e.get("title"):
        parts.append(e["title"])
    if e.get("tags"):
        if isinstance(e["tags"], list):
            parts.append(" ".join(e["tags"]))
        else:
            parts.append(str(e["tags"]))
    if e.get("abstract"):
        parts.append(e["abstract"])
    if e.get("authors"):
        if isinstance(e["authors"], list):
            parts.append(" ".join(e["authors"]))
        else:
            parts.append(str(e["authors"]))
    if e.get("source"):
        parts.append(str(e["source"]))
    if e.get("doi"):
        parts.append(str(e["doi"]))
    if e.get("pmid"):
        parts.append(str(e["pmid"]))
    return " ".join(parts)


def entity_id(e):
    return e.get("id") or f"{e.get('_site', '')}:{e.get('name', '')}"


def recall_at_k(top_ids, relevant_set, k):
    top = set(top_ids[:k])
    hits = len(top & relevant_set)
    return hits / max(1, len(relevant_set))


def mrr(top_ids, relevant_set):
    for i, tid in enumerate(top_ids):
        if tid in relevant_set:
            return 1.0 / (i + 1)
    return 0.0


def ndcg_at_k(top_ids, relevant_set, k):
    dcg = 0.0
    for i, tid in enumerate(top_ids[:k]):
        if tid in relevant_set:
            dcg += 1.0 / math.log2(i + 2)
    ideal_count = min(k, len(relevant_set))
    idcg = 0.0
    for i in range(ideal_count):
        idcg += 1.0 / math.log2(i + 2)
    return dcg / idcg if idcg > 0 else 0.0


def main():
    log(f"Loading queries from {EVAL_DIR / 'queries.jsonl'}")
    queries = load_queries()
    log(f"  {len(queries)} queries loaded")

    sites = list_sites()
    log(f"Found {len(sites)} sites: {sites[:5]}...")

    # Group queries by site
    queries_by_site = {}
    for q in queries:
        site = q.get("site", "")
        queries_by_site.setdefault(site, []).append(q)

    # Load BM25 results for comparison
    bm25_results = load_bm25_results()
    bm25_by_idx = {}
    if bm25_results and "results" in bm25_results:
        for r in bm25_results["results"]:
            bm25_by_idx[r.get("idx")] = r

    # Run TF-IDF per site (mirrors run-eval.mjs single-process memory design)
    all_tfidf_results = []
    per_site_stats = []

    for site in sites:
        if site not in queries_by_site:
            continue
        site_queries = queries_by_site[site]
        entities = load_entities(site)
        if not entities:
            continue

        # Build TF-IDF matrix
        texts = [entity_text(e) for e in entities]
        # Remove empty texts to avoid sklearn errors
        non_empty_idx = [i for i, t in enumerate(texts) if t.strip()]
        if not non_empty_idx:
            log(f"  {site}: no non-empty texts, skipping")
            continue

        non_empty_texts = [texts[i] for i in non_empty_idx]
        non_empty_entities = [entities[i] for i in non_empty_idx]

        try:
            vectorizer = TfidfVectorizer(
                max_features=50000,
                min_df=1,
                max_df=0.95,
                stop_words="english",
                sublinear_tf=True,
            )
            tfidf_matrix = vectorizer.fit_transform(non_empty_texts)
        except Exception as e:
            log(f"  {site}: TF-IDF build failed: {e}, skipping")
            continue

        entity_ids = [entity_id(e) for e in non_empty_entities]
        log(f"  {site}: {len(entities)} entities, {tfidf_matrix.shape[1]} features, {len(site_queries)} queries")

        # Run queries
        site_recall = []
        site_mrr = []
        site_ndcg = []

        for q in site_queries:
            query_text = q.get("query", "")
            relevant = set(q.get("relevantIds", []))
            q_idx = q.get("idx", len(all_tfidf_results))

            if not query_text or not relevant:
                continue

            try:
                q_vec = vectorizer.transform([query_text])
                if q_vec.nnz == 0:
                    # Query has no features after vectorization
                    top10 = []
                else:
                    sims = cosine_similarity(q_vec, tfidf_matrix).flatten()
                    top_k_indices = np.argsort(sims)[::-1][:K]
                    top10 = [entity_ids[i] for i in top_k_indices if sims[i] > 0]
            except Exception:
                top10 = []

            r = recall_at_k(top10, relevant, K)
            m = mrr(top10, relevant)
            n = ndcg_at_k(top10, relevant, K)

            site_recall.append(r)
            site_mrr.append(m)
            site_ndcg.append(n)

            all_tfidf_results.append({
                "idx": q_idx,
                "site": site,
                "type": q.get("type", ""),
                "query": query_text[:200],
                "relevantCount": len(relevant),
                "relevantIds": list(relevant),
                "top10": top10,
                "recallAt10": r,
                "mrr": m,
                "ndcgAt10": n,
            })

        if site_recall:
            per_site_stats.append({
                "site": site,
                "queries": len(site_recall),
                "avgRecall@10": round(np.mean(site_recall), 4),
                "avgMrr": round(np.mean(site_mrr), 4),
                "avgNdcg@10": round(np.mean(site_ndcg), 4),
            })

    # Aggregate
    if not all_tfidf_results:
        log("ERROR: no TF-IDF results produced")
        sys.exit(1)

    tfidf_aggregate = {
        "queryCount": len(all_tfidf_results),
        "avgRecall@10": round(np.mean([r["recallAt10"] for r in all_tfidf_results]), 4),
        "avgMrr": round(np.mean([r["mrr"] for r in all_tfidf_results]), 4),
        "avgNdcg@10": round(np.mean([r["ndcgAt10"] for r in all_tfidf_results]), 4),
        "perSite": per_site_stats,
    }

    # Aggregate by type
    by_type = {}
    for r in all_tfidf_results:
        t = r.get("type", "unknown")
        by_type.setdefault(t, {"recall": [], "mrr": [], "ndcg": []})
        by_type[t]["recall"].append(r["recallAt10"])
        by_type[t]["mrr"].append(r["mrr"])
        by_type[t]["ndcg"].append(r["ndcgAt10"])
    tfidf_by_type = {}
    for t, v in by_type.items():
        tfidf_by_type[t] = {
            "queries": len(v["recall"]),
            "avgRecall@10": round(np.mean(v["recall"]), 4),
            "avgMrr": round(np.mean(v["mrr"]), 4),
            "avgNdcg@10": round(np.mean(v["ndcg"]), 4),
        }

    # Save TF-IDF results
    tfidf_output = {
        "generatedAt": "2026-10-18T15:00:00Z",
        "method": "TF-IDF cosine similarity (sklearn TfidfVectorizer, sublinear_tf=True, max_features=50000)",
        "k": K,
        "aggregate": tfidf_aggregate,
        "byType": tfidf_by_type,
        "results": all_tfidf_results,
    }
    out_path = EVAL_DIR / f"results-tfidf-{NOW}.json"
    out_path.write_text(json.dumps(tfidf_output, indent=2))
    log(f"TF-IDF results saved to {out_path}")

    # Build comparison report
    comparison = {
        "generatedAt": "2026-10-18T15:00:00Z",
        "description": "T2.3 Vector retrieval comparison: BM25 vs TF-IDF cosine",
        "methods": {
            "bm25": "BM25 + field weighting + RRF fusion (eval/run-eval.mjs, mcp-server/src/search.mjs)",
            "tfidf": "TF-IDF cosine similarity (sklearn TfidfVectorizer, sublinear_tf=True, max_features=50000)",
        },
        "k": K,
        "aggregate": {
            "bm25": bm25_results["aggregate"] if bm25_results else None,
            "tfidf": tfidf_aggregate,
        },
        "byType": {
            "bm25": bm25_results["aggregate"].get("byType") if bm25_results else None,
            "tfidf": tfidf_by_type,
        },
        "perSite": {
            "bm25": bm25_results.get("perSite") if bm25_results else None,
            "tfidf": per_site_stats,
        },
        "interpretation": (
            "TF-IDF cosine is a lexical vector method (bag-of-words + cosine), "
            "not a neural dense embedding. It provides a baseline vector comparison. "
            "When a neural embedding endpoint becomes available (env GENETECH_EMBED_URL), "
            "the same harness can be extended to compare against dense neural embeddings "
            "for a fuller semantic retrieval comparison."
        ),
    }
    comp_path = REPORTS_DIR / f"vector-comparison-{NOW}.json"
    comp_path.write_text(json.dumps(comparison, indent=2))
    log(f"Comparison report saved to {comp_path}")

    # Print summary
    log("=" * 60)
    log(f"{'Method':<12} {'R@10':<10} {'MRR':<10} {'NDCG@10':<10}")
    log("-" * 60)
    if bm25_results:
        agg = bm25_results["aggregate"]
        log(f"{'BM25':<12} {agg['avgRecall@10']:<10.4f} {agg['avgMrr']:<10.4f} {agg['avgNdcg@10']:<10.4f}")
    log(f"{'TF-IDF':<12} {tfidf_aggregate['avgRecall@10']:<10.4f} {tfidf_aggregate['avgMrr']:<10.4f} {tfidf_aggregate['avgNdcg@10']:<10.4f}")
    log("=" * 60)

    if bm25_results:
        b_r = bm25_results["aggregate"]["avgRecall@10"]
        t_r = tfidf_aggregate["avgRecall@10"]
        delta = t_r - b_r
        log(f"TF-IDF vs BM25 Recall@10 delta: {delta:+.4f}")


if __name__ == "__main__":
    main()
