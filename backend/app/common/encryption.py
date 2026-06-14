from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings
from app.common.exceptions import BadRequestError

_MAGIC = b"LABPLOTENC1\n"


def _fernet() -> Fernet:
    secret = (settings.DATA_ENCRYPTION_KEY or settings.JWT_SECRET or "").strip()
    if not secret:
        raise BadRequestError(
            "Dataset encryption key is not configured",
            error_code="DATASET_ENCRYPTION_NOT_CONFIGURED",
        )
    raw = secret.encode("utf-8")
    try:
        return Fernet(raw)
    except ValueError:
        derived = base64.urlsafe_b64encode(hashlib.sha256(raw).digest())
        return Fernet(derived)


def encrypt_private_bytes(data: bytes) -> bytes:
    if data.startswith(_MAGIC):
        return data
    return _MAGIC + _fernet().encrypt(data)


def decrypt_private_bytes(data: bytes) -> bytes:
    if not data.startswith(_MAGIC):
        return data
    try:
        return _fernet().decrypt(data[len(_MAGIC):])
    except InvalidToken as exc:
        raise BadRequestError(
            "Dataset file could not be decrypted. Check DATA_ENCRYPTION_KEY.",
            error_code="DATASET_DECRYPTION_FAILED",
        ) from exc


def is_encrypted_private_file(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(len(_MAGIC)) == _MAGIC
    except OSError:
        return False
