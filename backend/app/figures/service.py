from __future__ import annotations

import base64
import binascii
import io
import json
import math
import os
import re
import secrets
import shutil
import tempfile
import uuid
import zipfile
import xml.etree.ElementTree as ET
from types import SimpleNamespace
from typing import Any

from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from app.ai import client as ai_client
from app.auth.models import User
from app.common import storage
from app.common.exceptions import BadRequestError, ForbiddenError, NotFoundError
from app.common.quotas import enforce_render_quota
from app.config import settings
from app.datasets.models import Dataset
from app.datasets import service as ds_service
from app.figures import codegen
from app.figures.models import Figure, FigureCodeArtifact, FigureComment, FigureTemplateFavorite, FigureVersion, Improvement, Recommendation, Review
from app.palettes import service as palette_service
from app.projects.models import Project
from app.r_engine import renderer
from app.r_engine.presets import PRESETS, journal_spec
from app.r_engine.templates import PLOT_TYPES, PLOT_TYPE_KEYS, rq

_STATIC_ROOT = os.path.dirname(settings.figures_dir.rstrip("/"))
_UNIVERSAL_OPTION_KEYS = {
    "palette_name", "size", "width_in", "height_in", "color_mode", "font_scale", "dpi",
    "title", "subtitle", "x_label", "y_label", "legend_title",
    "hide_legend", "log_x", "log_y", "flip_coords", "x_text_angle", "legend_position",
    "x_min", "x_max", "y_min", "y_max",
    "custom_palette_values", "custom_palette_label", "category_colors",
    # New visual/layout options (contract with the R-engine agent). Universal so
    # they pass the allow-list for any plot type that renders them; unused keys
    # are simply ignored by templates that do not consume them.
    "fill_alpha", "point_alpha", "error_type", "color_midpoint", "level_order",
    "facet_by", "facet_scales", "hline_at", "vline_at", "font_family", "transparent_background",
    # Gates the self-contained interactive plotly HTML export (bool).
    "interactive_html",
    # Statistical-annotation / model-fit options (contract with the plot-types
    # agent in templates.py). Universal so they pass the allow-list for any plot
    # type that renders them; unused keys are ignored by templates that do not.
    "fit_model", "show_n", "show_significance", "show_fit_stats",
    # Secondary-axis options (contract with the plot-types agent in
    # templates.py): y2_column must reference a real dataset column and
    # y2_label is a plain axis-label string.
    "y2_column", "y2_label",
    # Data-label / axis-tick / legend-layout options (contract with the
    # templates.py & presets.py agents). Universal so they pass the allow-list
    # for any plot type; unused keys are ignored by templates that do not render
    # them. Bool/number/choice shapes are enforced in _sanitize_option.
    "show_data_labels", "data_label_format",
    "reverse_x", "reverse_y", "x_breaks", "y_breaks",
    "x_tick_format", "y_tick_format",
    "legend_key_size", "legend_ncol",
    # Structured overlays (custom-sanitized to shape-safe dicts/lists below):
    # free-form annotations and per-series style overrides.
    "annotations", "series_styles",
}
_OPTION_CHOICES = {
    "palette_name": {"preset", "journal_muted", "okabe_ito", "tol_bright", "set2", "npg", "tableau10"},
    "size": {"single_column", "wide", "double_column", "square", "custom"},
    "color_mode": {"color", "grayscale"},
    "stat": {"mean", "sum", "count"},
    "palette": {"blue_red", "viridis", "magma", "inferno", "plasma", "cividis"},
    "corr_method": {"pearson", "spearman"},
    "layout": {"fr", "kk", "circle", "stress"},
    "legend_position": {"right", "bottom", "none"},
    "line_type": {"solid", "dashed", "dotted", "dotdash", "longdash"},
    "point_shape": {"circle", "square", "triangle", "diamond", "none"},
    "error_type": {"sd", "se", "ci95"},
    "facet_scales": {"fixed", "free", "free_x", "free_y"},
    # Superset of the base families plus the extra families the presets agent
    # adds; unknown values are dropped by the membership check.
    "font_family": {"sans", "serif", "mono", "helvetica", "arial", "times", "noto_sans", "noto_serif"},
    # Number formatting for on-plot data labels and axis ticks.
    "data_label_format": {"number", "percent", "comma"},
    "x_tick_format": {"number", "comma", "percent", "scientific"},
    "y_tick_format": {"number", "comma", "percent", "scientific"},
    # Curve-fit model for regression/dose-response templates (default "linear"
    # applied by the template; invalid values are dropped so the render falls
    # back to that default).
    "fit_model": {"linear", "4pl", "mm", "exponential", "logistic"},
    # Stacked-area stacking mode.
    "stack_mode": {"stack", "fill"},
}
_BOOL_OPTIONS = {
    "show_points", "show_box", "error_bars", "scale_rows", "add_smooth", "show_density", "show_rug",
    "show_values", "hide_legend", "log_x", "log_y", "flip_coords", "connect_points", "show_contour_lines",
    "cluster_rows", "cluster_cols", "show_row_names", "show_labels", "color_bars", "paired_rows_only",
    "transparent_background",
    "show_n", "show_significance", "show_fit_stats",
    # Per-type toggles for the new plot types (sina/qq/forest/dot_plot/lollipop/embedding).
    "show_violin", "show_line", "sort_by_estimate", "sort_desc", "show_cluster_labels",
    # Data-label toggle and axis reversal.
    "show_data_labels", "reverse_x", "reverse_y",
    # Gates the self-contained interactive plotly HTML export.
    "interactive_html",
}
_NUMBER_OPTIONS = {
    "fc_threshold", "p_threshold", "label_top", "font_scale", "dpi", "width_in", "height_in",
    "bins", "sig_threshold", "bar_alpha", "bar_width", "x_text_angle", "x_min", "x_max", "y_min", "y_max",
    "fill_alpha", "point_alpha", "color_midpoint", "hline_at", "vline_at",
    # Forest reference line + ridgeline overlap factor (new plot types).
    "ref_line", "overlap",
    # Axis tick-count hints and legend layout sizing (clamped in _sanitize_option).
    "x_breaks", "y_breaks", "legend_key_size", "legend_ncol",
}
_COLOR_WORDS = {
    "blue": "#2563EB",
    "파란": "#2563EB",
    "파란색": "#2563EB",
    "red": "#DC2626",
    "빨간": "#DC2626",
    "빨간색": "#DC2626",
    "black": "#111827",
    "검정": "#111827",
    "검은색": "#111827",
    "gray": "#6B7280",
    "grey": "#6B7280",
    "회색": "#6B7280",
    "green": "#16A34A",
    "초록": "#16A34A",
    "초록색": "#16A34A",
}
# Shared 6-digit hex-color validator (matches the inline checks used for
# category_colors / line_color / palettes). Colors are upper-cased before test.
_HEX_COLOR_RE = re.compile(r"#[0-9A-F]{6}")
_LINE_COMPONENT_RE = re.compile(r"(line|선|라인)")
_NON_LINE_COLOR_TARGET_RE = re.compile(
    r"(axis|축|tick|눈금|label|라벨|legend|범례|text|텍스트|글씨|point|marker|점|마커|bar|막대|category|group|그룹)"
)
_LOCALIZED_EDIT_MARKER = "Localized image editing annotations for R-code regeneration:"
_DEFAULT_LOCALIZED_EDIT_PROMPT = "Apply the localized edits marked on the figure preview."
_R_POINT_SHAPES = {
    "circle": 16,
    "square": 15,
    "triangle": 17,
    "diamond": 18,
    "none": None,
}
_MAX_SVG_BYTES = 5 * 1024 * 1024
_BLOCKED_SVG_TAGS = {"script", "foreignobject", "iframe", "object", "embed", "link"}
_MAX_AI_EDITOR_IMAGE_BYTES = 8 * 1024 * 1024
_AI_EDITOR_IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/webp"}


def _project_context(db: Session, project_id) -> str | None:
    if not project_id:
        return None
    from app.projects.models import Project
    p = db.query(Project).filter(Project.id == project_id).first()
    if p and (p.description or "").strip():
        return f"Study: {p.name}. {p.description.strip()}"
    return None


# ---------------------------------------------------------------- helpers
def _url(abs_path: str | None) -> str | None:
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


def _friendly_error(log: str) -> str:
    if not log:
        return "Rendering failed for unknown reasons."
    lines = [ln for ln in log.splitlines() if "error" in ln.lower()]
    msg = lines[-1] if lines else log.strip().splitlines()[-1]
    msg = re.sub(r"^Error[^:]*:\s*", "", msg).strip()
    # make a couple of common R errors human-friendly
    if "subscript out of bounds" in msg or "undefined columns" in msg:
        msg = "A selected column was not found in the data. Check your column mapping."
    if "must be a numeric" in msg or "non-numeric" in msg:
        msg = "A column expected to be numeric contains non-numeric values."
    if msg.startswith("A selected column") or msg.startswith("A column expected"):
        return msg
    return "Rendering failed. Check the chart type, column mappings, and options."


def _decode_ai_editor_image(data_url: str | None) -> tuple[bytes, str] | None:
    if not data_url:
        return None
    if not isinstance(data_url, str):
        raise BadRequestError("Annotated image must be a data URL.", error_code="BAD_ANNOTATED_IMAGE")
    raw = data_url.strip()
    mime = "image/png"
    payload = raw
    if raw.startswith("data:"):
        header, sep, encoded = raw.partition(",")
        if not sep or ";base64" not in header.lower():
            raise BadRequestError("Annotated image must be base64 encoded.", error_code="BAD_ANNOTATED_IMAGE")
        mime = header[5:].split(";", 1)[0].lower()
        payload = encoded
    if mime not in _AI_EDITOR_IMAGE_MIME_TYPES:
        raise BadRequestError("Annotated image must be PNG, JPEG, or WebP.", error_code="BAD_ANNOTATED_IMAGE_TYPE")
    try:
        image_bytes = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise BadRequestError("Annotated image could not be decoded.", error_code="BAD_ANNOTATED_IMAGE")
    if len(image_bytes) > _MAX_AI_EDITOR_IMAGE_BYTES:
        raise BadRequestError("Annotated image must be 8 MB or smaller.", error_code="ANNOTATED_IMAGE_TOO_LARGE")
    if not image_bytes:
        raise BadRequestError("Annotated image is empty.", error_code="EMPTY_ANNOTATED_IMAGE")
    return image_bytes, mime


def _plot_def(plot_type: str) -> dict:
    for p in PLOT_TYPES:
        if p["type"] == plot_type:
            return p
    raise BadRequestError(f"Unknown plot type '{plot_type}'", error_code="UNKNOWN_PLOT_TYPE")


def validate_mapping(plot_type: str, mapping: dict) -> None:
    if plot_type not in PLOT_TYPE_KEYS:
        raise BadRequestError(f"Unsupported plot type '{plot_type}'", error_code="UNKNOWN_PLOT_TYPE")
    pdef = _plot_def(plot_type)
    missing = []
    for req in pdef["required"]:
        key = req["key"]
        val = (mapping or {}).get(key)
        if req.get("multi"):
            if not val or (isinstance(val, list) and len(val) == 0):
                missing.append(req["label"])
        elif val in (None, ""):
            missing.append(req["label"])
    if missing:
        raise BadRequestError("Missing required mapping: " + ", ".join(missing), error_code="MISSING_MAPPING")


def _dataset_column_names(ds: Dataset | None) -> set[str]:
    """Real column names of a dataset, taken from its stored column_profile.

    Used as the authoritative allow-list when validating any option/mapping value
    that references a data column (new AI encodings, facet_by, ...).
    """
    names: set[str] = set()
    if ds is None:
        return names
    for column in (ds.column_profile or []):
        if not isinstance(column, dict):
            continue
        name = column.get("name")
        if isinstance(name, str) and name:
            names.add(name)
    return names


def _dataset_columns_for_ai(ds: Dataset | None, limit: int = 60) -> list[dict[str, Any]]:
    """Compact column descriptors for the AI improve context: name, role, dtype,
    and low-cardinality distinct values (cheap, straight from the stored profile).

    This is what lets the editor add a NEW encoding (e.g. "color points by
    treatment") because the model can see which real columns exist and what the
    small categorical levels are.
    """
    out: list[dict[str, Any]] = []
    if ds is None:
        return out
    for column in (ds.column_profile or []):
        if not isinstance(column, dict):
            continue
        name = column.get("name")
        if not isinstance(name, str) or not name:
            continue
        entry: dict[str, Any] = {"name": name}
        if column.get("role"):
            entry["role"] = column.get("role")
        if column.get("dtype"):
            entry["dtype"] = column.get("dtype")
        n_unique = column.get("n_unique")
        sample = column.get("sample_values")
        if isinstance(n_unique, int) and 0 < n_unique <= 12 and isinstance(sample, list) and sample:
            entry["distinct_values"] = [str(v) for v in sample[:12]]
        out.append(entry)
        if len(out) >= limit:
            break
    return out


def sanitize_options(plot_type: str, options: dict | None, valid_columns: set[str] | None = None) -> dict:
    pdef = _plot_def(plot_type)
    allowed_options = {o["key"] for o in pdef.get("options", [])} | _UNIVERSAL_OPTION_KEYS
    clean: dict[str, Any] = {}
    if not isinstance(options, dict):
        return clean
    for key, value in options.items():
        if key not in allowed_options:
            continue
        sanitized = _sanitize_option(key, value, valid_columns)
        if sanitized is not None:
            clean[key] = sanitized
    return clean


def _resolve_custom_palette_options(db: Session, owner_id: uuid.UUID, options: dict | None) -> dict:
    clean = dict(options or {})
    palette_name = clean.get("palette_name")
    if isinstance(palette_name, str) and palette_name.startswith("custom:"):
        try:
            palette_id = uuid.UUID(palette_name.split(":", 1)[1])
        except (ValueError, IndexError):
            raise BadRequestError("Custom palette was not found", error_code="CUSTOM_PALETTE_NOT_FOUND")
        row = palette_service.get_user_palette(db, owner_id, palette_id)
        clean["custom_palette_values"] = palette_service.normalize_colors(row.colors or [])
        clean["custom_palette_label"] = row.name
    elif palette_name == "custom":
        if "custom_palette_values" in clean:
            clean["custom_palette_values"] = palette_service.normalize_colors(clean.get("custom_palette_values"))
        else:
            clean.pop("custom_palette_label", None)
    else:
        clean.pop("custom_palette_values", None)
        clean.pop("custom_palette_label", None)
    return clean


def version_response(v: FigureVersion) -> dict:
    return {
        "id": v.id,
        "version_number": v.version_number,
        "mapping": v.mapping or {},
        "options": v.options or {},
        "style_preset": v.style_preset,
        "change_note": v.change_note,
        "created_at": v.created_at,
        "png_url": _url(v.png_path),
        "svg_url": _url(v.svg_path),
        "tiff_url": _url(v.tiff_path),
        "pdf_url": _url(v.pdf_path),
        "eps_url": _url(v.eps_path),
        "html_url": _url(v.html_path),
        "r_url": _url(v.r_path),
    }


# ---------------------------------------------------------------- retrieval
def get_figure(db: Session, figure_id: uuid.UUID, owner_id: uuid.UUID, write: bool = False) -> Figure:
    from app.projects import service as project_service

    fig = (
        db.query(Figure)
        .options(joinedload(Figure.versions), joinedload(Figure.dataset))
        .filter(Figure.id == figure_id)
        .first()
    )
    if not fig or (fig.owner_id != owner_id and not project_service.can_access_project(db, fig.project_id, owner_id)):
        raise NotFoundError("Figure", str(figure_id))
    if write and fig.owner_id != owner_id:
        project_service.require_project_write(db, fig.project_id, owner_id)
    return fig


def get_version(fig: Figure, version_id: uuid.UUID) -> FigureVersion:
    for v in fig.versions:
        if v.id == version_id:
            return v
    raise NotFoundError("FigureVersion", str(version_id))


def _current_or_latest_version(fig: Figure) -> FigureVersion | None:
    if not fig.versions:
        return None
    if fig.current_version_id:
        for version in fig.versions:
            if version.id == fig.current_version_id:
                return version
    return max(fig.versions, key=lambda version: version.version_number)


def _favorite_version(fig: Figure, favorite: FigureTemplateFavorite) -> FigureVersion | None:
    if favorite.source_version_id:
        for version in fig.versions:
            if version.id == favorite.source_version_id:
                return version
    return _current_or_latest_version(fig)


def _favorite_figure_ids(db: Session, owner_id: uuid.UUID, figure_ids: list[uuid.UUID]) -> set[uuid.UUID]:
    if not figure_ids:
        return set()
    rows = (
        db.query(FigureTemplateFavorite.figure_id)
        .filter(FigureTemplateFavorite.user_id == owner_id, FigureTemplateFavorite.figure_id.in_(figure_ids))
        .all()
    )
    return {row[0] for row in rows}


def _is_template_favorite(db: Session, owner_id: uuid.UUID, figure_id: uuid.UUID) -> bool:
    return db.query(FigureTemplateFavorite.id).filter(
        FigureTemplateFavorite.user_id == owner_id,
        FigureTemplateFavorite.figure_id == figure_id,
    ).first() is not None


def template_favorite_response(favorite: FigureTemplateFavorite) -> dict:
    fig = favorite.figure
    version = _favorite_version(fig, favorite)
    thumb_path = None
    source_version_id = favorite.source_version_id
    source_version_number = favorite.source_version_number
    plot_type = favorite.source_plot_type or fig.plot_type
    style_preset = favorite.source_style_preset or fig.style_preset
    mapping = favorite.source_mapping or {}
    options = favorite.source_options or {}
    if version:
        thumb_path = version.png_path or version.svg_path
        source_version_id = version.id
        source_version_number = source_version_number or version.version_number
        plot_type = plot_type or fig.plot_type
        style_preset = style_preset or version.style_preset or fig.style_preset
        if not mapping:
            mapping = version.mapping or {}
        if not options:
            options = version.options or {}
    return {
        "id": favorite.id,
        "figure_id": fig.id,
        "source_version_id": source_version_id,
        "source_version_number": source_version_number,
        "name": favorite.name or fig.name,
        "figure_name": fig.name,
        "plot_type": plot_type,
        "style_preset": style_preset,
        "mapping": mapping,
        "options": options,
        "status": fig.status,
        "dataset_id": fig.dataset_id,
        "project_id": fig.project_id,
        "created_at": favorite.created_at,
        "updated_at": favorite.updated_at,
        "figure_updated_at": fig.updated_at,
        "is_favorite": True,
        "thumb_url": _url(thumb_path),
    }


def list_figures(db: Session, owner_id: uuid.UUID, project_id: uuid.UUID | None = None) -> list[dict]:
    from app.projects import service as project_service

    q = (
        db.query(Figure, FigureVersion.png_path)
        .outerjoin(FigureVersion, Figure.current_version_id == FigureVersion.id)
    )
    if project_id is not None:
        project_service.get_project_model(db, project_id, owner_id)
        q = q.filter(Figure.project_id == project_id)
    else:
        ids = project_service.accessible_project_ids(db, owner_id)
        q = q.filter(or_(Figure.owner_id == owner_id, Figure.project_id.in_(ids)))
    if project_id is not None:
        rows = q.order_by(Figure.display_order.is_(None), Figure.display_order.asc(), Figure.updated_at.desc()).all()
    else:
        rows = q.order_by(Figure.updated_at.desc()).all()
    favorite_ids = _favorite_figure_ids(db, owner_id, [f.id for f, _ in rows])
    out = []
    for f, png_path in rows:
        out.append({
            "id": f.id, "name": f.name, "plot_type": f.plot_type, "style_preset": f.style_preset,
            "status": f.status, "dataset_id": f.dataset_id, "project_id": f.project_id,
            "created_at": f.created_at, "updated_at": f.updated_at,
            "display_order": f.display_order,
            "is_favorite": f.id in favorite_ids,
            "thumb_url": _url(png_path),
        })
    if project_id is not None:
        return out
    return sorted(out, key=lambda item: (item["is_favorite"], item["updated_at"]), reverse=True)


def reorder_figures(db: Session, owner_id: uuid.UUID, figure_ids: list[uuid.UUID]) -> list[dict]:
    from app.projects import service as project_service

    unique_ids = list(dict.fromkeys(figure_ids))
    if len(unique_ids) != len(figure_ids):
        raise BadRequestError("Figure order contains duplicate items.", error_code="DUPLICATE_FIGURE_ORDER")
    figures = db.query(Figure).filter(Figure.id.in_(unique_ids)).all()
    if len(figures) != len(unique_ids):
        raise NotFoundError("Figure", "reorder")
    project_ids = {fig.project_id for fig in figures}
    if len(project_ids) != 1:
        raise BadRequestError("Figures can only be reordered within one project.", error_code="MIXED_PROJECT_REORDER")
    project_id = next(iter(project_ids))
    if project_id is not None:
        project_service.require_project_write(db, project_id, owner_id)
    elif any(fig.owner_id != owner_id for fig in figures):
        raise NotFoundError("Figure", "reorder")

    by_id = {fig.id: fig for fig in figures}
    for index, figure_id in enumerate(unique_ids):
        by_id[figure_id].display_order = index
    db.commit()
    return list_figures(db, owner_id, project_id=project_id)


def list_template_favorites(db: Session, owner_id: uuid.UUID) -> list[dict]:
    from app.projects import service as project_service

    accessible_project_ids = project_service.accessible_project_ids(db, owner_id)
    q = (
        db.query(FigureTemplateFavorite)
        .join(Figure, FigureTemplateFavorite.figure_id == Figure.id)
        .options(joinedload(FigureTemplateFavorite.figure).joinedload(Figure.versions))
        .filter(
            FigureTemplateFavorite.user_id == owner_id,
            or_(Figure.owner_id == owner_id, Figure.project_id.in_(accessible_project_ids)),
        )
        .order_by(FigureTemplateFavorite.updated_at.desc())
    )
    return [template_favorite_response(row) for row in q.all()]


def list_gallery_figures(db: Session, limit: int = 200) -> list[dict]:
    limit = max(1, min(limit, 500))
    rows = (
        db.query(Figure, FigureVersion, Dataset.name, Project.name)
        .join(FigureVersion, Figure.current_version_id == FigureVersion.id)
        .outerjoin(Dataset, Figure.dataset_id == Dataset.id)
        .outerjoin(Project, Figure.project_id == Project.id)
        .filter(Figure.current_version_id.isnot(None), Figure.status == "ready", Figure.is_public == True)
        .order_by(Figure.updated_at.desc())
        .limit(limit)
        .all()
    )

    out = []
    for f, current, dataset_name, project_name in rows:
        out.append({
            "id": f.id,
            "name": f.name,
            "plot_type": f.plot_type,
            "style_preset": f.style_preset,
            "status": f.status,
            "dataset_id": f.dataset_id,
            "dataset_name": dataset_name,
            "project_id": f.project_id,
            "project_name": project_name,
            "current_version_id": f.current_version_id,
            "created_at": f.created_at,
            "updated_at": f.updated_at,
            "is_favorite": bool(f.is_favorite),
            "is_public": bool(f.is_public),
            "thumb_url": _url(current.png_path),
            "r_url": (
                f"/api/figures/gallery/{f.id}/versions/{current.id}/export?format=r"
                if current.r_path else None
            ),
        })
    return out


def figure_detail(db: Session, figure_id: uuid.UUID, owner_id: uuid.UUID) -> dict:
    fig = get_figure(db, figure_id, owner_id)
    return {
        "id": fig.id, "name": fig.name, "plot_type": fig.plot_type, "style_preset": fig.style_preset,
        "status": fig.status, "dataset_id": fig.dataset_id, "project_id": fig.project_id,
        "dataset_name": fig.dataset.name if fig.dataset else None,
        "description": fig.description, "legend": fig.legend,
        "current_version_id": fig.current_version_id,
        "created_at": fig.created_at, "updated_at": fig.updated_at,
        "is_favorite": _is_template_favorite(db, owner_id, fig.id),
        "is_public": bool(fig.is_public),
        "share_token": fig.share_token,
        "versions": [version_response(v) for v in sorted(fig.versions, key=lambda x: x.version_number)],
    }


def update_figure(db: Session, figure_id: uuid.UUID, owner_id: uuid.UUID, data: dict) -> dict:
    favorite_value = data.pop("is_favorite", None) if "is_favorite" in data else None
    public_value = data.pop("is_public", None) if "is_public" in data else None
    metadata = {k: v for k, v in data.items() if k in {"name", "description", "legend"} and v is not None}
    if metadata or public_value is not None:
        fig = get_figure(db, figure_id, owner_id, write=True)
        for key, value in metadata.items():
            setattr(fig, key, value)
        if public_value is not None:
            fig.is_public = public_value
        db.commit()
    if favorite_value is True:
        save_template_favorite(db, figure_id, owner_id)
    elif favorite_value is False:
        remove_template_favorite(db, figure_id, owner_id)
    return figure_detail(db, figure_id, owner_id)


def save_template_favorite(
    db: Session,
    figure_id: uuid.UUID,
    owner_id: uuid.UUID,
    source_version_id: uuid.UUID | None = None,
    name: str | None = None,
) -> dict:
    fig = get_figure(db, figure_id, owner_id)
    source_version = get_version(fig, source_version_id) if source_version_id else _current_or_latest_version(fig)
    favorite = db.query(FigureTemplateFavorite).filter(
        FigureTemplateFavorite.user_id == owner_id,
        FigureTemplateFavorite.figure_id == figure_id,
    ).first()
    cleaned_name = name.strip() if isinstance(name, str) and name.strip() else None
    source_mapping = source_version.mapping if source_version else {}
    source_options = source_version.options if source_version else {}
    source_style_preset = (source_version.style_preset if source_version else None) or fig.style_preset
    source_version_number = source_version.version_number if source_version else None
    if favorite:
        favorite.source_version_id = source_version.id if source_version else None
        favorite.source_version_number = source_version_number
        favorite.source_plot_type = fig.plot_type
        favorite.source_style_preset = source_style_preset
        favorite.source_mapping = source_mapping or {}
        favorite.source_options = source_options or {}
        favorite.name = cleaned_name
    else:
        favorite = FigureTemplateFavorite(
            user_id=owner_id,
            figure_id=figure_id,
            source_version_id=source_version.id if source_version else None,
            source_version_number=source_version_number,
            source_plot_type=fig.plot_type,
            source_style_preset=source_style_preset,
            source_mapping=source_mapping or {},
            source_options=source_options or {},
            name=cleaned_name,
        )
        db.add(favorite)
    db.commit()
    db.refresh(favorite)
    return template_favorite_response(favorite)


def remove_template_favorite(db: Session, figure_id: uuid.UUID, owner_id: uuid.UUID) -> None:
    get_figure(db, figure_id, owner_id)
    favorite = db.query(FigureTemplateFavorite).filter(
        FigureTemplateFavorite.user_id == owner_id,
        FigureTemplateFavorite.figure_id == figure_id,
    ).first()
    if favorite:
        db.delete(favorite)
        db.commit()


def generate_legend(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID, owner_id: uuid.UUID,
                    style: str = "nature", prompt: str | None = None,
                    current_legend: str | None = None) -> dict:
    fig = get_figure(db, figure_id, owner_id, write=True)
    v = get_version(fig, version_id)
    ds = ds_service.get_dataset(db, fig.dataset_id, owner_id)
    dataset_summary = {
        "name": ds.name, "n_rows": ds.n_rows,
        "columns": [{"name": c["name"], "role": c["role"]} for c in (ds.column_profile or [])],
        "comparisons": (ds.statistics or {}).get("comparisons", [])[:4],
    }
    pc = _project_context(db, fig.project_id)
    if ds.description and ds.description.strip():
        pc = ((pc + " ") if pc else "") + "Dataset: " + ds.description.strip()
    legend = ai_client.generate_legend(
        db, fig.plot_type, v.mapping or {}, v.options or {},
        dataset_summary, fig.description, style, project_context=pc, user_id=owner_id,
        current_legend=(current_legend or fig.legend or "").strip() or None,
        user_request=(prompt or "").strip() or None,
    )
    fig.legend = legend
    db.commit()
    return {"legend": legend}


# ------------------------------------------------------ methods text / alt text
_R_BASE_PACKAGES = {
    "ggplot2", "dplyr", "tidyr", "readr", "scales", "grid", "grDevices",
    "stats", "methods", "utils", "base", "svglite",
}
_METHODS_PLOT_LABEL = {
    "box": "box plot", "violin": "violin plot", "scatter": "scatter plot",
    "bar": "bar chart", "grouped_bar": "grouped bar chart", "overlap_bar": "overlapped bar chart",
    "line": "line chart", "histogram": "histogram", "density": "density plot",
    "correlation_heatmap": "correlation heatmap", "heatmap": "heatmap",
    "error_bar": "error-bar plot", "ribbon": "ribbon plot", "contour": "contour plot",
    "radar": "radar chart", "volcano": "volcano plot", "pca": "principal component analysis (PCA) plot",
    "kaplan_meier": "Kaplan-Meier survival curve", "annotated_heatmap": "annotated heatmap",
    "network": "network graph", "enrichment_dot": "enrichment dot plot", "enrichment_bar": "enrichment bar chart",
    "manhattan": "Manhattan plot", "chemical_space": "chemical-space scatter plot",
}
_PRESET_METHOD_LABELS = {
    "nature": "clean classic (Nature-style)", "science": "Science-style classic",
    "cell": "biomedical classic", "minimal": "minimal monochrome", "colorblind": "colorblind-safe",
}
_SIZE_METHOD_LABELS = {
    "single_column": "single-column", "wide": "wide single-column",
    "double_column": "double-column", "square": "square", "custom": "custom-size",
}
_R_METHOD_SIGNS = [
    (re.compile(r"\bprcomp\s*\("), "principal components were computed with prcomp (base R stats)"),
    (re.compile(r"\bcor\s*\("), "pairwise correlations were computed with cor (base R stats)"),
    (re.compile(r"\bsurvfit\s*\("), "survival curves were estimated with survfit (survival package)"),
    (re.compile(r"\bkmeans\s*\("), "groups were derived by k-means clustering (base R stats)"),
    (re.compile(r"\bhclust\s*\("), "rows/columns were ordered by hierarchical clustering with hclust (base R stats)"),
    (re.compile(r"geom_smooth\s*\("), "a fitted trend line was added with geom_smooth"),
]


def _english_join(items: list[str]) -> str:
    items = [i for i in items if i]
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return ", ".join(items[:-1]) + f", and {items[-1]}"


def _r_packages_from_code(r_code: str | None) -> list[str]:
    found: list[str] = []
    for name in re.findall(r'(?:library|require)\(\s*["\']?([A-Za-z][\w.]*)', r_code or ""):
        if name not in found:
            found.append(name)
    return found


def _assemble_methods_text(plot_type: str, mapping: dict, options: dict, preset: str,
                           r_code: str | None) -> str:
    """Deterministic, low-hallucination methods paragraph.

    Everything asserted here is grounded in the actual generated R code (real
    library() calls and statistical function calls) plus the stored style/size/
    dpi options. No AI is involved, so it cannot invent findings or packages.
    """
    options = options or {}
    packages = _r_packages_from_code(r_code)
    has_ggplot = "ggplot2" in packages or "geom_" in (r_code or "")
    extra = [p for p in packages if p not in _R_BASE_PACKAGES]
    methods = [desc for pattern, desc in _R_METHOD_SIGNS if pattern.search(r_code or "")]
    plot_label = _METHODS_PLOT_LABEL.get(plot_type, plot_type.replace("_", " ") + " plot")

    sentences: list[str] = []
    core = "Figures were generated in R"
    if has_ggplot:
        core += " using the ggplot2 package"
    if extra:
        connector = ", together with the " if has_ggplot else " with the "
        core += connector + _english_join(extra) + (" packages" if len(extra) != 1 else " package")
    core += "."
    sentences.append(core)

    data_sentence = f"The data were visualized as a {plot_label}"
    if methods:
        data_sentence += "; " + _english_join(methods)
    data_sentence += "."
    sentences.append(data_sentence)

    style_bits: list[str] = [f"the {_PRESET_METHOD_LABELS.get(preset, preset)} style"]
    size_label = _SIZE_METHOD_LABELS.get(str(options.get("size") or "wide"))
    if size_label:
        style_bits.append(f"a {size_label} layout")
    try:
        dpi_val = int(float(options.get("dpi"))) if options.get("dpi") is not None else None
    except (TypeError, ValueError):
        dpi_val = None
    if dpi_val:
        style_bits.append(f"{dpi_val} dpi export")
    font_word = {"serif": "a serif font", "mono": "a monospace font", "sans": "a sans-serif font"}.get(
        options.get("font_family")
    )
    if font_word:
        style_bits.append(font_word)
    sentences.append("Figures use " + _english_join(style_bits) + " on a white background.")
    return " ".join(sentences)


def generate_methods_text(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID,
                          owner_id: uuid.UUID) -> dict:
    fig = get_figure(db, figure_id, owner_id)
    v = get_version(fig, version_id)
    text = _assemble_methods_text(
        fig.plot_type, v.mapping or {}, v.options or {},
        v.style_preset or fig.style_preset, v.r_code,
    )
    return {"methods_text": text}


# -------- comments --------

_COMMENT_MAX_LEN = 2000
_COMMENT_LIST_LIMIT = 500


def _comment_author_name(author: User | None) -> str:
    """Display name for a comment author (mirrors organizations/admin naming)."""
    if author is None:
        return "Unknown"
    return author.display_name or author.email.split("@")[0]


def _comment_response(comment: FigureComment, author: User | None,
                      viewer_id: uuid.UUID, figure_owner_id: uuid.UUID) -> dict:
    return {
        "id": comment.id,
        "figure_id": comment.figure_id,
        "author_id": comment.author_id,
        "author_name": _comment_author_name(author),
        "body": comment.body,
        "created_at": comment.created_at,
        "can_delete": comment.author_id == viewer_id or figure_owner_id == viewer_id,
    }


def list_comments(db: Session, figure_id: uuid.UUID, user_id: uuid.UUID) -> list[dict]:
    """Comments on a figure, oldest first. Access mirrors figure_detail."""
    fig = get_figure(db, figure_id, user_id)
    rows = (
        db.query(FigureComment, User)
        .outerjoin(User, User.id == FigureComment.author_id)
        .filter(FigureComment.figure_id == fig.id)
        .order_by(FigureComment.created_at.asc(), FigureComment.id.asc())
        .limit(_COMMENT_LIST_LIMIT)
        .all()
    )
    return [_comment_response(comment, author, user_id, fig.owner_id) for comment, author in rows]


def create_comment(db: Session, figure_id: uuid.UUID, user_id: uuid.UUID, body: str) -> dict:
    fig = get_figure(db, figure_id, user_id)
    cleaned = (body or "").strip()
    if not cleaned:
        raise BadRequestError("Comment body must not be empty", error_code="COMMENT_EMPTY")
    if len(cleaned) > _COMMENT_MAX_LEN:
        raise BadRequestError(
            f"Comment body must be at most {_COMMENT_MAX_LEN} characters",
            error_code="COMMENT_TOO_LONG",
        )
    comment = FigureComment(figure_id=fig.id, author_id=user_id, body=cleaned)
    db.add(comment)
    db.commit()
    db.refresh(comment)
    author = db.query(User).filter(User.id == user_id).first()
    return _comment_response(comment, author, user_id, fig.owner_id)


def delete_comment(db: Session, figure_id: uuid.UUID, comment_id: uuid.UUID, user_id: uuid.UUID) -> None:
    fig = get_figure(db, figure_id, user_id)
    comment = (
        db.query(FigureComment)
        .filter(FigureComment.id == comment_id, FigureComment.figure_id == fig.id)
        .first()
    )
    if not comment:
        raise NotFoundError("Comment", str(comment_id))
    if comment.author_id != user_id and fig.owner_id != user_id:
        raise ForbiddenError("Only the comment author or figure owner can delete a comment")
    db.delete(comment)
    db.commit()


def generate_figure_code(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID,
                         owner_id: uuid.UUID, lang: str) -> dict:
    """Deterministic reproducible-code export (Python/matplotlib or LaTeX).

    Pure text generation via app.figures.codegen — no plotting libraries are
    imported server-side. Access control mirrors generate_methods_text.
    """
    lang = (lang or "python").strip().lower()
    if lang not in ("python", "latex"):
        raise BadRequestError("lang must be 'python' or 'latex'", error_code="INVALID_CODE_LANG")
    fig = get_figure(db, figure_id, owner_id)
    v = get_version(fig, version_id)
    basename = f"figure_{str(fig.id)[:8]}"
    if lang == "python":
        ds = fig.dataset
        code = codegen.generate_python_code(
            figure_name=fig.name,
            dataset_name=(ds.name if ds is not None and ds.name else "dataset"),
            column_names=_dataset_column_names(ds),
            plot_type=fig.plot_type,
            mapping=v.mapping or {},
            options=v.options or {},
            output_basename=basename,
        )
        filename = basename + ".py"
    else:
        code = codegen.generate_latex_snippet(fig.name, fig.legend, basename)
        filename = basename + ".tex"
    return {"language": lang, "filename": filename, "code": code}


def generate_alt_text(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID, owner_id: uuid.UUID,
                      prompt: str | None = None) -> dict:
    fig = get_figure(db, figure_id, owner_id)
    v = get_version(fig, version_id)
    ds = ds_service.get_dataset(db, fig.dataset_id, owner_id)
    dataset_summary = {
        "name": ds.name, "n_rows": ds.n_rows,
        "columns": [{"name": c["name"], "role": c["role"]} for c in (ds.column_profile or [])],
    }
    pc = _project_context(db, fig.project_id)
    if ds.description and ds.description.strip():
        pc = ((pc + " ") if pc else "") + "Dataset: " + ds.description.strip()
    alt_text = ai_client.generate_alt_text(
        db, fig.plot_type, v.mapping or {}, v.options or {},
        dataset_summary, fig.description, project_context=pc, user_id=owner_id,
        user_request=(prompt or "").strip() or None,
    )
    return {"alt_text": alt_text}


# ---------------------------------------------------------------- rendering
def _render_into_version(df, plot_type, mapping, options, preset, figure_id, version_id):
    out_dir = os.path.join(settings.figures_dir, str(figure_id), str(version_id))
    res = renderer.render(plot_type, mapping, options or {}, preset, df, out_dir)
    if not res.success:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise BadRequestError(_friendly_error(res.log), error_code="RENDER_FAILED")
    if storage.object_storage_enabled():
        stored_outputs = {}
        content_types = {
            "png": "image/png",
            "svg": "image/svg+xml",
            "tiff": "image/tiff",
            "pdf": "application/pdf",
            "eps": "application/postscript",
            "html": "text/html",
            "r": "text/plain",
        }
        for kind, path in (res.outputs or {}).items():
            key = storage.object_key("figures", figure_id, version_id, os.path.basename(path))
            stored_outputs[kind] = storage.upload_file(path, key, content_type=content_types.get(kind))
        res.outputs = stored_outputs
        shutil.rmtree(out_dir, ignore_errors=True)
    return res, out_dir


def _archive_code_artifact(db: Session, owner_id: uuid.UUID, ds: Dataset, fig: Figure,
                           version: FigureVersion, res) -> None:
    if not res.r_code:
        return
    import hashlib
    row = FigureCodeArtifact(
        owner_id=owner_id,
        dataset_id=ds.id,
        figure_id=fig.id,
        figure_version_id=version.id,
        plot_type=fig.plot_type,
        style_preset=version.style_preset,
        mapping=version.mapping or {},
        options=version.options or {},
        dataset_profile={
            "name": ds.name,
            "n_rows": ds.n_rows,
            "n_cols": ds.n_cols,
            "columns": [
                {"name": c.get("name"), "dtype": c.get("dtype"), "role": c.get("role")}
                for c in (ds.column_profile or [])
            ],
        },
        r_code=res.r_code,
        render_log=res.log,
        code_hash=hashlib.sha256(res.r_code.encode("utf-8")).hexdigest(),
    )
    db.add(row)


def _sanitize_svg(svg: str) -> str:
    raw = (svg or "").strip()
    if not raw:
        raise BadRequestError("Edited SVG is empty", error_code="EMPTY_SVG")
    if len(raw.encode("utf-8")) > _MAX_SVG_BYTES:
        raise BadRequestError("Edited SVG must be 5 MB or smaller", error_code="SVG_TOO_LARGE")
    lowered = raw.lower()
    if "<!doctype" in lowered or "<!entity" in lowered:
        raise BadRequestError("Edited SVG contains unsupported XML declarations", error_code="BAD_SVG")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        raise BadRequestError("Edited SVG is not valid XML", error_code="BAD_SVG")
    svg_ns = root.tag.startswith("{http://www.w3.org/2000/svg}")
    if root.tag.split("}")[-1].lower() != "svg":
        raise BadRequestError("Edited content must be an SVG document", error_code="BAD_SVG")

    for el in root.iter():
        tag = el.tag.split("}")[-1].lower()
        if tag in _BLOCKED_SVG_TAGS:
            raise BadRequestError("Edited SVG contains unsupported embedded content", error_code="BAD_SVG")
        for attr, value in list(el.attrib.items()):
            attr_name = attr.split("}")[-1].lower()
            attr_value = (value or "").strip().lower()
            if attr_name.startswith("on") or attr_value.startswith("javascript:"):
                del el.attrib[attr]
            if attr_name in {"href", "xlink:href"} and attr_value.startswith(("data:", "file:")):
                del el.attrib[attr]
            if attr_name.startswith("data-labplot-"):
                del el.attrib[attr]

    root.attrib.pop("data-labplot-svg-editor-root", None)
    if svg_ns:
        ET.register_namespace("", "http://www.w3.org/2000/svg")
    elif "xmlns" not in root.attrib:
        root.set("xmlns", "http://www.w3.org/2000/svg")
    return ET.tostring(root, encoding="unicode")


def _svg_replay_r(svg: str) -> str:
    lines = svg.splitlines() or [svg]
    quoted = ",\n  ".join(rq(line) for line in lines)
    return (
        "# LabPlot AI - manually edited SVG version\n"
        "# This script recreates the edited SVG export produced in the vector editor.\n"
        ".svg <- c(\n"
        f"  {quoted}\n"
        ")\n"
        "writeLines(.svg, \"figure.svg\", useBytes = TRUE)\n"
        "message(\"Wrote edited SVG to figure.svg\")\n"
    )


def create_figure(db: Session, owner_id: uuid.UUID, data) -> dict:
    from app.projects import service as project_service

    owner = db.query(User).filter(User.id == owner_id).first()
    if owner:
        enforce_render_quota(db, owner)
    ds = ds_service.get_dataset(db, data.dataset_id, owner_id)
    if ds.project_id is not None:
        project_service.require_project_write(db, ds.project_id, owner_id)
    preset = data.style_preset if data.style_preset in PRESETS else "nature"
    validate_mapping(data.plot_type, data.mapping)
    options = sanitize_options(data.plot_type, data.options, _dataset_column_names(ds))
    options = _resolve_custom_palette_options(db, owner_id, options)
    df = ds_service.load_dataframe(ds)

    figure_id = uuid.uuid4()
    version_id = uuid.uuid4()
    res, _ = _render_into_version(df, data.plot_type, data.mapping, options, preset, figure_id, version_id)
    next_display_order = (
        (db.query(func.max(Figure.display_order)).filter(Figure.project_id == ds.project_id).scalar() or -1) + 1
    )

    fig = Figure(
        id=figure_id, owner_id=owner_id, dataset_id=ds.id, project_id=ds.project_id, name=data.name,
        plot_type=data.plot_type, style_preset=preset, status="ready",
        current_version_id=version_id, display_order=next_display_order,
    )
    db.add(fig)
    db.flush()
    version = FigureVersion(
        id=version_id, figure_id=figure_id, version_number=1,
        mapping=data.mapping, options=options, style_preset=preset,
        r_code=res.r_code, change_note="Initial figure",
        png_path=res.outputs.get("png"), svg_path=res.outputs.get("svg"),
        tiff_path=res.outputs.get("tiff"), pdf_path=res.outputs.get("pdf"),
        eps_path=res.outputs.get("eps"),
        html_path=res.outputs.get("html"),
        r_path=res.outputs.get("r"), render_log=res.log,
    )
    db.add(version)
    db.flush()
    _archive_code_artifact(db, owner_id, ds, fig, version, res)
    _auto_quality_correct_initial_figure(
        db, owner_id, ds, df, fig, version, data.plot_type, data.mapping, options, preset
    )
    db.commit()
    return figure_detail(db, figure_id, owner_id)


def _auto_quality_correct_initial_figure(db: Session, owner_id: uuid.UUID, ds: Dataset, df,
                                         fig: Figure, version: FigureVersion,
                                         plot_type: str, mapping: dict, options: dict,
                                         preset: str) -> None:
    """Review the initial render and, when useful, create a corrected v2.

    This is intentionally best-effort: AI outages or unsupported responses should
    not prevent the user from getting the first rendered figure.
    """
    try:
        if not version.png_path or not storage.exists(version.png_path):
            return
        cols = _dataset_column_names(ds)
        png_path = storage.materialize(version.png_path, suffix=".png")
        review_payload = ai_client.review_figure(
            db,
            png_path,
            plot_type,
            mapping or {},
            options or {},
            project_context=_project_context(db, fig.project_id),
            user_id=owner_id,
            r_code=version.r_code,
        )
        review = Review(
            figure_version_id=version.id,
            publication_score=review_payload.get("publication_score"),
            payload=review_payload,
            model=ai_client.active_provider_label(db, owner_id),
        )
        db.add(review)
        pdef = _plot_def(plot_type)
        available = {
            "options": pdef.get("options", []),
            "mapping_keys": [r["key"] for r in pdef["required"]] + [o["key"] for o in pdef.get("optional", [])],
            "dataset_columns": _dataset_columns_for_ai(ds),
        }
        suggestions = ai_client.improve_figure(
            db,
            plot_type,
            mapping or {},
            options or {},
            preset,
            review_payload,
            [available],
            project_context=_project_context(db, fig.project_id),
            user_id=owner_id,
            user_request=(
                "Automatically correct this first draft for journal-ready output. "
                "Prioritize restrained academic colors, avoid unnecessary multicolor bars, "
                "fix overlapping x-axis labels with x_text_angle when needed, keep final text at 7 pt, "
                "and choose a suitable single-column, wide, square, or custom figure size rather than shrinking text."
            ),
        )
        patch = _combined_quality_patch(suggestions, pdef, mapping or {}, options or {}, preset, cols)
        _drop_unneeded_auto_x_rotation(patch, df, mapping or {}, options or {})
        if not patch:
            return
        new_mapping = {**(mapping or {}), **(patch.get("mapping") or {})}
        new_options = {**(options or {}), **(patch.get("options") or {})}
        new_preset = patch.get("style_preset") or preset
        validate_mapping(plot_type, new_mapping)
        new_options = sanitize_options(plot_type, new_options, cols)
        new_options = _resolve_custom_palette_options(db, owner_id, new_options)
        next_num = (db.query(func.max(FigureVersion.version_number))
                    .filter(FigureVersion.figure_id == fig.id).scalar() or 0) + 1
        corrected_id = uuid.uuid4()
        res, _ = _render_into_version(df, plot_type, new_mapping, new_options, new_preset, fig.id, corrected_id)
        corrected = FigureVersion(
            id=corrected_id,
            figure_id=fig.id,
            version_number=next_num,
            mapping=new_mapping,
            options=new_options or {},
            style_preset=new_preset,
            r_code=res.r_code,
            change_note="Auto-corrected after AI quality check",
            png_path=res.outputs.get("png"),
            svg_path=res.outputs.get("svg"),
            tiff_path=res.outputs.get("tiff"),
            pdf_path=res.outputs.get("pdf"),
            eps_path=res.outputs.get("eps"),
            html_path=res.outputs.get("html"),
            r_path=res.outputs.get("r"),
            render_log=res.log,
        )
        db.add(corrected)
        fig.current_version_id = corrected_id
        fig.style_preset = new_preset
        fig.status = "ready"
        for suggestion in suggestions:
            clean = _sanitize_param_patch(suggestion.get("param_patch", {}), pdef, mapping or {}, cols)
            if not clean:
                continue
            db.add(Improvement(
                figure_version_id=version.id,
                suggestion_type=suggestion.get("suggestion_type"),
                current_state=suggestion.get("current"),
                recommended=suggestion.get("recommended"),
                param_patch=clean,
                priority=suggestion.get("priority"),
                applied=True,
            ))
        db.flush()
        _archive_code_artifact(db, owner_id, ds, fig, corrected, res)
    except Exception as exc:
        note = f"Auto quality check skipped: {type(exc).__name__}: {str(exc)[:300]}"
        version.render_log = ((version.render_log or "").rstrip() + "\n" + note).strip()


def _combined_quality_patch(suggestions: list[dict], pdef: dict, base_mapping: dict[str, Any],
                            base_options: dict[str, Any], base_preset: str,
                            valid_columns: set[str] | None = None) -> dict[str, Any]:
    combined: dict[str, Any] = {}
    for suggestion in suggestions or []:
        clean = _sanitize_param_patch(suggestion.get("param_patch", {}), pdef, base_mapping, valid_columns)
        if not clean:
            continue
        if clean.get("style_preset"):
            combined["style_preset"] = clean["style_preset"]
        if clean.get("mapping"):
            combined.setdefault("mapping", {}).update(clean["mapping"])
        if clean.get("options"):
            combined.setdefault("options", {}).update(clean["options"])
    if not combined:
        return {}
    if combined.get("style_preset") == base_preset:
        combined.pop("style_preset", None)
    if combined.get("mapping"):
        changed_mapping = {k: v for k, v in combined["mapping"].items() if base_mapping.get(k) != v}
        if changed_mapping:
            combined["mapping"] = changed_mapping
        else:
            combined.pop("mapping", None)
    if combined.get("options"):
        changed_options = {k: v for k, v in combined["options"].items() if base_options.get(k) != v}
        if changed_options:
            combined["options"] = changed_options
        else:
            combined.pop("options", None)
    return combined


def _drop_unneeded_auto_x_rotation(patch: dict[str, Any], df, mapping: dict[str, Any],
                                   base_options: dict[str, Any]) -> None:
    options_patch = patch.get("options")
    if not isinstance(options_patch, dict) or "x_text_angle" not in options_patch:
        return
    if _x_axis_labels_need_rotation(df, mapping, {**base_options, **options_patch}):
        return
    options_patch.pop("x_text_angle", None)
    if not options_patch:
        patch.pop("options", None)


def _x_axis_labels_need_rotation(df, mapping: dict[str, Any], options: dict[str, Any]) -> bool:
    x_col = mapping.get("x") or mapping.get("time") or mapping.get("group") or mapping.get("axis")
    if not isinstance(x_col, str) or not x_col or x_col not in getattr(df, "columns", []):
        return False
    values = df[x_col].dropna().astype(str).str.strip()
    labels = [label for label in values.unique().tolist() if label]
    if len(labels) <= 1:
        return False

    lengths = [len(label) for label in labels]
    numeric = True
    for label in labels:
        try:
            float(label)
        except ValueError:
            numeric = False
            break
    if numeric and max(lengths) <= 5 and len(labels) <= 25:
        return False

    size = options.get("size", "wide")
    width_by_size = {"single_column": 3.6, "wide": 7.0, "double_column": 7.0, "square": 4.5}
    try:
        width_in = float(options.get("width_in") if size == "custom" else width_by_size.get(size, 7.0))
    except (TypeError, ValueError):
        width_in = 7.0
    width_in = max(1.0, min(20.0, width_in))
    total_chars = sum(min(length, 18) for length in lengths)
    avg_len = sum(lengths) / len(lengths)

    return (
        max(lengths) >= 14
        or (max(lengths) >= 10 and len(labels) >= 4)
        or total_chars > width_in * 9
        or (len(labels) > width_in * 5 and avg_len > 3)
        or len(labels) > 30
    )


def _explicit_visual_patch_from_request(plot_type: str, request: str | None) -> dict[str, Any]:
    text = (request or "").strip()
    if not text:
        return {}
    intent_text = _user_edit_intent_text(text)
    lowered = intent_text.lower()
    options: dict[str, Any] = {}

    # Deterministic safety net for explicit, supported visual edits. The LLM
    # still receives the rendered image and marks; these rules prevent clearly
    # stated UI edits from silently degrading into a generic fallback.
    if plot_type == "line":
        if re.search(r"(네모|사각|square)", lowered):
            options["point_shape"] = "square"
        if re.search(r"(점선|dashed)", lowered):
            options["line_type"] = "dashed"
        elif re.search(r"(dotted|점\s*모양\s*선)", lowered):
            options["line_type"] = "dotted"
        requested_color = _color_from_request_text(lowered)
        if requested_color and _line_color_request_targets_line(lowered):
            options["line_color"] = requested_color

    range_re = re.compile(
        r"(-?\d+(?:\.\d+)?)(?!\s*%)\s*(?:~|–|—|to|부터|에서|-)\s*"
        r"(-?\d+(?:\.\d+)?)(?!\s*%)"
    )
    x_range: re.Match[str] | None = None
    y_range: re.Match[str] | None = None
    for match in range_re.finditer(lowered):
        context_start = max(0, match.start() - 80)
        context_end = min(len(lowered), match.end() + 30)
        context = lowered[context_start:context_end]
        if re.search(r"(x\s*[- ]?\s*axis|x축)", context):
            x_range = match
            break
        if re.search(r"(y\s*[- ]?\s*axis|y축|구간|range|limits?|범위)", context):
            y_range = match
            break
        if plot_type == "line":
            # In line-plot AI editor marks, a plain numeric range such as
            # "5~10으로 바꿔줘" almost always means the visible y-axis range.
            # Percent coordinates from mark summaries are excluded above.
            y_range = match
            break
    if x_range:
        x1 = float(x_range.group(1))
        x2 = float(x_range.group(2))
        if x1 != x2:
            options["x_min"] = min(x1, x2)
            options["x_max"] = max(x1, x2)
            options["log_x"] = False
    if y_range:
        y1 = float(y_range.group(1))
        y2 = float(y_range.group(2))
        if y1 != y2:
            options["y_min"] = min(y1, y2)
            options["y_max"] = max(y1, y2)
            options["log_y"] = False

    return {"options": options} if options else {}


def _professionalized_edit_request(plot_type: str, request: str | None) -> str | None:
    text = (request or "").strip()
    if not text:
        return None
    intent_text = _user_edit_intent_text(text)
    lowered = intent_text.lower()
    instructions: list[str] = []

    if plot_type == "line":
        requested_color = _color_from_request_text(lowered)
        if requested_color and _line_color_request_targets_line(lowered):
            instructions.append(
                f"Set the ungrouped line stroke color to {requested_color} using options.line_color; "
                "preserve the current data mapping, theme, line width, point style, axis labels, and export size."
            )
        if re.search(r"(점선|dashed)", lowered):
            instructions.append("Set the line type to dashed using options.line_type = \"dashed\".")
        elif re.search(r"(dotted|점\s*모양\s*선)", lowered):
            instructions.append("Set the line type to dotted using options.line_type = \"dotted\".")
        if re.search(r"(네모|사각|square)", lowered):
            instructions.append("Set point markers to square using options.point_shape = \"square\".")

    if not instructions:
        return text
    return "\n".join([
        text,
        "",
        "INTERNAL PROFESSIONALIZED EDIT INSTRUCTION",
        "Use the following normalized English instruction as the operational edit request while preserving the user's original intent:",
        *instructions,
    ])


def _patch_changes_version(patch: dict[str, Any], version: FigureVersion) -> bool:
    if patch.get("style_preset") and patch["style_preset"] != version.style_preset:
        return True
    base_mapping = version.mapping or {}
    if any(base_mapping.get(k) != v for k, v in (patch.get("mapping") or {}).items()):
        return True
    base_options = version.options or {}
    return any(base_options.get(k) != v for k, v in (patch.get("options") or {}).items())


def _color_from_request_text(text: str) -> str | None:
    explicit_hex = re.search(r"#[0-9A-Fa-f]{6}", text)
    if explicit_hex:
        return explicit_hex.group(0).upper()
    for word, color in _COLOR_WORDS.items():
        if word in text:
            return color
    return None


def _user_edit_intent_text(text: str) -> str:
    if _LOCALIZED_EDIT_MARKER not in text:
        return text
    parts: list[str] = []
    head = text.split(_LOCALIZED_EDIT_MARKER, 1)[0].strip()
    if head and head != _DEFAULT_LOCALIZED_EDIT_PROMPT:
        parts.append(head)
    for memo in re.findall(r"User memo:\s*(.*)", text):
        clean = memo.strip()
        if clean and clean != "(no memo)":
            parts.append(clean)
    return "\n".join(parts) or text


def _line_color_request_targets_line(text: str) -> bool:
    if _LINE_COMPONENT_RE.search(text):
        return True
    return not _NON_LINE_COLOR_TARGET_RE.search(text)


def _values_match(expected: Any, actual: Any) -> bool:
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return abs(float(expected) - float(actual)) < 1e-9
    if isinstance(expected, dict) and isinstance(actual, dict):
        return all(_values_match(v, actual.get(k)) for k, v in expected.items())
    return expected == actual


def _format_patch_value(value: Any) -> str:
    if isinstance(value, dict):
        return ", ".join(f"{k}={v}" for k, v in value.items())
    return str(value)


def _r_number_literal(value: Any) -> str | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return f"{number:g}"


def _r_code_check_for_patch(section: str, key: str, expected: Any, version: FigureVersion) -> tuple[bool | None, str]:
    r_code = version.r_code or ""
    if not r_code:
        return None, "R code was not available for text verification."
    text = str(expected)
    quoted = rq(text)
    if section == "mapping":
        return (quoted in r_code or text in r_code), f"Looked for mapped column {text!r} in generated R code."
    if key == "x_text_angle":
        try:
            angle = float(expected)
            pattern = rf"axis\.text\.x\s*=\s*element_text\(angle\s*=\s*{angle:g}\b"
            return bool(re.search(pattern, r_code)), f"Looked for axis.text.x angle = {angle:g}."
        except (TypeError, ValueError):
            return None, "Could not normalize x-axis text angle for R-code verification."
    if key in {"x_min", "x_max"}:
        number = _r_number_literal(expected)
        if number is None:
            return None, "Could not normalize x-axis limit for R-code verification."
        pattern = rf"xlim\s*=\s*c\([^)]*\b{re.escape(number)}\b"
        return bool(re.search(pattern, r_code)), f"Looked for xlim containing {number}."
    if key in {"y_min", "y_max"}:
        number = _r_number_literal(expected)
        if number is None:
            return None, "Could not normalize y-axis limit for R-code verification."
        pattern = rf"ylim\s*=\s*c\([^)]*\b{re.escape(number)}\b"
        return bool(re.search(pattern, r_code)), f"Looked for ylim containing {number}."
    if key == "legend_position":
        return f'legend.position = "{expected}"' in r_code, f"Looked for legend.position = {expected!r}."
    if key in {"legend_title", "x_label", "y_label", "title", "subtitle", "series_1_label", "series_2_label"}:
        return quoted in r_code or text in r_code, f"Looked for label text {text!r} in generated R code."
    if key == "line_type":
        return f"linetype = {quoted}" in r_code, f"Looked for line type {text!r} in generated R code."
    if key == "point_shape":
        shape = _R_POINT_SHAPES.get(text)
        if shape is None and text == "none":
            return "geom_point(" not in r_code, "Looked for omitted point layer."
        if shape is None:
            return None, "Could not map point shape to an R shape code for verification."
        return f"shape = {shape}" in r_code, f"Looked for point shape {text!r} as R shape {shape}."
    if key == "line_color":
        return quoted in r_code or text.upper() in r_code.upper(), f"Looked for line color {text!r} in generated R code."
    if key in {"palette_name", "color_mode", "size", "dpi", "width_in", "height_in", "font_scale"}:
        return None, "Setting matched the regenerated version; exact R text is template-dependent."
    if isinstance(expected, dict):
        missing = [str(v) for v in expected.values() if str(v) not in r_code]
        return len(missing) == 0, "Looked for custom values in generated R code."
    return None, "Setting matched the regenerated version; no specific R-code string check is defined for this option."


def _ai_edit_checklist(improvements: list[Improvement], version: FigureVersion) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for index, imp in enumerate(improvements, start=1):
        patch = imp.param_patch or {}
        label = imp.suggestion_type or f"AI suggestion {index}"
        items: list[tuple[str, str, Any, Any]] = []
        if patch.get("style_preset"):
            items.append(("style_preset", "style_preset", patch["style_preset"], version.style_preset))
        for key, expected in (patch.get("mapping") or {}).items():
            items.append(("mapping", key, expected, (version.mapping or {}).get(key)))
        for key, expected in (patch.get("options") or {}).items():
            items.append(("options", key, expected, (version.options or {}).get(key)))

        if not items:
            rows.append({
                "label": label,
                "path": "param_patch",
                "status": "warning",
                "expected": "non-empty patch",
                "actual": "empty patch",
                "r_code_check": "No patch was available to verify against the regenerated R code.",
            })
            continue

        for section, key, expected, actual in items:
            settings_match = _values_match(expected, actual)
            r_code_match, r_code_note = _r_code_check_for_patch(section, key, expected, version)
            status = "applied" if settings_match and r_code_match is not False else "warning"
            rows.append({
                "label": label,
                "path": key if section == "style_preset" else f"{section}.{key}",
                "status": status,
                "expected": _format_patch_value(expected),
                "actual": _format_patch_value(actual),
                "r_code_check": r_code_note,
                "r_code_evidence": r_code_match,
            })
    return rows


def _append_internal_ai_edit_checklist(version: FigureVersion, improvements: list[Improvement],
                                       checklist: list[dict[str, Any]] | None = None) -> None:
    if checklist is None:
        checklist = _ai_edit_checklist(improvements, version)
    if not checklist:
        return
    note = "AI edit internal checklist:\n" + json.dumps(checklist, ensure_ascii=False, indent=2)
    version.render_log = ((version.render_log or "").rstrip() + "\n" + note).strip()


def _applied_skipped_from_checklist(checklist: list[dict[str, Any]]) -> tuple[list[str], list[str]]:
    """Split a verification checklist into applied vs skipped dotted paths so the
    client can show "N of M changes applied; 'X' not supported"."""
    applied: list[str] = []
    skipped: list[str] = []
    for row in checklist:
        path = str(row.get("path"))
        if row.get("status") == "applied":
            applied.append(path)
        else:
            skipped.append(path)
    return applied, skipped


def rerender(db: Session, figure_id: uuid.UUID, owner_id: uuid.UUID, req) -> dict:
    owner = db.query(User).filter(User.id == owner_id).first()
    if owner:
        enforce_render_quota(db, owner)
    fig = get_figure(db, figure_id, owner_id, write=True)
    base = get_version(fig, fig.current_version_id) if fig.current_version_id else fig.versions[-1]
    mapping = req.mapping if req.mapping is not None else base.mapping
    options = req.options if req.options is not None else base.options
    preset = req.style_preset or fig.style_preset
    if preset not in PRESETS:
        preset = "nature"
    plot_type = getattr(req, "plot_type", None) or fig.plot_type
    validate_mapping(plot_type, mapping)
    ds = ds_service.get_dataset(db, fig.dataset_id, owner_id)
    options = sanitize_options(plot_type, options, _dataset_column_names(ds))
    options = _resolve_custom_palette_options(db, owner_id, options)

    df = ds_service.load_dataframe(ds)
    next_num = (db.query(func.max(FigureVersion.version_number))
                .filter(FigureVersion.figure_id == figure_id).scalar() or 0) + 1
    version_id = uuid.uuid4()
    res, _ = _render_into_version(df, plot_type, mapping, options, preset, figure_id, version_id)

    version = FigureVersion(
        id=version_id, figure_id=figure_id, version_number=next_num,
        mapping=mapping, options=options or {}, style_preset=preset,
        r_code=res.r_code, change_note=(req.change_note or "Re-rendered"),
        png_path=res.outputs.get("png"), svg_path=res.outputs.get("svg"),
        tiff_path=res.outputs.get("tiff"), pdf_path=res.outputs.get("pdf"),
        eps_path=res.outputs.get("eps"),
        html_path=res.outputs.get("html"),
        r_path=res.outputs.get("r"), render_log=res.log,
    )
    db.add(version)
    fig.current_version_id = version_id
    fig.style_preset = preset
    fig.plot_type = plot_type
    fig.status = "ready"
    db.flush()
    _archive_code_artifact(db, owner_id, ds, fig, version, res)
    db.commit()
    return version_response(version)


# Style-only option keys copied by bulk_apply_style. Deliberately excludes data
# mappings, axis ranges (x_min/x_max/...), annotations and per-series overrides —
# only palette / typography / legend-layout / background styling travels.
_BULK_STYLE_OPTION_KEYS = {
    "palette_name", "custom_palette_values", "custom_palette_label",
    "color_mode", "font_family", "font_scale",
    "legend_position", "legend_key_size", "legend_ncol",
    "transparent_background",
}


def duplicate_figure(db: Session, figure_id: uuid.UUID, owner_id: uuid.UUID) -> dict:
    """Deep-copy a figure the user can access into a fresh, freshly-rendered copy.

    The new figure is owned by ``owner_id`` and re-uses the source's current
    version mapping/options/style_preset/plot_type; a real render produces the
    new current version. Project write permission is enforced when the source
    lives in a project (via get_figure(write=True)).
    """
    owner = db.query(User).filter(User.id == owner_id).first()
    if owner:
        enforce_render_quota(db, owner)
    src = get_figure(db, figure_id, owner_id, write=True)
    base = _current_or_latest_version(src)
    if base is None:
        raise BadRequestError("Figure has no version to duplicate", error_code="NO_VERSION")

    plot_type = src.plot_type
    preset = base.style_preset if base.style_preset in PRESETS else (
        src.style_preset if src.style_preset in PRESETS else "nature"
    )
    ds = ds_service.get_dataset(db, src.dataset_id, owner_id)
    mapping = dict(base.mapping or {})
    options = sanitize_options(plot_type, base.options or {}, _dataset_column_names(ds))
    options = _resolve_custom_palette_options(db, owner_id, options)
    validate_mapping(plot_type, mapping)
    df = ds_service.load_dataframe(ds)

    new_figure_id = uuid.uuid4()
    new_version_id = uuid.uuid4()
    res, _ = _render_into_version(df, plot_type, mapping, options, preset, new_figure_id, new_version_id)
    next_display_order = (
        (db.query(func.max(Figure.display_order)).filter(Figure.project_id == src.project_id).scalar() or -1) + 1
    )
    copy_name = (src.name or "Figure")[: 255 - len(" (copy)")] + " (copy)"
    fig = Figure(
        id=new_figure_id, owner_id=owner_id, dataset_id=src.dataset_id, project_id=src.project_id,
        name=copy_name, plot_type=plot_type, style_preset=preset, status="ready",
        current_version_id=new_version_id, display_order=next_display_order,
        description=src.description, legend=src.legend,
    )
    db.add(fig)
    db.flush()
    version = FigureVersion(
        id=new_version_id, figure_id=new_figure_id, version_number=1,
        mapping=mapping, options=options or {}, style_preset=preset,
        r_code=res.r_code, change_note=f"Duplicated from '{src.name}'",
        png_path=res.outputs.get("png"), svg_path=res.outputs.get("svg"),
        tiff_path=res.outputs.get("tiff"), pdf_path=res.outputs.get("pdf"),
        eps_path=res.outputs.get("eps"),
        html_path=res.outputs.get("html"),
        r_path=res.outputs.get("r"), render_log=res.log,
    )
    db.add(version)
    db.flush()
    _archive_code_artifact(db, owner_id, ds, fig, version, res)
    db.commit()
    return figure_detail(db, new_figure_id, owner_id)


def bulk_apply_style(db: Session, source_figure_id: uuid.UUID,
                     target_figure_ids: list[uuid.UUID], owner_id: uuid.UUID) -> dict:
    """Copy STYLE-ONLY options + style_preset from a source figure to each target.

    Each target is re-rendered into a new version. Targets not owned by the user
    (or missing / unrenderable) are skipped. Capped at 20 targets by the schema.
    Renders are committed per-target so one failure does not discard the rest.
    """
    src = get_figure(db, source_figure_id, owner_id)
    src_base = _current_or_latest_version(src)
    if src_base is None:
        raise BadRequestError("Source figure has no version to copy style from", error_code="NO_VERSION")
    src_options = src_base.options or {}
    src_preset = src_base.style_preset if src_base.style_preset in PRESETS else (
        src.style_preset if src.style_preset in PRESETS else "nature"
    )
    style_patch = {k: v for k, v in src_options.items() if k in _BULK_STYLE_OPTION_KEYS}

    updated: list[uuid.UUID] = []
    skipped: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    for target_id in target_figure_ids:
        if target_id in seen:
            continue
        seen.add(target_id)
        if target_id == source_figure_id:
            skipped.append(target_id)
            continue
        try:
            tgt = get_figure(db, target_id, owner_id)
        except NotFoundError:
            skipped.append(target_id)
            continue
        if tgt.owner_id != owner_id:
            skipped.append(target_id)
            continue
        tgt_base = _current_or_latest_version(tgt)
        if tgt_base is None:
            skipped.append(target_id)
            continue
        try:
            plot_type = tgt.plot_type
            mapping = tgt_base.mapping or {}
            validate_mapping(plot_type, mapping)
            ds = ds_service.get_dataset(db, tgt.dataset_id, owner_id)
            merged = {**(tgt_base.options or {}), **style_patch}
            options = sanitize_options(plot_type, merged, _dataset_column_names(ds))
            options = _resolve_custom_palette_options(db, owner_id, options)
            df = ds_service.load_dataframe(ds)
            next_num = (db.query(func.max(FigureVersion.version_number))
                        .filter(FigureVersion.figure_id == target_id).scalar() or 0) + 1
            new_version_id = uuid.uuid4()
            res, _ = _render_into_version(df, plot_type, mapping, options, src_preset, target_id, new_version_id)
            version = FigureVersion(
                id=new_version_id, figure_id=target_id, version_number=next_num,
                mapping=mapping, options=options or {}, style_preset=src_preset,
                r_code=res.r_code, change_note="Bulk style applied",
                png_path=res.outputs.get("png"), svg_path=res.outputs.get("svg"),
                tiff_path=res.outputs.get("tiff"), pdf_path=res.outputs.get("pdf"),
                eps_path=res.outputs.get("eps"),
                html_path=res.outputs.get("html"),
                r_path=res.outputs.get("r"), render_log=res.log,
            )
            db.add(version)
            tgt.current_version_id = new_version_id
            tgt.style_preset = src_preset
            tgt.status = "ready"
            db.flush()
            _archive_code_artifact(db, owner_id, ds, tgt, version, res)
            db.commit()
            updated.append(target_id)
        except Exception:
            db.rollback()
            skipped.append(target_id)
    return {"updated": updated, "skipped": skipped}


def save_svg_edit(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID, owner_id: uuid.UUID,
                  svg: str, change_note: str | None = None) -> dict:
    owner = db.query(User).filter(User.id == owner_id).first()
    if owner:
        enforce_render_quota(db, owner)
    fig = get_figure(db, figure_id, owner_id, write=True)
    base = get_version(fig, version_id)
    clean_svg = _sanitize_svg(svg)
    ds = ds_service.get_dataset(db, fig.dataset_id, owner_id)
    next_num = (db.query(func.max(FigureVersion.version_number))
                .filter(FigureVersion.figure_id == figure_id).scalar() or 0) + 1
    new_version_id = uuid.uuid4()
    out_dir = os.path.join(settings.figures_dir, str(figure_id), str(new_version_id))
    os.makedirs(out_dir, exist_ok=True)
    svg_path = os.path.join(out_dir, "figure.svg")
    r_path = os.path.join(out_dir, "figure.R")
    r_code = _svg_replay_r(clean_svg)
    with open(svg_path, "w", encoding="utf-8") as f:
        f.write(clean_svg)
    with open(r_path, "w", encoding="utf-8") as f:
        f.write(r_code)

    if storage.object_storage_enabled():
        svg_path = storage.upload_file(
            svg_path,
            storage.object_key("figures", figure_id, new_version_id, "figure.svg"),
            content_type="image/svg+xml",
        )
        r_path = storage.upload_file(
            r_path,
            storage.object_key("figures", figure_id, new_version_id, "figure.R"),
            content_type="text/plain",
        )
        shutil.rmtree(out_dir, ignore_errors=True)

    options = {**(base.options or {}), "manual_svg_edit": True, "source_version_id": str(base.id)}
    version = FigureVersion(
        id=new_version_id, figure_id=figure_id, version_number=next_num,
        mapping=base.mapping or {}, options=options, style_preset=base.style_preset,
        r_code=r_code, change_note=(change_note or "Manual SVG edit"),
        png_path=None, svg_path=svg_path, tiff_path=None, pdf_path=None, eps_path=None,
        html_path=None,
        r_path=r_path, render_log="Manual SVG edit saved from vector editor.",
    )
    db.add(version)
    fig.current_version_id = new_version_id
    fig.status = "ready"
    db.flush()
    _archive_code_artifact(
        db, owner_id, ds, fig, version,
        SimpleNamespace(r_code=r_code, log="Manual SVG edit saved from vector editor.")
    )
    db.commit()
    return version_response(version)


def set_figure_share(db: Session, figure_id: uuid.UUID, owner_id: uuid.UUID, enable: bool) -> dict:
    """Enable (create/rotate) or disable the public share link for a figure.

    Owner-only: project collaborators can view the figure but must not be able
    to mint public links to it.
    """
    fig = get_figure(db, figure_id, owner_id)
    if fig.owner_id != owner_id:
        raise NotFoundError("Figure", str(figure_id))
    if enable:
        # Calling again while enabled rotates the token (old links stop working).
        fig.share_token = secrets.token_urlsafe(32)
    else:
        fig.share_token = None
    db.commit()
    return {
        "share_token": fig.share_token,
        "share_url": f"/share/{fig.share_token}" if fig.share_token else None,
    }


def delete_figure(db: Session, figure_id: uuid.UUID, owner_id: uuid.UUID) -> None:
    fig = get_figure(db, figure_id, owner_id, write=True)
    shutil.rmtree(os.path.join(settings.figures_dir, str(figure_id)), ignore_errors=True)
    if storage.object_storage_enabled():
        storage.delete_prefix(f"figures/{figure_id}")
    db.delete(fig)
    db.commit()


def delete_figure_version(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID, owner_id: uuid.UUID) -> dict:
    fig = get_figure(db, figure_id, owner_id, write=True)
    version = get_version(fig, version_id)
    remaining = [v for v in fig.versions if v.id != version_id]
    if not remaining:
        raise BadRequestError("A figure must keep at least one version", error_code="LAST_VERSION")

    file_refs = [version.png_path, version.svg_path, version.tiff_path, version.pdf_path, version.eps_path, version.html_path, version.r_path]
    version_dir = os.path.join(settings.figures_dir, str(figure_id), str(version_id))

    if fig.current_version_id == version_id:
        replacement = max(remaining, key=lambda v: v.version_number)
        fig.current_version_id = replacement.id
        fig.style_preset = replacement.style_preset
        artifact = (
            db.query(FigureCodeArtifact)
            .filter(FigureCodeArtifact.figure_version_id == replacement.id)
            .first()
        )
        if artifact:
            fig.plot_type = artifact.plot_type

    db.delete(version)
    db.commit()

    for ref in file_refs:
        storage.delete_file(ref)
    shutil.rmtree(version_dir, ignore_errors=True)
    if storage.object_storage_enabled():
        storage.delete_prefix(f"figures/{figure_id}/{version_id}")

    return figure_detail(db, figure_id, owner_id)


# ---------------------------------------------------------------- AI: review / improve / apply
def review_version(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID, owner_id: uuid.UUID) -> Review:
    fig = get_figure(db, figure_id, owner_id, write=True)
    v = get_version(fig, version_id)
    if not v.png_path or not storage.exists(v.png_path):
        raise BadRequestError("Rendered image not available for review", error_code="NO_IMAGE")
    png_path = storage.materialize(v.png_path, suffix=".png")
    result = ai_client.review_figure(
        db, png_path, fig.plot_type, v.mapping or {}, v.options or {},
        project_context=_project_context(db, fig.project_id), user_id=owner_id,
        r_code=v.r_code,
    )
    rev = Review(
        figure_version_id=version_id,
        publication_score=result.get("publication_score"),
        payload=result, model=ai_client.active_provider_label(db, owner_id),
    )
    db.add(rev)
    db.commit()
    db.refresh(rev)
    return rev


def improve_version(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID, owner_id: uuid.UUID,
                    prompt: str | None = None, annotated_image: str | None = None) -> list[Improvement]:
    fig = get_figure(db, figure_id, owner_id, write=True)
    v = get_version(fig, version_id)
    ds = ds_service.get_dataset(db, fig.dataset_id, owner_id)
    cols = _dataset_column_names(ds)
    last_review = (db.query(Review).filter(Review.figure_version_id == version_id)
                   .order_by(Review.created_at.desc()).first())
    pdef = _plot_def(fig.plot_type)
    available = {"options": pdef.get("options", []),
                 "mapping_keys": [r["key"] for r in pdef["required"]] + [o["key"] for o in pdef.get("optional", [])],
                 "dataset_columns": _dataset_columns_for_ai(ds)}
    image_payload = _decode_ai_editor_image(annotated_image)
    if image_payload is None and v.png_path and storage.exists(v.png_path):
        png_path = storage.materialize(v.png_path, suffix=".png")
        with open(png_path, "rb") as f:
            image_payload = (f.read(), "image/png")
    suggestions = ai_client.improve_figure(
        db, fig.plot_type, v.mapping or {}, v.options or {}, fig.style_preset,
        last_review.payload if last_review else None, [available],
        project_context=_project_context(db, fig.project_id), user_id=owner_id,
        user_request=_professionalized_edit_request(fig.plot_type, prompt),
        rendered_image=image_payload,
        r_code=v.r_code,
    )
    user_intent = bool((prompt or "").strip() or annotated_image)
    rows = []
    skipped_lists: list[list[str]] = []
    for s in suggestions:
        raw_patch = s.get("param_patch", {})
        patch = _sanitize_param_patch(raw_patch, pdef, v.mapping or {}, cols)
        if not patch:
            continue
        kept_paths = set(_patch_key_paths(patch))
        dropped = [p for p in _patch_key_paths(raw_patch) if p not in kept_paths]
        imp = Improvement(
            figure_version_id=version_id,
            suggestion_type=s.get("suggestion_type"),
            current_state=s.get("current"),
            recommended=s.get("recommended"),
            param_patch=patch,
            priority=s.get("priority"),
        )
        db.add(imp)
        rows.append(imp)
        skipped_lists.append(dropped)

    explicit_patch = _sanitize_param_patch(
        _explicit_visual_patch_from_request(fig.plot_type, prompt),
        pdef,
        v.mapping or {},
        cols,
    )
    if explicit_patch and _patch_changes_version(explicit_patch, v):
        imp = Improvement(
            figure_version_id=version_id,
            suggestion_type="Marked edit request",
            current_state="Current figure does not yet reflect the explicit marked edit request.",
            recommended="Apply the visual options explicitly requested in the mark memos and edit request.",
            param_patch=explicit_patch,
            priority="high",
        )
        db.add(imp)
        rows.append(imp)
        skipped_lists.append([])

    if not rows and not user_intent:
        imp = Improvement(
            figure_version_id=version_id,
            suggestion_type="Publication export settings",
            current_state="Current figure settings may not specify final export defaults.",
            recommended="Use a stable wide export with 300 dpi and 7 pt type for publication layout.",
            param_patch={"options": {"size": "wide", "dpi": 300, "font_scale": 1.0, "palette_name": "journal_muted"}},
            priority="medium",
        )
        db.add(imp)
        rows.append(imp)
        skipped_lists.append([])
    if not rows:
        return []
    db.commit()
    for r in rows:
        db.refresh(r)
    # Attach the per-suggestion dropped-key summary AFTER refresh so it survives.
    for r, sk in zip(rows, skipped_lists):
        r.skipped = sk
    return rows


def list_improvements(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID, owner_id: uuid.UUID) -> list[Improvement]:
    fig = get_figure(db, figure_id, owner_id)
    get_version(fig, version_id)
    return (db.query(Improvement).filter(Improvement.figure_version_id == version_id)
            .order_by(Improvement.created_at.desc()).all())


def apply_improvement(db: Session, figure_id: uuid.UUID, improvement_id: uuid.UUID, owner_id: uuid.UUID) -> dict:
    fig = get_figure(db, figure_id, owner_id, write=True)
    version_ids = {v.id for v in fig.versions}
    imp = db.query(Improvement).filter(Improvement.id == improvement_id).first()
    if not imp or imp.figure_version_id not in version_ids:
        raise NotFoundError("Improvement", str(improvement_id))

    base = get_version(fig, imp.figure_version_id)
    patch = imp.param_patch or {}
    new_mapping = {**(base.mapping or {}), **(patch.get("mapping") or {})}
    new_options = {**(base.options or {}), **(patch.get("options") or {})}
    new_preset = patch.get("style_preset") or base.style_preset or fig.style_preset

    class _Req:
        mapping = new_mapping
        options = new_options
        style_preset = new_preset
        change_note = f"Applied AI suggestion to v{base.version_number}: {imp.suggestion_type or 'improvement'}"

    result = rerender(db, figure_id, owner_id, _Req())
    new_version = db.query(FigureVersion).filter(FigureVersion.id == result["id"]).first()
    applied_paths: list[str] = []
    skipped_paths: list[str] = []
    if new_version:
        checklist = _ai_edit_checklist([imp], new_version)
        _append_internal_ai_edit_checklist(new_version, [imp], checklist)
        applied_paths, skipped_paths = _applied_skipped_from_checklist(checklist)
    imp.applied = True
    db.commit()
    result["applied"] = applied_paths
    result["skipped"] = skipped_paths
    return result


def apply_improvements(db: Session, figure_id: uuid.UUID, improvement_ids: list[uuid.UUID], owner_id: uuid.UUID) -> dict:
    if not improvement_ids:
        raise BadRequestError("Select at least one AI suggestion to apply.", error_code="NO_IMPROVEMENTS_SELECTED")
    if len(improvement_ids) > 20:
        raise BadRequestError("Apply 20 or fewer AI suggestions at once.", error_code="TOO_MANY_IMPROVEMENTS")

    fig = get_figure(db, figure_id, owner_id, write=True)
    version_ids = {v.id for v in fig.versions}
    improvements = db.query(Improvement).filter(Improvement.id.in_(improvement_ids)).all()
    by_id = {imp.id: imp for imp in improvements}
    ordered = [by_id.get(imp_id) for imp_id in improvement_ids]
    if any(imp is None or imp.figure_version_id not in version_ids for imp in ordered):
        raise NotFoundError("Improvement", "selected")

    base_version_id = ordered[0].figure_version_id
    if any(imp.figure_version_id != base_version_id for imp in ordered):
        raise BadRequestError("Selected suggestions must come from the same figure version.", error_code="MIXED_IMPROVEMENT_BASES")

    base = get_version(fig, base_version_id)
    new_mapping = dict(base.mapping or {})
    new_options = dict(base.options or {})
    new_preset = base.style_preset or fig.style_preset
    labels = []
    for imp in ordered:
        patch = imp.param_patch or {}
        new_mapping.update(patch.get("mapping") or {})
        new_options.update(patch.get("options") or {})
        new_preset = patch.get("style_preset") or new_preset
        if imp.suggestion_type:
            labels.append(str(imp.suggestion_type))

    class _Req:
        mapping = new_mapping
        options = new_options
        style_preset = new_preset
        change_note = (
            f"Applied {len(ordered)} AI suggestions to v{base.version_number}: "
            + (", ".join(labels[:3]) if labels else "improvements")
        )

    result = rerender(db, figure_id, owner_id, _Req())
    new_version = db.query(FigureVersion).filter(FigureVersion.id == result["id"]).first()
    applied_paths: list[str] = []
    skipped_paths: list[str] = []
    if new_version:
        applied_improvements = [imp for imp in ordered if imp is not None]
        checklist = _ai_edit_checklist(applied_improvements, new_version)
        _append_internal_ai_edit_checklist(new_version, applied_improvements, checklist)
        applied_paths, skipped_paths = _applied_skipped_from_checklist(checklist)
    for imp in ordered:
        imp.applied = True
    db.commit()
    result["applied"] = applied_paths
    result["skipped"] = skipped_paths
    return result


def _known_mapping_values(mapping: dict[str, Any]) -> set[str]:
    values: set[str] = set()
    for value in mapping.values():
        if isinstance(value, str) and value:
            values.add(value)
        elif isinstance(value, list):
            values.update(v for v in value if isinstance(v, str) and v)
    return values


_ANNOTATION_KINDS = {"text", "arrow", "rect", "bracket"}
# Required coordinate fields per annotation kind (see contract in task/frontend).
_ANNOTATION_REQUIRED_COORDS = {
    "text": ("x", "y"),
    "bracket": ("x", "y", "x2"),
    "arrow": ("x", "y", "x2", "y2"),
    "rect": ("x", "y", "x2", "y2"),
}
_SERIES_LINETYPES = {"solid", "dashed", "dotted", "dotdash", "longdash"}
_SERIES_SHAPES = {"circle", "square", "triangle", "diamond"}


def _clean_hex(value: Any) -> str | None:
    """Return an upper-cased #RRGGBB hex color, or None if not a valid hex."""
    if not isinstance(value, str):
        return None
    color = value.strip().upper()
    return color if _HEX_COLOR_RE.fullmatch(color) else None


def _sanitize_annotations(value: Any) -> list[dict[str, Any]] | None:
    """Strictly sanitize the free-form ``annotations`` overlay list.

    Anything not matching the known shape is dropped (never passed through).
    Returns a cleaned list of dicts with only validated known fields, capped at
    30 elements. Empty result -> None (drops the key).
    """
    if not isinstance(value, list):
        return None
    cleaned: list[dict[str, Any]] = []
    for item in value:
        if len(cleaned) >= 30:
            break
        if not isinstance(item, dict):
            continue
        kind = item.get("kind")
        if not isinstance(kind, str) or kind not in _ANNOTATION_KINDS:
            continue
        # Coerce coordinates via float(); drop non-finite / non-numeric.
        coords: dict[str, float] = {}
        for coord_key in ("x", "y", "x2", "y2"):
            if coord_key not in item:
                continue
            try:
                num = float(item[coord_key])
            except (TypeError, ValueError):
                continue
            if math.isfinite(num):
                coords[coord_key] = num
        required = _ANNOTATION_REQUIRED_COORDS[kind]
        if any(rk not in coords for rk in required):
            continue
        entry: dict[str, Any] = {"kind": kind, **coords}
        for text_key in ("text", "label"):
            raw_text = item.get(text_key)
            if isinstance(raw_text, str):
                stripped = raw_text.strip()
                if stripped:
                    entry[text_key] = stripped[:200]
        if "size" in item:
            try:
                size_num = float(item["size"])
            except (TypeError, ValueError):
                size_num = None
            if size_num is not None and math.isfinite(size_num):
                entry["size"] = max(1.0, min(20.0, size_num))
        color = _clean_hex(item.get("color"))
        if color is not None:
            entry["color"] = color
        cleaned.append(entry)
    return cleaned or None


def _sanitize_series_styles(value: Any) -> dict[str, dict[str, Any]] | None:
    """Strictly sanitize the ``series_styles`` mapping (series name -> style).

    Keys are capped to 120 chars; each style keeps only a hex ``color``, a
    known ``linetype`` and a known ``shape``. Entries that end up empty are
    dropped, and the whole dict is capped at 30 entries. Empty -> None.
    """
    if not isinstance(value, dict):
        return None
    cleaned: dict[str, dict[str, Any]] = {}
    for raw_name, raw_style in value.items():
        if len(cleaned) >= 30:
            break
        if not isinstance(raw_style, dict):
            continue
        name = str(raw_name).strip()[:120]
        if not name:
            continue
        inner: dict[str, Any] = {}
        color = _clean_hex(raw_style.get("color"))
        if color is not None:
            inner["color"] = color
        linetype = raw_style.get("linetype")
        if isinstance(linetype, str) and linetype in _SERIES_LINETYPES:
            inner["linetype"] = linetype
        shape = raw_style.get("shape")
        if isinstance(shape, str) and shape in _SERIES_SHAPES:
            inner["shape"] = shape
        if inner:
            cleaned[name] = inner
    return cleaned or None


def _sanitize_option(key: str, value: Any, valid_columns: set[str] | None = None) -> Any:
    if key in {"x_label", "y_label"} and value == "":
        return ""
    if key == "category_colors":
        if not isinstance(value, dict):
            return None
        clean: dict[str, str] = {}
        for raw_level, raw_color in value.items():
            if not isinstance(raw_level, str) or not isinstance(raw_color, str):
                continue
            level = raw_level.strip()
            color = raw_color.strip().upper()
            if not level or len(level) > 120:
                continue
            if not re.fullmatch(r"#[0-9A-F]{6}", color):
                continue
            clean[level] = color
            if len(clean) >= 80:
                break
        return clean or None
    if key == "level_order":
        # Ordered category levels: keep as a list of short strings, drop non-str.
        if not isinstance(value, list):
            return None
        clean_levels: list[str] = []
        for item in value:
            if not isinstance(item, str):
                continue
            text = item.strip()
            if not text:
                continue
            clean_levels.append(text[:120])
            if len(clean_levels) >= 60:
                break
        return clean_levels or None
    if key == "line_color":
        if not isinstance(value, str):
            return None
        color = value.strip().upper()
        if _HEX_COLOR_RE.fullmatch(color):
            return color
        return None
    if key == "annotations":
        return _sanitize_annotations(value)
    if key == "series_styles":
        return _sanitize_series_styles(value)
    if value in (None, ""):
        return None
    if key in {"facet_by", "y2_column"}:
        # Must reference a real dataset column; otherwise the render breaks.
        return value if isinstance(value, str) and value in (valid_columns or set()) else None
    if key == "y2_label":
        # Secondary-axis label: plain free string, length-capped like other labels.
        return value[:120] if isinstance(value, str) else None
    if key == "palette_name":
        if isinstance(value, str) and value in _OPTION_CHOICES[key]:
            return value
        if isinstance(value, str) and value.startswith("custom:"):
            try:
                uuid.UUID(value.split(":", 1)[1])
            except (ValueError, IndexError):
                return None
            return value
        if value == "custom":
            return value
        return None
    if key == "custom_palette_values":
        try:
            return palette_service.normalize_colors(value)
        except BadRequestError:
            return None
    if key == "custom_palette_label":
        if not isinstance(value, str):
            return None
        try:
            return palette_service.normalize_palette_name(value)
        except BadRequestError:
            return None
    if key in _OPTION_CHOICES:
        return value if isinstance(value, str) and value in _OPTION_CHOICES[key] else None
    if key in _BOOL_OPTIONS:
        return value if isinstance(value, bool) else None
    if key in _NUMBER_OPTIONS:
        try:
            num = float(value)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(num):
            return None
        if key == "dpi":
            return int(max(72, min(1200, num)))
        if key == "label_top":
            return int(max(0, min(100, num)))
        if key == "bins":
            return int(max(5, min(120, num)))
        if key == "font_scale":
            return max(0.6, min(2.0, num))
        if key == "bar_alpha":
            return max(0.15, min(1.0, num))
        if key in {"fill_alpha", "point_alpha"}:
            return max(0.05, min(1.0, num))
        if key == "bar_width":
            return max(0.2, min(1.0, num))
        if key == "x_text_angle":
            return max(0, min(90, num))
        if key in {"width_in", "height_in"}:
            return max(1.0, min(20.0, num))
        if key in {"x_breaks", "y_breaks"}:
            # Desired number of axis ticks: small integer range.
            return int(max(2, min(20, num)))
        if key == "legend_ncol":
            return int(max(1, min(8, num)))
        if key == "legend_key_size":
            # Legend key size in points.
            return max(4.0, min(40.0, num))
        # color_midpoint, hline_at, vline_at and any other finite numbers.
        return num
    if isinstance(value, str):
        return value[:200]
    return None


def _sanitize_param_patch(patch: dict[str, Any], pdef: dict, base_mapping: dict[str, Any],
                          valid_columns: set[str] | None = None) -> dict[str, Any]:
    if not isinstance(patch, dict):
        return {}

    clean: dict[str, Any] = {}
    style = patch.get("style_preset")
    if isinstance(style, str) and style in PRESETS:
        clean["style_preset"] = style

    allowed_mapping = {r["key"] for r in pdef["required"]} | {o["key"] for o in pdef.get("optional", [])}
    # A mapping value is accepted if it is already used in the base mapping OR is
    # a REAL column of the figure's dataset. The dataset column list is what
    # unlocks brand-new AI encodings (e.g. "color points by treatment"); values
    # that are not real columns are still rejected so renders cannot break.
    allowed_column_values = _known_mapping_values(base_mapping) | (valid_columns or set())
    mapping_patch = {}
    raw_mapping = patch.get("mapping")
    if isinstance(raw_mapping, dict):
        for key, value in raw_mapping.items():
            if key not in allowed_mapping:
                continue
            if isinstance(value, str) and value in allowed_column_values:
                mapping_patch[key] = value
            elif isinstance(value, list):
                vals = [v for v in value if isinstance(v, str) and v in allowed_column_values]
                if vals:
                    mapping_patch[key] = vals
    if mapping_patch:
        clean["mapping"] = mapping_patch

    allowed_options = {o["key"] for o in pdef.get("options", [])} | _UNIVERSAL_OPTION_KEYS
    options_patch = {}
    raw_options = patch.get("options")
    if isinstance(raw_options, dict):
        for key, value in raw_options.items():
            if key not in allowed_options:
                continue
            sanitized = _sanitize_option(key, value, valid_columns)
            if sanitized is not None:
                options_patch[key] = sanitized
    if options_patch:
        clean["options"] = options_patch
    return clean


def _patch_key_paths(patch: dict[str, Any] | None) -> list[str]:
    """Flatten a param_patch into stable dotted paths (style_preset, mapping.<k>,
    options.<k>) for applied/skipped reporting to the client."""
    paths: list[str] = []
    if not isinstance(patch, dict):
        return paths
    if patch.get("style_preset"):
        paths.append("style_preset")
    mapping = patch.get("mapping")
    if isinstance(mapping, dict):
        paths.extend(f"mapping.{k}" for k in mapping)
    options = patch.get("options")
    if isinstance(options, dict):
        paths.extend(f"options.{k}" for k in options)
    return paths


def _score_value(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _recommendation_record_to_item(row: Recommendation) -> dict[str, Any] | None:
    if row.plot_type == "_none":
        return None
    stored = row.required_vars if isinstance(row.required_vars, dict) else {}
    if "required_vars" in stored or "suggested_mapping" in stored:
        required_vars = stored.get("required_vars")
        suggested_mapping = stored.get("suggested_mapping")
        fit = stored.get("fit")
        rank = stored.get("rank")
    else:
        required_vars = stored
        suggested_mapping = None
        fit = None
        rank = None
    item: dict[str, Any] = {
        "plot_type": row.plot_type,
        "title": row.title,
        "score": _score_value(row.score),
        "rationale": row.rationale,
        "required_vars": required_vars if isinstance(required_vars, dict) else None,
        "suggested_mapping": suggested_mapping if isinstance(suggested_mapping, dict) else None,
        "example_usage": row.example_usage,
        "source": row.source,
    }
    if isinstance(rank, int):
        item["rank"] = rank
    if isinstance(fit, str):
        item["fit"] = fit
    return item


def cached_recommendations(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID) -> tuple[list[dict], bool]:
    ds_service.get_dataset(db, dataset_id, owner_id)
    rows = (
        db.query(Recommendation)
        .filter(Recommendation.dataset_id == dataset_id)
        .order_by(Recommendation.created_at.asc())
        .all()
    )
    if not rows:
        return [], False
    items = [item for row in rows if (item := _recommendation_record_to_item(row)) is not None]
    return sorted(items, key=lambda item: float(item.get("score") or 0), reverse=True), True


def _save_recommendations(db: Session, dataset_id: uuid.UUID, suggestions: list[dict]) -> None:
    db.query(Recommendation).filter(Recommendation.dataset_id == dataset_id).delete(synchronize_session=False)
    if not suggestions:
        db.add(Recommendation(dataset_id=dataset_id, plot_type="_none", source="ai", required_vars={"empty": True}))
        db.commit()
        return
    for index, suggestion in enumerate(suggestions, start=1):
        payload = {
            "required_vars": suggestion.get("required_vars") if isinstance(suggestion.get("required_vars"), dict) else {},
            "suggested_mapping": suggestion.get("suggested_mapping") if isinstance(suggestion.get("suggested_mapping"), dict) else {},
            "fit": suggestion.get("fit"),
            "rank": suggestion.get("rank") or index,
        }
        score = _score_value(suggestion.get("score"))
        source = str(suggestion.get("source") or "ai")
        if source != "rule":
            source = "ai"
        db.add(Recommendation(
            dataset_id=dataset_id,
            plot_type=str(suggestion.get("plot_type") or ""),
            title=suggestion.get("title"),
            score=None if score is None else f"{score:.4f}",
            rationale=suggestion.get("rationale"),
            required_vars=payload,
            example_usage=suggestion.get("example_usage"),
            source=source[:16],
        ))
    db.commit()


# ---------------------------------------------------------------- recommend
def ai_recommend(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID,
                 refresh: bool = False, prompt: str | None = None) -> list[dict]:
    ds = ds_service.get_dataset(db, dataset_id, owner_id)
    clean_prompt = (prompt or "").strip()
    if not refresh and not clean_prompt:
        cached, found = cached_recommendations(db, dataset_id, owner_id)
        if found:
            return cached
    ctx = _project_context(db, ds.project_id)
    if ds.description and ds.description.strip():
        ctx = ((ctx + " ") if ctx else "") + "Dataset: " + ds.description.strip()
    column_profile = ds_service.focused_column_profile(ds)
    if ds.focus_columns:
        ctx = ((ctx + " ") if ctx else "") + "Prioritize these user-selected columns: " + ", ".join(ds.focus_columns)
    suggestions = ai_client.recommend_charts(
        db, column_profile, project_context=ctx, user_id=owner_id, chart_prompt=clean_prompt or None,
        dataset_preview=(ds.preview or [])[:10],
    )
    _save_recommendations(db, dataset_id, suggestions)
    return suggestions


def ai_recommend_from_reference_image(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID,
                                      image_bytes: bytes, mime: str) -> list[dict]:
    if mime not in {"image/png", "image/jpeg", "image/webp"}:
        raise BadRequestError("Reference image must be PNG, JPEG, or WebP", error_code="BAD_IMAGE_TYPE")
    if len(image_bytes) > 8 * 1024 * 1024:
        raise BadRequestError("Reference image must be 8 MB or smaller", error_code="IMAGE_TOO_LARGE")
    ds = ds_service.get_dataset(db, dataset_id, owner_id)
    ctx = _project_context(db, ds.project_id)
    if ds.description and ds.description.strip():
        ctx = ((ctx + " ") if ctx else "") + "Dataset: " + ds.description.strip()
    column_profile = ds_service.focused_column_profile(ds)
    if ds.focus_columns:
        ctx = ((ctx + " ") if ctx else "") + "Prioritize these user-selected columns: " + ", ".join(ds.focus_columns)
    return ai_client.recommend_from_reference_image(
        db, column_profile, image_bytes, mime, project_context=ctx, user_id=owner_id,
        dataset_preview=(ds.preview or [])[:10],
    )


# ---------------------------------------------------------------- export
_EXPORT = {
    "png": ("png_path", "image/png", "png"),
    "svg": ("svg_path", "image/svg+xml", "svg"),
    "tiff": ("tiff_path", "image/tiff", "tiff"),
    "pdf": ("pdf_path", "application/pdf", "pdf"),
    "eps": ("eps_path", "application/postscript", "eps"),
    "html": ("html_path", "text/html", "html"),
    "r": ("r_path", "text/plain", "R"),
}


def export_path(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID, fmt: str, owner_id: uuid.UUID):
    if fmt not in _EXPORT:
        raise BadRequestError(f"Unsupported export format '{fmt}'", error_code="BAD_FORMAT")
    fig = get_figure(db, figure_id, owner_id)
    v = get_version(fig, version_id)
    attr, media, ext = _EXPORT[fmt]
    path = getattr(v, attr)
    if not path or not storage.exists(path):
        raise NotFoundError("Export file", fmt)
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", fig.name)
    filename = f"{safe}_v{v.version_number}.{ext}"
    return path, media, filename


def gallery_export_path(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID, fmt: str):
    if fmt not in _EXPORT:
        raise BadRequestError(f"Unsupported export format '{fmt}'", error_code="BAD_FORMAT")
    fig = (
        db.query(Figure)
        .options(joinedload(Figure.versions))
        .filter(Figure.id == figure_id, Figure.status == "ready", Figure.is_public == True)
        .first()
    )
    if not fig:
        raise NotFoundError("Figure", str(figure_id))
    v = get_version(fig, version_id)
    attr, media, ext = _EXPORT[fmt]
    path = getattr(v, attr)
    if not path or not storage.exists(path):
        raise NotFoundError("Export file", fmt)
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", fig.name)
    filename = f"gallery_{safe}_v{v.version_number}.{ext}"
    return path, media, filename


# ---------------------------------------------------------------- compliance
# Small tolerance (~6 mm) when matching a rendered width to a journal column
# width, and the set of vector / high-resolution raster formats that count as
# publication-grade for the format check.
_WIDTH_TOL_IN = 0.25
_HQ_FORMATS = ("tiff", "pdf", "svg", "eps")


def _available_formats(v: FigureVersion) -> list[str]:
    """Rendered image formats that actually exist for a version (png/svg/tiff/pdf/eps)."""
    formats: list[str] = []
    for fmt in ("png", "svg", "tiff", "pdf", "eps"):
        attr = _EXPORT[fmt][0]
        path = getattr(v, attr, None)
        if path and storage.exists(path):
            formats.append(fmt)
    return formats


def check_compliance(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID,
                     owner_id: uuid.UUID) -> dict:
    """Deterministic (no AI) comparison of a version's actual rendered attributes
    against the journal spec of its style preset. Returns an overall pass/fail
    plus a per-check list of {name, ok, actual, expected, hint}."""
    fig = get_figure(db, figure_id, owner_id)
    v = get_version(fig, version_id)
    preset = v.style_preset or fig.style_preset or "nature"
    spec = journal_spec(preset)

    width_in, height_in, dpi = renderer._dimensions(v.options or {})
    available = _available_formats(v)
    single = float(spec["single_col_in"])
    double = float(spec["double_col_in"])
    checks: list[dict[str, Any]] = []

    # 1) Column width -- must match single or double column within tolerance.
    # Round the measured difference to sidestep float-representation noise at the
    # tolerance boundary (e.g. |7.0 - 7.2| == 0.2000000000000002).
    matches_single = round(abs(width_in - single), 3) <= _WIDTH_TOL_IN
    matches_double = round(abs(width_in - double), 3) <= _WIDTH_TOL_IN
    width_ok = matches_single or matches_double
    if width_ok:
        width_hint = None
    elif width_in <= double + _WIDTH_TOL_IN:
        width_hint = (f"Resize to a single-column ({single:.2f} in) or double-column "
                      f"({double:.2f} in) width for {spec['journal']}.")
    else:
        width_hint = (f"Figure is wider than the {spec['journal']} double-column width "
                      f"({double:.2f} in); reduce the width.")
    checks.append({
        "name": "Column width",
        "ok": width_ok,
        "actual": f"{width_in:.2f} in",
        "expected": f"{single:.2f} in (single) or {double:.2f} in (double)",
        "hint": width_hint,
    })

    # 2) Resolution -- dpi must be at least the journal minimum.
    min_dpi = int(spec["min_dpi"])
    max_dpi = int(spec["max_dpi"])
    dpi_ok = dpi >= min_dpi
    if not dpi_ok:
        dpi_hint = f"Increase export resolution to at least {min_dpi} dpi."
    elif dpi > max_dpi:
        dpi_hint = (f"{spec['journal']} recommends no more than {max_dpi} dpi; the current "
                    "export is larger than needed.")
    else:
        dpi_hint = None
    checks.append({
        "name": "Resolution",
        "ok": dpi_ok,
        "actual": f"{dpi} dpi",
        "expected": f">= {min_dpi} dpi",
        "hint": dpi_hint,
    })

    # 3) A preferred vector / TIFF export must be available.
    hq_available = [f for f in available if f in _HQ_FORMATS]
    format_ok = bool(hq_available)
    checks.append({
        "name": "Vector/TIFF format",
        "ok": format_ok,
        "actual": (", ".join(available) if available else "none"),
        "expected": "one of: " + ", ".join(spec["preferred_formats"]),
        "hint": (None if format_ok else
                 "Export a vector (PDF/EPS) or TIFF file; "
                 f"{spec['journal']} prefers " + ", ".join(spec["preferred_formats"]) + "."),
    })

    # 4) Font family -- should match the journal's preferred family.
    font_family = (v.options or {}).get("font_family") or "sans"
    preferred_font = spec["preferred_font"]
    font_ok = font_family == preferred_font
    checks.append({
        "name": "Font family",
        "ok": font_ok,
        "actual": font_family,
        "expected": preferred_font,
        "hint": (None if font_ok else
                 f"{spec['journal']} figures prefer a {preferred_font} font; current is {font_family}."),
    })

    return {
        "figure_id": fig.id,
        "version_id": v.id,
        "style_preset": preset,
        "journal": spec["journal"],
        "passed": all(c["ok"] for c in checks),
        "width_in": round(width_in, 2),
        "height_in": round(height_in, 2),
        "dpi": dpi,
        "available_formats": available,
        "checks": checks,
    }


# ---------------------------------------------------------------- submission bundle
def build_submission_bundle(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID,
                            owner_id: uuid.UUID, column: str = "single") -> tuple[bytes, str]:
    """Owner-scoped ZIP for journal submission.

    Best-effort re-renders the figure at the journal's exact column width using
    the same render machinery; if that is unavailable (manual SVG edit, missing
    dataset, or a render error) it falls back to the version's existing rendered
    files. Always includes the reproducible figure.R and a README/caption stub.
    Returns (zip_bytes, filename).
    """
    fig = get_figure(db, figure_id, owner_id)
    v = get_version(fig, version_id)
    column = "double" if str(column or "").lower() == "double" else "single"
    preset = v.style_preset or fig.style_preset or "nature"
    spec = journal_spec(preset)
    target_width = float(spec["double_col_in"] if column == "double" else spec["single_col_in"])

    base_w, base_h, base_dpi = renderer._dimensions(v.options or {})
    target_dpi = int(min(int(spec["max_dpi"]), max(int(spec["min_dpi"]), int(base_dpi))))
    aspect = (base_h / base_w) if base_w else 0.75
    target_height = round(max(1.0, min(20.0, target_width * aspect)), 2)

    plot_label = _METHODS_PLOT_LABEL.get(fig.plot_type, fig.plot_type.replace("_", " "))
    manual_svg = bool((v.options or {}).get("manual_svg_edit"))

    rendered: dict[str, bytes] = {}
    did_rerender = False
    zip_buf = io.BytesIO()

    with tempfile.TemporaryDirectory(prefix="labplot_bundle_") as work:
        # ---- best-effort re-render at the exact journal column width ----
        if not manual_svg:
            try:
                ds = ds_service.get_dataset(db, fig.dataset_id, owner_id)
                df = ds_service.load_dataframe(ds)
                new_options = dict(v.options or {})
                new_options.update({
                    "size": "custom", "width_in": target_width,
                    "height_in": target_height, "dpi": target_dpi,
                })
                new_options = sanitize_options(fig.plot_type, new_options, _dataset_column_names(ds))
                new_options = _resolve_custom_palette_options(db, owner_id, new_options)
                out_dir = os.path.join(work, "render")
                res = renderer.render(fig.plot_type, v.mapping or {}, new_options, preset, df, out_dir)
                if res.success:
                    for ext in ("png", "tiff", "pdf", "svg", "eps", "r"):
                        path = (res.outputs or {}).get(ext)
                        if path and os.path.exists(path):
                            with open(path, "rb") as fh:
                                rendered[ext] = fh.read()
                    did_rerender = bool(rendered)
            except Exception:
                rendered = {}
                did_rerender = False

        # ---- fallback: bundle the version's existing rendered files ----
        if not rendered:
            for fmt in ("tiff", "pdf", "png", "svg", "eps", "r"):
                attr = _EXPORT[fmt][0]
                path = getattr(v, attr, None)
                if path and storage.exists(path):
                    rendered[fmt] = storage.read_bytes(path)

        if did_rerender:
            note = (f"Re-rendered at the {spec['journal']} {column}-column width "
                    f"{target_width:.2f} in x {target_height:.2f} in @ {target_dpi} dpi.")
            size_line = f"Render size  : {target_width:.2f} in x {target_height:.2f} in @ {target_dpi} dpi"
        elif manual_svg:
            note = "Manually SVG-edited version bundled as-is (not re-rendered)."
            size_line = f"Source size  : {base_w:.2f} in x {base_h:.2f} in @ {base_dpi} dpi"
        else:
            note = "Bundled the version's existing rendered files (re-render unavailable)."
            size_line = f"Source size  : {base_w:.2f} in x {base_h:.2f} in @ {base_dpi} dpi"

        included = ", ".join(sorted(rendered.keys())) or "none"
        caption_stub = fig.legend or (
            f"Figure. {fig.name}. Describe the figure content, sample sizes (n), "
            "and statistical tests here."
        )
        readme = "\n".join([
            "LabPlot AI - journal submission bundle",
            "",
            f"Figure name  : {fig.name}",
            f"Plot type    : {plot_label}",
            f"Journal style: {spec['journal']} ({preset})",
            f"Target column: {column} ({target_width:.2f} in)",
            size_line,
            f"Files        : {included}",
            f"Note         : {note}",
            "",
            "Caption (stub):",
            caption_stub,
            "",
            "Interpretation:",
            (fig.description or "-"),
            "",
            "Reproducibility:",
            "See figure.R for the exact, self-contained R script that regenerates this figure.",
        ])

        safe = re.sub(r"[^A-Za-z0-9_-]+", "_", fig.name) or "figure"
        name_map = {
            "png": f"{safe}.png", "tiff": f"{safe}.tiff", "pdf": f"{safe}.pdf",
            "svg": f"{safe}.svg", "eps": f"{safe}.eps", "r": "figure.R",
        }
        with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as z:
            for ext, data in rendered.items():
                z.writestr(name_map.get(ext, f"{safe}.{ext}"), data)
            z.writestr("README.txt", readme)

    return zip_buf.getvalue(), f"{safe}_v{v.version_number}_{column}_submission.zip"
