import uuid

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.ai.models import AIUsage
from app.auth.models import User
from app.auth.service import _hash_password
from app.common.exceptions import BadRequestError, NotFoundError
from app.datasets.models import Dataset
from app.figures.models import Figure


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
    return [
        {
            "id": u.id,
            "email": u.email,
            "display_name": u.display_name,
            "is_active": u.is_active,
            "is_approved": u.is_approved,
            "is_admin": u.is_admin,
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
        }
        for u in users
    ]


def _get(db: Session, user_id: uuid.UUID) -> User:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise NotFoundError("User", str(user_id))
    return user


def create_user(db: Session, email: str, password: str, display_name: str, is_admin: bool) -> User:
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
    db.commit()
    db.refresh(user)
    return user


def update_user(db: Session, user_id: uuid.UUID, data, acting_user: User) -> User:
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
    db.commit()
    db.refresh(user)
    return user


def reset_password(db: Session, user_id: uuid.UUID, password: str) -> User:
    user = _get(db, user_id)
    user.hashed_password = _hash_password(password)
    db.commit()
    db.refresh(user)
    return user


def delete_user(db: Session, user_id: uuid.UUID, acting_user: User) -> None:
    user = _get(db, user_id)
    if user.id == acting_user.id:
        raise BadRequestError("You cannot delete your own account")
    db.delete(user)
    db.commit()
