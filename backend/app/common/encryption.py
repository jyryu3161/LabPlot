from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings
from app.common.exceptions import BadRequestError

_MAGIC = b"LABPLOTENC1\n"


def _fernet_for_secret(secret: str) -> Fernet:
    raw = secret.encode("utf-8")
    try:
        return Fernet(raw)
    except ValueError:
        derived = base64.urlsafe_b64encode(hashlib.sha256(raw).digest())
        return Fernet(derived)


def _primary_secret() -> str:
    secret = (settings.DATA_ENCRYPTION_KEY or settings.JWT_SECRET or "").strip()
    if not secret:
        raise BadRequestError(
            "Dataset encryption key is not configured",
            error_code="DATASET_ENCRYPTION_NOT_CONFIGURED",
        )
    return secret


def _fernet() -> Fernet:
    return _fernet_for_secret(_primary_secret())


def _candidate_fernets() -> list[Fernet]:
    secrets = [_primary_secret()]
    previous = (settings.DATA_ENCRYPTION_PREVIOUS_KEYS or "").replace("\n", ",")
    secrets.extend(s.strip() for s in previous.split(",") if s.strip())
    seen: set[str] = set()
    out: list[Fernet] = []
    for secret in secrets:
        if secret in seen:
            continue
        seen.add(secret)
        out.append(_fernet_for_secret(secret))
    return out


def encrypt_private_bytes(data: bytes) -> bytes:
    if data.startswith(_MAGIC):
        return data
    return _MAGIC + _fernet().encrypt(data)


def decrypt_private_bytes(data: bytes) -> bytes:
    if not data.startswith(_MAGIC):
        return data
    token = data[len(_MAGIC):]
    for fernet in _candidate_fernets():
        try:
            return fernet.decrypt(token)
        except InvalidToken:
            continue
    raise BadRequestError(
        "Dataset file could not be decrypted. Check DATA_ENCRYPTION_KEY.",
        error_code="DATASET_DECRYPTION_FAILED",
    )


def encrypted_with_primary_key(data: bytes) -> bool:
    if not data.startswith(_MAGIC):
        return False
    try:
        _fernet().decrypt(data[len(_MAGIC):])
        return True
    except InvalidToken:
        return False


def is_encrypted_private_file(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(len(_MAGIC)) == _MAGIC
    except OSError:
        return False
