#!/usr/bin/env python3
"""End-to-end API smoke checks for a running LabPlot backend.

Run inside the backend container for file-encryption assertions:
  docker cp scripts/smoke_api.py labplot-backend:/tmp/smoke_api.py
  docker exec labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/smoke_api.py"
"""
from __future__ import annotations

import json
import os
import secrets
import string
import sys
import uuid
import zipfile
from io import BytesIO
import urllib.error
import urllib.request

API_BASE = os.environ.get("API_BASE", "http://127.0.0.1:8000").rstrip("/")
sys.path.insert(0, os.getcwd())


def request(method: str, path: str, body=None, headers=None, content_type: str = "application/json"):
    data = None
    req_headers = dict(headers or {})
    if body is not None:
        if content_type == "application/json":
            data = json.dumps(body).encode("utf-8")
            req_headers["Content-Type"] = "application/json"
        else:
            data = body
            req_headers["Content-Type"] = content_type
    req = urllib.request.Request(API_BASE + path, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            raw = resp.read().decode("utf-8", "ignore")
            return resp.status, json.loads(raw) if raw else None, dict(resp.headers)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "ignore")
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = raw
        return exc.code, parsed, dict(exc.headers)


def request_bytes(method: str, path: str, headers=None):
    req = urllib.request.Request(API_BASE + path, headers=dict(headers or {}), method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers)


def multipart(fields: dict[str, str], files: list[tuple[str, str, str, bytes]]) -> tuple[bytes, str]:
    boundary = "----LabPlotSmoke" + secrets.token_hex(8)
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
        )
    for name, filename, content_type, content in files:
        chunks.append(
            (
                f"--{boundary}\r\n"
                f"Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n"
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode()
        )
        chunks.append(content)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def error_code(payload) -> str | None:
    if not isinstance(payload, dict):
        return None
    detail = payload.get("detail")
    if isinstance(detail, dict):
        return detail.get("code") or detail.get("error_code")
    return payload.get("code") or payload.get("error_code")


def assert_ok(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def db_helpers():
    try:
        from app.ai import models as _ai_models  # noqa: F401
        from app.ai.models import AIUsage
        from app.audit import models as _audit_models  # noqa: F401
        from app.auth import models as _auth_models  # noqa: F401
        from app.projects import models as _project_models  # noqa: F401
        from app.common.encryption import is_encrypted_private_file
        from app.database import SessionLocal
        from app.datasets.models import Dataset
        from app.figures.models import Figure, FigureCodeArtifact
    except Exception:
        return None
    return SessionLocal, Dataset, Figure, FigureCodeArtifact, AIUsage, is_encrypted_private_file


def main() -> None:
    base_headers = {"X-Forwarded-For": f"198.51.100.{secrets.randbelow(200) + 20}"}
    admin_email = os.environ["ROOT_EMAIL"]
    admin_password = os.environ["ROOT_PASSWORD"]
    status, payload, _ = request("POST", "/api/auth/login", {"email": admin_email, "password": admin_password}, base_headers)
    assert_ok(status == 200, f"admin login failed: {status} {payload}")
    admin_headers = {**base_headers, "Authorization": f"Bearer {payload['access_token']}"}

    status, users, _ = request("GET", "/api/admin/users", headers=admin_headers)
    assert_ok(status == 200, f"admin users failed: {status}")
    for row in users:
        if row["email"].startswith("smoke-") and row["email"].endswith("@example.com"):
            request("DELETE", f"/api/admin/users/{row['id']}", headers=admin_headers)

    suffix = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(8))
    email = f"smoke-{suffix}@example.com"
    password = "SmokePass12345"
    status, user, _ = request(
        "POST",
        "/api/admin/users",
        {"email": email, "password": password, "display_name": "Smoke User", "is_admin": False},
        admin_headers,
    )
    assert_ok(status == 201, f"user create failed: {status} {user}")
    user_id = user["id"]
    status, _, _ = request(
        "PATCH",
        f"/api/admin/users/{user_id}",
        {"ai_monthly_limit": 1, "render_monthly_limit": 1, "storage_limit_mb": 1},
        admin_headers,
    )
    assert_ok(status == 200, f"quota update failed: {status}")

    status, payload, _ = request("POST", "/api/auth/login", {"email": email, "password": password}, base_headers)
    assert_ok(status == 200, f"user login failed: {status} {payload}")
    user_headers = {**base_headers, "Authorization": f"Bearer {payload['access_token']}"}

    csv = b"group,value\nA,1.0\nA,2.0\nB,3.0\nB,4.0\n"
    body, ctype = multipart({"name": "Smoke dataset"}, [("file", "smoke.csv", "text/csv", csv)])
    status, dataset, _ = request("POST", "/api/datasets", body, user_headers, ctype)
    assert_ok(status == 201, f"dataset upload failed: {status} {dataset}")
    dataset_id = dataset["id"]

    helpers = db_helpers()
    dataset_path = None
    figure_dir = None
    if helpers:
        SessionLocal, Dataset, _, _, AIUsage, is_encrypted_private_file = helpers
        with SessionLocal() as db:
            ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
            assert_ok(ds is not None, "dataset row missing")
            dataset_path = ds.file_path
            assert_ok(is_encrypted_private_file(dataset_path), f"dataset file is not encrypted: {dataset_path}")
            db.add(AIUsage(user_id=uuid.UUID(user_id), provider="claude", model="smoke", feature="smoke"))
            db.commit()

        status, blocked, _ = request("POST", f"/api/datasets/{dataset_id}/recommend", headers=user_headers)
        assert_ok(
            status == 429 and error_code(blocked) == "AI_QUOTA_EXCEEDED",
            f"AI quota did not block: {status} {blocked}",
        )

    status, figure, _ = request(
        "POST",
        "/api/figures",
        {
            "dataset_id": dataset_id,
            "name": "Smoke box plot",
            "plot_type": "box",
            "mapping": {"x": "group", "y": "value"},
            "options": {"show_points": True},
            "style_preset": "publication",
        },
        user_headers,
    )
    assert_ok(status == 201, f"figure create failed: {status} {figure}")
    figure_id = figure["id"]

    if helpers:
        import os as _os

        SessionLocal, _, Figure, FigureCodeArtifact, _, _ = helpers
        with SessionLocal() as db:
            fig = db.query(Figure).filter(Figure.id == figure_id).first()
            assert_ok(fig is not None, "figure row missing")
            figure_dir = _os.path.join("/app/backend/static/figures", str(fig.id))
            assert_ok(_os.path.isdir(figure_dir), f"figure directory missing: {figure_dir}")
            artifact_count = db.query(FigureCodeArtifact).filter(FigureCodeArtifact.owner_id == uuid.UUID(user_id)).count()
            assert_ok(artifact_count > 0, "figure code artifact was not archived")

    status, blocked, _ = request(
        "POST",
        "/api/figures",
        {
            "dataset_id": dataset_id,
            "name": "Smoke blocked box plot",
            "plot_type": "box",
            "mapping": {"x": "group", "y": "value"},
            "options": {},
            "style_preset": "publication",
        },
        user_headers,
    )
    assert_ok(
        status == 429 and error_code(blocked) == "RENDER_QUOTA_EXCEEDED",
        f"render quota did not block: {status} {blocked}",
    )

    large = b"a,b\n" + (b"1,2\n" * 280000)
    body, ctype = multipart({"name": "Too large"}, [("file", "large.csv", "text/csv", large)])
    status, blocked, _ = request("POST", "/api/datasets", body, user_headers, ctype)
    assert_ok(
        status == 413 and error_code(blocked) == "STORAGE_QUOTA_EXCEEDED",
        f"storage quota did not block: {status} {blocked}",
    )

    status, export_body, export_headers = request_bytes("GET", "/api/account/export", headers=user_headers)
    assert_ok(status == 200, f"account export failed: {status}")
    lowered_headers = {k.lower(): v for k, v in export_headers.items()}
    assert_ok("application/zip" in lowered_headers.get("content-type", ""), f"unexpected export type: {export_headers}")
    with zipfile.ZipFile(BytesIO(export_body)) as z:
        names = set(z.namelist())
        assert_ok("manifest.json" in names, "account export missing manifest")
        assert_ok("account/profile.json" in names, "account export missing profile")
        dataset_files = [name for name in names if name.startswith("datasets/files/")]
        assert_ok(bool(dataset_files), "account export missing dataset source file")
        assert_ok(b"group,value" in z.read(dataset_files[0]), "account export dataset source is not readable")

    status, logs, _ = request("GET", "/api/admin/audit-logs?limit=200", headers=admin_headers)
    assert_ok(status == 200, f"audit log endpoint failed: {status}")
    actions = {row["action"] for row in logs}
    required = {"admin.user.create", "admin.user.update", "auth.login", "dataset.upload", "figure.create"}
    assert_ok(required.issubset(actions), f"missing audit events: {sorted(required - actions)}")

    status, blocked, _ = request("DELETE", "/api/account", {"password": "wrong", "confirm": "DELETE"}, user_headers)
    assert_ok(
        status == 400 and error_code(blocked) == "PASSWORD_CONFIRMATION_FAILED",
        f"wrong password did not block account delete: {status} {blocked}",
    )

    status, _, _ = request("DELETE", "/api/account", {"password": password, "confirm": "DELETE"}, user_headers)
    assert_ok(status == 204, f"user delete failed: {status}")
    status, relogin, _ = request("POST", "/api/auth/login", {"email": email, "password": password}, base_headers)
    assert_ok(status == 400, f"deleted account can still log in: {status} {relogin}")
    if dataset_path:
        assert_ok(not os.path.exists(dataset_path), f"dataset file was not removed: {dataset_path}")
    if figure_dir:
        assert_ok(not os.path.exists(figure_dir), f"figure directory was not removed: {figure_dir}")
    if helpers:
        SessionLocal, _, _, FigureCodeArtifact, _, _ = helpers
        with SessionLocal() as db:
            artifact_count = db.query(FigureCodeArtifact).filter(FigureCodeArtifact.owner_id == uuid.UUID(user_id)).count()
            assert_ok(artifact_count == 0, f"figure code artifacts were not removed: {artifact_count}")

    print("PASS api scenario: encrypted upload, account export/delete, quotas, audit logs, delete cleanup")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"FAIL api scenario: {exc}", file=sys.stderr)
        raise
