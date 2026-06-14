import uuid
from collections.abc import Generator

from fastapi import Depends, Header
from sqlalchemy.orm import Session

from app.database import SessionLocal


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
):
    from app.auth.jwt import decode_token
    from app.auth.models import User
    from app.common.exceptions import UnauthorizedError

    if not authorization:
        raise UnauthorizedError("Authorization header is required", error_code="MISSING_AUTH_HEADER")

    if not authorization.startswith("Bearer "):
        raise UnauthorizedError("Invalid authorization header", error_code="INVALID_AUTH_HEADER")

    token = authorization[7:]  # Remove "Bearer "
    payload = decode_token(token)
    if not payload or payload.get("type") != "access":
        raise UnauthorizedError("Invalid or expired token", error_code="INVALID_TOKEN")

    user_id = payload.get("sub")
    if not user_id:
        raise UnauthorizedError("Invalid token payload", error_code="INVALID_TOKEN")

    user = db.query(User).filter(User.id == uuid.UUID(user_id), User.is_active == True).first()
    if not user:
        raise UnauthorizedError("User not found or inactive", error_code="USER_NOT_FOUND")
    if not user.is_approved:
        raise UnauthorizedError("Account is awaiting root approval", error_code="ACCOUNT_PENDING_APPROVAL")
    if int(payload.get("tv", 0)) != int(user.token_version or 0):
        raise UnauthorizedError("Invalid or expired token", error_code="INVALID_TOKEN")

    return user


def get_current_admin(current_user=Depends(get_current_user)):
    from app.common.exceptions import AppError

    if not current_user.is_admin:
        raise AppError(status_code=403, detail="Admin privileges required", error_code="FORBIDDEN")
    return current_user
