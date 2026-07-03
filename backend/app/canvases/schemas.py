import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

# mm clamps (§5): canvas 20-500 mm/side; panel 10-500 mm/side.
_CANVAS_MM_MIN = 20.0
_CANVAS_MM_MAX = 500.0
_PANEL_MM_MIN = 10.0
_PANEL_MM_MAX = 500.0


class CanvasCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    project_id: uuid.UUID | None = None
    preset: str | None = Field(default=None, max_length=40)
    width_mm: float = Field(..., ge=_CANVAS_MM_MIN, le=_CANVAS_MM_MAX)
    height_mm: float = Field(..., ge=_CANVAS_MM_MIN, le=_CANVAS_MM_MAX)
    background: str | None = None


class CanvasUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    width_mm: float | None = Field(default=None, ge=_CANVAS_MM_MIN, le=_CANVAS_MM_MAX)
    height_mm: float | None = Field(default=None, ge=_CANVAS_MM_MIN, le=_CANVAS_MM_MAX)
    background: str | None = None
    preset: str | None = Field(default=None, max_length=40)
    # Attach to / move between / detach from a project (None detaches). The
    # service restricts ALL project_id changes to the canvas OWNER — a
    # non-owner editor could otherwise privatize a shared canvas.
    project_id: uuid.UUID | None = None


class PanelCreate(BaseModel):
    figure_id: uuid.UUID
    x_mm: float
    y_mm: float
    width_mm: float = Field(..., ge=_PANEL_MM_MIN, le=_PANEL_MM_MAX)
    height_mm: float = Field(..., ge=_PANEL_MM_MIN, le=_PANEL_MM_MAX)
    z_order: int | None = None
    label: str | None = Field(default=None, max_length=8)
    pinned_version_id: uuid.UUID | None = None


class PanelUpdate(BaseModel):
    x_mm: float | None = None
    y_mm: float | None = None
    width_mm: float | None = Field(default=None, ge=_PANEL_MM_MIN, le=_PANEL_MM_MAX)
    height_mm: float | None = Field(default=None, ge=_PANEL_MM_MIN, le=_PANEL_MM_MAX)
    z_order: int | None = None
    label: str | None = Field(default=None, max_length=8)
    label_visible: bool | None = None
    pinned_version_id: uuid.UUID | None = None


class CanvasPanel(BaseModel):
    id: uuid.UUID
    canvas_id: uuid.UUID
    figure_id: uuid.UUID
    pinned_version_id: uuid.UUID | None = None
    x_mm: float
    y_mm: float
    width_mm: float
    height_mm: float
    z_order: int
    label: str | None = None
    label_visible: bool
    created_at: datetime
    updated_at: datetime
    # Resolved for the editor without an extra round-trip (§3): pin or
    # figure.current_version_id, and the derived-cache render artifact (§4).
    effective_version_id: uuid.UUID | None = None
    render_url: str | None = None
    # Native render size (mm) of the effective version's options — lets the
    # editor offer original-size placement/reset. None when no version.
    native_width_mm: float | None = None
    native_height_mm: float | None = None


class CanvasListItem(BaseModel):
    id: uuid.UUID
    name: str
    project_id: uuid.UUID | None = None
    width_mm: float
    height_mm: float
    panel_count: int
    updated_at: datetime


class CanvasDetail(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None = None
    owner_id: uuid.UUID
    project_id: uuid.UUID | None = None
    width_mm: float
    height_mm: float
    preset: str | None = None
    background: str
    export_snapshot: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime
    panels: list[CanvasPanel] = Field(default_factory=list)


class PreviewOptionsOverlay(BaseModel):
    series_styles: dict[str, Any] | None = None
    category_colors: dict[str, Any] | None = None
    base_size: int | None = Field(default=None, ge=5, le=14)


class PreviewRenderRequest(BaseModel):
    figure_id: uuid.UUID
    version_id: uuid.UUID | None = None
    options_overlay: PreviewOptionsOverlay | None = None
    width_mm: float = Field(..., ge=_PANEL_MM_MIN, le=_PANEL_MM_MAX)
    height_mm: float = Field(..., ge=_PANEL_MM_MIN, le=_PANEL_MM_MAX)


# ---------------------------------------------------------------- M4 export
class CanvasExportRequest(BaseModel):
    # Vector composition only (design §1: never bitmap-stretch). SVG nests each
    # panel's physical-size vector render; PDF converts that composite via
    # rsvg-convert (librsvg) — a pure vector SVG→PDF, fonts preserved as text.
    format: Literal["svg", "pdf"] = "svg"


class CanvasExportResponse(BaseModel):
    url: str
    format: Literal["svg", "pdf"]
    # {panel_id: version_id} snapshot recorded for reproducibility (design §5).
    snapshot: dict[str, str] = Field(default_factory=dict)


# ---------------------------------------------------------------- M4 apply-style
class CanvasApplyStyleRequest(BaseModel):
    # Style-only copy from one panel's figure to every OTHER panel figure. Each
    # target gets a NEW version (content ⇒ version bump, design decision 3).
    source_figure_id: uuid.UUID


class CanvasApplyStyleResponse(BaseModel):
    updated: list[uuid.UUID] = Field(default_factory=list)
    skipped: list[uuid.UUID] = Field(default_factory=list)
