import uuid

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from app.audit import service as audit_service
from app.auth.models import User
from app.canvases import service
from app.canvases.schemas import (
    CanvasCreate,
    CanvasDetail,
    CanvasListItem,
    CanvasRenderResponse,
    CanvasUpdate,
)
from app.common import storage
from app.common.deps import get_current_user, get_db
from app.common.security import rate_limit

router = APIRouter(prefix="/api/canvases", tags=["canvases"])


@router.get("", response_model=list[CanvasListItem])
def list_canvases(project_id: uuid.UUID | None = None,
                  db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.list_canvases(db, current_user.id, project_id=project_id)


@router.post("", response_model=CanvasDetail, status_code=201,
             dependencies=[Depends(rate_limit("canvas_create", 60, 3600))])
def create_canvas(data: CanvasCreate, request: Request,
                  db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    detail = service.create_canvas(db, current_user.id, data)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="canvas.create",
        target_type="canvas",
        target_id=detail["id"],
        metadata={"name": detail["name"]},
        request=request,
    )
    db.commit()
    return detail


@router.get("/{canvas_id}", response_model=CanvasDetail)
def get_canvas(canvas_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.canvas_response(service.get_canvas(db, canvas_id, current_user.id))


@router.patch("/{canvas_id}", response_model=CanvasDetail)
def update_canvas(canvas_id: uuid.UUID, data: CanvasUpdate,
                  db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.update_canvas(db, canvas_id, current_user.id, data)


@router.delete("/{canvas_id}", status_code=204)
def delete_canvas(canvas_id: uuid.UUID, request: Request,
                  db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    service.delete_canvas(db, canvas_id, current_user.id)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="canvas.delete",
        target_type="canvas",
        target_id=canvas_id,
        metadata={},
        request=request,
    )
    db.commit()


@router.post("/{canvas_id}/render", response_model=CanvasRenderResponse,
             dependencies=[Depends(rate_limit("canvas_render", 60, 3600))])
def render_canvas(canvas_id: uuid.UUID, request: Request,
                  db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    result = service.render_canvas(db, canvas_id, current_user.id)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="canvas.render",
        target_type="canvas",
        target_id=canvas_id,
        metadata={},
        request=request,
    )
    db.commit()
    return result


@router.get("/{canvas_id}/export")
def export_canvas(canvas_id: uuid.UUID, format: str = "png",
                  db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    path, media, filename = service.export_path(db, canvas_id, current_user.id, format)
    if storage.is_object_ref(path):
        return Response(
            storage.read_bytes(path),
            media_type=media,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    return FileResponse(path, media_type=media, filename=filename)
