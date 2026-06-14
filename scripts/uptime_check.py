#!/usr/bin/env python3
"""External uptime check for LabPlot public endpoints."""
from __future__ import annotations

import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

HEALTH_URL = os.environ.get("UPTIME_HEALTH_URL", "https://labplotai.com/api/health")
HOME_URL = os.environ.get("UPTIME_HOME_URL", "https://labplotai.com/")
TIMEOUT = float(os.environ.get("UPTIME_TIMEOUT_SEC", "20"))


def fetch(url: str) -> tuple[int, bytes, float]:
    req = urllib.request.Request(url, headers={"User-Agent": "LabPlot-Uptime/1.0"})
    context = ssl.create_default_context()
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=context) as resp:
            return resp.status, resp.read(), time.monotonic() - start
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), time.monotonic() - start


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    status, body, elapsed = fetch(HEALTH_URL)
    require(status == 200, f"health returned {status}")
    payload = json.loads(body.decode("utf-8"))
    require(payload.get("status") == "ok", f"health payload is not ok: {payload}")
    require(elapsed < TIMEOUT, f"health took {elapsed:.2f}s")
    print(f"PASS health {HEALTH_URL} {elapsed:.2f}s")

    status, body, elapsed = fetch(HOME_URL)
    require(status == 200, f"home returned {status}")
    require(b"LabPlot" in body or b"LabPlot AI" in body, "home page does not look like LabPlot")
    require(elapsed < TIMEOUT, f"home took {elapsed:.2f}s")
    print(f"PASS home {HOME_URL} {elapsed:.2f}s")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"FAIL uptime check: {exc}", file=sys.stderr)
        raise
