import mimetypes

from fastapi import APIRouter
from fastapi.responses import Response

from app.common import storage
from app.common.exceptions import NotFoundError

router = APIRouter(prefix="/api/assets", tags=["assets"])


@router.get("/{key:path}")
def rendered_asset(key: str):
    if not storage.object_storage_enabled():
        raise NotFoundError("Asset", key)
    allowed_prefix = storage.object_key("figures").rstrip("/") + "/"
    if not key.startswith(allowed_prefix):
        raise NotFoundError("Asset", key)
    ref = storage.object_uri(key)
    if not storage.exists(ref):
        raise NotFoundError("Asset", key)
    media_type = mimetypes.guess_type(key)[0] or "application/octet-stream"
    return Response(storage.read_bytes(ref), media_type=media_type)
