from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from urllib.parse import urlparse

from app.config import settings

_TOKEN_TTL_SECONDS = 15 * 60


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _signature(payload: str) -> str:
    return _encode(hmac.new(settings.JWT_SECRET.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).digest())


def create_asset_token(ref: str, ttl_seconds: int = _TOKEN_TTL_SECONDS) -> str:
    payload = _encode(json.dumps(
        {"ref": ref, "exp": int(time.time()) + ttl_seconds},
        separators=(",", ":"),
    ).encode("utf-8"))
    return f"{payload}.{_signature(payload)}"


def verify_asset_token(token: str) -> str | None:
    try:
        payload, signature = token.rsplit(".", 1)
        if not hmac.compare_digest(signature, _signature(payload)):
            return None
        claims = json.loads(_decode(payload))
        ref = claims["ref"]
        expiry = int(claims["exp"])
        if not isinstance(ref, str) or expiry < int(time.time()):
            return None
        return ref
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def asset_filename(ref: str) -> str:
    if ref.startswith("s3://"):
        return os.path.basename(urlparse(ref).path)
    return os.path.basename(ref)


def signed_asset_url(ref: str | None) -> str | None:
    if not ref or ref.lower().endswith(".r"):
        return None
    filename = asset_filename(ref)
    if not filename:
        return None
    return f"/api/assets/signed/{create_asset_token(ref)}/{filename}"
