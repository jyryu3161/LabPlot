import os
import shutil
import uuid

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.ai.models import AIUsage
from app.account.service import scrub_user_audit_subject
from app.audit import service as audit_service
from app.auth.models import User
from app.auth.service import _hash_password, _normalize_email, _validate_password
from app.common import storage
from app.common.exceptions import BadRequestError, NotFoundError
from app.common.quotas import quota_summary
from app.config import settings
from app.datasets.models import Dataset
from app.figures.models import Figure, FigureCodeArtifact


def list_users(db: Session) -> list[dict]:
    users = db.query(User).order_by(User.created_at.asc()).all()
    if not users:
        return []
    ds_counts = dict(
        db.query(Dataset.owner_id, func.count(Dataset.id)).group_by(Dataset.owner_id).all()
    )
    fig_counts = dict(
        db.query(Figure.owner_id, func.count(Figure.id)).group_by(Figure.owner_id).all()
    )
    usage_rows = (
        db.query(
            AIUsage.user_id,
            func.count(AIUsage.id),
            func.coalesce(func.sum(AIUsage.input_tokens), 0),
            func.coalesce(func.sum(AIUsage.output_tokens), 0),
            func.coalesce(func.sum(AIUsage.total_tokens), 0),
            func.coalesce(func.sum(AIUsage.estimated_cost_usd), 0.0),
        )
        .filter(AIUsage.user_id.isnot(None))
        .group_by(AIUsage.user_id)
        .all()
    )
    usage = {
        user_id: {
            "ai_request_count": int(request_count or 0),
            "ai_input_tokens": int(input_tokens or 0),
            "ai_output_tokens": int(output_tokens or 0),
            "ai_total_tokens": int(total_tokens or 0),
            "ai_estimated_cost_usd": float(estimated_cost or 0.0),
        }
        for user_id, request_count, input_tokens, output_tokens, total_tokens, estimated_cost in usage_rows
    }
    out = []
    for u in users:
        quotas = quota_summary(db, u)
        out.append({
            "id": u.id,
            "email": u.email,
            "display_name": u.display_name,
            "is_active": u.is_active,
            "is_approved": u.is_approved,
            "is_admin": u.is_admin,
            "ai_monthly_limit": u.ai_monthly_limit,
            "render_monthly_limit": u.render_monthly_limit,
            "storage_limit_mb": u.storage_limit_mb,
            **quotas,
            "created_at": u.created_at,
            "dataset_count": ds_counts.get(u.id, 0),
            "figure_count": fig_counts.get(u.id, 0),
            **usage.get(u.id, {
                "ai_request_count": 0,
                "ai_input_tokens": 0,
                "ai_output_tokens": 0,
                "ai_total_tokens": 0,
                "ai_estimated_cost_usd": 0.0,
            }),
        })
    return out


def _get(db: Session, user_id: uuid.UUID) -> User:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise NotFoundError("User", str(user_id))
    return user


def create_user(db: Session, email: str, password: str, display_name: str, is_admin: bool, acting_user: User | None = None, request=None) -> User:
    email = _normalize_email(email)
    _validate_password(password)
    if db.query(User).filter(User.email == email).first():
        raise BadRequestError("Email already registered", error_code="EMAIL_ALREADY_EXISTS")
    user = User(
        email=email,
        hashed_password=_hash_password(password),
        display_name=display_name,
        is_approved=True,
        is_admin=is_admin,
    )
    db.add(user)
    db.flush()
    audit_service.log_event(
        db,
        actor_id=acting_user.id if acting_user else None,
        action="admin.user.create",
        target_type="user",
        target_id=user.id,
        metadata={"email": user.email, "is_admin": is_admin},
        request=request,
    )
    db.commit()
    db.refresh(user)
    return user


def update_user(db: Session, user_id: uuid.UUID, data, acting_user: User, request=None) -> User:
    user = _get(db, user_id)
    payload = data.model_dump(exclude_unset=True)
    # Safety: a user cannot revoke their own admin or deactivate themselves
    if user.id == acting_user.id:
        if payload.get("is_admin") is False:
            raise BadRequestError("You cannot revoke your own admin role")
        if payload.get("is_active") is False:
            raise BadRequestError("You cannot deactivate your own account")
        if payload.get("is_approved") is False:
            raise BadRequestError("You cannot revoke your own approval")
    for k, v in payload.items():
        setattr(user, k, v)
    audit_service.log_event(
        db,
        actor_id=acting_user.id,
        action="admin.user.update",
        target_type="user",
        target_id=user.id,
        metadata={"changes": payload},
        request=request,
    )
    db.commit()
    db.refresh(user)
    return user


def reset_password(db: Session, user_id: uuid.UUID, password: str, acting_user: User | None = None, request=None) -> User:
    _validate_password(password)
    user = _get(db, user_id)
    user.hashed_password = _hash_password(password)
    user.token_version = int(user.token_version or 0) + 1
    audit_service.log_event(
        db,
        actor_id=acting_user.id if acting_user else None,
        action="admin.user.reset_password",
        target_type="user",
        target_id=user.id,
        metadata={},
        request=request,
    )
    db.commit()
    db.refresh(user)
    return user


def delete_user(db: Session, user_id: uuid.UUID, acting_user: User, request=None) -> None:
    user = _get(db, user_id)
    if user.id == acting_user.id:
        raise BadRequestError("You cannot delete your own account")
    dataset_paths = [path for (path,) in db.query(Dataset.file_path).filter(Dataset.owner_id == user.id).all() if path]
    figure_ids = [fid for (fid,) in db.query(Figure.id).filter(Figure.owner_id == user.id).all()]
    audit_service.log_event(
        db,
        actor_id=acting_user.id,
        action="admin.user.delete",
        target_type="user",
        target_id=user.id,
        metadata={"email": user.email},
        request=request,
    )
    scrub_user_audit_subject(db, user.id)
    db.query(FigureCodeArtifact).filter(FigureCodeArtifact.owner_id == user.id).delete(synchronize_session=False)
    db.delete(user)
    db.commit()
    for path in dataset_paths:
        storage.delete_file(path)
    for figure_id in figure_ids:
        shutil.rmtree(os.path.join(settings.figures_dir, str(figure_id)), ignore_errors=True)
        if storage.object_storage_enabled():
            storage.delete_prefix(f"figures/{figure_id}")


def list_audit_logs(db: Session, limit: int = 200) -> list:
    return audit_service.list_events(db, limit=limit)
