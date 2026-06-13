import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.auth.models import User
from app.common.deps import get_current_user, get_db
from app.figures import service
from app.figures.schemas import (
    EnhancePromptRequest,
    EnhancePromptResponse,
    FigureCreate,
    FigureDetail,
    FigureListItem,
    FigureUpdate,
    GalleryFigureItem,
    ImprovementResponse,
    LegendResponse,
    RecommendationItem,
    RerenderRequest,
    ReviewResponse,
    VersionResponse,
)
from app.r_engine.presets import PRESET_LABELS, PRESETS, list_palettes
from app.r_engine.templates import PLOT_TYPES

router = APIRouter(prefix="/api/figures", tags=["figures"])
meta_router = APIRouter(prefix="/api", tags=["meta"])


# -------- meta --------
@meta_router.get("/plot-types")
def plot_types(_: User = Depends(get_current_user)):
    return {"plot_types": PLOT_TYPES}


@meta_router.get("/styles")
def styles(_: User = Depends(get_current_user)):
    return {"styles": [{"key": p, "label": PRESET_LABELS.get(p, p)} for p in PRESETS]}


@meta_router.get("/palettes")
def palettes(_: User = Depends(get_current_user)):
    return {"palettes": list_palettes()}


@meta_router.post("/ai/enhance-prompt", response_model=EnhancePromptResponse)
def enhance_prompt(data: EnhancePromptRequest, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    from app.ai import client as ai_client
    return {"enhanced": ai_client.enhance_prompt(db, data.draft, data.kind, data.context)}


@meta_router.post("/datasets/{dataset_id}/recommend", response_model=list[RecommendationItem])
def ai_recommend(dataset_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.ai_recommend(db, dataset_id, current_user.id)


# -------- figures --------
@router.post("", response_model=FigureDetail, status_code=201)
def create_figure(data: FigureCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.create_figure(db, current_user.id, data)


@router.get("", response_model=list[FigureListItem])
def list_figures(project_id: uuid.UUID | None = None, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.list_figures(db, current_user.id, project_id=project_id)


@router.get("/gallery", response_model=list[GalleryFigureItem])
def gallery(limit: int = 200, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return service.list_gallery_figures(db, limit=limit)


@router.get("/gallery/{figure_id}/versions/{version_id}/export")
def gallery_export(figure_id: uuid.UUID, version_id: uuid.UUID, format: str = "r",
                   db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    path, media, filename = service.gallery_export_path(db, figure_id, version_id, format)
    return FileResponse(path, media_type=media, filename=filename)


@router.get("/{figure_id}", response_model=FigureDetail)
def get_figure(figure_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.figure_detail(db, figure_id, current_user.id)


@router.patch("/{figure_id}", response_model=FigureDetail)
def update_figure(figure_id: uuid.UUID, data: FigureUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.update_figure(db, figure_id, current_user.id, data.model_dump(exclude_unset=True))


@router.post("/{figure_id}/versions/{version_id}/legend", response_model=LegendResponse)
def generate_legend(figure_id: uuid.UUID, version_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.generate_legend(db, figure_id, version_id, current_user.id)


@router.delete("/{figure_id}", status_code=204)
def delete_figure(figure_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    service.delete_figure(db, figure_id, current_user.id)


@router.post("/{figure_id}/rerender", response_model=VersionResponse)
def rerender(figure_id: uuid.UUID, req: RerenderRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.rerender(db, figure_id, current_user.id, req)


@router.post("/{figure_id}/versions/{version_id}/review", response_model=ReviewResponse)
def review(figure_id: uuid.UUID, version_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.review_version(db, figure_id, version_id, current_user.id)


@router.post("/{figure_id}/versions/{version_id}/improve", response_model=list[ImprovementResponse])
def improve(figure_id: uuid.UUID, version_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.improve_version(db, figure_id, version_id, current_user.id)


@router.get("/{figure_id}/versions/{version_id}/improvements", response_model=list[ImprovementResponse])
def list_improvements(figure_id: uuid.UUID, version_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.list_improvements(db, figure_id, version_id, current_user.id)


@router.post("/{figure_id}/improvements/{improvement_id}/apply", response_model=VersionResponse)
def apply_improvement(figure_id: uuid.UUID, improvement_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.apply_improvement(db, figure_id, improvement_id, current_user.id)


@router.get("/{figure_id}/versions/{version_id}/export")
def export(figure_id: uuid.UUID, version_id: uuid.UUID, format: str = "png",
           db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    path, media, filename = service.export_path(db, figure_id, version_id, format, current_user.id)
    return FileResponse(path, media_type=media, filename=filename)
