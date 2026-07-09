import mimetypes
import os

from fastapi import APIRouter
from fastapi.responses import FileResponse, Response

from app.common import storage
from app.common.asset_tokens import asset_filename, verify_asset_token
from app.common.exceptions import NotFoundError
from app.config import settings

router = APIRouter(prefix="/api/assets", tags=["assets"])


def _allowed_ref(ref: str) -> bool:
    if ref.lower().endswith(".r"):
        return False
    if storage.is_object_ref(ref):
        if not storage.object_storage_enabled():
            return False
        try:
            bucket, key = storage.parse_object_ref(ref)
            allowed_prefix = storage.object_key("figures").rstrip("/") + "/"
            return bucket == settings.OBJECT_STORAGE_BUCKET.strip() and key.startswith(allowed_prefix)
        except ValueError:
            return False
    base = os.path.realpath(settings.figures_dir)
    path = os.path.realpath(ref)
    try:
        return os.path.commonpath([base, path]) == base
    except ValueError:
        return False


@router.get("/signed/{token}/{filename}")
def rendered_asset(token: str, filename: str):
    ref = verify_asset_token(token)
    if not ref or filename != asset_filename(ref) or not _allowed_ref(ref) or not storage.exists(ref):
        raise NotFoundError("Asset", filename)
    media_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    headers = {"Cache-Control": "private, max-age=300", "X-Robots-Tag": "noindex, nofollow"}
    if storage.is_object_ref(ref):
        return Response(storage.read_bytes(ref), media_type=media_type, headers=headers)
    return FileResponse(ref, media_type=media_type, headers=headers)
