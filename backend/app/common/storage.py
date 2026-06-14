from __future__ import annotations

import hashlib
import mimetypes
import os
import shutil
from pathlib import Path
from urllib.parse import quote, urlparse

from app.config import settings


def backend() -> str:
    return (settings.STORAGE_BACKEND or "local").lower()


def object_storage_enabled() -> bool:
    return backend() in {"s3", "filesystem_object"}


def is_object_ref(ref: str | None) -> bool:
    return bool(ref and ref.startswith("s3://"))


def _prefix() -> str:
    return (settings.OBJECT_STORAGE_PREFIX or "").strip("/")


def object_key(*parts: object) -> str:
    clean_parts = [str(p).strip("/").replace("\\", "/") for p in parts if str(p).strip("/")]
    prefix = _prefix()
    if prefix:
        clean_parts.insert(0, prefix)
    return "/".join(clean_parts)


def _require_bucket() -> str:
    bucket = settings.OBJECT_STORAGE_BUCKET.strip()
    if not bucket:
        raise RuntimeError("OBJECT_STORAGE_BUCKET must be set when object storage is enabled")
    return bucket


def object_uri(key: str) -> str:
    return f"s3://{_require_bucket()}/{key.lstrip('/')}"


def parse_object_ref(ref: str) -> tuple[str, str]:
    parsed = urlparse(ref)
    if parsed.scheme != "s3" or not parsed.netloc or not parsed.path:
        raise ValueError(f"Invalid object storage URI: {ref}")
    return parsed.netloc, parsed.path.lstrip("/")


def asset_url(ref: str | None) -> str | None:
    if not ref:
        return None
    if not is_object_ref(ref):
        return None
    if not object_storage_enabled():
        return None
    bucket, key = parse_object_ref(ref)
    public_base = settings.OBJECT_STORAGE_PUBLIC_BASE_URL.strip().rstrip("/")
    if public_base:
        return f"{public_base}/{quote(key)}"
    if bucket != _require_bucket():
        return None
    return "/api/assets/" + quote(key)


def _local_object_path(bucket: str, key: str) -> str:
    return os.path.join(settings.OBJECT_STORAGE_LOCAL_DIR, bucket, key)


def _s3_client():
    import boto3

    kwargs = {
        "region_name": settings.OBJECT_STORAGE_REGION or None,
        "endpoint_url": settings.OBJECT_STORAGE_ENDPOINT_URL or None,
    }
    if settings.OBJECT_STORAGE_ACCESS_KEY_ID or settings.OBJECT_STORAGE_SECRET_ACCESS_KEY:
        kwargs["aws_access_key_id"] = settings.OBJECT_STORAGE_ACCESS_KEY_ID or None
        kwargs["aws_secret_access_key"] = settings.OBJECT_STORAGE_SECRET_ACCESS_KEY or None
    return boto3.client("s3", **{k: v for k, v in kwargs.items() if v})


def _put_extra_args(content_type: str | None = None) -> dict:
    extra: dict[str, str] = {}
    if content_type:
        extra["ContentType"] = content_type
    if settings.OBJECT_STORAGE_SSE:
        extra["ServerSideEncryption"] = settings.OBJECT_STORAGE_SSE
    if settings.OBJECT_STORAGE_KMS_KEY_ID:
        extra["SSEKMSKeyId"] = settings.OBJECT_STORAGE_KMS_KEY_ID
    return extra


def put_bytes(key: str, data: bytes, content_type: str | None = None) -> str:
    bucket = _require_bucket()
    key = key.lstrip("/")
    if backend() == "filesystem_object":
        path = _local_object_path(bucket, key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return object_uri(key)
    if backend() == "s3":
        _s3_client().put_object(Bucket=bucket, Key=key, Body=data, **_put_extra_args(content_type))
        return object_uri(key)
    raise RuntimeError("put_bytes requires object storage backend")


def upload_file(path: str, key: str, content_type: str | None = None) -> str:
    key = key.lstrip("/")
    if backend() == "local":
        return path
    bucket = _require_bucket()
    if backend() == "filesystem_object":
        dest = _local_object_path(bucket, key)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(path, dest)
        return object_uri(key)
    if backend() == "s3":
        guessed_type = content_type or mimetypes.guess_type(path)[0]
        _s3_client().upload_file(path, bucket, key, ExtraArgs=_put_extra_args(guessed_type))
        return object_uri(key)
    return path


def read_bytes(ref: str) -> bytes:
    if not is_object_ref(ref):
        with open(ref, "rb") as f:
            return f.read()
    if not object_storage_enabled():
        raise RuntimeError("Object storage is not enabled for object URI reads")
    bucket, key = parse_object_ref(ref)
    if backend() == "filesystem_object":
        with open(_local_object_path(bucket, key), "rb") as f:
            return f.read()
    obj = _s3_client().get_object(Bucket=bucket, Key=key)
    return obj["Body"].read()


def write_bytes(ref: str, data: bytes, content_type: str | None = None) -> str:
    if not is_object_ref(ref):
        os.makedirs(os.path.dirname(ref), exist_ok=True)
        with open(ref, "wb") as f:
            f.write(data)
        return ref
    _, key = parse_object_ref(ref)
    return put_bytes(key, data, content_type=content_type)


def exists(ref: str | None) -> bool:
    if not ref:
        return False
    if not is_object_ref(ref):
        return os.path.exists(ref)
    if not object_storage_enabled():
        return False
    bucket, key = parse_object_ref(ref)
    if backend() == "filesystem_object":
        return os.path.exists(_local_object_path(bucket, key))
    try:
        _s3_client().head_object(Bucket=bucket, Key=key)
        return True
    except Exception:
        return False


def size(ref: str | None) -> int:
    if not ref:
        return 0
    if not is_object_ref(ref):
        return os.path.getsize(ref) if os.path.exists(ref) else 0
    if not object_storage_enabled():
        return 0
    bucket, key = parse_object_ref(ref)
    if backend() == "filesystem_object":
        path = _local_object_path(bucket, key)
        return os.path.getsize(path) if os.path.exists(path) else 0
    obj = _s3_client().head_object(Bucket=bucket, Key=key)
    return int(obj.get("ContentLength") or 0)


def delete_file(ref: str | None) -> None:
    if not ref:
        return
    if not is_object_ref(ref):
        try:
            if os.path.exists(ref):
                os.remove(ref)
        except OSError:
            pass
        return
    bucket, key = parse_object_ref(ref)
    if not object_storage_enabled():
        return
    if backend() == "filesystem_object":
        try:
            os.remove(_local_object_path(bucket, key))
        except OSError:
            pass
        return
    _s3_client().delete_object(Bucket=bucket, Key=key)


def delete_prefix(key_prefix: str) -> None:
    key_prefix = key_prefix.strip("/")
    if not object_storage_enabled():
        return
    bucket = _require_bucket()
    full_prefix = object_key(key_prefix)
    if backend() == "filesystem_object":
        shutil.rmtree(_local_object_path(bucket, full_prefix), ignore_errors=True)
        return
    client = _s3_client()
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=full_prefix.rstrip("/") + "/"):
        objects = [{"Key": item["Key"]} for item in page.get("Contents", [])]
        if objects:
            client.delete_objects(Bucket=bucket, Delete={"Objects": objects})


def materialize(ref: str, suffix: str = "") -> str:
    if not is_object_ref(ref):
        return ref
    if not object_storage_enabled():
        raise RuntimeError("Object storage is not enabled for object URI materialization")
    bucket, key = parse_object_ref(ref)
    digest = hashlib.sha256(f"{bucket}/{key}".encode("utf-8")).hexdigest()
    ext = suffix or Path(key).suffix
    cached = os.path.join(settings.OBJECT_STORAGE_CACHE_DIR, digest + ext)
    if not os.path.exists(cached):
        os.makedirs(os.path.dirname(cached), exist_ok=True)
        with open(cached, "wb") as f:
            f.write(read_bytes(ref))
    return cached
