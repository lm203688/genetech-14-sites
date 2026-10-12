import json, os, urllib.request, concurrent.futures as cf

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sites = sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d, 'website')))

def probe(s):
    url = f'https://lm203688.github.io/genetech-14-sites/{s}/'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'probe/1.0'})
        with urllib.request.urlopen(req, timeout=15) as r:
            return s, r.status
    except Exception as e:
        return s, getattr(e, 'code', str(e)[:20])

with cf.ThreadPoolExecutor(max_workers=10) as ex:
    res = list(ex.map(probe, sites))

ok = [s for s, c in res if c == 200]
bad = [(s, c) for s, c in res if c != 200]
print(f'GitHub Pages 200: {len(ok)}/{len(sites)}')
print('非200:', bad)
