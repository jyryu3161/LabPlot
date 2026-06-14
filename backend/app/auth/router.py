from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

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
def register(data: UserRegister, db: Session = Depends(get_db)):
    user = service.register_user(db, data.email, data.password, data.display_name)
    return user


@router.post("/login", response_model=TokenResponse, dependencies=[Depends(rate_limit("auth_login", 20, 300))])
def login(data: UserLogin, db: Session = Depends(get_db)):
    return service.login_user(db, data.email, data.password)


@router.post("/refresh", response_model=TokenResponse, dependencies=[Depends(rate_limit("auth_refresh", 60, 300))])
def refresh(data: TokenRefreshRequest, db: Session = Depends(get_db)):
    return service.refresh_tokens(db, data.refresh_token)


@router.post("/forgot-password", response_model=MessageResponse,
             dependencies=[Depends(rate_limit("auth_forgot_password", 5, 3600))])
def forgot_password(data: PasswordResetRequest, db: Session = Depends(get_db)):
    return service.request_password_reset(db, data.email)


@router.post("/reset-password", response_model=MessageResponse,
             dependencies=[Depends(rate_limit("auth_reset_password", 10, 3600))])
def reset_password(data: PasswordResetConfirm, db: Session = Depends(get_db)):
    return service.reset_password(db, data.token, data.password)


@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    return current_user
