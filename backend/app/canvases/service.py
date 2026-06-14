from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.ai import client as ai_client
from app.canvases.models import FigureCanvas
from app.common.exceptions import BadRequestError, NotFoundError
from app.figures.models import Figure, FigureVersion
from app.projects import service as project_service
from app.r_engine.presets import list_palettes

_MAX_CANVAS_STATE_BYTES = 750_000
_PRESETS = {
    "double_column": (720, 500),
    "double_column_tall": (720, 900),
    "single_column": (360, 500),
}


def _state_size(state: dict[str, Any]) -> int:
    return len(json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _default_state(preset: str, width_px: int, height_px: int) -> dict[str, Any]:
    return {
        "version": 1,
        "preset": preset,
        "widthPx": width_px,
        "heightPx": height_px,
        "widthIn": 7.2 if preset.startswith("double_column") else 3.5,
        "heightIn": 5.0 if preset == "double_column" else 9.0 if preset == "double_column_tall" else 5.0,
        "exportDpi": 300,
        "panelLabelMode": "letters",
        "unifiedFontSize": 9,
        "items": [],
    }


def _normalize_state(state: dict[str, Any] | None, preset: str, width_px: int, height_px: int) -> dict[str, Any]:
    base = _default_state(preset, width_px, height_px)
    if not isinstance(state, dict):
        return base
    merged = {**base, **state}
    merged["version"] = 1
    merged["preset"] = preset
    merged["widthPx"] = width_px
    merged["heightPx"] = height_px
    if not isinstance(merged.get("items"), list):
        merged["items"] = []
    if _state_size(merged) > _MAX_CANVAS_STATE_BYTES:
        raise BadRequestError("Canvas state is too large", error_code="CANVAS_STATE_TOO_LARGE")
    return merged


def _extract_uuid(value: Any) -> uuid.UUID | None:
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _validate_canvas_state_figures(db: Session, owner_id: uuid.UUID, state: dict[str, Any]) -> None:
    items = state.get("items") or []
    if not isinstance(items, list):
        raise BadRequestError("Canvas items must be a list", error_code="BAD_CANVAS_STATE")
    for item in items:
        if not isinstance(item, dict):
            raise BadRequestError("Canvas item must be an object", error_code="BAD_CANVAS_STATE")
        figure_id = _extract_uuid(item.get("figureId") or item.get("figure_id"))
        version_id = _extract_uuid(item.get("versionId") or item.get("version_id"))
        if figure_id is None:
            continue
        fig = db.query(Figure).filter(Figure.id == figure_id, Figure.owner_id == owner_id).first()
        if not fig:
            raise BadRequestError("Canvas references a figure you do not own", error_code="BAD_CANVAS_FIGURE")
        if version_id is not None:
            exists = (
                db.query(FigureVersion.id)
                .filter(FigureVersion.id == version_id, FigureVersion.figure_id == figure_id)
                .first()
            )
            if not exists:
                raise BadRequestError("Canvas references a missing figure version", error_code="BAD_CANVAS_VERSION")


def _canvas_or_404(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID) -> FigureCanvas:
    row = db.query(FigureCanvas).filter(FigureCanvas.id == canvas_id, FigureCanvas.owner_id == owner_id).first()
    if not row:
        raise NotFoundError("Canvas", str(canvas_id))
    return row


def list_canvases(db: Session, owner_id: uuid.UUID, project_id: uuid.UUID | None = None) -> list[dict]:
    q = db.query(FigureCanvas).filter(FigureCanvas.owner_id == owner_id)
    if project_id:
        q = q.filter(FigureCanvas.project_id == project_id)
    rows = q.order_by(FigureCanvas.updated_at.desc()).all()
    return [
        {
            "id": row.id,
            "name": row.name,
            "description": row.description,
            "project_id": row.project_id,
            "preset": row.preset,
            "width_px": row.width_px,
            "height_px": row.height_px,
            "item_count": len((row.state or {}).get("items") or []),
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }
        for row in rows
    ]


def create_canvas(db: Session, owner_id: uuid.UUID, data) -> FigureCanvas:
    preset = data.preset if data.preset in _PRESETS else "double_column"
    width_px = data.width_px or _PRESETS[preset][0]
    height_px = data.height_px or _PRESETS[preset][1]
    if data.project_id is not None:
        project_service.get_project(db, data.project_id, owner_id)
        project_id = data.project_id
    else:
        project_id = project_service.ensure_default_project(db, owner_id).id
    state = _normalize_state(data.state, preset, width_px, height_px)
    _validate_canvas_state_figures(db, owner_id, state)
    row = FigureCanvas(
        owner_id=owner_id,
        project_id=project_id,
        name=data.name,
        description=data.description,
        preset=preset,
        width_px=width_px,
        height_px=height_px,
        state=state,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get_canvas(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID) -> FigureCanvas:
    return _canvas_or_404(db, canvas_id, owner_id)


def update_canvas(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID, data: dict) -> FigureCanvas:
    row = _canvas_or_404(db, canvas_id, owner_id)
    if "project_id" in data:
        project_id = data["project_id"]
        if project_id is not None:
            project_service.get_project(db, project_id, owner_id)
        row.project_id = project_id
    if data.get("name") is not None:
        row.name = data["name"]
    if "description" in data:
        row.description = data["description"]
    if data.get("preset") is not None:
        row.preset = data["preset"] if data["preset"] in _PRESETS else row.preset
    if data.get("width_px") is not None:
        row.width_px = data["width_px"]
    if data.get("height_px") is not None:
        row.height_px = data["height_px"]
    if "state" in data:
        state = _normalize_state(data["state"], row.preset, row.width_px, row.height_px)
        _validate_canvas_state_figures(db, owner_id, state)
        row.state = state
    db.commit()
    db.refresh(row)
    return row


def delete_canvas(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID) -> None:
    row = _canvas_or_404(db, canvas_id, owner_id)
    db.delete(row)
    db.commit()


def suggest_canvas_style(
    db: Session,
    canvas_id: uuid.UUID,
    owner_id: uuid.UUID,
    selected_item_id: str | None = None,
    instruction: str | None = None,
) -> dict:
    row = _canvas_or_404(db, canvas_id, owner_id)
    state = row.state or {}
    items = [item for item in (state.get("items") or []) if isinstance(item, dict)]
    figure_ids = [_extract_uuid(item.get("figureId") or item.get("figure_id")) for item in items]
    valid_figure_ids = [fid for fid in figure_ids if fid]
    figures = {
        str(fig.id): fig
        for fig in db.query(Figure).filter(Figure.owner_id == owner_id, Figure.id.in_(valid_figure_ids)).all()
    } if valid_figure_ids else {}
    panels = []
    for item in items[:12]:
        figure_id = str(item.get("figureId") or item.get("figure_id") or "")
        fig = figures.get(figure_id)
        panels.append({
            "id": str(item.get("id") or ""),
            "label": str(item.get("label") or ""),
            "name": str(item.get("name") or (fig.name if fig else "")),
            "plot_type": fig.plot_type if fig else "",
            "selected": bool(selected_item_id and str(item.get("id")) == selected_item_id),
            "x": item.get("x"),
            "y": item.get("y"),
            "width": item.get("width"),
            "height": item.get("height"),
        })
    context = {
        "name": row.name,
        "preset": row.preset,
        "width_px": row.width_px,
        "height_px": row.height_px,
        "width_in": state.get("widthIn"),
        "height_in": state.get("heightIn"),
        "unified_font_size": state.get("unifiedFontSize"),
        "panel_count": len(items),
        "panels": panels,
        "user_instruction": instruction or "",
    }
    palettes = list_palettes()
    return ai_client.suggest_canvas_style(db, context, palettes, user_id=owner_id)
