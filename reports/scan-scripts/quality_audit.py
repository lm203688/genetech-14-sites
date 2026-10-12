import json, os, sys, collections, random

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sites = [d for d in os.listdir(root) if os.path.isfile(os.path.join(root, d, 'website', 'api', 'entities.json'))]
sites.sort()
print('域数:', len(sites))

random.seed(7)
sample_sites = random.sample(sites, 10)
agg = {
    'n': 0, 'with_doi': 0, 'with_url': 0, 'with_summary': 0, 'with_tags': 0,
    'conf': collections.Counter(), 'sources': collections.Counter(),
    'dup_titles': 0, 'titles': collections.Counter(),
}
per_site = {}
for s in sample_sites:
    p = os.path.join(root, s, 'website', 'api', 'entities.json')
    try:
        d = json.load(open(p, encoding='utf-8'))
    except Exception as e:
        print(s, 'ERR', e)
        continue
    ents = d if isinstance(d, list) else d.get('entities', d.get('items', []))
    n = len(ents)
    local = {'n': n, 'sum': 0, 'tag': 0, 'doi': 0, 'url': 0}
    titles = collections.Counter()
    for e in ents:
        agg['n'] += 1
        if e.get('doi'):
            agg['with_doi'] += 1; local['doi'] += 1
        if e.get('url') or e.get('sourceUrl'):
            agg['with_url'] += 1; local['url'] += 1
        sm = e.get('summary') or e.get('abstract') or e.get('description') or ''
        if isinstance(sm, str) and len(sm.strip()) > 30:
            agg['with_summary'] += 1; local['sum'] += 1
        tg = e.get('tags') or e.get('keywords') or []
        if tg:
            agg['with_tags'] += 1; local['tag'] += 1
        c = e.get('confidence')
        agg['conf'][c] += 1
        src = e.get('source') or e.get('sourceSite') or e.get('provider') or '?'
        agg['sources'][str(src)[:28]] += 1
        t = (e.get('title') or '').strip().lower()
        if t:
            titles[t] += 1; agg['titles'][t] += 1
    dup = sum(v - 1 for v in titles.values() if v > 1)
    per_site[s] = {
        'n': n,
        '摘要%': round(local['sum'] / n * 100, 1),
        '标签%': round(local['tag'] / n * 100, 1),
        'DOI%': round(local['doi'] / n * 100, 1),
        'URL%': round(local['url'] / n * 100, 1),
        '重名%': round(dup / n * 100, 1),
    }
n = agg['n']
print('\n=== 10站抽样聚合 (n=%d) ===' % n)
print('摘要完整度 : %.1f%%' % (agg['with_summary'] / n * 100))
print('有标签率   : %.1f%%' % (agg['with_tags'] / n * 100))
print('DOI 覆盖   : %.1f%%' % (agg['with_doi'] / n * 100))
print('URL 覆盖   : %.1f%%' % (agg['with_url'] / n * 100))
print('confidence :', dict(agg['conf'].most_common(8)))
print('\n=== 各站明细 ===')
for s, v in sorted(per_site.items(), key=lambda x: x[1]['摘要%']):
    print('%-22s %s' % (s, v))
print('\n=== 来源 TOP10 ===')
for k, v in agg['sources'].most_common(10):
    print('%-30s %d' % (k, v))
