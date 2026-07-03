from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from xml.sax.saxutils import escape as _xml_escape

from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from app.canvases.models import Canvas, CanvasPanel
from app.canvases.schemas import CanvasCreate, PanelCreate, PreviewRenderRequest
from app.common import storage
from app.common.encryption import decrypt_private_bytes
from app.common.exceptions import AppError, BadRequestError, NotFoundError
from app.config import settings
from app.datasets import service as ds_service
from app.datasets.models import Dataset
from app.figures import service as figures_service
from app.figures.models import Figure
from app.r_engine import renderer
from app.r_engine.presets import JOURNAL_SPECS, PRESETS

# mm clamps (design §5): canvas 20-500 mm/side; panel 10-500 mm/side. Enforced
# again defensively here even though the request schema already validates the
# range, so a degenerate value can never reach the R device / a stored row.
_CANVAS_MM_MIN = 20.0
_CANVAS_MM_MAX = 500.0
_PANEL_MM_MIN = 10.0
_PANEL_MM_MAX = 500.0

# Allowed canvas backgrounds (design §2). Anything else falls back to "white".
_CANVAS_BACKGROUNDS = {"white", "transparent"}

# Ephemeral preview cache namespace (design §4). Mirrors the existing figures
# storage layout: local under static/figures/canvases/preview, object storage
# under the "figures/canvases/preview" key prefix.
_PREVIEW_PARTS = ("figures", "canvases", "preview")


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, float(value)))


def _dataset_content_hash(ds: Dataset) -> str:
    """Stable content hash of the dataset (design §4).

    The Dataset model stores no precomputed content hash, so hash the decrypted
    file bytes. This keys the preview cache to the *data* — a new upload/replace
    produces a different hash and misses the stale cache.
    """
    raw = decrypt_private_bytes(storage.read_bytes(ds.file_path))
    return hashlib.sha256(raw).hexdigest()


def _local_cache_path(digest: str) -> str:
    return os.path.join(settings.figures_dir, "canvases", "preview", f"{digest}.svg")


def _local_layout_path(digest: str) -> str:
    return os.path.join(settings.figures_dir, "canvases", "preview", f"{digest}.layout.json")


def _object_cache_ref(digest: str) -> str:
    return storage.object_uri(storage.object_key(*_PREVIEW_PARTS, f"{digest}.svg"))


def _read_layout_local(digest: str) -> dict | None:
    """Parse the cached preview sidecar (series_hex / legend_keys / panel_px in
    the preview SVG's own px coords) — used by the canvas color editor for
    scoped instant recolor. Best-effort: any failure returns None."""
    try:
        path = _local_layout_path(digest)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else None
    except Exception:
        return None
    return None


def _read_layout_object(digest: str) -> dict | None:
    try:
        ref = storage.object_uri(storage.object_key(*_PREVIEW_PARTS, f"{digest}.layout.json"))
        if storage.exists(ref):
            data = json.loads(storage.read_bytes(ref).decode("utf-8"))
            return data if isinstance(data, dict) else None
    except Exception:
        return None
    return None


def render_preview(db: Session, owner_id: uuid.UUID, req: PreviewRenderRequest) -> dict:
    """Ephemeral single-SVG preview render (design decision 4, §3, §4).

    Thin public wrapper over :func:`_render_preview_ref` that maps the readable
    SVG storage ref to a served URL. External contract unchanged
    (``{svg_url, cached, layout}``).
    """
    ref, layout, cached = _render_preview_ref(db, owner_id, req)
    return {"svg_url": figures_service._url(ref), "cached": cached, "layout": layout}


def _render_preview_ref(db: Session, owner_id: uuid.UUID, req: PreviewRenderRequest) -> tuple[str, dict | None, bool]:
    """Ephemeral single-SVG preview render → (svg_ref, layout, cached).

    Renders the figure's current (or pinned) version at a custom physical size
    with an optional color/base_size overlay, WITHOUT creating a FigureVersion
    and WITHOUT touching the rerender() path. Content-hash cached: an identical
    request returns the cached SVG with cached=True and never re-renders.

    ``svg_ref`` is a reference readable by ``storage.read_bytes`` (a local
    filesystem path or an ``s3://`` object URI) — the canvas export composer
    reuses this to obtain each panel's raw physical-size vector SVG.
    """
    # 1. Owner/project-scoped figure access (404/403 as usual).
    fig = figures_service.get_figure(db, req.figure_id, owner_id)

    # Pick the version: explicit pin (must belong to the figure) else current.
    if req.version_id is not None:
        version = figures_service.get_version(fig, req.version_id)
    elif fig.current_version_id:
        version = figures_service.get_version(fig, fig.current_version_id)
    else:
        version = figures_service._current_or_latest_version(fig)
    if version is None:
        raise BadRequestError("Figure has no version to preview", error_code="NO_VERSION")

    plot_type = fig.plot_type
    ds = ds_service.get_dataset(db, fig.dataset_id, owner_id)
    valid_columns = figures_service._dataset_column_names(ds)

    # 2. Merge the overlay (series_styles / category_colors / base_size) ON TOP
    #    of the version's stored options, then run the whole thing through the
    #    figures allow-list so ONLY allow-listed keys reach R.
    merged = dict(version.options or {})
    overlay = req.options_overlay
    if overlay is not None:
        if overlay.series_styles is not None:
            merged["series_styles"] = overlay.series_styles
        if overlay.category_colors is not None:
            merged["category_colors"] = overlay.category_colors
        if overlay.base_size is not None:
            merged["base_size"] = overlay.base_size

    options = figures_service.sanitize_options(plot_type, merged, valid_columns)

    # Custom physical size -> inches for the R device (mm/25.4). base_size stays
    # absolute pt regardless of (w,h) — the re-layout guarantee (§5).
    w_mm = _clamp(req.width_mm, _PANEL_MM_MIN, _PANEL_MM_MAX)
    h_mm = _clamp(req.height_mm, _PANEL_MM_MIN, _PANEL_MM_MAX)
    options["size"] = "custom"
    options["width_in"] = w_mm / 25.4
    options["height_in"] = h_mm / 25.4

    preset = version.style_preset if version.style_preset in PRESETS else fig.style_preset
    if preset not in PRESETS:
        preset = "nature"

    mapping = version.mapping or {}

    # 3. Content-hash cache key (§4 preview cache).
    key_material = json.dumps(
        {
            "dataset_content_hash": _dataset_content_hash(ds),
            "plot_type": plot_type,
            "mapping": mapping,
            "options": options,
            "style_preset": preset,
            "w_mm": round(w_mm, 2),
            "h_mm": round(h_mm, 2),
        },
        sort_keys=True,
        default=str,
    )
    digest = hashlib.sha256(key_material.encode("utf-8")).hexdigest()

    # Cache hit -> return without rendering, no version, no artifact written.
    if storage.object_storage_enabled():
        cache_ref = _object_cache_ref(digest)
        if storage.exists(cache_ref):
            return cache_ref, _read_layout_object(digest), True
    else:
        cache_path = _local_cache_path(digest)
        if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
            return cache_path, _read_layout_local(digest), True

    # 4. Render (sandbox intact via renderer.render). Copy ONLY the SVG to the
    #    cache path; never persist png/version/etc. On failure raise RENDER_FAILED
    #    with no partial artifact.
    df = ds_service.load_dataframe(ds)
    with tempfile.TemporaryDirectory(prefix="labplot_preview_") as tmp_out_dir:
        res = renderer.render(plot_type, mapping, options, preset, df, tmp_out_dir)
        if not res.success:
            raise BadRequestError(figures_service._friendly_error(res.log), error_code="RENDER_FAILED")
        svg_src = (res.outputs or {}).get("svg")
        if not svg_src or not os.path.exists(svg_src):
            raise BadRequestError("Preview render produced no SVG", error_code="RENDER_FAILED")

        # Parse the sidecar produced for THIS preview render (series_hex /
        # legend_keys / panel_px in the preview SVG's own px), so the color
        # editor can scope its instant recolor. Best-effort.
        layout = None
        layout_src = (res.outputs or {}).get("layout")
        if layout_src and os.path.exists(layout_src):
            try:
                with open(layout_src, encoding="utf-8") as fh:
                    parsed = json.load(fh)
                layout = parsed if isinstance(parsed, dict) else None
            except Exception:
                layout = None

        if storage.object_storage_enabled():
            key = storage.object_key(*_PREVIEW_PARTS, f"{digest}.svg")
            cache_ref = storage.upload_file(svg_src, key, content_type="image/svg+xml")
            if layout is not None and layout_src:
                try:
                    storage.upload_file(layout_src, storage.object_key(*_PREVIEW_PARTS, f"{digest}.layout.json"), content_type="application/json")
                except Exception:
                    pass
            return cache_ref, layout, False

        cache_path = _local_cache_path(digest)
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        shutil.copyfile(svg_src, cache_path)
        if layout is not None and layout_src:
            try:
                shutil.copyfile(layout_src, _local_layout_path(digest))
            except Exception:
                pass
        return cache_path, layout, False


# ============================================================================
# M2 — canvas + panel CRUD (design §3). Plain owner/project-scoped CRUD over the
# `canvases` / `canvas_panels` tables. NONE of this touches the R engine or
# creates a FigureVersion: geometry/placement is canvas-owned (§1) and a panel
# PATCH only mutates a canvas_panels row.
# ============================================================================


# ---------------------------------------------------------------- retrieval
def get_canvas(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID, write: bool = False) -> Canvas:
    """Owner/project-scoped canvas fetch, mirroring figures.get_figure exactly.

    Visible when the caller owns it OR has project access; a write additionally
    requires project write access when the canvas is project-scoped. Anything
    else is a 404 (never leak existence across tenants).
    """
    from app.projects import service as project_service

    canvas = (
        db.query(Canvas)
        .options(joinedload(Canvas.panels))
        .filter(Canvas.id == canvas_id)
        .first()
    )
    if not canvas or (
        canvas.owner_id != owner_id
        and not project_service.can_access_project(db, canvas.project_id, owner_id)
    ):
        raise NotFoundError("Canvas", str(canvas_id))
    if write and canvas.owner_id != owner_id:
        project_service.require_project_write(db, canvas.project_id, owner_id)
    return canvas


def _get_panel(canvas: Canvas, panel_id: uuid.UUID) -> CanvasPanel:
    """A panel is only reachable through its canvas (panel.canvas_id == canvas.id)."""
    for panel in canvas.panels:
        if panel.id == panel_id:
            return panel
    raise NotFoundError("CanvasPanel", str(panel_id))


def _figure_current_versions(db: Session, figure_ids: list[uuid.UUID]) -> dict[uuid.UUID, uuid.UUID | None]:
    """Map figure_id -> figure.current_version_id for follow-latest resolution."""
    ids = list({fid for fid in figure_ids if fid is not None})
    if not ids:
        return {}
    rows = db.query(Figure.id, Figure.current_version_id).filter(Figure.id.in_(ids)).all()
    return {fid: cvid for fid, cvid in rows}


# ---------------------------------------------------------------- serialization
def _panel_response(panel: CanvasPanel, current_map: dict[uuid.UUID, uuid.UUID | None]) -> dict:
    # effective_version_id (§3): the pin if set, else the figure's current
    # version (None if the figure has no version yet). Resolved here so the
    # editor needs no extra round-trip. render_url is the committed derived-cache
    # artifact (§4), populated by later milestones; None for pure CRUD.
    effective = panel.pinned_version_id or current_map.get(panel.figure_id)
    return {
        "id": panel.id,
        "canvas_id": panel.canvas_id,
        "figure_id": panel.figure_id,
        "pinned_version_id": panel.pinned_version_id,
        "x_mm": panel.x_mm,
        "y_mm": panel.y_mm,
        "width_mm": panel.width_mm,
        "height_mm": panel.height_mm,
        "z_order": panel.z_order,
        "label": panel.label,
        "label_visible": panel.label_visible,
        "created_at": panel.created_at,
        "updated_at": panel.updated_at,
        "effective_version_id": effective,
        "render_url": None,
    }


def _canvas_detail(db: Session, canvas: Canvas) -> dict:
    current_map = _figure_current_versions(db, [p.figure_id for p in canvas.panels])
    # Ordered by z_order; ties broken by id for stable paint order (§2).
    panels = sorted(canvas.panels, key=lambda p: (p.z_order, str(p.id)))
    return {
        "id": canvas.id,
        "name": canvas.name,
        "description": canvas.description,
        "owner_id": canvas.owner_id,
        "project_id": canvas.project_id,
        "width_mm": canvas.width_mm,
        "height_mm": canvas.height_mm,
        "preset": canvas.preset,
        "background": canvas.background,
        "export_snapshot": canvas.export_snapshot,
        "created_at": canvas.created_at,
        "updated_at": canvas.updated_at,
        "panels": [_panel_response(p, current_map) for p in panels],
    }


def _canvas_list_item(canvas: Canvas) -> dict:
    return {
        "id": canvas.id,
        "name": canvas.name,
        "project_id": canvas.project_id,
        "width_mm": canvas.width_mm,
        "height_mm": canvas.height_mm,
        "panel_count": len(canvas.panels),
        "updated_at": canvas.updated_at,
    }


# ---------------------------------------------------------------- canvases
def list_canvases(db: Session, owner_id: uuid.UUID, project_id: uuid.UUID | None = None) -> list[dict]:
    """Owner's canvases plus project-accessible ones, newest first (§3)."""
    from app.projects import service as project_service

    q = db.query(Canvas).options(joinedload(Canvas.panels))
    if project_id is not None:
        project_service.get_project_model(db, project_id, owner_id)
        q = q.filter(Canvas.project_id == project_id)
    else:
        ids = project_service.accessible_project_ids(db, owner_id)
        q = q.filter(or_(Canvas.owner_id == owner_id, Canvas.project_id.in_(ids)))
    rows = q.order_by(Canvas.updated_at.desc()).all()
    return [_canvas_list_item(c) for c in rows]


def create_canvas(db: Session, owner_id: uuid.UUID, data: CanvasCreate) -> dict:
    from app.projects import service as project_service

    if data.project_id is not None:
        project_service.require_project_write(db, data.project_id, owner_id)
    background = data.background if data.background in _CANVAS_BACKGROUNDS else "white"
    canvas = Canvas(
        owner_id=owner_id,
        project_id=data.project_id,
        name=data.name,
        description=data.description,
        width_mm=_clamp(data.width_mm, _CANVAS_MM_MIN, _CANVAS_MM_MAX),
        height_mm=_clamp(data.height_mm, _CANVAS_MM_MIN, _CANVAS_MM_MAX),
        preset=data.preset,
        background=background,
    )
    db.add(canvas)
    db.commit()
    return canvas_detail(db, canvas.id, owner_id)


def canvas_detail(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID) -> dict:
    canvas = get_canvas(db, canvas_id, owner_id)
    return _canvas_detail(db, canvas)


def update_canvas(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID, data: dict) -> dict:
    canvas = get_canvas(db, canvas_id, owner_id, write=True)
    if data.get("name") is not None:
        canvas.name = data["name"]
    if "description" in data:
        canvas.description = data["description"]
    if data.get("width_mm") is not None:
        canvas.width_mm = _clamp(data["width_mm"], _CANVAS_MM_MIN, _CANVAS_MM_MAX)
    if data.get("height_mm") is not None:
        canvas.height_mm = _clamp(data["height_mm"], _CANVAS_MM_MIN, _CANVAS_MM_MAX)
    if data.get("background") is not None:
        canvas.background = data["background"] if data["background"] in _CANVAS_BACKGROUNDS else "white"
    if "preset" in data:
        canvas.preset = data["preset"]
    db.commit()
    return canvas_detail(db, canvas_id, owner_id)


def delete_canvas(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID) -> None:
    canvas = get_canvas(db, canvas_id, owner_id, write=True)
    db.delete(canvas)  # FK ON DELETE CASCADE + orm cascade removes panels
    db.commit()


# ---------------------------------------------------------------- panels
def _validate_pin(fig: Figure, pinned_version_id: uuid.UUID | None) -> None:
    if pinned_version_id is None:
        return
    if not any(v.id == pinned_version_id for v in fig.versions):
        raise BadRequestError(
            "pinned_version_id does not belong to this figure",
            error_code="BAD_PINNED_VERSION",
        )


def add_panel(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID, data: PanelCreate) -> dict:
    canvas = get_canvas(db, canvas_id, owner_id, write=True)
    # The figure must be accessible to the caller (owner OR project access);
    # get_figure raises NotFoundError (404) otherwise.
    fig = figures_service.get_figure(db, data.figure_id, owner_id)
    _validate_pin(fig, data.pinned_version_id)

    z_order = data.z_order
    if z_order is None:
        z_order = max((p.z_order for p in canvas.panels), default=-1) + 1

    panel = CanvasPanel(
        canvas_id=canvas.id,
        figure_id=fig.id,
        pinned_version_id=data.pinned_version_id,
        x_mm=data.x_mm,
        y_mm=data.y_mm,
        width_mm=_clamp(data.width_mm, _PANEL_MM_MIN, _PANEL_MM_MAX),
        height_mm=_clamp(data.height_mm, _PANEL_MM_MIN, _PANEL_MM_MAX),
        z_order=z_order,
        label=data.label,
    )
    db.add(panel)
    db.commit()
    db.refresh(panel)
    current_map = _figure_current_versions(db, [panel.figure_id])
    return _panel_response(panel, current_map)


def update_panel(db: Session, canvas_id: uuid.UUID, panel_id: uuid.UUID,
                 owner_id: uuid.UUID, data: dict) -> dict:
    """Mutate placement/size/label/z_order/pin of a panel row ONLY.

    CRITICAL (design §1 "resize = canvas-owned"): this never creates or touches a
    FigureVersion and never invokes the R engine — it writes only to the
    canvas_panels row. Panel width/height changes are geometry the canvas owns.
    """
    canvas = get_canvas(db, canvas_id, owner_id, write=True)
    panel = _get_panel(canvas, panel_id)

    if data.get("x_mm") is not None:
        panel.x_mm = data["x_mm"]
    if data.get("y_mm") is not None:
        panel.y_mm = data["y_mm"]
    if data.get("width_mm") is not None:
        panel.width_mm = _clamp(data["width_mm"], _PANEL_MM_MIN, _PANEL_MM_MAX)
    if data.get("height_mm") is not None:
        panel.height_mm = _clamp(data["height_mm"], _PANEL_MM_MIN, _PANEL_MM_MAX)
    if data.get("z_order") is not None:
        panel.z_order = data["z_order"]
    if "label" in data:
        panel.label = data["label"]
    if data.get("label_visible") is not None:
        panel.label_visible = data["label_visible"]
    if "pinned_version_id" in data:
        pin = data["pinned_version_id"]
        if pin is not None:
            fig = figures_service.get_figure(db, panel.figure_id, owner_id)
            _validate_pin(fig, pin)
        panel.pinned_version_id = pin

    db.commit()
    db.refresh(panel)
    current_map = _figure_current_versions(db, [panel.figure_id])
    return _panel_response(panel, current_map)


def remove_panel(db: Session, canvas_id: uuid.UUID, panel_id: uuid.UUID, owner_id: uuid.UUID) -> None:
    canvas = get_canvas(db, canvas_id, owner_id, write=True)
    panel = _get_panel(canvas, panel_id)
    db.delete(panel)
    db.commit()


# ---------------------------------------------------------------- presets
def list_canvas_presets() -> list[dict]:
    """Physical canvas-size presets derived from JOURNAL_SPECS (§3, pure lookup).

    For each journal spec, offer a single-column and double-column canvas: width
    = column inches x 25.4 mm; height = width x 0.72 (landscape-ish default);
    both clamped to the canvas range [20, 500] mm. No rendering.
    """
    out: list[dict] = []
    for key, spec in JOURNAL_SPECS.items():
        journal = spec.get("journal", key)
        for variant, in_key in (("single", "single_col_in"), ("double", "double_col_in")):
            width_in = spec.get(in_key)
            if not width_in:
                continue
            width_mm = _clamp(width_in * 25.4, _CANVAS_MM_MIN, _CANVAS_MM_MAX)
            height_mm = _clamp(width_mm * 0.72, _CANVAS_MM_MIN, _CANVAS_MM_MAX)
            out.append({
                "key": f"{key}_{variant}",
                "label": f"{journal} — {variant} column ({round(width_mm)} mm)",
                "width_mm": round(width_mm, 2),
                "height_mm": round(height_mm, 2),
            })
    return out


# ============================================================================
# M4 — canvas export (vector composition) + canvas-wide bulk style apply.
#
# CRITICAL (design §1): vector composition ONLY. Each panel is rendered at its
# exact physical mm size by the SAME renderer the preview uses (fonts stay pt),
# then its vector SVG is *nested* inside a parent SVG sized to the canvas. There
# is NO rasterization — the banned rasterGrob/bitmap-stretch path is never used.
# PDF is produced from that composite by rsvg-convert (librsvg), a vector
# SVG→PDF converter that keeps text as text.
# ============================================================================

_EXPORT_PARTS = ("figures", "canvases", "export")

# Panel label (A/B/C…) typography. Absolute pt → mm: the parent SVG's user unit
# is 1 mm (viewBox in mm, width/height in mm), so a physical pt size maps to
# `pt * 25.4 / 72` mm regardless of any panel scaling (§5 font invariance).
_LABEL_PT = 12.0
_PT_TO_MM = 25.4 / 72.0
_LABEL_FONT_MM = round(_LABEL_PT * _PT_TO_MM, 4)
_LABEL_INSET_MM = 1.0  # nudge in from the panel's top-left corner


def _num(value: float) -> str:
    """Format a float for SVG attributes (trim noise, never scientific)."""
    return f"{float(value):.4f}".rstrip("0").rstrip(".") or "0"


def _split_svg(svg_text: str) -> tuple[str, str]:
    """Return (opening-tag attribute string, inner markup) of an SVG document.

    Strips the XML/doctype preamble and the outer <svg> wrapper, keeping the
    children verbatim so vector fidelity (paths, text, defs) is preserved.
    """
    m = re.search(r"<svg\b([^>]*)>(.*)</svg\s*>", svg_text, re.DOTALL | re.IGNORECASE)
    if not m:
        raise BadRequestError("Panel SVG is malformed", error_code="BAD_PANEL_SVG")
    return m.group(1), m.group(2)


def _svg_native_size(attrs: str) -> tuple[float, float]:
    """Native (px) width/height of a panel SVG from its viewBox (preferred) or
    width/height attributes. Used as the nested <svg> viewBox so the panel scales
    cleanly into its mm box."""
    # svglite emits attributes with SINGLE quotes; accept either quote style.
    vb = re.search(r"""viewBox\s*=\s*["']([^"']+)["']""", attrs)
    if vb:
        parts = re.split(r"[\s,]+", vb.group(1).strip())
        if len(parts) == 4:
            try:
                w, h = float(parts[2]), float(parts[3])
                if w > 0 and h > 0:
                    return w, h
            except ValueError:
                pass

    def _dim(name: str) -> float | None:
        mm = re.search(rf"""\b{name}\s*=\s*["']([0-9.]+)""", attrs)
        return float(mm.group(1)) if mm else None

    return (_dim("width") or 100.0, _dim("height") or 100.0)


def _prefix_svg_ids(inner: str, prefix: str) -> str:
    """Scope every id + fragment reference in a panel's inner SVG with `prefix`.

    Nesting multiple independently-rendered SVGs into one document would collide
    on shared ids (svglite emits generic ids for <clipPath>/<defs>/gradients).
    Prefixing definitions AND their references (`url(#id)`, `href="#id"`) with a
    per-panel token keeps each panel's clip-paths/defs self-consistent.
    """
    # svglite uses single-quoted attributes; match either quote style.
    inner = re.sub(r"""\bid=["']([^"']+)["']""", lambda m: f'id="{prefix}{m.group(1)}"', inner)
    inner = re.sub(r"url\(#([^)]+)\)", lambda m: f"url(#{prefix}{m.group(1)})", inner)
    inner = re.sub(
        r"""\b(xlink:href|href)=["']#([^"']+)["']""",
        lambda m: f'{m.group(1)}="#{prefix}{m.group(2)}"',
        inner,
    )
    return inner


def _compose_canvas_svg(db: Session, owner_id: uuid.UUID, canvas: Canvas) -> tuple[str, dict[str, str]]:
    """Build the composite canvas SVG by nesting each panel's vector render.

    Returns (svg_text, snapshot) where snapshot is {panel_id: version_id} of the
    versions actually rendered (design §5 reproducibility).
    """
    w_mm = _clamp(canvas.width_mm, _CANVAS_MM_MIN, _CANVAS_MM_MAX)
    h_mm = _clamp(canvas.height_mm, _CANVAS_MM_MIN, _CANVAS_MM_MAX)

    current_map = _figure_current_versions(db, [p.figure_id for p in canvas.panels])
    # Paint order: ascending z_order (ties by id) → later panels drawn on top (§2).
    panels = sorted(canvas.panels, key=lambda p: (p.z_order, str(p.id)))

    parts: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        (
            '<svg xmlns="http://www.w3.org/2000/svg" '
            'xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" '
            f'width="{_num(w_mm)}mm" height="{_num(h_mm)}mm" '
            f'viewBox="0 0 {_num(w_mm)} {_num(h_mm)}">'
        ),
    ]
    # Background: opaque white unless the canvas is explicitly transparent (§2).
    if canvas.background != "transparent":
        parts.append(f'<rect x="0" y="0" width="{_num(w_mm)}" height="{_num(h_mm)}" fill="#ffffff"/>')

    snapshot: dict[str, str] = {}
    for idx, panel in enumerate(panels):
        effective = panel.pinned_version_id or current_map.get(panel.figure_id)
        if effective is None:
            continue  # figure has no version yet → nothing to render

        pw_mm = _clamp(panel.width_mm, _PANEL_MM_MIN, _PANEL_MM_MAX)
        ph_mm = _clamp(panel.height_mm, _PANEL_MM_MIN, _PANEL_MM_MAX)
        # Reuse the exact physical-size vector renderer (fonts stay pt, §5).
        ref, _layout, _cached = _render_preview_ref(
            db,
            owner_id,
            PreviewRenderRequest(
                figure_id=panel.figure_id,
                version_id=effective,
                width_mm=pw_mm,
                height_mm=ph_mm,
            ),
        )
        svg_text = storage.read_bytes(ref).decode("utf-8")
        attrs, inner = _split_svg(svg_text)
        native_w, native_h = _svg_native_size(attrs)
        inner = _prefix_svg_ids(inner, f"p{idx}_")

        parts.append(
            f'<svg x="{_num(panel.x_mm)}" y="{_num(panel.y_mm)}" '
            f'width="{_num(pw_mm)}" height="{_num(ph_mm)}" '
            f'viewBox="0 0 {_num(native_w)} {_num(native_h)}" '
            f'preserveAspectRatio="none" overflow="hidden">{inner}</svg>'
        )

        if panel.label_visible and panel.label:
            # Absolute-pt bold label pinned to the panel's top-left corner.
            ty = panel.y_mm + _LABEL_INSET_MM + _LABEL_FONT_MM
            tx = panel.x_mm + _LABEL_INSET_MM
            parts.append(
                f'<text x="{_num(tx)}" y="{_num(ty)}" '
                f'font-family="Helvetica, Arial, sans-serif" '
                f'font-size="{_num(_LABEL_FONT_MM)}" font-weight="bold" '
                f'fill="#000000">{_xml_escape(panel.label)}</text>'
            )

        snapshot[str(panel.id)] = str(effective)

    parts.append("</svg>")
    return "\n".join(parts), snapshot


def _persist_export(canvas_id: uuid.UUID, data: bytes, ext: str, content_type: str) -> str:
    """Write the composed export artifact to storage and return a served URL."""
    filename = f"{canvas_id}_{uuid.uuid4().hex}.{ext}"
    if storage.object_storage_enabled():
        key = storage.object_key(*_EXPORT_PARTS, filename)
        ref = storage.put_bytes(key, data, content_type=content_type)
        return figures_service._url(ref)
    out_path = os.path.join(settings.figures_dir, "canvases", "export", filename)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "wb") as fh:
        fh.write(data)
    return figures_service._url(out_path)


def export_canvas(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID, fmt: str) -> dict:
    """Compose all panels as VECTOR and export the canvas as SVG or PDF (§1).

    Records `{panel_id: version_id}` into `canvas.export_snapshot` for
    reproducibility (§5) and commits.
    """
    fmt = (fmt or "svg").lower()
    if fmt not in {"svg", "pdf"}:
        raise BadRequestError("format must be 'svg' or 'pdf'", error_code="BAD_EXPORT_FORMAT")

    # Fail fast if PDF is requested but the vector converter is unavailable —
    # never silently fall back to a raster path (that path is banned).
    if fmt == "pdf" and shutil.which("rsvg-convert") is None:
        raise AppError(
            status_code=501,
            detail="PDF export requires librsvg (rsvg-convert), which is not installed.",
            error_code="PDF_EXPORT_UNAVAILABLE",
        )

    canvas = get_canvas(db, canvas_id, owner_id)
    composite_svg, snapshot = _compose_canvas_svg(db, owner_id, canvas)

    if fmt == "svg":
        url = _persist_export(canvas_id, composite_svg.encode("utf-8"), "svg", "image/svg+xml")
    else:
        with tempfile.TemporaryDirectory(prefix="labplot_canvas_export_") as td:
            svg_path = os.path.join(td, "composite.svg")
            pdf_path = os.path.join(td, "out.pdf")
            with open(svg_path, "w", encoding="utf-8") as fh:
                fh.write(composite_svg)
            # Hardened subprocess: no shell, fixed literal args + trusted temp
            # paths, bounded runtime.
            try:
                subprocess.run(
                    ["rsvg-convert", "-f", "pdf", "-o", pdf_path, svg_path],
                    check=True,
                    capture_output=True,
                    timeout=60,
                )
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
                raise BadRequestError("PDF conversion failed", error_code="PDF_EXPORT_FAILED") from exc
            with open(pdf_path, "rb") as fh:
                pdf_bytes = fh.read()
        if not pdf_bytes:
            raise BadRequestError("PDF conversion produced no output", error_code="PDF_EXPORT_FAILED")
        url = _persist_export(canvas_id, pdf_bytes, "pdf", "application/pdf")

    # Snapshot the versions actually composed (§5), then commit.
    canvas.export_snapshot = snapshot
    db.commit()
    return {"url": url, "format": fmt, "snapshot": snapshot}


def apply_canvas_style(db: Session, canvas_id: uuid.UUID, owner_id: uuid.UUID,
                       source_figure_id: uuid.UUID) -> dict:
    """Apply the source figure's STYLE-ONLY options to every OTHER panel figure.

    Delegates to `figures_service.bulk_apply_style`, so each target figure gets a
    NEW version (content ⇒ version bump, design decision 3). The source must be
    one of the canvas's own panel figures. Returns {updated, skipped}.
    """
    canvas = get_canvas(db, canvas_id, owner_id, write=True)
    panel_figure_ids = [p.figure_id for p in canvas.panels]
    if source_figure_id not in panel_figure_ids:
        raise BadRequestError(
            "source_figure_id must be one of the canvas's panel figures",
            error_code="BAD_SOURCE_FIGURE",
        )
    targets = list({fid for fid in panel_figure_ids if fid != source_figure_id})
    result = figures_service.bulk_apply_style(db, source_figure_id, targets, owner_id)
    return {"updated": result.get("updated", []), "skipped": result.get("skipped", [])}
