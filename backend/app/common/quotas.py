from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.ai.models import AIUsage
from app.auth.models import User
from app.common.exceptions import AppError
from app.common import storage
from app.datasets.models import Dataset
from app.figures.models import Figure, FigureVersion


def _month_start() -> datetime:
    now = datetime.now(timezone.utc)
    return datetime(now.year, now.month, 1, tzinfo=timezone.utc)


def monthly_ai_requests(db: Session, user_id: uuid.UUID) -> int:
    return int(
        db.query(func.count(AIUsage.id))
        .filter(AIUsage.user_id == user_id, AIUsage.created_at >= _month_start())
        .scalar()
        or 0
    )


def monthly_renders(db: Session, user_id: uuid.UUID) -> int:
    return int(
        db.query(func.count(FigureVersion.id))
        .join(Figure, FigureVersion.figure_id == Figure.id)
        .filter(Figure.owner_id == user_id, FigureVersion.created_at >= _month_start())
        .scalar()
        or 0
    )


def storage_used_bytes(db: Session, user_id: uuid.UUID) -> int:
    paths: list[str] = []
    for (path,) in db.query(Dataset.file_path).filter(Dataset.owner_id == user_id).all():
        if path:
            paths.append(path)
    rows = (
        db.query(FigureVersion.png_path, FigureVersion.svg_path, FigureVersion.tiff_path, FigureVersion.pdf_path, FigureVersion.r_path)
        .join(Figure, FigureVersion.figure_id == Figure.id)
        .filter(Figure.owner_id == user_id)
        .all()
    )
    for row in rows:
        paths.extend([p for p in row if p])
    total = 0
    for path in set(paths):
        try:
            total += storage.size(path)
        except Exception:
            continue
    return total


def enforce_ai_quota(db: Session, user: User) -> None:
    limit = int(user.ai_monthly_limit or 0)
    if limit > 0 and monthly_ai_requests(db, user.id) >= limit:
        raise AppError(status_code=429, detail="Monthly AI request quota exceeded", error_code="AI_QUOTA_EXCEEDED")


def enforce_render_quota(db: Session, user: User) -> None:
    limit = int(user.render_monthly_limit or 0)
    if limit > 0 and monthly_renders(db, user.id) >= limit:
        raise AppError(status_code=429, detail="Monthly render quota exceeded", error_code="RENDER_QUOTA_EXCEEDED")


def enforce_storage_quota(db: Session, user: User, incoming_bytes: int = 0) -> None:
    limit_mb = int(user.storage_limit_mb or 0)
    if limit_mb <= 0:
        return
    limit_bytes = limit_mb * 1024 * 1024
    if storage_used_bytes(db, user.id) + incoming_bytes > limit_bytes:
        raise AppError(status_code=413, detail="Storage quota exceeded", error_code="STORAGE_QUOTA_EXCEEDED")


def quota_summary(db: Session, user: User) -> dict:
    used_bytes = storage_used_bytes(db, user.id)
    return {
        "ai_monthly_used": monthly_ai_requests(db, user.id),
        "ai_monthly_limit": int(user.ai_monthly_limit or 0),
        "render_monthly_used": monthly_renders(db, user.id),
        "render_monthly_limit": int(user.render_monthly_limit or 0),
        "storage_used_mb": round(used_bytes / (1024 * 1024), 2),
        "storage_limit_mb": int(user.storage_limit_mb or 0),
    }
