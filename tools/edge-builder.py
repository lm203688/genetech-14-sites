#!/usr/bin/env python3
"""
GeneTech 知识图谱边自动填充器（edge-builder.py）
-------------------------------------------------
功能：从各实体数据集中提取跨域共现关系，自动为 knowledge-graph-entities.json
      补充 edges，解决"4075 节点仅 50 边"的稀疏问题。

算法：
  1. 扫描 data/*.json 中的 academic-entities / crossref-entities / pubmed-entities
  2. 对每条实体，提取：
     - tags（领域标签）
     - title + abstract 中的关键词（英文按词、中文按字）
     - citation keywords / MeSH terms（PubMed）
  3. 统计 tag 共现频次：若 tag A 和 tag B 在 N 条以上实体中同时出现，
     则在 A 与 B 之间建一条有向边，权重 = 共现次数
  4. 限制总边数 ≤ 5000，按权重降序选取 top-K

使用：
  python tools/edge-builder.py                          # 使用默认参数
  python tools/edge-builder.py --max-edges 3000         # 限制最大边数
  python tools/edge-builder.py --min-cooccurrence 3     # 降低共现阈值
  python tools/edge-builder.py --dry-run                # 只输出统计，不写文件
"""

import json
import sys
import os
from pathlib import Path
from collections import Counter, defaultdict
from typing import Dict, List, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / 'data'
STATE_DIR = REPO_ROOT / 'state'
KG_FILE = DATA_DIR / 'knowledge-graph-entities.json'

# 默认配置
DEFAULT_MAX_EDGES = 5000
DEFAULT_MIN_COOC = 3
MAX_TAGS_PER_ENTITY = 10  # 每实体最多贡献的 tag，防偏斜


def load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def tokenize_text(text: str) -> List[str]:
    """提取英文词 + CJK 字符"""
    if not text:
        return []
    s = text.lower()
    tokens = []
    import re
    latin = re.findall(r'[a-z0-9]+', s)
    tokens.extend(latin)
    cjk = re.findall(r'[\u4e00-\u9fff]', s)
    tokens.extend(cjk)
    return tokens


def extract_tags(entity: dict) -> List[str]:
    """从实体中提取领域标签"""
    tags = []

    # source site domain
    site = entity.get('_site', '') or entity.get('site', '')
    if site:
        tags.append(site)

    # domain / category
    for k in ('domain', 'category', 'type'):
        v = entity.get(k, '')
        if v:
            tags.append(str(v))

    # tags array
    ent_tags = entity.get('tags', [])
    if isinstance(ent_tags, list):
        tags.extend([str(t).lower() for t in ent_tags[:MAX_TAGS_PER_ENTITY]])
    elif isinstance(ent_tags, str):
        tags.append(ent_tags.lower())

    # keywords (CrossRef / OpenAlex)
    for k in ('keywords', 'primary_topic'):
        v = entity.get(k)
        if isinstance(v, list):
            tags.extend([str(x).lower() for x in v[:MAX_TAGS_PER_ENTITY]])
        elif isinstance(v, dict):
            for kk in ('keyword', 'text', 'topic'):
                val = v.get(kk)
                if val:
                    tags.append(str(val).lower())

    # title + abstract keywords
    for field in ('title', 'abstract', 'summary'):
        v = entity.get(field)
        if v:
            tokens = tokenize_text(str(v))
            tags.extend(tokens[:5])  # 每条实体最多贡献 5 个关键词 tag

    return list(dict.fromkeys(tags))  # 去重保序


def build_cooccurrence_matrix(entities: List[dict]) -> Dict[Tuple[str, str], int]:
    """统计 tag 共现频次"""
    cooc = Counter()
    for ent in entities:
        tags = extract_tags(ent)
        unique_tags = list(dict.fromkeys(tags))
        # 对每个 tag 组合统计共现
        for i, t1 in enumerate(unique_tags):
            for t2 in unique_tags[i + 1:]:
                pair = tuple(sorted([t1, t2]))
                cooc[pair] += 1
    return cooc


def load_all_entities() -> List[dict]:
    """从多个数据集文件加载实体"""
    all_entities = []
    patterns = [
        'academic-entities.json',
        'crossref-entities.json',
        'pubmed-entities.json',
        'openalex-entities.json',
    ]
    seen_ids = set()
    for fname in patterns:
        fpath = DATA_DIR / fname
        if not fpath.exists():
            continue
        try:
            data = load_json(fpath)
            ents = data if isinstance(data, list) else data.get('entities', [])
            for e in ents:
                eid = e.get('id')
                if eid and eid not in seen_ids:
                    seen_ids.add(eid)
                    all_entities.append(e)
        except Exception as ex:
            print(f'[edge-builder] 跳过 {fname}: {ex}', file=sys.stderr)
    return all_entities


def build_edges(cooc: Counter, min_cooc: int, max_edges: int) -> List[dict]:
    """从共现矩阵生成边列表"""
    edges = []
    for (t1, t2), count in cooc.most_common():
        if count < min_cooc:
            continue
        # 确定源 domain 和目标 domain（取较长的 tag 作为 source）
        src = t1 if len(t1) >= len(t2) else t2
        tgt = t2 if len(t1) >= len(t2) else t1
        edges.append({
            'source': src,
            'sourceDomain': src,
            'target': tgt,
            'targetDomain': tgt,
            'relation': 'co-occurrence',
            'label': f'共现 {count} 次',
            'weight': count,
        })
        if len(edges) >= max_edges:
            break
    return edges


def merge_edges(existing: List[dict], new_edges: List[dict]) -> List[dict]:
    """合并新旧边：优先保留原有语义边，补充新边"""
    existing_keys = {(e.get('source'), e.get('target')) for e in existing}
    merged = list(existing)
    added = 0
    for e in new_edges:
        key = (e['source'], e['target'])
        if key not in existing_keys:
            merged.append(e)
            existing_keys.add(key)
            added += 1
    return merged, added


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Knowledge graph edge builder')
    parser.add_argument('--max-edges', type=int, default=DEFAULT_MAX_EDGES)
    parser.add_argument('--min-cooccurrence', type=int, default=DEFAULT_MIN_COOC)
    parser.add_argument('--dry-run', action='store_true', help='只输出统计，不写文件')
    args = parser.parse_args()

    print(f'[edge-builder] 加载实体...', file=sys.stderr)
    entities = load_all_entities()
    print(f'[edge-builder] 共 {len(entities)} 条实体', file=sys.stderr)

    if not entities:
        print('[edge-builder] 未找到实体，退出', file=sys.stderr)
        return

    print(f'[edge-builder] 计算共现矩阵（阈值={args.min_cooccurrence}）...', file=sys.stderr)
    cooc = build_cooccurrence_matrix(entities)
    print(f'[edge-builder] 共现对数量: {len(cooc)}', file=sys.stderr)

    new_edges = build_edges(cooc, args.min_cooccurrence, args.max_edges)
    print(f'[edge-builder] 新边候选: {len(new_edges)}', file=sys.stderr)

    # 加载现有边
    kg_data = load_json(KG_FILE)
    existing_edges = kg_data.get('edges', [])
    print(f'[edge-builder] 现有边: {len(existing_edges)}', file=sys.stderr)

    merged_edges, added = merge_edges(existing_edges, new_edges)
    print(f'[edge-builder] 新增边: {added}, 合并后总边: {len(merged_edges)}', file=sys.stderr)

    if args.dry_run:
        print(f'\n[dry-run] 前 20 条新边:', file=sys.stderr)
        for e in new_edges[:20]:
            print(f"  {e['source']} -> {e['target']} (w={e['weight']})", file=sys.stderr)
        return

    # 写回
    kg_data['edges'] = merged_edges
    kg_data['builtAt'] = __import__('datetime').datetime.utcnow().isoformat() + 'Z'
    kg_data['version'] = '2.0'
    kg_data['edge_builder_stats'] = {
        'entities_scanned': len(entities),
        'cooccurrence_pairs': len(cooc),
        'new_edges_added': added,
        'total_edges': len(merged_edges),
        'min_cooccurrence': args.min_cooccurrence,
        'max_edges': args.max_edges,
    }

    with open(KG_FILE, 'w', encoding='utf-8') as f:
        json.dump(kg_data, f, ensure_ascii=False, indent=2)

    print(f'[edge-builder] ✓ 已写回 {KG_FILE}', file=sys.stderr)
    print(f'[edge-builder]   现有边: {len(existing_edges)} → 合并后: {len(merged_edges)} (+{added})', file=sys.stderr)


if __name__ == '__main__':
    main()
