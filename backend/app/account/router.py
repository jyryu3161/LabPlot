from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.account import service
from app.account.schemas import AccountDeleteRequest
from app.auth.models import User
from app.common.deps import get_current_user, get_db
from app.common.quotas import quota_summary
from app.common.security import rate_limit

router = APIRouter(prefix="/api/account", tags=["account"])


@router.get("/usage")
def account_usage(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return quota_summary(db, current_user)


@router.get("/export", dependencies=[Depends(rate_limit("account_export", 10, 3600))])
def export_account(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    path, filename = service.build_account_export(db, current_user)
    return FileResponse(path, media_type="application/zip", filename=filename)


@router.delete("", status_code=204, dependencies=[Depends(rate_limit("account_delete", 5, 3600))])
def delete_account(
    data: AccountDeleteRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    service.delete_own_account(db, current_user, data.password, request=request)
