import http.client, ssl, json, base64, os, time, urllib.parse, sys

ctx = ssl._create_unverified_context()
TOKEN = os.environ.get("GH_TOKEN", "")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OWNER, REPO = "lm203688", "genetech-14-sites"

FILES = [
    "tools/deploy-independent-workers.mjs",
    "tools/lib/ask.mjs",
    "unified-license/README.md",
    "unified-license/site-adapter.js",
    "unified-license/verify.js",
]

def api_conn():
    return http.client.HTTPSConnection("api.github.com", timeout=30, context=ctx)

def api_request(method, path, body=None, attempts=8):
    for attempt in range(attempts):
        try:
            conn = api_conn()
            h = {"Authorization": "Bearer " + TOKEN, "User-Agent": "py-final", "Accept": "application/vnd.github+json"}
            data = json.dumps(body).encode("utf-8") if body else None
            if data:
                h["Content-Type"] = "application/json"
            conn.request(method, path, body=data, headers=h)
            r = conn.getresponse()
            d = r.read().decode()
            conn.close()
            return r.status, json.loads(d) if d else None
        except (ssl.SSLError, OSError, ConnectionError) as e:
            print(f"    retry {attempt+1}/{attempts}: {e}")
            time.sleep(3)
    return 0, None

def main():
    success = 0
    for i, f in enumerate(FILES, 1):
        local_path = os.path.join(ROOT, f)
        if not os.path.isfile(local_path):
            print(f"  [{i}/{len(FILES)}] SKIP: {f}")
            continue

        with open(local_path, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode("utf-8")

        print(f"  [{i}/{len(FILES)}] GET {f}...")
        s, remote = api_request("GET", f"/repos/{OWNER}/{REPO}/contents/{urllib.parse.quote(f, safe='')}?ref=master")

        if s == 200:
            sha = remote["sha"]
            msg = f"update {f}"
        elif s == 404:
            sha = None
            msg = f"create {f}"
        else:
            print(f"    FAIL GET {s}")
            continue

        body = {"message": msg, "content": b64, "branch": "master"}
        if sha:
            body["sha"] = sha

        print(f"    PUT...")
        s, r = api_request("PUT", f"/repos/{OWNER}/{REPO}/contents/{urllib.parse.quote(f, safe='')}", body=body)
        if s in (200, 201):
            success += 1
            print(f"    OK {s}: {f}")
        else:
            print(f"    FAIL {s}: {f}")

        time.sleep(1)

    print(f"\nResult: {success}/{len(FILES)}")

if __name__ == "__main__":
    main()
