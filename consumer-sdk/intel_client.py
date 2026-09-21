"""
SwarmLabs Intel Client — 零依赖 Python SDK (>=3.8)

Usage:
    from intel_client import IntelClient

    client = IntelClient(base_url="https://api.swarmlabs.tools", key="ckn_...")
    result = client.submit_demand({
        "consumer": "csm_...",
        "query": {
            "keywords": ["CRISPR", "gene editing"],
            "sites": ["quantum", "tcm"],
            "time_window": "90d",
        },
        "delivery": {"top_n": 50, "format": "json"},
    })
    print(result["results"]["total"])

Key types:
    ckn_  = consumer key (for /v1/intel/* endpoints, per-project)
    gtk_  = site Pro key (also accepted as fallback identity)

Design notes:
- Pure stdlib. urllib + json + hashlib. No pip install.
- 6 endpoint surface mirrors docs/intel-service.md exactly.
- Rate limit is enforced by the server; client does local soft-throttle.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional


class IntelAPIError(Exception):
    def __init__(self, status: int, body: Any):
        self.status = status
        self.body = body
        msg = ""
        if isinstance(body, dict):
            msg = body.get("message") or body.get("error") or ""
        super().__init__(f"[{status}] {msg} | {body}")


class IntelClient:
    """
    Client for https://api.swarmlabs.tools/v1/intel/*

    Attributes:
        base_url  : server base, e.g. "https://api.swarmlabs.tools"
        key       : consumer key ("ckn_...") or site Pro key ("gtk_...")
        timeout   : per-request timeout seconds (default 20)
        soft_rpm  : local soft rate limit, seconds between calls (default None)
    """

    def __init__(
        self,
        base_url: str = "https://api.swarmlabs.tools",
        key: Optional[str] = None,
        timeout: int = 20,
        soft_rpm: Optional[int] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.key = key
        self.timeout = timeout
        self._min_interval = (60.0 / soft_rpm) if soft_rpm else None
        self._last_call = 0.0

    # ---------------- public API ----------------

    def verify(self) -> Dict[str, Any]:
        """Verify the key. Returns parsed payload including cid / tier / exp."""
        return self._request("GET", "/v1/intel/verify")

    def apply(self, application: Dict[str, Any]) -> Dict[str, Any]:
        """POST /v1/intel/apply — register an intake application, get application_id + csm_ cid."""
        return self._request("POST", "/v1/intel/apply", json_body=application)

    def submit_demand(self, spec: Dict[str, Any]) -> Dict[str, Any]:
        """POST /v1/intel/demand — run a demand against the search index."""
        return self._request("POST", "/v1/intel/demand", json_body=spec)

    def get_demand(self, demand_id: str) -> Dict[str, Any]:
        """GET /v1/intel/demand/{id} — fetch a previously submitted demand."""
        return self._request("GET", f"/v1/intel/demand/{demand_id}")

    def list_consumers(self) -> Dict[str, Any]:
        """Admin only: GET /v1/intel/consumer — list all consumer keys."""
        return self._request("GET", "/v1/intel/consumer")

    def admin_state(self, force: bool = False) -> Dict[str, Any]:
        """Admin only: GET /v1/intel/admin/state — full state snapshot."""
        qs = "?force=1" if force else ""
        return self._request("GET", "/v1/intel/admin/state" + qs)

    def health(self) -> Dict[str, Any]:
        """GET /v1/intel/health — cheap liveness probe."""
        return self._request("GET", "/v1/intel/health")

    # ---------------- internals ----------------

    def _throttle(self) -> None:
        if self._min_interval is None:
            return
        elapsed = time.time() - self._last_call
        wait = self._min_interval - elapsed
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.time()

    def _request(
        self,
        method: str,
        path: str,
        json_body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        self._throttle()
        url = self.base_url + path
        data = None
        headers = {
            "Accept": "application/json",
            "User-Agent": "swarmlabs-intel-client/1.0 (+https://swarmlabs.tools)",
        }
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self.key:
            headers["Authorization"] = f"Bearer {self.key}"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                if not raw:
                    return {"_status": resp.status, "_empty": True}
                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    return {"_status": resp.status, "_raw": raw}
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            try:
                body = json.loads(raw) if raw else {"_empty": True}
            except json.JSONDecodeError:
                body = {"_raw": raw}
            raise IntelAPIError(e.code, body) from e


# ---------------- CLI (optional) ----------------

def _cli() -> None:
    import argparse
    p = argparse.ArgumentParser(description="SwarmLabs Intel Client CLI")
    p.add_argument("--base-url", default="https://api.swarmlabs.tools")
    p.add_argument("--key", required=True)
    p.add_argument("cmd", nargs="?", choices=["verify", "health", "apply", "demand", "get", "state", "consumers"], help="Command to run")
    p.add_argument("id", nargs="?", help="demand_id (for 'get')")
    p.add_argument("--file", help="path to JSON file for 'apply' / 'demand'")
    a = p.parse_args()

    client = IntelClient(base_url=a.base_url, key=a.key)
    if a.cmd == "verify":
        out = client.verify()
    elif a.cmd == "health":
        out = client.health()
    elif a.cmd == "state":
        out = client.admin_state()
    elif a.cmd == "consumers":
        out = client.list_consumers()
    elif a.cmd in ("apply", "demand"):
        with open(a.file) as f:
            out = client._request("POST", f"/v1/intel/{a.cmd}", json_body=json.load(f))
    elif a.cmd == "get":
        out = client.get_demand(a.id)
    else:
        raise SystemExit("unknown command")
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    _cli()
