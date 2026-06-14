import uuid
import hashlib
import logging
import secrets
import smtplib
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import bcrypt
from sqlalchemy.orm import Session

from app.auth.models import PasswordResetToken, User
from app.auth.jwt import create_access_token, create_refresh_token, decode_token
from app.common.exceptions import BadRequestError, NotFoundError
from app.config import settings

logger = logging.getLogger(__name__)
_PASSWORD_MIN_LENGTH = 10


def _hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def _verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _validate_password(password: str) -> None:
    if len(password or "") < _PASSWORD_MIN_LENGTH:
        raise BadRequestError(f"Password must be at least {_PASSWORD_MIN_LENGTH} characters", error_code="WEAK_PASSWORD")
    if not any(ch.isalpha() for ch in password) or not any(ch.isdigit() for ch in password):
        raise BadRequestError("Password must contain at least one letter and one number", error_code="WEAK_PASSWORD")


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _as_utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _issue_tokens(user: User) -> dict:
    access_token = create_access_token(str(user.id), int(user.token_version or 0))
    refresh_token = create_refresh_token(str(user.id), int(user.token_version or 0))
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
    }


def register_user(db: Session, email: str, password: str, display_name: str) -> User:
    email = _normalize_email(email)
    _validate_password(password)
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
    email = _normalize_email(email)
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
    return _issue_tokens(user)


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
    if int(payload.get("tv", 0)) != int(user.token_version or 0):
        raise BadRequestError("Invalid refresh token", error_code="INVALID_TOKEN")

    return _issue_tokens(user)


def _send_password_reset_email(email: str, token: str) -> None:
    link = f"{settings.APP_BASE_URL.rstrip('/')}/reset-password?token={token}"
    if not settings.SMTP_HOST:
        if settings.PASSWORD_RESET_LOG_TOKEN:
            logger.warning("Password reset link for %s: %s", email, link)
        return
    msg = EmailMessage()
    msg["Subject"] = "Reset your LabPlot AI password"
    msg["From"] = settings.SMTP_FROM
    msg["To"] = email
    msg.set_content(
        "A password reset was requested for your LabPlot AI account.\n\n"
        f"Open this link within {settings.PASSWORD_RESET_EXPIRE_MINUTES} minutes:\n{link}\n\n"
        "If you did not request this reset, you can ignore this email."
    )
    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=10) as smtp:
        smtp.starttls()
        if settings.SMTP_USERNAME:
            smtp.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
        smtp.send_message(msg)


def request_password_reset(db: Session, email: str) -> dict:
    email = _normalize_email(email)
    generic = {"message": "If an active account exists for that email, a password reset link has been sent."}
    user = db.query(User).filter(User.email == email, User.is_active == True).first()
    if not user:
        return generic

    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    reset = PasswordResetToken(
        user_id=user.id,
        token_hash=_token_hash(token),
        created_at=now,
        expires_at=now + timedelta(minutes=settings.PASSWORD_RESET_EXPIRE_MINUTES),
    )
    db.add(reset)
    db.commit()
    try:
        _send_password_reset_email(user.email, token)
    except Exception:
        logger.exception("Failed to send password reset email")
    return generic


def reset_password(db: Session, token: str, new_password: str) -> dict:
    _validate_password(new_password)
    reset = (
        db.query(PasswordResetToken)
        .filter(PasswordResetToken.token_hash == _token_hash(token), PasswordResetToken.used_at.is_(None))
        .first()
    )
    now = datetime.now(timezone.utc)
    if not reset or _as_utc(reset.expires_at) < now:
        raise BadRequestError("Invalid or expired password reset token", error_code="INVALID_RESET_TOKEN")
    user = db.query(User).filter(User.id == reset.user_id, User.is_active == True).first()
    if not user:
        raise BadRequestError("Invalid or expired password reset token", error_code="INVALID_RESET_TOKEN")
    user.hashed_password = _hash_password(new_password)
    user.token_version = int(user.token_version or 0) + 1
    reset.used_at = now
    db.commit()
    return {"message": "Password has been reset. Please sign in with the new password."}


def get_user_by_id(db: Session, user_id: uuid.UUID) -> User:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise NotFoundError("User", str(user_id))
    return user
