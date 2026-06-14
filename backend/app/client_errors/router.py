from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from app.auth.models import User
from app.client_errors import service
from app.client_errors.schemas import ClientErrorCreate
from app.common.deps import get_db, get_optional_current_user
from app.common.security import rate_limit

router = APIRouter(prefix="/api/client-errors", tags=["client-errors"])


@router.post("", status_code=204, dependencies=[Depends(rate_limit("client_errors", 60, 3600))])
def create_client_error(
    data: ClientErrorCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_optional_current_user),
):
    service.record_client_error(db, data, user=current_user, request=request)
    return Response(status_code=204)
