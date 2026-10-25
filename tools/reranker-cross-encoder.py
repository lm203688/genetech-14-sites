#!/usr/bin/env python3
"""
BGE-Reranker-v2-m3 Cross-Encoder Reranker
==========================================
对 BM25-gated cosine 的 top-N 候选进行精排。

用法：
  python tools/reranker-cross-encoder.py --eval eval/results-hybrid-gated-3site.json --k 20

输入：eval 结果文件（包含 top-10 候选 ID 和 relevantIds）
输出：精排后的结果文件（results-reranked.json）

模型：BAAI/bge-reranker-v2-m3 (via ModelScope, CPU-only)
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

# --- 模型加载 ---
import torch
import torch.nn as nn
from safetensors.torch import load_file
from transformers import XLMRobertaModel, AutoTokenizer

MODEL_CACHE = os.path.expanduser('~/.cache/modelscope')
MODEL_LOCAL = os.path.join(MODEL_CACHE, 'models', 'AI-ModelScope--bge-reranker-v2-m3', 'snapshots', 'master')

print(f'[reranker] Loading BGE-Reranker-v2-m3 from {MODEL_LOCAL}...')
t0 = time.time()

tokenizer = AutoTokenizer.from_pretrained(MODEL_LOCAL)
base_model = XLMRobertaModel.from_pretrained(MODEL_LOCAL)

# 手动加载 classifier head（ModelScope 版本与 transformers 标准架构不匹配）
sd = load_file(os.path.join(MODEL_LOCAL, 'model.safetensors'))
dense = nn.Linear(sd['classifier.dense.weight'].shape[1], sd['classifier.dense.weight'].shape[0])
dense.load_state_dict({'weight': sd['classifier.dense.weight'], 'bias': sd['classifier.dense.bias']})
out_proj = nn.Linear(sd['classifier.out_proj.weight'].shape[1], sd['classifier.out_proj.weight'].shape[0])
out_proj.load_state_dict({'weight': sd['classifier.out_proj.weight'], 'bias': sd['classifier.out_proj.bias']})

base_model.eval()
dense.eval()
out_proj.eval()

print(f'[reranker] Model loaded in {time.time()-t0:.1f}s')

def score_pairs(query, passages, batch_size=8):
    """对 (query, passage) 对进行精排打分。"""
    pairs = [[query, p] for p in passages]
    scores = []
    for i in range(0, len(pairs), batch_size):
        batch = pairs[i:i+batch_size]
        inputs = tokenizer(batch, padding=True, truncation=True, return_tensors='pt', max_length=512)
        with torch.no_grad():
            outputs = base_model(**inputs)
            cls_out = outputs.last_hidden_state[:, 0, :]
            hidden = torch.tanh(dense(cls_out))
            logits = out_proj(hidden).squeeze(-1)
            scores.extend(logits.tolist())
    return scores

# --- 实体文本提取 ---
def load_entities(site):
    """加载站点的 entities.json，返回 {id: text} 映射。"""
    p = Path(site) / 'website' / 'api' / 'entities.json'
    if not p.exists():
        print(f'  [warn] {p} not found')
        return {}
    raw = json.loads(p.read_text())
    ents = raw if isinstance(raw, list) else raw.get('entities', [])
    result = {}
    for e in ents:
        eid = e.get('id') or f"{e.get('_site', site)}:{e.get('name', '')}"
        name = e.get('name') or e.get('title') or ''
        tags = ' '.join(e.get('tags', [])) if isinstance(e.get('tags'), list) else e.get('tags', '')
        abstract = e.get('abstract', '')
        text = f"{name}. {tags}. {abstract}".strip()
        if text:
            result[eid] = text[:512]  # truncation for tokenizer
    return result

# --- 主流程 ---
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--eval', required=True, help='eval 结果文件路径')
    ap.add_argument('--k', type=int, default=10, help='精排后的 top-K')
    ap.add_argument('--out', help='输出文件路径（默认：results-reranked.json）')
    args = ap.parse_args()

    eval_path = args.eval
    out_path = args.out or 'eval/results-reranked.json'
    k = args.k

    print(f'\n[reranker] 读取 {eval_path}')
    data = json.loads(Path(eval_path).read_text())
    results = data['results']
    print(f'[reranker] 共 {len(results)} 个查询')

    # 按站点分组加载实体
    sites = set(r['site'] for r in results)
    print(f'[reranker] 涉及 {len(sites)} 个站点: {sorted(sites)}')
    entity_text = {}
    for site in sites:
        print(f'[reranker] 加载 {site} 实体...')
        entity_text.update(load_entities(site))
    print(f'[reranker] 共加载 {len(entity_text)} 个实体文本')

    # 对每个查询进行精排
    new_results = []
    t_start = time.time()
    for i, r in enumerate(results):
        query = r['query']
        top10 = r['top10']
        relevant_ids = set(r['relevantIds'])
        relevant_count = r['relevantCount']

        # 收集候选实体的文本
        candidates = []
        for eid in top10:
            if eid in entity_text:
                candidates.append((eid, entity_text[eid]))

        if not candidates:
            new_results.append(r)
            continue

        # Cross-encoder 精排
        t_q = time.time()
        scores = score_pairs(query, [c[1] for c in candidates])
        t_q = time.time() - t_q

        # 按精排分数重新排序
        scored = list(zip(candidates, scores))
        scored.sort(key=lambda x: x[1], reverse=True)
        new_top10 = [c[0] for c, _ in scored[:k]]

        # 计算新指标
        new_top10_set = set(new_top10[:10])
        new_r10 = len(new_top10_set & relevant_ids) / max(1, len(relevant_ids))
        new_hit = len(set(r['top10'][:10]) & relevant_ids)
        # MRR: 第一个 relevant 在 new_top10 中的排名
        new_mrr = 0.0
        for rank, eid in enumerate(new_top10, 1):
            if eid in relevant_ids:
                new_mrr = 1.0 / rank
                break

        new_results.append({
            **r,
            'top10': new_top10,
            'recall@10': new_r10,
            'mrr': new_mrr,
            'rerank_score': [round(s, 4) for _, s in scored[:10]],
            'rerank_ms': round(t_q * 1000, 1),
        })

        if (i + 1) % 10 == 0 or i == len(results) - 1:
            elapsed = time.time() - t_start
            avg = elapsed / (i + 1)
            print(f'[reranker] {i+1}/{len(results)} done, avg={avg:.2f}s/query')

    # 计算聚合指标
    def mean(xs):
        return sum(xs) / len(xs) if xs else 0

    def quantile(xs, q):
        if not xs: return 0
        s = sorted(xs)
        return s[min(len(s)-1, int(q * len(s)))]

    aggregate = {
        'queryCount': len(new_results),
        'avgRecall@10': mean([r['recall@10'] for r in new_results]),
        'avgMrr': mean([r['mrr'] for r in new_results]),
        'perfectCount': sum(1 for r in new_results if r['recall@10'] == 1),
        'missCount': sum(1 for r in new_results if r['recall@10'] == 0),
    }

    # 按类型分解
    by_type = {}
    for r in new_results:
        t = r.get('type') or r.get('type') or 'unknown'
        if t not in by_type:
            by_type[t] = {'n': 0, 'r10': 0, 'mrr': 0}
        by_type[t]['n'] += 1
        by_type[t]['r10'] += r['recall@10']
        by_type[t]['mrr'] += r['mrr']
    for t in by_type:
        by_type[t]['r10'] /= by_type[t]['n']
        by_type[t]['mrr'] /= by_type[t]['n']
    aggregate['byType'] = by_type

    # 输出
    output = {
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'reranker': 'BAAI/bge-reranker-v2-m3',
        'source': eval_path,
        'k': k,
        'aggregate': aggregate,
        'results': new_results,
    }
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(output, indent=2))

    total_time = time.time() - t_start
    print(f'\n[reranker] 完成! 总耗时={total_time:.1f}s')
    print(f'[reranker] R@10: {aggregate["avgRecall@10"]:.4f} | MRR: {aggregate["avgMrr"]:.4f}')
    print(f'[reranker] 完美: {aggregate["perfectCount"]} | 未召回: {aggregate["missCount"]}')
    print(f'[reranker] 输出: {out_path}')

if __name__ == '__main__':
    main()
