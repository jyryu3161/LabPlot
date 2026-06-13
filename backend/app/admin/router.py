import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.admin import service
from app.admin.schemas import (
    AdminPasswordReset, AdminUserCreate, AdminUserItem, AdminUserUpdate,
    AIConfigUpdate, AIConfigView,
)
from app.ai import config_service
from app.auth.models import User
from app.auth.schemas import UserResponse
from app.common.deps import get_current_admin, get_db

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/ai-config", response_model=AIConfigView)
def get_ai_config(db: Session = Depends(get_db), _: User = Depends(get_current_admin)):
    return config_service.public_view(config_service.get_config(db))


@router.put("/ai-config", response_model=AIConfigView)
def update_ai_config(data: AIConfigUpdate, db: Session = Depends(get_db), _: User = Depends(get_current_admin)):
    cfg = config_service.update_config(db, data.model_dump(exclude_unset=True))
    return config_service.public_view(cfg)


@router.get("/users", response_model=list[AdminUserItem])
def list_users(db: Session = Depends(get_db), _: User = Depends(get_current_admin)):
    return service.list_users(db)


@router.post("/users", response_model=UserResponse, status_code=201)
def create_user(data: AdminUserCreate, db: Session = Depends(get_db), _: User = Depends(get_current_admin)):
    return service.create_user(db, data.email, data.password, data.display_name, data.is_admin)


@router.patch("/users/{user_id}", response_model=UserResponse)
def update_user(
    user_id: uuid.UUID,
    data: AdminUserUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    return service.update_user(db, user_id, data, acting_user=admin)


@router.post("/users/{user_id}/reset-password", response_model=UserResponse)
def reset_password(
    user_id: uuid.UUID,
    data: AdminPasswordReset,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_admin),
):
    return service.reset_password(db, user_id, data.password)


@router.delete("/users/{user_id}", status_code=204)
def delete_user(
    user_id: uuid.UUID,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    service.delete_user(db, user_id, acting_user=admin)
