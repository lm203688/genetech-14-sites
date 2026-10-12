"""
GeneTech Knowledge Engine — Python SDK

零依赖（只用标准库），单文件，可直接拷贝进任何项目。

    from gentech import GeneTech

    g = GeneTech(api_key="gt_xxx")      # 没有 key 也能用公开端点
    g.health()
    g.domains()                         # 30 域总量与 lastUpdated
    for e in g.citation_edges():
        ...

本地样本包（不需要 key、不需要联网）：

    g.iter_sample_pack()                # 迭代 consumer-sdk/samples/sample-10k.jsonl

CLI：

    python gentech.py health
    python gentech.py domains
    python gentech.py sample --limit 5

设计取舍：故意不用 requests/httpx，也不做连接池。这个 SDK 的定位是"数据层的
最小接入面"，不是通用 HTTP 客户端。零依赖意味着它可以被放进离线环境、放进
容器镜像、放进别人的 notebook 而不会引发依赖冲突。
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, Iterator, List, Optional, Sequence


__version__ = "1.0.0"

DEFAULT_BASE_URL = "https://api.swarmlabs.tools"
TIMEOUT = 30.0
USER_AGENT = f"gentech-python-sdk/{__version__}"


class GeneTechError(Exception):
    """SDK 的基类异常。"""


class ApiError(GeneTechError):
    """HTTP 4xx/5xx 或非 JSON 响应。"""

    def __init__(self, status: int, body: str, endpoint: str) -> None:
        self.status = status
        self.body = body
        self.endpoint = endpoint
        super().__init__(f"{endpoint} -> HTTP {status}: {body[:300]}")


class KeyRequired(ApiError):
    """401：端点需要 key。注意这不是故障，是设计如此。"""


class GeneTech:
    """GeneTech 知识引擎客户端。

    公开端点（health / domains / registry / citation/edges / citation/gaps）
    不需要 key。语义检索与 intel 端点需要 key，未配置时抛 KeyRequired。
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = TIMEOUT,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or os.environ.get("GENETECH_API_KEY")
        self.timeout = timeout

    # ---------------------------------------------------------------- 公开端点
    def health(self) -> Dict[str, Any]:
        """GET /health。"""
        return self._get("/health", require_key=False)

    def domains(self) -> Dict[str, Any]:
        """GET /v1/domains —— 30 域总量、lastUpdated 与相对路径。

        返回体形如 {"totalSites": 30, "totalEntities": N, "sites": [...]}。
        注意 sites[] 里给的是 GitHub Pages **相对路径**（index / entities），
        不是自定义域名。30 个站点子域从未配置 DNS。
        """
        return self._get("/v1/domains", require_key=False)

    def registry(self) -> List[Dict[str, Any]]:
        """GET /v1/oss/registry —— 开源项目注册表。"""
        return self._get("/v1/oss/registry", require_key=False)

    def citation_edges(self) -> Dict[str, Any]:
        """GET /v1/citation/edges —— 跨域引用边（28,001 条，约 2.4 MB）。"""
        return self._get("/v1/citation/edges", require_key=False)

    def citation_gaps(self) -> Dict[str, Any]:
        """GET /v1/citation/gaps —— 零引用域缺口矩阵。"""
        return self._get("/v1/citation/gaps", require_key=False)

    def entities(self, site: Optional[str] = None) -> Dict[str, Any]:
        """GET /v1/entities 或 /v1/entities/<site>。"""
        path = "/v1/entities" + (f"/{site}" if site else "")
        return self._get(path, require_key=False)

    # ---------------------------------------------------------------- 需 key
    def search_semantic(
        self,
        query: str,
        top_k: int = 10,
        sites: Optional[Sequence[str]] = None,
        site: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /v1/search/semantic。需要 API key。

        sites 是列表参数；site 是它的单值便捷写法（两者都给时 sites 优先）。
        未配置 key 时抛 KeyRequired（401 是设计如此，不是服务故障）。
        """
        payload: Dict[str, Any] = {"query": query, "topK": top_k}
        if sites is not None:
            payload["sites"] = list(sites)
        elif site is not None:
            payload["sites"] = [site]
        return self._post("/v1/search/semantic", payload, require_key=True)

    # ---------------------------------------------------------------- 本地样本包
    @staticmethod
    def sample_pack_path() -> str:
        """样本包默认位置：consumer-sdk/samples/sample-10k.jsonl。"""
        return os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "samples", "sample-10k.jsonl"
        )

    def iter_sample_pack(self, path: Optional[str] = None) -> Iterator[Dict[str, Any]]:
        """逐行迭代本地样本包。不需要 key、不需要联网。

        默认读 samples/sample-10k.jsonl（10,020 条，约 8 MB）。
        JSONL 一行一条，所以可以用生成器流式消费，不占内存。
        """
        p = path or self.sample_pack_path()
        with open(p, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    yield json.loads(line)

    def load_sample_pack(self, path: Optional[str] = None) -> List[Dict[str, Any]]:
        """一次性载入样本包到内存。"""
        return list(self.iter_sample_pack(path))

    # ---------------------------------------------------------------- 归因
    @staticmethod
    def attribution_note(retrieved_on: Optional[str] = None) -> str:
        """生成一条符合归因规范的数据源声明。

        规范见 docs/attribution.md。引用本知识库的内容时请把 provider、
        取数时间一起带上，并且不要把带 DOI 的上游记录说成本方数据。
        """
        when = retrieved_on or "unknown date"
        return (
            f"Data source: GeneTech Knowledge Engine ({DEFAULT_BASE_URL}), "
            f"retrieved {when}. "
            "Original upstream: see the `source` field of each record "
            "(crossref | openalex | europepmc | pubmed | datacite | arxiv | preprints | semanticscholar)."
        )

    # ---------------------------------------------------------------- HTTP
    def _headers(self, require_key: bool) -> Dict[str, str]:
        h = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        elif require_key:
            # 不静默降级：明确告诉调用方"这个端点要 key，你根本没配"。
            raise KeyRequired(401, "GENETECH_API_KEY not set", "local")
        return h

    def _request(self, method: str, path: str, body: Optional[bytes] = None, require_key: bool = False) -> bytes:
        url = self.base_url + path
        req = urllib.request.Request(url, data=body, method=method, headers=self._headers(require_key))
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            err = ApiError(e.code, raw, path)
            if e.code == 401:
                err = KeyRequired(e.code, raw, path)
            raise err

    def _get(self, path: str, require_key: bool = False) -> Any:
        return json.loads(self._request("GET", path, require_key=require_key).decode("utf-8"))

    def _post(self, path: str, payload: Dict[str, Any], require_key: bool = False) -> Any:
        body = json.dumps(payload).encode("utf-8")
        return json.loads(self._request("POST", path, body=body, require_key=require_key).decode("utf-8"))


# --------------------------------------------------------------------------- CLI
_COMMANDS = {
    "health": lambda g: g.health(),
    "domains": lambda g: g.domains(),
    "registry": lambda g: g.registry(),
    "citation-edges": lambda g: g.citation_edges(),
    "citation-gaps": lambda g: g.citation_gaps(),
}


def _cli(argv: Sequence[str]) -> int:
    if not argv:
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]

    if cmd == "sample":
        limit = 5
        for a in rest:
            if a.startswith("--limit="):
                limit = int(a.split("=", 1)[1])
        for i, rec in enumerate(GeneTech().iter_sample_pack()):
            if i >= limit:
                break
            print(json.dumps({k: rec.get(k) for k in ("site", "id", "source", "name", "confidence", "quality_tier")}, ensure_ascii=False))
        return 0

    if cmd == "attribution":
        print(GeneTech.attribution_note())
        return 0

    if cmd in ("--version", "-v"):
        print(__version__)
        return 0

    if cmd in ("--help", "-h"):
        print(__doc__)
        return 0

    if cmd not in _COMMANDS:
        print(f"unknown command: {cmd}")
        print(__doc__)
        return 2

    try:
        print(json.dumps(_COMMANDS[cmd](GeneTech()), ensure_ascii=False, indent=2)[:2000])
    except GeneTechError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))
