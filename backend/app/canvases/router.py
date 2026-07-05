import uuid

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.audit import service as audit_service
from app.auth.models import User
from app.canvases import service
from app.canvases.schemas import (
    CanvasApplyStyleRequest,
    CanvasApplyStyleResponse,
    CanvasCreate,
    CanvasDetail,
    CanvasExportRequest,
    CanvasExportResponse,
    CanvasListItem,
    CanvasPanel,
    CanvasUpdate,
    PanelCreate,
    PanelUpdate,
    PreviewRenderRequest,
)
from app.common.deps import get_current_user, get_db
from app.common.security import rate_limit

router = APIRouter(prefix="/api/canvases", tags=["canvases"])


# -------- preview (M1, ephemeral) --------
# Single SVG, NO FigureVersion created, content-hash cached (design §4),
# separate rate limit from figure_rerender.
@router.post("/preview", dependencies=[Depends(rate_limit("canvas_preview", 240, 3600))])
def preview(data: PreviewRenderRequest, db: Session = Depends(get_db),
            current_user: User = Depends(get_current_user)):
    return service.render_preview(db, current_user.id, data)


# -------- presets (data-only lookup) --------
# Declared before /{canvas_id} so the literal path wins over the parameter.
@router.get("/presets")
def canvas_presets(_: User = Depends(get_current_user)):
    return service.list_canvas_presets()


# -------- canvases (M2 CRUD) --------
@router.get("", response_model=list[CanvasListItem])
def list_canvases(project_id: uuid.UUID | None = None, db: Session = Depends(get_db),
                  current_user: User = Depends(get_current_user)):
    return service.list_canvases(db, current_user.id, project_id=project_id)


@router.post("", response_model=CanvasDetail, status_code=201,
             dependencies=[Depends(rate_limit("canvas_create", 60, 3600))])
def create_canvas(data: CanvasCreate, request: Request, db: Session = Depends(get_db),
                  current_user: User = Depends(get_current_user)):
    detail = service.create_canvas(db, current_user.id, data)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="canvas.create",
        target_type="canvas",
        target_id=detail["id"],
        metadata={"project_id": str(detail["project_id"]) if detail["project_id"] else None},
        request=request,
    )
    db.commit()
    return detail


@router.get("/{canvas_id}", response_model=CanvasDetail)
def get_canvas(canvas_id: uuid.UUID, db: Session = Depends(get_db),
               current_user: User = Depends(get_current_user)):
    return service.canvas_detail(db, canvas_id, current_user.id)


@router.patch("/{canvas_id}", response_model=CanvasDetail)
def update_canvas(canvas_id: uuid.UUID, data: CanvasUpdate, request: Request,
                  db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    changed = data.model_dump(exclude_unset=True)
    detail = service.update_canvas(db, canvas_id, current_user.id, changed)
    # Record WHAT changed — a project attach/move/detach alters sharing scope
    # and must be traceable in the audit trail.
    meta: dict = {"changed": sorted(changed.keys())}
    if "project_id" in changed:
        meta["project_id"] = str(changed["project_id"]) if changed["project_id"] else None
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="canvas.update",
        target_type="canvas",
        target_id=canvas_id,
        metadata=meta,
        request=request,
    )
    db.commit()
    return detail


@router.delete("/{canvas_id}", status_code=204)
def delete_canvas(canvas_id: uuid.UUID, request: Request, db: Session = Depends(get_db),
                  current_user: User = Depends(get_current_user)):
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


# -------- duplicate (U9 §3) --------
# Only READ access to the source is required (service.duplicate_canvas uses
# get_canvas without write=True) — any project member who can view a shared
# canvas can take a personal copy of it. The copy is always owned by the
# caller; project_id only carries over when the caller has write access to
# that project (else the copy is personal).
@router.post("/{canvas_id}/duplicate", response_model=CanvasDetail, status_code=201,
             dependencies=[Depends(rate_limit("canvas_duplicate", 60, 3600))])
def duplicate_canvas(canvas_id: uuid.UUID, request: Request, db: Session = Depends(get_db),
                     current_user: User = Depends(get_current_user)):
    detail = service.duplicate_canvas(db, canvas_id, current_user.id)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="canvas.duplicate",
        target_type="canvas",
        target_id=detail["id"],
        metadata={
            "source_canvas_id": str(canvas_id),
            "project_id": str(detail["project_id"]) if detail["project_id"] else None,
        },
        request=request,
    )
    db.commit()
    return detail


# -------- panels (M2 CRUD) --------
@router.post("/{canvas_id}/panels", response_model=CanvasPanel, status_code=201,
             dependencies=[Depends(rate_limit("canvas_panel_add", 120, 3600))])
def add_panel(canvas_id: uuid.UUID, data: PanelCreate, request: Request,
              db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    panel = service.add_panel(db, canvas_id, current_user.id, data)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="canvas.panel.add",
        target_type="canvas",
        target_id=canvas_id,
        metadata={"panel_id": str(panel["id"]), "figure_id": str(panel["figure_id"])},
        request=request,
    )
    db.commit()
    return panel


@router.patch("/{canvas_id}/panels/{panel_id}", response_model=CanvasPanel)
def update_panel(canvas_id: uuid.UUID, panel_id: uuid.UUID, data: PanelUpdate, request: Request,
                 db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # NOTE: never creates or touches a FigureVersion — canvas-owned geometry only.
    panel = service.update_panel(db, canvas_id, panel_id, current_user.id, data.model_dump(exclude_unset=True))
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="canvas.panel.update",
        target_type="canvas",
        target_id=canvas_id,
        metadata={"panel_id": str(panel_id)},
        request=request,
    )
    db.commit()
    return panel


@router.delete("/{canvas_id}/panels/{panel_id}", status_code=204)
def remove_panel(canvas_id: uuid.UUID, panel_id: uuid.UUID, request: Request,
                 db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    service.remove_panel(db, canvas_id, panel_id, current_user.id)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="canvas.panel.remove",
        target_type="canvas",
        target_id=canvas_id,
        metadata={"panel_id": str(panel_id)},
        request=request,
    )
    db.commit()


# -------- export (M4, vector composition; U9 §2 adds png/tiff raster) --------
# Composes every panel as VECTOR (nested SVG); PDF/PNG/TIFF via rsvg-convert
# (librsvg) — PNG/TIFF rasterize the SAME composite at `dpi` (300/600), never
# a per-panel bitmap stretch. Snapshots {panel_id: version_id} for
# reproducibility, for every format.
@router.post("/{canvas_id}/export", response_model=CanvasExportResponse,
             dependencies=[Depends(rate_limit("canvas_export", 30, 3600))])
def export_canvas(canvas_id: uuid.UUID, data: CanvasExportRequest, request: Request,
                  db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    result = service.export_canvas(db, canvas_id, current_user.id, data.format, data.dpi, data.crop)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="canvas.export",
        target_type="canvas",
        target_id=canvas_id,
        metadata={"format": result["format"], "dpi": result.get("dpi"), "crop": data.crop, "panels": len(result["snapshot"])},
        request=request,
    )
    db.commit()
    return result


# -------- canvas-wide bulk style apply (M4) --------
# Copies the source panel figure's STYLE-ONLY options to every OTHER panel's
# figure. Each target gets a NEW version (content ⇒ version bump, decision 3).
@router.post("/{canvas_id}/apply-style", response_model=CanvasApplyStyleResponse,
             dependencies=[Depends(rate_limit("canvas_apply_style", 60, 3600))])
def apply_style(canvas_id: uuid.UUID, data: CanvasApplyStyleRequest, request: Request,
                db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    result = service.apply_canvas_style(db, canvas_id, current_user.id, data.source_figure_id)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="canvas.apply_style",
        target_type="canvas",
        target_id=canvas_id,
        metadata={
            "source_figure_id": str(data.source_figure_id),
            "updated": len(result["updated"]),
            "skipped": len(result["skipped"]),
        },
        request=request,
    )
    db.commit()
    return result
