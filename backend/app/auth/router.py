from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.common.deps import get_db, get_current_user
from app.auth import service
from app.auth.models import User
from app.auth.schemas import (
    UserRegister,
    UserLogin,
    UserResponse,
    TokenResponse,
    TokenRefreshRequest,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", response_model=UserResponse, status_code=201)
def register(data: UserRegister, db: Session = Depends(get_db)):
    user = service.register_user(db, data.email, data.password, data.display_name)
    return user


@router.post("/login", response_model=TokenResponse)
def login(data: UserLogin, db: Session = Depends(get_db)):
    return service.login_user(db, data.email, data.password)


@router.post("/refresh", response_model=TokenResponse)
def refresh(data: TokenRefreshRequest, db: Session = Depends(get_db)):
    return service.refresh_tokens(db, data.refresh_token)


@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    return current_user
