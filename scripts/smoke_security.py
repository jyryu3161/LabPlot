#!/usr/bin/env python3
"""Production smoke/security checks for a running LabPlot deployment.

Defaults target the local Docker deployment:
  python scripts/smoke_security.py

Override with:
  API_BASE=http://127.0.0.1:8071 PUBLIC_BASE=https://labplotai.com python scripts/smoke_security.py
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.error
import urllib.request


API_BASE = os.environ.get("API_BASE", "http://127.0.0.1:8071").rstrip("/")
PUBLIC_BASE = os.environ.get("PUBLIC_BASE", "https://labplotai.com").rstrip("/")
PUBLIC_HOST = os.environ.get("PUBLIC_HOST", "labplotai.com")
LOCAL_RESOLVE_IP = os.environ.get("LOCAL_RESOLVE_IP", "127.0.0.1")


def request(method: str, url: str, body: dict | None = None, headers: dict | None = None) -> tuple[int, str, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    if body is not None:
        req.add_header("Content-Type", "application/json")
    context = ssl._create_unverified_context() if url.startswith("https://") else None
    try:
        with urllib.request.urlopen(req, timeout=20, context=context) as resp:
            return resp.status, resp.read().decode("utf-8", "ignore"), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore"), dict(e.headers)


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'} {name}{': ' + detail if detail else ''}")
    if not ok:
        raise SystemExit(1)


def main() -> None:
    status, body, headers = request("GET", f"{API_BASE}/api/health")
    check("api health", status == 200 and '"status":"ok"' in body.replace(" ", ""), f"status={status}")

    status, _, headers = request("GET", f"{API_BASE}/api/health", headers={"Origin": "https://evil.example"})
    check("cors rejects unknown origin", "access-control-allow-origin" not in {k.lower(): v for k, v in headers.items()}, str(headers))

    status, _, headers = request("GET", f"{API_BASE}/api/health", headers={"Origin": f"https://{PUBLIC_HOST}"})
    lowered = {k.lower(): v for k, v in headers.items()}
    check("cors allows public origin", lowered.get("access-control-allow-origin") == f"https://{PUBLIC_HOST}")

    status, _, _ = request("GET", f"{API_BASE}/static/uploads/not-real.csv")
    check("static uploads unavailable on backend", status == 404, f"status={status}")

    statuses = []
    for _ in range(21):
        status, _, _ = request(
            "POST",
            f"{API_BASE}/api/auth/login",
            {"email": "missing@example.com", "password": "wrong"},
            {"X-Forwarded-For": "198.51.100.241"},
        )
        statuses.append(status)
    check("login rate limit", statuses[-1] == 429, f"last={statuses[-1]}")

    # The public endpoint may require DNS/TLS in real deployments. Use curl --resolve
    # externally for edge checks when running against localhost Caddy.
    print("INFO edge header check command:")
    print(f"curl -k --resolve {PUBLIC_HOST}:443:{LOCAL_RESOLVE_IP} -I {PUBLIC_BASE}/")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"FAIL unexpected error: {exc}", file=sys.stderr)
        raise
