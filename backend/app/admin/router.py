import uuid

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.admin import service
from app.admin.schemas import (
    AdminGalleryFigureItem, AdminGalleryUnpublishResponse,
    AdminPasswordReset, AdminUserCreate, AdminUserItem, AdminUserUpdate,
    AIConfigUpdate, AIConfigView, AuditLogItem, ClientErrorItem,
    EmailDeliveryStatus, EmailTestRequest, EmailTestResponse,
)
from app.ai import config_service
from app.audit import service as audit_service
from app.auth.models import User
from app.client_errors import service as client_error_service
from app.auth.schemas import UserResponse
from app.common.deps import get_current_admin, get_db

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/ai-config", response_model=AIConfigView)
def get_ai_config(db: Session = Depends(get_db), _: User = Depends(get_current_admin)):
    return config_service.public_view(config_service.get_config(db))


@router.put("/ai-config", response_model=AIConfigView)
def update_ai_config(data: AIConfigUpdate, request: Request, db: Session = Depends(get_db), admin: User = Depends(get_current_admin)):
    cfg = config_service.update_config(db, data.model_dump(exclude_unset=True))
    audit_service.log_event(
        db,
        actor_id=admin.id,
        action="admin.ai_config.update",
        target_type="ai_config",
        target_id=str(cfg.id),
        metadata=data.model_dump(exclude_unset=True),
        request=request,
    )
    db.commit()
    return config_service.public_view(cfg)


@router.get("/email-config", response_model=EmailDeliveryStatus)
def get_email_config(_: User = Depends(get_current_admin)):
    return service.email_delivery_status()


@router.post("/email-test", response_model=EmailTestResponse)
def send_email_test(data: EmailTestRequest, request: Request, db: Session = Depends(get_db), admin: User = Depends(get_current_admin)):
    return service.send_email_test(db, data.email, acting_user=admin, request=request)


@router.get("/users", response_model=list[AdminUserItem])
def list_users(db: Session = Depends(get_db), _: User = Depends(get_current_admin)):
    return service.list_users(db)


@router.post("/users", response_model=UserResponse, status_code=201)
def create_user(data: AdminUserCreate, request: Request, db: Session = Depends(get_db), admin: User = Depends(get_current_admin)):
    return service.create_user(db, data.email, data.password, data.display_name, data.is_admin, acting_user=admin, request=request)


@router.patch("/users/{user_id}", response_model=UserResponse)
def update_user(
    user_id: uuid.UUID,
    data: AdminUserUpdate,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    return service.update_user(db, user_id, data, acting_user=admin, request=request)


@router.post("/users/{user_id}/reset-password", response_model=UserResponse)
def reset_password(
    user_id: uuid.UUID,
    data: AdminPasswordReset,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    return service.reset_password(db, user_id, data.password, acting_user=admin, request=request)


@router.delete("/users/{user_id}", status_code=204)
def delete_user(
    user_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    service.delete_user(db, user_id, acting_user=admin, request=request)


@router.get("/gallery", response_model=list[AdminGalleryFigureItem])
def list_gallery_figures(limit: int = 200, db: Session = Depends(get_db), _: User = Depends(get_current_admin)):
    return service.list_gallery_figures(db, limit=limit)


@router.post("/gallery/{figure_id}/unpublish", response_model=AdminGalleryUnpublishResponse)
def unpublish_gallery_figure(
    figure_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    return service.unpublish_gallery_figure(db, figure_id, acting_user=admin, request=request)


@router.get("/audit-logs", response_model=list[AuditLogItem])
def audit_logs(limit: int = 200, db: Session = Depends(get_db), _: User = Depends(get_current_admin)):
    return service.list_audit_logs(db, limit=limit)


@router.get("/client-errors", response_model=list[ClientErrorItem])
def client_errors(limit: int = 100, db: Session = Depends(get_db), _: User = Depends(get_current_admin)):
    return client_error_service.list_client_errors(db, limit=limit)
