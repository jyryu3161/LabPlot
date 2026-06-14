from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.audit import service as audit_service
from app.common.deps import get_db, get_current_user
from app.common.security import rate_limit
from app.auth import service
from app.auth.models import User
from app.auth.schemas import (
    MessageResponse,
    PasswordResetConfirm,
    PasswordResetRequest,
    UserRegister,
    UserLogin,
    UserResponse,
    TokenResponse,
    TokenRefreshRequest,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", response_model=UserResponse, status_code=201,
             dependencies=[Depends(rate_limit("auth_register", 10, 3600))])
def register(data: UserRegister, request: Request, db: Session = Depends(get_db)):
    user = service.register_user(
        db,
        data.email,
        data.password,
        data.display_name,
        organization_id=data.organization_id,
        organization_name=data.organization_name,
    )
    audit_service.log_event(db, actor_id=user.id, action="auth.register", target_type="user", target_id=user.id, metadata={"email": user.email}, request=request)
    db.commit()
    return user


@router.post("/login", response_model=TokenResponse, dependencies=[Depends(rate_limit("auth_login", 20, 300))])
def login(data: UserLogin, request: Request, db: Session = Depends(get_db)):
    tokens = service.login_user(db, data.email, data.password)
    from app.auth.service import _normalize_email
    user = db.query(User).filter(User.email == _normalize_email(data.email)).first()
    if user:
        audit_service.log_event(db, actor_id=user.id, action="auth.login", target_type="user", target_id=user.id, metadata={}, request=request)
        db.commit()
    return tokens


@router.post("/refresh", response_model=TokenResponse, dependencies=[Depends(rate_limit("auth_refresh", 60, 300))])
def refresh(data: TokenRefreshRequest, db: Session = Depends(get_db)):
    return service.refresh_tokens(db, data.refresh_token)


@router.post("/forgot-password", response_model=MessageResponse,
             dependencies=[Depends(rate_limit("auth_forgot_password", 5, 3600))])
def forgot_password(data: PasswordResetRequest, request: Request, db: Session = Depends(get_db)):
    out = service.request_password_reset(db, data.email)
    audit_service.log_event(db, actor_id=None, action="auth.password_reset.request", target_type="user", target_id=None, metadata={"email": data.email}, request=request)
    db.commit()
    return out


@router.post("/reset-password", response_model=MessageResponse,
             dependencies=[Depends(rate_limit("auth_reset_password", 10, 3600))])
def reset_password(data: PasswordResetConfirm, request: Request, db: Session = Depends(get_db)):
    out = service.reset_password(db, data.token, data.password)
    audit_service.log_event(db, actor_id=None, action="auth.password_reset.complete", target_type="user", metadata={}, request=request)
    db.commit()
    return out


@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    return current_user
