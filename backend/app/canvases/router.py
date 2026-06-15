import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.models import User
from app.canvases import service
from app.canvases.schemas import (
    CanvasCreate,
    CanvasLegendResponse,
    CanvasListItem,
    CanvasResponse,
    CanvasStyleSuggestionRequest,
    CanvasStyleSuggestionResponse,
    CanvasUpdate,
)
from app.common.deps import get_current_user, get_db
from app.common.security import rate_limit

router = APIRouter(prefix="/api/canvases", tags=["canvases"])


@router.get("", response_model=list[CanvasListItem])
def list_canvases(
    project_id: uuid.UUID | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.list_canvases(db, current_user.id, project_id=project_id)


@router.post("", response_model=CanvasResponse, status_code=201,
             dependencies=[Depends(rate_limit("canvas_create", 60, 3600))])
def create_canvas(
    data: CanvasCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.create_canvas(db, current_user.id, data)


@router.get("/{canvas_id}", response_model=CanvasResponse)
def get_canvas(
    canvas_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.get_canvas(db, canvas_id, current_user.id)


@router.patch("/{canvas_id}", response_model=CanvasResponse,
              dependencies=[Depends(rate_limit("canvas_update", 240, 3600))])
def update_canvas(
    canvas_id: uuid.UUID,
    data: CanvasUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.update_canvas(db, canvas_id, current_user.id, data.model_dump(exclude_unset=True))


@router.post("/{canvas_id}/suggest-style", response_model=CanvasStyleSuggestionResponse,
             dependencies=[Depends(rate_limit("ai_canvas_style", 60, 3600))])
def suggest_style(
    canvas_id: uuid.UUID,
    data: CanvasStyleSuggestionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.suggest_canvas_style(
        db,
        canvas_id,
        current_user.id,
        selected_item_id=data.selected_item_id,
        instruction=data.instruction,
    )


@router.post("/{canvas_id}/legend", response_model=CanvasLegendResponse,
             dependencies=[Depends(rate_limit("ai_canvas_legend", 30, 3600))])
def generate_legend(
    canvas_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.generate_canvas_legend(db, canvas_id, current_user.id)


@router.delete("/{canvas_id}", status_code=204)
def delete_canvas(
    canvas_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    service.delete_canvas(db, canvas_id, current_user.id)
