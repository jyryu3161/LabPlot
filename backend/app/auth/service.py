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
_DUMMY_PASSWORD_HASH = "$2b$12$pO9hpU9jrKBlz9wR62LnVOERfyY7yWSOIAAxaEnec82l3JgH3J2be"


class EmailDeliveryError(RuntimeError):
    """Raised when outbound email cannot be delivered."""


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


def register_user(
    db: Session,
    email: str,
    password: str,
    display_name: str,
    organization_id: uuid.UUID | None = None,
    organization_name: str | None = None,
) -> tuple[User, bool]:
    """Register a user.

    Returns ``(user, created)``. ``created`` is ``False`` when the email is
    already registered: to avoid account enumeration we do NOT reveal that the
    address is taken. Instead we return a synthetic, non-persisted user that is
    indistinguishable from a fresh registration (same response shape/status and
    the same field values a brand-new pending account would have) without
    leaking the existing account's real attributes.
    """
    email = _normalize_email(email)
    _validate_password(password)
    # Always hash so response timing does not depend on whether the email
    # exists (mirrors the dummy-hash pattern in authenticate_user).
    hashed_password = _hash_password(password)
    existing = db.query(User).filter(User.email == email).first()
    if existing:
        masked = User(
            id=uuid.uuid4(),
            email=email,
            display_name=display_name,
            is_active=True,
            is_approved=False,
            is_admin=False,
            token_version=0,
            active_organization_id=None,
            created_at=datetime.now(timezone.utc),
        )
        return masked, False

    user = User(
        email=email,
        hashed_password=hashed_password,
        display_name=display_name,
        is_approved=False,
    )
    db.add(user)
    db.flush()
    if organization_name and organization_name.strip():
        from app.organizations.schemas import OrganizationCreate
        from app.organizations.service import create_organization

        create_organization(db, user, OrganizationCreate(name=organization_name.strip()))
    elif organization_id:
        from app.organizations.service import request_join

        request_join(db, organization_id, user)
    db.commit()
    db.refresh(user)
    return user, True


def authenticate_user(db: Session, email: str, password: str) -> User:
    email = _normalize_email(email)
    user = db.query(User).filter(User.email == email).first()
    password_hash = user.hashed_password if user else _DUMMY_PASSWORD_HASH
    password_ok = _verify_password(password, password_hash)
    if not user or not password_ok:
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
    try:
        parsed_user_id = uuid.UUID(user_id)
    except (TypeError, ValueError):
        raise BadRequestError("Invalid refresh token", error_code="INVALID_TOKEN")
    user = db.query(User).filter(User.id == parsed_user_id).first()
    if not user or not user.is_active:
        raise BadRequestError("User not found or inactive", error_code="USER_NOT_FOUND")
    if not user.is_approved:
        raise BadRequestError("Account is awaiting root approval", error_code="ACCOUNT_PENDING_APPROVAL")
    if int(payload.get("tv", 0)) != int(user.token_version or 0):
        raise BadRequestError("Invalid refresh token", error_code="INVALID_TOKEN")

    # Idempotent refresh: re-issue an access+refresh pair carrying the current
    # token_version. We deliberately do NOT bump token_version here: it is a
    # single global per-user counter, so rotating it on every refresh would
    # invalidate the user's other devices/tabs (which each refresh hourly) and
    # cause spurious logouts. Global revocation is available via logout_user()
    # and password reset. (A per-token refresh-family store would be needed for
    # true refresh-token rotation without breaking multi-device sessions.)
    return _issue_tokens(user)


def logout_user(db: Session, user: User) -> None:
    """Revoke all outstanding tokens for the user by bumping token_version.

    Every access/refresh token carries the tv it was minted with; the tv check
    in common/deps.py and refresh_tokens rejects anything below the current
    value, so incrementing here invalidates all currently-issued tokens.
    """
    user.token_version = int(user.token_version or 0) + 1
    db.commit()


def smtp_status() -> dict:
    return {
        "configured": bool(settings.SMTP_HOST and settings.SMTP_FROM),
        "host": settings.SMTP_HOST or "",
        "port": settings.SMTP_PORT,
        "from_address": settings.SMTP_FROM or "",
        "username_set": bool(settings.SMTP_USERNAME),
        "use_tls": bool(settings.SMTP_USE_TLS),
        "use_ssl": bool(settings.SMTP_USE_SSL),
        "app_base_url": settings.APP_BASE_URL,
    }


def send_email(to_email: str, subject: str, text_body: str) -> None:
    if not settings.SMTP_HOST:
        raise EmailDeliveryError("SMTP_HOST is not configured")
    if not settings.SMTP_FROM:
        raise EmailDeliveryError("SMTP_FROM is not configured")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = settings.SMTP_FROM
    msg["To"] = to_email
    msg.set_content(text_body)

    try:
        smtp_cls = smtplib.SMTP_SSL if settings.SMTP_USE_SSL else smtplib.SMTP
        with smtp_cls(settings.SMTP_HOST, settings.SMTP_PORT, timeout=10) as smtp:
            if settings.SMTP_USE_TLS and not settings.SMTP_USE_SSL:
                smtp.starttls()
            if settings.SMTP_USERNAME:
                smtp.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
            smtp.send_message(msg)
    except Exception as exc:
        raise EmailDeliveryError("SMTP delivery failed") from exc


def _send_password_reset_email(email: str, token: str) -> None:
    link = f"{settings.APP_BASE_URL.rstrip('/')}/reset-password?token={token}"
    if not smtp_status()["configured"]:
        raise EmailDeliveryError("SMTP is not configured")
    send_email(
        email,
        "Reset your LabPlot AI password",
        "A password reset was requested for your LabPlot AI account.\n\n"
        f"Open this link within {settings.PASSWORD_RESET_EXPIRE_MINUTES} minutes:\n{link}\n\n"
        "If you did not request this reset, you can ignore this email.",
    )


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
    except EmailDeliveryError:
        logger.warning("Password reset email delivery failed")
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
