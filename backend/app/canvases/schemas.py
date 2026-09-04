import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

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
    # U8: text/arrow/line/rect/ellipse annotation objects. None = leave
    # unchanged (the key can still be *absent* from the request entirely, or
    # explicitly sent as null — both are no-ops); [] = clear all annotations.
    # Sanitized server-side by service._sanitize_annotations before persisting.
    annotations: list[dict[str, Any]] | None = None
    # Optimistic-concurrency guard for the whole-array annotations replace
    # (mirrors figures RerenderRequest.base_version_id): when supplied, the
    # replace only proceeds if the stored annotations_rev still matches.
    # Mismatch -> 409 ANNOTATIONS_CONFLICT. Omitted keeps last-write-wins.
    base_annotations_rev: int | None = None
    # M-C1 §3: {label?, typography?} panel-label + typography style. Whole
    # object replaced after sanitize (service._sanitize_canvas_style) —
    # unknown keys dropped, an out-of-range/malformed KNOWN key -> 400
    # CANVAS_STYLE_INVALID. None (absent or explicit null) = leave unchanged.
    style: dict[str, Any] | None = None


class PanelCreate(BaseModel):
    # Exactly ONE of figure_id/image_key (service-enforced): a figure panel
    # references a figure; an image panel references an ALREADY-UPLOADED import
    # blob by its relative key ("canvases/imports/<hex32>.<ext>"). The key form
    # exists for undo-recreate and panel duplication — fresh images arrive via
    # the multipart POST /panels/image endpoint, never through here.
    figure_id: uuid.UUID | None = None
    image_key: str | None = Field(default=None, max_length=160)
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
    # None for imported-image panels (image_key set instead).
    figure_id: uuid.UUID | None = None
    image_key: str | None = None
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
    # M-C1 §3: {label, typography} — label always carries every field
    # (defaults filled in); typography is {} when unset.
    style: dict[str, Any] = Field(default_factory=dict)


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
    # M-C1 §3: sanitized {label, typography} — label always carries every
    # field (defaults filled in); typography is {} when unset.
    style: dict[str, Any] = Field(default_factory=dict)
    export_snapshot: dict[str, Any] | None = None
    created_at: datetime
    updated_at: datetime
    panels: list[CanvasPanel] = Field(default_factory=list)
    # U8: sanitized text/arrow/line/rect/ellipse annotation objects, always
    # painted above every panel (V1).
    annotations: list[dict[str, Any]] = Field(default_factory=list)
    annotations_rev: int = 0


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
    # svg/pdf/eps: vector composition only (design §1: never bitmap-stretch).
    # SVG nests each panel's physical-size vector render; PDF/EPS convert that
    # composite via rsvg-convert (librsvg) — a pure vector SVG→PDF/EPS. PDF
    # keeps text as text; EPS (M-C1 §8) is rsvg's `-f eps` output, which
    # renders text as outlines/paths (PostScript has no embedded-font path
    # here) — still exact vector geometry, just not text-selectable. png/tiff
    # (U9 §2) RASTERIZE that same composite via rsvg-convert at `dpi`; tiff is
    # LZW-compressed and derived from the png. pptx: one slide sized to the
    # canvas (mm→EMU) with each figure as its own movable picture (annotations
    # rendered as native shapes) — needs librsvg to rasterise the panels and
    # the python-pptx package.
    format: Literal["svg", "pdf", "eps", "png", "tiff", "pptx"] = "svg"
    # Raster DPI — png/tiff only, ignored for svg/pdf/eps/pptx. Output pixel
    # size is ceil(mm / 25.4 * dpi) (verified against the installed
    # rsvg-convert).
    dpi: Literal[300, 600] = 300
    # Crop the export to the tight bounding box of all content (panels +
    # annotations), removing the surrounding sheet margins. Applies to every
    # format.
    crop: bool = False


class CanvasExportSkippedPanel(BaseModel):
    panel_id: str
    reason: str


class CanvasExportResponse(BaseModel):
    url: str
    format: Literal["svg", "pdf", "eps", "png", "tiff", "pptx"]
    # Set for png/tiff exports only; None for svg/pdf/eps/pptx.
    dpi: int | None = None
    # {panel_id: version_id} snapshot recorded for reproducibility (design §5).
    snapshot: dict[str, str] = Field(default_factory=dict)
    # M-C1 §8: panels with no renderable source (no version yet, figure not
    # accessible to the exporting user, or a missing image blob) — the export
    # still succeeds with those panels simply absent from the composite.
    skipped_panels: list[CanvasExportSkippedPanel] = Field(default_factory=list)
    # Journal-submission-friendly filename, e.g.
    # "Fig_MyFigure_nature_89mm_300dpi.png" — see service._journal_filename.
    filename: str = "figure"


# ---------------------------------------------------------------- M4 apply-style
class CanvasApplyStyleRequest(BaseModel):
    # Style-only copy from one panel's figure to every OTHER panel figure. Each
    # target gets a NEW version (content ⇒ version bump, design decision 3).
    source_figure_id: uuid.UUID


class CanvasApplyStyleResponse(BaseModel):
    updated: list[uuid.UUID] = Field(default_factory=list)
    skipped: list[uuid.UUID] = Field(default_factory=list)


# ---------------------------------------------------------------- M-C1 §6 typography
class CanvasTypographyRequest(BaseModel):
    # A subset of CanvasStyle.typography — at least one key required. Server
    # validates via the same range checks as PATCH .../style (400
    # CANVAS_STYLE_INVALID), merges into canvas.style.typography, then
    # re-renders every distinct figure panel figure with the mapped patch.
    font_family: str | None = None
    base_pt: float | None = Field(default=None, ge=5, le=14)
    axis_line_width_pt: float | None = Field(default=None, ge=0.1, le=3.0)
    data_line_width_pt: float | None = Field(default=None, ge=0.1, le=3.0)

    @model_validator(mode="after")
    def _require_one(self) -> "CanvasTypographyRequest":
        if all(v is None for v in (self.font_family, self.base_pt, self.axis_line_width_pt, self.data_line_width_pt)):
            raise ValueError("at least one typography field is required")
        return self


# ---------------------------------------------------------------- M-C1 §2 presets
class CanvasPresetItem(BaseModel):
    key: str
    label: str
    width_mm: float
    height_mm: float
    max_height_mm: float | None = None
    journal: str | None = None
    journal_key: str | None = None
    column: Literal["single", "onehalf", "double"] | None = None


# ---------------------------------------------------------------- M-C1 §7 journal check
class CanvasJournalCheckItem(BaseModel):
    name: str
    ok: bool
    actual: str
    expected: str
    hint: str | None = None


class CanvasJournalSkippedPanel(BaseModel):
    panel_id: str
    reason: str


class CanvasJournalReport(BaseModel):
    canvas_id: uuid.UUID
    preset: str | None = None
    journal: str | None = None
    column: str | None = None
    passed: bool
    checks: list[CanvasJournalCheckItem] = Field(default_factory=list)
    skipped_panels: list[CanvasJournalSkippedPanel] = Field(default_factory=list)
