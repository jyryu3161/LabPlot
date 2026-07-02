"""Multi-panel figure canvases: CRUD + composition of rendered figure PNGs."""
from __future__ import annotations

import os
import re
import shutil
import string
import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.canvases.models import FigureCanvas
from app.canvases.schemas import CanvasCreate, CanvasState, CanvasUpdate
from app.common import storage
from app.common.exceptions import BadRequestError, NotFoundError
from app.config import settings
from app.figures import service as figures_service
from app.r_engine import composer

_STATIC_ROOT = os.path.dirname(settings.figures_dir.rstrip("/"))

_EXPORT = {
    "png": ("png_path", "image/png", "png"),
    "pdf": ("pdf_path", "application/pdf", "pdf"),
}


def _url(abs_path: str | None) -> str | None:
    """Map a stored output path (local file or object-storage ref) to a URL.

    Mirrors figures.service._url so canvas outputs are served the same way
    figure version files are.
    """
    if not abs_path:
        return None
    if storage.is_object_ref(abs_path):
        return storage.asset_url(abs_path)
    try:
        rel = os.path.relpath(abs_path, _STATIC_ROOT)
    except ValueError:
        return None
    if rel.startswith(".."):
        return None
    return "/static/" + rel.replace(os.sep, "/")


def _output(canvas: FigureCanvas) -> dict:
    output = (canvas.state or {}).get("output")
    return output if isinstance(output, dict) else {}


def canvas_response(canvas: FigureCanvas) -> dict:
    output = _output(canvas)
    return {
        "id": canvas.id,
        "project_id": canvas.project_id,
        "name": canvas.name,
        "description": canvas.description,
        "preset": canvas.preset,
        "width_px": canvas.width_px,
        "height_px": canvas.height_px,
        "state": canvas.state or {},
        "png_url": _url(output.get("png_path")),
        "pdf_url": _url(output.get("pdf_path")),
        "created_at": canvas.created_at,
        "updated_at": canvas.updated_at,
    }


def _list_item_response(canvas: FigureCanvas) -> dict:
    state = canvas.state or {}
    items = state.get("items")
    return {
        "id": canvas.id,
        "project_id": canvas.project_id,
        "name": canvas.name,
        "preset": canvas.preset,
        "width_px": canvas.width_px,
        "height_px": canvas.height_px,
        "panel_count": len(items) if isinstance(items, list) else 0,
        "png_url": _url(_output(canvas).get("png_path")),
        "created_at": canvas.created_at,
        "updated_at": canvas.updated_at,
    }


# ---------------------------------------------------------------- retrieval
def get_canvas(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID) -> FigureCanvas:
    canvas = (
        db.query(FigureCanvas)
        .filter(FigureCanvas.id == canvas_id, FigureCanvas.owner_id == owner_id)
        .first()
    )
    if not canvas:
        raise NotFoundError("Canvas", str(canvas_id))
    return canvas


def list_canvases(db: Session, owner_id: uuid.UUID, project_id: uuid.UUID | None = None) -> list[dict]:
    q = db.query(FigureCanvas).filter(FigureCanvas.owner_id == owner_id)
    if project_id is not None:
        q = q.filter(FigureCanvas.project_id == project_id)
    rows = q.order_by(FigureCanvas.updated_at.desc()).all()
    return [_list_item_response(c) for c in rows]


# ---------------------------------------------------------------- CRUD
def create_canvas(db: Session, owner_id: uuid.UUID, data: CanvasCreate) -> dict:
    from app.projects import service as project_service

    if data.project_id is not None:
        # raises NotFound/Forbidden through the projects access check
        project_service.get_project_model(db, data.project_id, owner_id)
    state = data.state or CanvasState()
    canvas = FigureCanvas(
        id=uuid.uuid4(),
        owner_id=owner_id,
        project_id=data.project_id,
        name=data.name,
        description=data.description,
        preset=data.preset,
        width_px=data.width_px,
        height_px=data.height_px,
        state=state.model_dump(mode="json"),
    )
    db.add(canvas)
    db.commit()
    return canvas_response(canvas)


def update_canvas(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID, data: CanvasUpdate) -> dict:
    canvas = get_canvas(db, canvas_id, owner_id)
    fields = data.model_dump(exclude_unset=True)
    for key in ("name", "description", "preset", "width_px", "height_px"):
        if key in fields and fields[key] is not None:
            setattr(canvas, key, fields[key])
    if data.state is not None:
        # Replacing the layout invalidates any previously rendered output, so
        # the stale "output" key is intentionally dropped here.
        canvas.state = data.state.model_dump(mode="json")
    db.commit()
    return canvas_response(canvas)


def delete_canvas(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID) -> None:
    canvas = get_canvas(db, canvas_id, owner_id)
    db.delete(canvas)
    db.commit()
    # best-effort cleanup of composed outputs on local disk
    shutil.rmtree(_out_dir(canvas_id), ignore_errors=True)


# ---------------------------------------------------------------- rendering
def _out_dir(canvas_id: uuid.UUID) -> str:
    return os.path.join(settings.figures_dir, "canvases", str(canvas_id))


def _default_label(index: int, label_style: str) -> str:
    if label_style == "none" or index >= len(string.ascii_lowercase):
        return ""
    letter = string.ascii_lowercase[index]
    return letter.upper() if label_style == "upper" else letter


def _resolve_panels(db: Session, owner_id: uuid.UUID, state: CanvasState) -> list[dict]:
    """Resolve canvas items to panel PNG bytes with authorization.

    Every referenced figure must pass the same access check figures use
    (owner or accessible project) and the referenced version must have a
    rendered PNG available.
    """
    ordered = sorted(state.items, key=lambda item: (item.row, item.col))
    panels: list[dict] = []
    for index, item in enumerate(ordered):
        fig = figures_service.get_figure(db, item.figure_id, owner_id)
        version = figures_service.get_version(fig, item.version_id)
        if not version.png_path or not storage.exists(version.png_path):
            raise BadRequestError(
                f"Panel figure '{fig.name}' (version {version.version_number}) has no rendered PNG",
                error_code="PANEL_PNG_MISSING",
            )
        if state.label_style == "none":
            label = ""
        else:
            label = (item.label or "").strip() or _default_label(index, state.label_style)
        panels.append({
            "png_bytes": storage.read_bytes(version.png_path),
            "row": item.row,
            "col": item.col,
            "label": label[:8],
        })
    return panels


def render_canvas(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID) -> dict:
    canvas = get_canvas(db, canvas_id, owner_id)
    raw_state = dict(canvas.state or {})
    raw_state.pop("output", None)
    try:
        state = CanvasState.model_validate(raw_state)
    except ValueError as e:
        raise BadRequestError(f"Canvas layout is invalid: {e}", error_code="BAD_CANVAS_STATE")
    if not state.items:
        raise BadRequestError("Canvas has no panels to compose", error_code="EMPTY_CANVAS")

    panels = _resolve_panels(db, owner_id, state)
    out_dir = _out_dir(canvas.id)
    res = composer.compose(panels, state.rows, state.cols, canvas.width_px, canvas.height_px, out_dir)
    if not res.success:
        shutil.rmtree(out_dir, ignore_errors=True)
        tail = (res.log or "").strip()[-500:]
        raise BadRequestError(
            "Canvas composition failed" + (f": {tail}" if tail else ""),
            error_code="COMPOSE_FAILED",
        )

    outputs: dict[str, Any] = res.outputs
    if storage.object_storage_enabled():
        stored: dict[str, str] = {}
        content_types = {"png": "image/png", "pdf": "application/pdf", "r": "text/plain"}
        for kind, path in outputs.items():
            key = storage.object_key("figures", "canvases", canvas.id, os.path.basename(path))
            stored[kind] = storage.upload_file(path, key, content_type=content_types.get(kind))
        outputs = stored
        shutil.rmtree(out_dir, ignore_errors=True)

    new_state = dict(canvas.state or {})
    new_state["output"] = {"png_path": outputs.get("png"), "pdf_path": outputs.get("pdf")}
    canvas.state = new_state
    db.commit()
    return {"png_url": _url(outputs.get("png")), "pdf_url": _url(outputs.get("pdf"))}


# ---------------------------------------------------------------- export
def export_path(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID, fmt: str):
    if fmt not in _EXPORT:
        raise BadRequestError(f"Unsupported export format '{fmt}'", error_code="BAD_FORMAT")
    canvas = get_canvas(db, canvas_id, owner_id)
    key, media, ext = _EXPORT[fmt]
    path = _output(canvas).get(key)
    if not path or not storage.exists(path):
        raise NotFoundError("Canvas export", fmt)
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", canvas.name)
    filename = f"{safe}.{ext}"
    return path, media, filename
