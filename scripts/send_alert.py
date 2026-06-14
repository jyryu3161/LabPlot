#!/usr/bin/env python3
"""Send a small operational alert to an external webhook."""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request


def build_payload(fmt: str, title: str, message: str, severity: str, source: str, url: str) -> dict[str, object]:
    text = f"[{severity.upper()}] {title}\n{message}"
    if source:
        text += f"\nsource: {source}"
    if url:
        text += f"\nurl: {url}"

    if fmt == "slack":
        return {"text": text}
    if fmt == "discord":
        return {"content": text}
    return {
        "title": title,
        "message": message,
        "severity": severity,
        "source": source,
        "url": url,
        "text": text,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Send a LabPlot operational alert webhook.")
    parser.add_argument("--dry-run", action="store_true", help="Print the payload instead of sending it.")
    args = parser.parse_args()

    webhook_url = os.environ.get("ALERT_WEBHOOK_URL", "")
    webhook_format = os.environ.get("ALERT_WEBHOOK_FORMAT", "generic").lower()
    timeout = float(os.environ.get("ALERT_TIMEOUT_SEC", "10"))
    title = os.environ.get("ALERT_TITLE", "LabPlot alert")
    message = os.environ.get("ALERT_MESSAGE", "Operational alert triggered.")
    severity = os.environ.get("ALERT_SEVERITY", "warning")
    source = os.environ.get("ALERT_SOURCE", "")
    url = os.environ.get("ALERT_URL", "")

    if webhook_format not in {"generic", "slack", "discord"}:
        raise ValueError("ALERT_WEBHOOK_FORMAT must be one of: generic, slack, discord")

    payload = build_payload(webhook_format, title, message, severity, source, url)
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")

    if args.dry_run:
        print(body.decode("utf-8"))
        return

    if not webhook_url:
        print("SKIP alert: ALERT_WEBHOOK_URL is not set")
        return

    req = urllib.request.Request(
        webhook_url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "LabPlot-Alert/1.0"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status >= 400:
            raise RuntimeError(f"alert webhook returned HTTP {resp.status}")
    print(f"PASS alert sent via {webhook_format} webhook")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"FAIL alert: {exc}", file=sys.stderr)
        raise
