import uuid

import bcrypt
from sqlalchemy.orm import Session

from app.auth.models import User
from app.auth.jwt import create_access_token, create_refresh_token, decode_token
from app.common.exceptions import BadRequestError, NotFoundError


def _hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def _verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


def register_user(db: Session, email: str, password: str, display_name: str) -> User:
    existing = db.query(User).filter(User.email == email).first()
    if existing:
        raise BadRequestError("Email already registered", error_code="EMAIL_ALREADY_EXISTS")

    user = User(
        email=email,
        hashed_password=_hash_password(password),
        display_name=display_name,
        is_approved=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def authenticate_user(db: Session, email: str, password: str) -> User:
    user = db.query(User).filter(User.email == email).first()
    if not user or not _verify_password(password, user.hashed_password):
        raise BadRequestError("Invalid email or password", error_code="INVALID_CREDENTIALS")
    if not user.is_active:
        raise BadRequestError("Account is deactivated", error_code="ACCOUNT_INACTIVE")
    if not user.is_approved:
        raise BadRequestError("Account is awaiting root approval", error_code="ACCOUNT_PENDING_APPROVAL")
    return user


def login_user(db: Session, email: str, password: str) -> dict:
    user = authenticate_user(db, email, password)
    access_token = create_access_token(str(user.id))
    refresh_token = create_refresh_token(str(user.id))
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
    }


def refresh_tokens(db: Session, refresh_token: str) -> dict:
    payload = decode_token(refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise BadRequestError("Invalid refresh token", error_code="INVALID_TOKEN")

    user_id = payload.get("sub")
    user = db.query(User).filter(User.id == uuid.UUID(user_id)).first()
    if not user or not user.is_active:
        raise BadRequestError("User not found or inactive", error_code="USER_NOT_FOUND")
    if not user.is_approved:
        raise BadRequestError("Account is awaiting root approval", error_code="ACCOUNT_PENDING_APPROVAL")

    new_access = create_access_token(str(user.id))
    new_refresh = create_refresh_token(str(user.id))
    return {
        "access_token": new_access,
        "refresh_token": new_refresh,
        "token_type": "bearer",
    }


def get_user_by_id(db: Session, user_id: uuid.UUID) -> User:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise NotFoundError("User", str(user_id))
    return user
