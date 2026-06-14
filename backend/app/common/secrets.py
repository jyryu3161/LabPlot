from __future__ import annotations

import base64

from app.common.encryption import decrypt_private_bytes, encrypt_private_bytes, encrypted_with_primary_key
from app.common.exceptions import BadRequestError
from app.config import settings

_KMS_MAGIC = "LABPLOTKMS1\n"


def _context_dict(context: dict[str, str] | None) -> dict[str, str]:
    return {str(k): str(v) for k, v in (context or {}).items() if v is not None}


def _kms_client():
    try:
        import boto3
    except Exception as exc:
        raise BadRequestError("AWS KMS support is not installed", error_code="KMS_NOT_AVAILABLE") from exc
    kwargs = {}
    region = settings.SECRET_AWS_KMS_REGION or settings.OBJECT_STORAGE_REGION
    if region:
        kwargs["region_name"] = region
    return boto3.client("kms", **kwargs)


def _encrypt_with_kms(value: str, context: dict[str, str] | None) -> str:
    key_id = (settings.SECRET_AWS_KMS_KEY_ID or "").strip()
    if not key_id:
        raise BadRequestError("SECRET_AWS_KMS_KEY_ID is not configured", error_code="KMS_NOT_CONFIGURED")
    res = _kms_client().encrypt(
        KeyId=key_id,
        Plaintext=value.encode("utf-8"),
        EncryptionContext=_context_dict(context),
    )
    return _KMS_MAGIC + base64.b64encode(res["CiphertextBlob"]).decode("ascii")


def _decrypt_with_kms(value: str, context: dict[str, str] | None) -> str:
    blob = base64.b64decode(value[len(_KMS_MAGIC):].encode("ascii"))
    res = _kms_client().decrypt(CiphertextBlob=blob, EncryptionContext=_context_dict(context))
    return res["Plaintext"].decode("utf-8")


def encrypt_secret(value: str | None, context: dict[str, str] | None = None) -> str | None:
    if not value:
        return None
    if value.startswith(_KMS_MAGIC):
        return value
    raw = value.encode("utf-8")
    if raw.startswith(b"LABPLOTENC1\n") and encrypted_with_primary_key(raw):
        return value
    if (settings.SECRET_ENCRYPTION_PROVIDER or "local").lower() == "aws_kms":
        return _encrypt_with_kms(decrypt_private_bytes(raw).decode("utf-8"), context)
    return encrypt_private_bytes(decrypt_private_bytes(raw)).decode("utf-8")


def decrypt_secret(value: str | None, context: dict[str, str] | None = None) -> str | None:
    if not value:
        return None
    if value.startswith(_KMS_MAGIC):
        return _decrypt_with_kms(value, context)
    return decrypt_private_bytes(value.encode("utf-8")).decode("utf-8")


def secret_status(value: str | None) -> dict:
    provider = "aws_kms" if value and value.startswith(_KMS_MAGIC) else "local" if value else ""
    return {"set": bool(value), "provider": provider}
