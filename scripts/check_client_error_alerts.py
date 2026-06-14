#!/usr/bin/env python3
"""Check recent frontend client-error volume and optionally send an alert."""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

from sqlalchemy import func

sys.path.insert(0, os.getcwd())

from app.ai import models as _ai_models  # noqa: F401
from app.audit import models as _audit_models  # noqa: F401
from app.auth import models as _auth_models  # noqa: F401
from app.client_errors.models import ClientErrorEvent
from app.database import SessionLocal
from app.datasets import models as _dataset_models  # noqa: F401
from app.figures import models as _figure_models  # noqa: F401
from app.projects import models as _project_models  # noqa: F401


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw in (None, ""):
        return default
    return int(raw)


def _build_payload(fmt: str, title: str, message: str) -> dict[str, object]:
    if fmt == "slack":
        return {"text": message}
    if fmt == "discord":
        return {"content": message}
    return {
        "title": title,
        "message": message,
        "severity": "warning",
        "source": "client-error-volume",
        "text": message,
    }


def _send_alert(payload: dict[str, object], fmt: str, timeout: float) -> None:
    webhook_url = os.environ.get("CLIENT_ERROR_ALERT_WEBHOOK_URL", "")
    if not webhook_url:
        print("SKIP client-error alert: CLIENT_ERROR_ALERT_WEBHOOK_URL is not set")
        return
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        webhook_url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "LabPlot-ClientErrorAlert/1.0"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status >= 400:
            raise RuntimeError(f"client-error alert webhook returned HTTP {resp.status}")
    print(f"PASS client-error alert sent via {fmt} webhook")


def main() -> None:
    parser = argparse.ArgumentParser(description="Alert when recent LabPlot frontend client errors exceed a threshold.")
    parser.add_argument("--dry-run", action="store_true", help="Print the alert payload instead of sending it.")
    args = parser.parse_args()

    window_minutes = _env_int("CLIENT_ERROR_ALERT_WINDOW_MINUTES", 15)
    threshold = _env_int("CLIENT_ERROR_ALERT_THRESHOLD", 25)
    webhook_format = os.environ.get("CLIENT_ERROR_ALERT_WEBHOOK_FORMAT", "generic").lower()
    timeout = float(os.environ.get("CLIENT_ERROR_ALERT_TIMEOUT_SEC", "10"))
    if webhook_format not in {"generic", "slack", "discord"}:
        raise ValueError("CLIENT_ERROR_ALERT_WEBHOOK_FORMAT must be one of: generic, slack, discord")

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=window_minutes)
    with SessionLocal() as db:
        count = (
            db.query(func.count(ClientErrorEvent.id))
            .filter(ClientErrorEvent.created_at >= cutoff)
            .scalar()
            or 0
        )
        top_rows = (
            db.query(ClientErrorEvent.source, ClientErrorEvent.path, ClientErrorEvent.message, func.count(ClientErrorEvent.id))
            .filter(ClientErrorEvent.created_at >= cutoff)
            .group_by(ClientErrorEvent.source, ClientErrorEvent.path, ClientErrorEvent.message)
            .order_by(func.count(ClientErrorEvent.id).desc())
            .limit(5)
            .all()
        )

    print(f"client_errors={count} window_minutes={window_minutes} threshold={threshold}")
    if count < threshold:
        return

    title = "LabPlot frontend client-error volume is high"
    lines = [
        f"[WARNING] {title}",
        f"{count} browser/client errors were recorded in the last {window_minutes} minutes.",
        f"threshold: {threshold}",
    ]
    if top_rows:
        lines.append("top errors:")
        for source, path, message, row_count in top_rows:
            clean_message = " ".join((message or "").split())[:180]
            lines.append(f"- {row_count}x {source} {path or '-'}: {clean_message}")
    payload = _build_payload(webhook_format, title, "\n".join(lines))

    if args.dry_run:
        print(json.dumps(payload, separators=(",", ":")))
        return
    _send_alert(payload, webhook_format, timeout)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"FAIL client-error alert check: {exc}", file=sys.stderr)
        raise
