from __future__ import annotations

import re
import uuid

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.common.exceptions import BadRequestError, ConflictError, NotFoundError
from app.palettes.models import UserColorPalette

_HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
_MAX_PALETTES_PER_USER = 50


def normalize_palette_name(name: str) -> str:
    clean = re.sub(r"\s+", " ", (name or "").strip())
    if not clean:
        raise BadRequestError("Palette name is required", error_code="PALETTE_NAME_REQUIRED")
    if len(clean) > 100:
        raise BadRequestError("Palette name must be 100 characters or shorter", error_code="PALETTE_NAME_TOO_LONG")
    return clean


def normalize_colors(colors: list[str] | None) -> list[str]:
    if not isinstance(colors, list) or not colors:
        raise BadRequestError("Choose at least one color", error_code="PALETTE_COLORS_REQUIRED")
    if len(colors) > 12:
        raise BadRequestError("Use 12 colors or fewer in one palette", error_code="PALETTE_TOO_MANY_COLORS")
    out: list[str] = []
    for raw in colors:
        if not isinstance(raw, str):
            raise BadRequestError("Palette colors must be HEX strings", error_code="BAD_PALETTE_COLOR")
        color = raw.strip()
        if not _HEX_RE.match(color):
            raise BadRequestError("Palette colors must use #RRGGBB HEX format", error_code="BAD_PALETTE_COLOR")
        out.append(color.upper())
    return out


def palette_response(row: UserColorPalette) -> dict:
    return {
        "id": row.id,
        "key": f"custom:{row.id}",
        "name": row.name,
        "label": f"Custom: {row.name}",
        "colorblind_safe": False,
        "hex": row.colors or [],
        "custom": True,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def list_custom_palettes(db: Session, owner_id: uuid.UUID) -> list[UserColorPalette]:
    return (
        db.query(UserColorPalette)
        .filter(UserColorPalette.owner_id == owner_id)
        .order_by(func.lower(UserColorPalette.name).asc(), UserColorPalette.created_at.asc())
        .all()
    )


def list_palette_options(db: Session, owner_id: uuid.UUID) -> list[dict]:
    return [palette_response(row) for row in list_custom_palettes(db, owner_id)]


def get_user_palette(db: Session, owner_id: uuid.UUID, palette_id: uuid.UUID) -> UserColorPalette:
    row = (
        db.query(UserColorPalette)
        .filter(UserColorPalette.id == palette_id, UserColorPalette.owner_id == owner_id)
        .first()
    )
    if not row:
        raise NotFoundError("Palette", str(palette_id))
    return row


def _ensure_name_available(db: Session, owner_id: uuid.UUID, name: str, palette_id: uuid.UUID | None = None) -> None:
    q = db.query(UserColorPalette).filter(
        UserColorPalette.owner_id == owner_id,
        func.lower(UserColorPalette.name) == name.lower(),
    )
    if palette_id is not None:
        q = q.filter(UserColorPalette.id != palette_id)
    if q.first():
        raise ConflictError("A custom palette with this name already exists")


def create_palette(db: Session, owner_id: uuid.UUID, name: str, colors: list[str]) -> UserColorPalette:
    count = db.query(func.count(UserColorPalette.id)).filter(UserColorPalette.owner_id == owner_id).scalar() or 0
    if count >= _MAX_PALETTES_PER_USER:
        raise BadRequestError("Custom palette limit reached", error_code="PALETTE_LIMIT_REACHED")
    clean_name = normalize_palette_name(name)
    clean_colors = normalize_colors(colors)
    _ensure_name_available(db, owner_id, clean_name)
    row = UserColorPalette(owner_id=owner_id, name=clean_name, colors=clean_colors)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def update_palette(db: Session, owner_id: uuid.UUID, palette_id: uuid.UUID,
                   name: str, colors: list[str]) -> UserColorPalette:
    row = get_user_palette(db, owner_id, palette_id)
    clean_name = normalize_palette_name(name)
    clean_colors = normalize_colors(colors)
    _ensure_name_available(db, owner_id, clean_name, palette_id=palette_id)
    row.name = clean_name
    row.colors = clean_colors
    db.commit()
    db.refresh(row)
    return row


def delete_palette(db: Session, owner_id: uuid.UUID, palette_id: uuid.UUID) -> None:
    row = get_user_palette(db, owner_id, palette_id)
    db.delete(row)
    db.commit()
