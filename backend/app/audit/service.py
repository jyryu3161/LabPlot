from __future__ import annotations

import uuid
from typing import Any

from fastapi import Request
from sqlalchemy.orm import Session

from app.audit.models import AuditLog

_SENSITIVE_KEYS = {
    "password",
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "api_key_ciphertext",
    "anthropic_api_key",
    "gemini_api_key",
    "anthropic_api_key_ciphertext",
    "gemini_api_key_ciphertext",
    "secret",
    "ciphertext",
}


def _client_ip(request: Request | None) -> str | None:
    if not request:
        return None
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    return request.client.host if request.client else None


def _clean(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: ("[redacted]" if k.lower() in _SENSITIVE_KEYS else _clean(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    if isinstance(value, uuid.UUID):
        return str(value)
    return value


def log_event(
    db: Session,
    *,
    actor_id: uuid.UUID | None,
    action: str,
    target_type: str | None = None,
    target_id: str | uuid.UUID | None = None,
    metadata: dict[str, Any] | None = None,
    request: Request | None = None,
) -> None:
    row = AuditLog(
        actor_id=actor_id,
        action=action,
        target_type=target_type,
        target_id=str(target_id) if target_id is not None else None,
        ip_address=_client_ip(request),
        user_agent=(request.headers.get("user-agent")[:512] if request and request.headers.get("user-agent") else None),
        metadata_json=_clean(metadata or {}),
    )
    db.add(row)


def list_events(db: Session, limit: int = 200) -> list[AuditLog]:
    limit = max(1, min(limit, 1000))
    return db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit).all()
