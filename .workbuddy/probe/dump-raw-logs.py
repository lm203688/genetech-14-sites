#!/usr/bin/env python
"""把 workflow run 的日志 zip 原始内容逐文件打印（不裁剪），用于判断"某行到底有没有被输出"。

用法: python dump-raw-logs.py <run_id> [只打印含关键字的文件?]
"""
import json
import os
import sys
import zipfile
import urllib.request
import urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SECRETS = os.path.join(ROOT, ".workbuddy", "secrets.json")
with open(SECRETS, encoding="utf-8") as f:
    d = json.load(f)
TOKEN = str(d["GITHUB_TOKEN"]).strip()
OWNER = d.get("OWNER", "lm203688")
REPO = d.get("REPO", "genetech-14-sites")

run_id = sys.argv[1]
url = "https://api.github.com/repos/%s/%s/actions/runs/%s/logs" % (OWNER, REPO, run_id)
req = urllib.request.Request(url, headers={
    "Authorization": "Bearer " + TOKEN,
    "Accept": "application/vnd.github+json",
    "User-Agent": "dump-raw",
})
try:
    raw = urllib.request.urlopen(req).read()
except urllib.error.HTTPError as e:
    print("[fail] HTTP", e.code)
    sys.exit(1)

z = zipfile.ZipFile(__import__("io").BytesIO(raw))
for name in z.namelist():
    data = z.read(name)
    print("=" * 70)
    print("FILE:", name, "bytes:", len(data))
    try:
        txt = data.decode("utf-8")
    except UnicodeDecodeError:
        txt = data.decode("utf-8", "replace")
    for line in txt.split("\n"):
        if line.strip():
            print("  " + line[:240])
