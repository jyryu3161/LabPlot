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
from app.ai.grounding import build_dataset_grounding, collect_r_package_versions
from app.ai.prompts import ALT_TEXT_PROMPT_VERSION, LEGEND_PROMPT_VERSION
from app.auth.models import User
from app.common import storage
from app.common.asset_tokens import signed_asset_url
from app.common.exceptions import AppError, BadRequestError, ForbiddenError, NotFoundError
from app.common.quotas import enforce_render_quota
from app.config import settings
from app.datasets.models import Dataset
from app.datasets import service as ds_service
from app.figures import codegen
from app.figures.models import Figure, FigureCodeArtifact, FigureComment, FigureTemplateFavorite, FigureVersion, Improvement, Recommendation, Review
from app.figures.option_metadata import _BOOL_OPTIONS, _NUMBER_OPTIONS, _OPTION_CHOICES, _UNIVERSAL_OPTION_KEYS
from app.palettes import service as palette_service
from app.projects.models import Project
from app.r_engine import renderer
from app.r_engine.presets import DEFAULT_NEW_FIGURE_OPTIONS, PRESETS, journal_spec
from app.r_engine.templates import CONTINUOUS_FILL_TYPES, DEFAULT_X_TEXT_ANGLE, PLOT_TYPES, PLOT_TYPE_KEYS, rq

_STATIC_ROOT = os.path.dirname(settings.figures_dir.rstrip("/"))
# _UNIVERSAL_OPTION_KEYS / _OPTION_CHOICES / _BOOL_OPTIONS / _NUMBER_OPTIONS now
# live in app.figures.option_metadata (see that module's docstring for why:
# app.ai.options_schema needs the same authoritative sets without creating a
# circular import through app.ai.client).
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
    "purple": "#7E22CE",
    "보라": "#7E22CE",
    "보라색": "#7E22CE",
}
# Shared 6-digit hex-color validator (matches the inline checks used for
# category_colors / line_color / palettes). Colors are upper-cased before test.
_HEX_COLOR_RE = re.compile(r"#[0-9A-F]{6}")
_URL_ID_TOKEN = r"(?:[A-Za-z0-9._~+\-]|%[0-9A-Fa-f]{2})+"
_GROUPED_BAR_MARK_ID_RE = re.compile(
    rf"^mark:grouped_bar:category={_URL_ID_TOKEN}&series={_URL_ID_TOKEN}$"
)
_SCATTER_MARK_ID_RE = re.compile(rf"^mark:scatter:row={_URL_ID_TOKEN}$")
_HEATMAP_MARK_ID_RE = re.compile(
    rf"^mark:heatmap:row={_URL_ID_TOKEN}&col={_URL_ID_TOKEN}$"
)
_CORRELATION_HEATMAP_MARK_ID_RE = re.compile(
    rf"^mark:correlation_heatmap:x={_URL_ID_TOKEN}&y={_URL_ID_TOKEN}$"
)
_ELEMENT_MARK_ID_RE_BY_PLOT = {
    "grouped_bar": _GROUPED_BAR_MARK_ID_RE,
    "scatter": _SCATTER_MARK_ID_RE,
    "heatmap": _HEATMAP_MARK_ID_RE,
    "correlation_heatmap": _CORRELATION_HEATMAP_MARK_ID_RE,
}
_MAX_ELEMENT_OVERRIDES = 80
_MAX_ELEMENT_ID_LENGTH = 512
_LINE_COMPONENT_RE = re.compile(r"(line|선|라인)")
_NON_LINE_COLOR_TARGET_RE = re.compile(
    r"(axis|축|tick|눈금|label|라벨|legend|범례|text|텍스트|글씨|point|marker|점|마커|bar|막대|category|group|그룹)"
)
_LOCALIZED_EDIT_MARKER = "Localized image editing annotations for R-code regeneration:"
_DEFAULT_LOCALIZED_EDIT_PROMPT = "Apply the localized edits marked on the figure preview."
_LOCALIZED_MARK_BLOCK_RE = re.compile(
    r"Mark\s*#(?P<mark_id>\d+)\s*\[(?P<mark_type>region|arrow|note)\]\."
    r"(?P<body>.*?)(?=(?:\nMark\s*#\d+\s*\[)|\Z)",
    re.IGNORECASE | re.DOTALL,
)
_SIMPLE_MARK_LINE_RE = re.compile(r"^\s*Mark\s*#(?P<mark_id>\d+)\s*:\s*(?P<memo>.+?)\s*$", re.IGNORECASE)
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
    return signed_asset_url(abs_path)


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


def _profile_column_names(column_profile: list[dict] | None) -> set[str]:
    """Column allow-list for the active recommendation scope.

    Unlike `_dataset_column_names`, this intentionally honors focus_columns by
    accepting the already-focused profile sent to the model.
    """
    return {
        column["name"]
        for column in (column_profile or [])
        if isinstance(column, dict) and isinstance(column.get("name"), str) and column["name"]
    }


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
        sanitized = _sanitize_option(key, value, valid_columns, plot_type=plot_type)
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


def _augmented_layout(v: FigureVersion) -> dict | None:
    """Sidecar layout + request-time scale_editable_x/y capability flags (same
    augmentation the canvas preview endpoint applies) so the figure page's
    element-edit overlay can gate axis controls the renderer would ignore."""
    layout = v.layout
    if not isinstance(layout, dict):
        return layout
    try:
        from app.r_engine.templates import scale_editable_axes
        flags = scale_editable_axes(v.figure.plot_type, v.mapping or {}, v.options or {})
        layout = dict(layout)
        layout["scale_editable_x"] = flags["x"]
        layout["scale_editable_y"] = flags["y"]
    except Exception:
        pass
    return layout


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
        "r_available": bool(v.r_path and storage.exists(v.r_path)),
        "layout": _augmented_layout(v),
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


def native_size_mm(options: dict | None) -> tuple[float | None, float | None]:
    """Physical size (mm) a version's options render at — the figure's "native"
    size, used by the canvas editor to place new panels at original size.
    None options (figure has no version yet) -> unknown."""
    if options is None:
        return None, None
    w_in, h_in, _dpi = renderer._dimensions(options)
    return round(w_in * 25.4, 2), round(h_in * 25.4, 2)


def list_figures(db: Session, owner_id: uuid.UUID, project_id: uuid.UUID | None = None) -> list[dict]:
    from app.projects import service as project_service

    q = (
        db.query(Figure, FigureVersion.png_path, FigureVersion.options)
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
    favorite_ids = _favorite_figure_ids(db, owner_id, [f.id for f, _, _ in rows])
    out = []
    for f, png_path, v_options in rows:
        nw, nh = native_size_mm(v_options)
        out.append({
            "id": f.id, "name": f.name, "plot_type": f.plot_type, "style_preset": f.style_preset,
            "status": f.status, "dataset_id": f.dataset_id, "project_id": f.project_id,
            "created_at": f.created_at, "updated_at": f.updated_at,
            "display_order": f.display_order,
            "is_favorite": f.id in favorite_ids,
            "thumb_url": _url(png_path),
            "native_width_mm": nw, "native_height_mm": nh,
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


def _figure_dataset_grounding(ds: Dataset, plot_type: str, mapping: dict, options: dict,
                              *, dataframe=None) -> dict:
    """Best-effort factual context shared by figure writing/review endpoints."""
    frame = dataframe
    if frame is None:
        try:
            frame = ds_service.load_dataframe(ds)
        except Exception:
            # Column profiles still provide grounded row counts, exact small
            # categorical levels and numeric ranges when source loading fails.
            frame = None
    return build_dataset_grounding(
        n_rows=ds.n_rows,
        column_profile=ds.column_profile or [],
        mapping=mapping or {},
        options=options or {},
        plot_type=plot_type,
        dataframe=frame,
    )


def generate_legend(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID, owner_id: uuid.UUID,
                    style: str = "nature", prompt: str | None = None,
                    current_legend: str | None = None) -> dict:
    fig = get_figure(db, figure_id, owner_id, write=True)
    v = get_version(fig, version_id)
    ds = ds_service.get_dataset(db, fig.dataset_id, owner_id)
    dataset_summary = _figure_dataset_grounding(
        ds, fig.plot_type, v.mapping or {}, v.options or {},
    )
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
    return {
        "legend": legend,
        "grounding": dataset_summary,
        "prompt_version": LEGEND_PROMPT_VERSION,
    }


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
                           r_code: str | None, *, package_versions: dict[str, str] | None = None,
                           dataset_grounding: dict | None = None) -> str:
    """Deterministic, low-hallucination methods paragraph.

    Everything asserted here is grounded in the actual generated R code (real
    library() calls and statistical function calls) plus the stored style/size/
    dpi options. No AI is involved, so it cannot invent findings or packages.
    """
    options = options or {}
    packages = _r_packages_from_code(r_code)
    has_ggplot = "ggplot2" in packages or "geom_" in (r_code or "")
    methods = [desc for pattern, desc in _R_METHOD_SIGNS if pattern.search(r_code or "")]
    plot_label = _METHODS_PLOT_LABEL.get(plot_type, plot_type.replace("_", " ") + " plot")

    sentences: list[str] = []
    package_versions = package_versions or {}
    core = "Figures were generated in R"
    if package_versions.get("R"):
        core += f" {package_versions['R']}"
    used_packages = list(packages)
    if has_ggplot and "ggplot2" not in used_packages:
        used_packages.insert(0, "ggplot2")
    if used_packages:
        labels = [
            f"{name} {package_versions[name]}" if package_versions.get(name) else name
            for name in used_packages
        ]
        core += " using " + _english_join(labels)
    core += "."
    sentences.append(core)

    data_sentence = f"The data were visualized as a {plot_label}"
    if methods:
        data_sentence += "; " + _english_join(methods)
    data_sentence += "."
    sentences.append(data_sentence)

    grounding = dataset_grounding or {}
    quantitative: list[str] = []
    total_rows = grounding.get("total_rows")
    if isinstance(total_rows, int):
        quantitative.append(f"the source table contained {total_rows} rows")
    series = grounding.get("series")
    if isinstance(series, dict) and series.get("levels_complete") and series.get("levels"):
        quantitative.append(
            f"{series.get('column') or 'series'} levels were {_english_join([str(v) for v in series['levels']])}"
        )
    representation = grounding.get("representation")
    if isinstance(representation, dict):
        if representation.get("summary"):
            quantitative.append(f"the rendered summary was {representation['summary']}")
        if representation.get("error_bars") and representation.get("error_type"):
            quantitative.append(f"error bars represented {str(representation['error_type']).upper()}")
        if representation.get("individual_observations"):
            quantitative.append("individual observations were displayed")
    if quantitative:
        quantitative_text = _english_join(quantitative)
        sentences.append(quantitative_text[:1].upper() + quantitative_text[1:] + ".")

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
    font_word = {
        "serif": "a serif font", "mono": "a monospace font", "sans": "a sans-serif font",
        "dejavu_sans": "DejaVu Sans", "arial": "DejaVu Sans (Arial-compatible fallback)",
        "helvetica": "DejaVu Sans (Helvetica-compatible fallback)", "noto_sans": "Noto Sans",
        "noto_serif": "Noto Serif", "times": "DejaVu Serif (Times-compatible fallback)",
    }.get(options.get("font_family"))
    if font_word:
        style_bits.append(font_word)
    if options.get("axis_line_width_pt") is not None:
        style_bits.append(f"{options['axis_line_width_pt']} pt axis lines")
    if options.get("data_line_width_pt") is not None:
        style_bits.append(f"{options['data_line_width_pt']} pt data lines")
    sentences.append("Figures use " + _english_join(style_bits) + " on a white background.")
    return " ".join(sentences)


def generate_methods_text(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID,
                          owner_id: uuid.UUID) -> dict:
    fig = get_figure(db, figure_id, owner_id)
    v = get_version(fig, version_id)
    ds = ds_service.get_dataset(db, fig.dataset_id, owner_id)
    grounding = _figure_dataset_grounding(ds, fig.plot_type, v.mapping or {}, v.options or {})
    packages = _r_packages_from_code(v.r_code)
    if "geom_" in (v.r_code or "") and "ggplot2" not in packages:
        packages.insert(0, "ggplot2")
    versions = collect_r_package_versions(packages)
    text = _assemble_methods_text(
        fig.plot_type, v.mapping or {}, v.options or {},
        v.style_preset or fig.style_preset, v.r_code,
        package_versions=versions,
        dataset_grounding=grounding,
    )
    return {
        "methods_text": text,
        "grounding": grounding,
        "runtime_versions": versions,
        "generator_version": "methods-grounded-2026-08-18.1",
    }


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
    dataset_summary = _figure_dataset_grounding(
        ds, fig.plot_type, v.mapping or {}, v.options or {},
    )
    pc = _project_context(db, fig.project_id)
    if ds.description and ds.description.strip():
        pc = ((pc + " ") if pc else "") + "Dataset: " + ds.description.strip()
    alt_text = ai_client.generate_alt_text(
        db, fig.plot_type, v.mapping or {}, v.options or {},
        dataset_summary, fig.description, project_context=pc, user_id=owner_id,
        user_request=(prompt or "").strip() or None,
    )
    return {
        "alt_text": alt_text,
        "grounding": dataset_summary,
        "prompt_version": ALT_TEXT_PROMPT_VERSION,
    }


# ---------------------------------------------------------------- rendering
def _parse_layout_json(path: str | None) -> dict | None:
    """Read the renderer's panel-geometry sidecar into a dict, defensively.

    The file is machine-generated JSON, but parse it as untrusted input: only a
    top-level dict is accepted; any error yields None so a malformed/absent
    sidecar never blocks persisting the version.
    """
    if not path:
        return None
    try:
        with open(path, "r") as f:
            data = json.load(f)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _render_into_version(df, plot_type, mapping, options, preset, figure_id, version_id):
    out_dir = os.path.join(settings.figures_dir, str(figure_id), str(version_id))
    res = renderer.render(plot_type, mapping, options or {}, preset, df, out_dir)
    if not res.success:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise BadRequestError(_friendly_error(res.log), error_code="RENDER_FAILED")
    # Parse the panel-geometry sidecar into a dict now, while the local file is
    # still on disk -- object-storage mode deletes out_dir below. Stored on the
    # version's `layout` column, NOT uploaded as an asset.
    res.layout = _parse_layout_json((res.outputs or {}).get("layout"))
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
            # layout is persisted as JSON in the DB, not as an object-store asset
            if kind == "layout":
                continue
            key = storage.object_key("figures", figure_id, version_id, os.path.basename(path))
            stored_outputs[kind] = storage.upload_file(path, key, content_type=content_types.get(kind))
        res.outputs = stored_outputs
        shutil.rmtree(out_dir, ignore_errors=True)
    return res, out_dir


def _discard_uncommitted_render(res, out_dir: str) -> None:
    """Remove artifacts from a render that lost an optimistic commit race."""
    for kind, ref in (getattr(res, "outputs", None) or {}).items():
        if kind == "layout":
            continue
        try:
            storage.delete_file(ref)
        except Exception:
            # Conflict handling must still return 409 even if best-effort
            # artifact cleanup encounters an unavailable object store.
            pass
    shutil.rmtree(out_dir, ignore_errors=True)


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
    defaults_profile = getattr(data, "defaults_profile", "publication_v2")
    if defaults_profile == "publication_v2":
        # Persist every default in v1. Rendering must not depend on a mutable
        # global fallback, otherwise old figures can change on a later export.
        for key, value in DEFAULT_NEW_FIGURE_OPTIONS.items():
            options.setdefault(key, value)
    # Materialize the template's default tick rotation for the same reason:
    # the renderer would fall back to this exact value anyway, and storing it
    # keeps the Advanced UI and the AI plan's before-values in agreement with
    # what is actually drawn. Identical render either way, so this is safe for
    # both defaults profiles.
    template_angle = DEFAULT_X_TEXT_ANGLE.get(data.plot_type)
    if template_angle is not None:
        options.setdefault("x_text_angle", template_angle)
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
        layout=res.layout,
        r_path=res.outputs.get("r"), render_log=res.log,
    )
    db.add(version)
    db.flush()
    _archive_code_artifact(db, owner_id, ds, fig, version, res)
    # Initial creation returns after exactly one deterministic R render.  The
    # former synchronous AI review could make the request wait for an external
    # model and a second render (measured p95 >30s) before v1 was usable.
    # Explicit AI Review remains available, and the helper below is retained
    # for a future background job where it cannot extend create latency.
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
            dataset_grounding=_figure_dataset_grounding(
                ds, plot_type, mapping or {}, options or {}, dataframe=df,
            ),
            style_preset=preset,
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
        # Best-effort automatic pass: `unsupported` reasons aren't user-facing
        # here (there is no interactive editor UI at figure-creation time), so
        # they are dropped intentionally rather than surfaced.
        suggestions, _unsupported = ai_client.improve_figure(
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
            layout=res.layout,
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
        # The automatic first-render review may improve layout, but it must not
        # replace explicit defaults or a user's deliberate palette/type choice.
        protected_style_keys = set(DEFAULT_NEW_FIGURE_OPTIONS)
        changed_options = {
            k: v for k, v in combined["options"].items()
            if base_options.get(k) != v
            and not (k in protected_style_keys and k in base_options)
        }
        # A continuous colorbar's home is the right-hand side; the automatic
        # first-render pass must never relocate it (2026-08-19 request:
        # heatmap-family color keys stay right unless the USER asks). This
        # runs only on the unrequested auto-quality path, so explicit edit
        # requests can still move the guide.
        if pdef.get("type") in CONTINUOUS_FILL_TYPES:
            for key in ("legend_position", "legend_direction"):
                changed_options.pop(key, None)
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


def _normalize_edit_mark_id(value: Any) -> str | None:
    if isinstance(value, bool):
        return None
    match = re.search(r"\d+", str(value or ""))
    return str(int(match.group(0))) if match else None


def _extract_edit_request_scopes(request: str | None) -> list[dict[str, Any]]:
    """Parse the frontend's localized prompt into stable server-owned scopes.

    Provider-generated identifiers are never trusted as the source of truth:
    ``scope_id=mark:n`` comes only from the user's Mark #n summaries. The same
    parser also accepts the compact ``Mark #n: memo`` provenance form used by
    apply requests and plain unmarked requests.
    """
    text = (request or "").strip()
    if not text:
        return []
    scopes: list[dict[str, Any]] = []
    localized = _LOCALIZED_EDIT_MARKER in text
    if localized:
        head, tail = text.split(_LOCALIZED_EDIT_MARKER, 1)
        general = head.strip()
        if general and general != _DEFAULT_LOCALIZED_EDIT_PROMPT:
            scopes.append({
                "scope_id": "request",
                "mark_id": None,
                "mark_type": None,
                "request": general[:4000],
            })
        for match in _LOCALIZED_MARK_BLOCK_RE.finditer(tail):
            memo_match = re.search(r"User memo:\s*(.*?)(?:\n|\Z)", match.group("body"), re.IGNORECASE)
            memo = (memo_match.group(1) if memo_match else "").strip()
            if not memo or memo == "(no memo)":
                continue
            mark_id = _normalize_edit_mark_id(match.group("mark_id"))
            if not mark_id:
                continue
            scopes.append({
                "scope_id": f"mark:{mark_id}",
                "mark_id": mark_id,
                "mark_type": match.group("mark_type").lower(),
                "request": memo[:1000],
            })
        return scopes

    general_lines: list[str] = []
    for line in text.splitlines():
        match = _SIMPLE_MARK_LINE_RE.match(line)
        if not match:
            if line.strip():
                general_lines.append(line.strip())
            continue
        mark_id = _normalize_edit_mark_id(match.group("mark_id"))
        memo = match.group("memo").strip()
        if mark_id and memo:
            scopes.append({
                "scope_id": f"mark:{mark_id}",
                "mark_id": mark_id,
                "mark_type": None,
                "request": memo[:1000],
            })
    general = "\n".join(general_lines).strip()
    if general:
        scopes.insert(0, {
            "scope_id": "request",
            "mark_id": None,
            "mark_type": None,
            "request": general[:4000],
        })
    return scopes


_EDITABLE_TEXT_TARGET_PATHS = {
    "title": "options.title",
    "subtitle": "options.subtitle",
    "x_label": "options.x_label",
    "y_label": "options.y_label",
}

# Roles ranked in the label-content tier of mark hit-testing. Tick-label
# strips are text too: without this a box drawn around crowded tick labels
# loses to the zero-height x_label band right beneath them.
_TEXT_TIER_ROLES = frozenset(_EDITABLE_TEXT_TARGET_PATHS) | {"x_tick_labels", "y_tick_labels"}

# Deterministic wording -> option-key rules for scene-resolved targets whose
# edits are visual (not text-content). The pointing gesture supplies WHICH
# element; the memo wording still has to name a supported operation, so this
# never widens authorization beyond the marked element's own settings.
_SCENE_ROLE_SETTING_RULES: dict[str, tuple[tuple[str, tuple[str, ...]], ...]] = {
    "x_tick_labels": (
        (r"\b(?:rotate|rotation|angle|angled|diagonal|slanted?|tilt(?:ed)?|overlap(?:ping)?|crowd(?:ed)?"
         r"|horizontal|vertical)\b|회전|각도|기울|겹치|겹침|눈금", ("x_text_angle",)),
        (r"\b(?:format|percent|comma|scientific)\b|퍼센트|콤마|형식", ("x_tick_format",)),
    ),
    "y_tick_labels": (
        (r"\b(?:format|percent|comma|scientific)\b|퍼센트|콤마|형식", ("y_tick_format",)),
    ),
    "colorbar": (
        (r"\b(?:move|position|relocate|place|placed|top|bottom|left|right|side)\b"
         r"|위치|이동|옮기|옮겨|오른쪽|왼쪽|위로|아래", ("legend_position", "legend_direction")),
        (r"\b(?:vertical|horizontal|direction)\b|세로|가로|수직|수평|방향", ("legend_direction",)),
        (r"\b(?:hide|remove|without)\b|숨기|제거|없애", ("hide_legend",)),
    ),
    "legend": (
        (r"\b(?:move|position|relocate|place|placed|top|bottom|left|right|side)\b"
         r"|위치|이동|옮기|옮겨|오른쪽|왼쪽|위로|아래", ("legend_position", "legend_direction")),
        (r"\b(?:vertical|horizontal|direction)\b|세로|가로|수직|수평|방향", ("legend_direction",)),
        (r"\b(?:hide|remove|without)\b|숨기|제거|없애", ("hide_legend",)),
        (r"\b(?:columns?|ncol)\b|열\s*수", ("legend_ncol",)),
        (r"\b(?:key\s*size|bigger\s+keys?)\b|키\s*크기", ("legend_key_size",)),
    ),
}

# One-line "what CAN you do here" hints for unsupported-result messages.
_SCENE_ROLE_SUPPORTED_HINTS = {
    "x_tick_labels": 'rotating the labels (e.g. "rotate 45 degrees") or changing the tick number format',
    "y_tick_labels": "changing the tick number format (percent/comma/scientific)",
    "colorbar": "moving it (right/bottom/top/left), making it vertical/horizontal, or hiding it",
    "legend": "moving it (right/bottom/top/left), making it vertical/horizontal, hiding it, or changing its columns/key size",
}


def _scene_role_paths_for_request(role: str, request: str) -> set[str]:
    """Option keys a scene-resolved target of `role` authorizes for `request`."""
    rules = _SCENE_ROLE_SETTING_RULES.get(role or "")
    if not rules:
        return set()
    text = (request or "").lower()
    keys: set[str] = set()
    for pattern, option_keys in rules:
        if re.search(pattern, text):
            keys.update(option_keys)
    return keys


def _scope_generic_unsupported_reason(scope: dict[str, Any]) -> str:
    """User-facing fallback reason that names WHAT was recognized and what IS
    supported there, instead of a bare 'nothing could be derived'."""
    target = scope.get("server_resolved_target")
    if isinstance(target, dict):
        label = str(target.get("label") or target.get("role") or "").strip()
        hint = _SCENE_ROLE_SUPPORTED_HINTS.get(str(target.get("role") or ""))
        if label and hint:
            return (
                f"The marked area was recognized as the {label}, but the memo did not "
                f"match a supported edit for it. Supported here: {hint}."
            )
        if label:
            return (
                f"The marked area was recognized as the {label}, but no request-authorized "
                "parameter change could be derived from the memo."
            )
    return "No request-authorized parameter change could be derived for this edit scope."


def _server_mark_target_candidates(
    layout: dict[str, Any] | None,
) -> tuple[float, float, list[tuple[dict[str, Any], tuple[float, float, float, float]]]] | None:
    """Build semantic hit candidates solely from the persisted render layout."""
    if not isinstance(layout, dict):
        return None
    image = layout.get("img_px")
    if not isinstance(image, dict):
        return None
    try:
        image_width = float(image.get("w"))
        image_height = float(image.get("h"))
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(image_width) and math.isfinite(image_height)) or image_width <= 0 or image_height <= 0:
        return None

    def normalize_box(raw: Any) -> tuple[float, float, float, float] | None:
        if not isinstance(raw, dict):
            return None
        try:
            x0, x1 = sorted((float(raw.get("x0")), float(raw.get("x1"))))
            y0, y1 = sorted((float(raw.get("y0")), float(raw.get("y1"))))
        except (TypeError, ValueError):
            return None
        if not all(math.isfinite(value) for value in (x0, x1, y0, y1)):
            return None
        if x1 - x0 < 14:
            center = (x0 + x1) / 2
            x0, x1 = center - 7, center + 7
        if y1 - y0 < 14:
            center = (y0 + y1) / 2
            y0, y1 = center - 7, center + 7
        return (
            max(0.0, min(image_width, x0)),
            max(0.0, min(image_height, y0)),
            max(0.0, min(image_width, x1)),
            max(0.0, min(image_height, y1)),
        )

    role_labels = {
        "title": "Title", "subtitle": "Subtitle", "x_label": "X-axis label",
        "y_label": "Y-axis label", "x_axis": "X axis", "y_axis": "Y axis",
        "point": "Point", "cell": "Cell",
        "x_tick_labels": "X-axis tick labels", "y_tick_labels": "Y-axis tick labels",
        "colorbar": "Continuous colorbar", "legend": "Legend",
    }
    candidates: list[tuple[dict[str, Any], tuple[float, float, float, float]]] = []
    seen_scene_candidates: set[tuple[str, str, tuple[float, float, float, float]]] = set()
    for element in layout.get("scene_elements") or []:
        if not isinstance(element, dict):
            continue
        box = normalize_box(element.get("bbox_px"))
        if box is None:
            continue
        role = str(element.get("role") or "scene_element")[:80]
        element_id = str(element.get("id") or "")[:_MAX_ELEMENT_ID_LENGTH]
        candidate_key = (role, element_id, tuple(round(value, 4) for value in box))
        # Duplicate source identities/row labels intentionally remain as two
        # non-editable scene nodes for faithful geometry, but identical target
        # choices would pollute the correction dropdown with indistinguishable
        # entries. Collapse only exact same-ID/same-box candidates here.
        if element_id and candidate_key in seen_scene_candidates:
            continue
        if element_id:
            seen_scene_candidates.add(candidate_key)
        label = role_labels.get(role, role.replace("_", " ").title())
        if role == "bar" and element.get("category"):
            label = f"Bar · {element.get('category')}"
            if element.get("series"):
                label += f" · {element.get('series')}"
        elif role == "point" and element.get("row_identity") is not None:
            label = f"Point · {element.get('row_identity')}"
        elif role == "cell":
            row_value = element.get("row") if element.get("row") is not None else element.get("y_value")
            col_value = element.get("column") if element.get("column") is not None else element.get("x_value")
            if row_value is not None or col_value is not None:
                label = f"Cell · {row_value or '?'} · {col_value or '?'}"
        target = {
            "type": role if role in {*role_labels, "bar", "point", "cell"} else "scene_element",
            "label": label[:160],
            "setting_path": str(element.get("setting_path"))[:1024] if isinstance(element.get("setting_path"), str) else None,
            "element_id": element_id or None,
            "role": role,
            "category": str(element.get("category"))[:160] if element.get("category") is not None else None,
            "series": str(element.get("series"))[:160] if element.get("series") is not None else None,
            "row_identity": str(element.get("row_identity"))[:160] if element.get("row_identity") is not None else None,
            "row": str(element.get("row"))[:160] if element.get("row") is not None else None,
            "column": str(element.get("column"))[:160] if element.get("column") is not None else None,
            "x_value": str(element.get("x_value"))[:160] if element.get("x_value") is not None else None,
            "y_value": str(element.get("y_value"))[:160] if element.get("y_value") is not None else None,
            "editable": bool(element.get("editable")),
            "unsupported_reason": str(element.get("unsupported_reason") or "")[:500] or None,
            "bbox_source": str(element.get("bbox_source") or "")[:80] or None,
            # Degenerate "add here" bands (e.g. labs(x = NULL)). They stay
            # selectable as explicit corrections but must never win inference
            # over a really-rendered element (None drops via the filter below).
            "placeholder": True if element.get("placeholder") else None,
        }
        candidates.append(({key: value for key, value in target.items() if value is not None}, box))

    fallback_definitions = {
        "title_px": ("title", "Title", "options.title"),
        "subtitle_px": ("subtitle", "Subtitle", "options.subtitle"),
        "xlab_px": ("x_label", "X-axis label", "options.x_label"),
        "ylab_px": ("y_label", "Y-axis label", "options.y_label"),
        "x_axis_px": ("x_axis", "X axis", "options"),
        "y_axis_px": ("y_axis", "Y axis", "options"),
    }
    for layout_key, (role, label, path) in fallback_definitions.items():
        raw = layout.get(layout_key)
        box = normalize_box(raw)
        if box is not None:
            candidate = {
                "type": role, "label": label, "setting_path": path,
                "role": role, "editable": True, "bbox_source": "layout_gtable_cell",
            }
            # A zero-size gtable cell means the element is not rendered; keep
            # the band selectable but out of automatic hit-testing (same rule
            # as scene-element placeholders, judged on the RAW box because
            # normalize_box inflates degenerate boxes for hit tolerance).
            try:
                if (abs(float(raw.get("x1")) - float(raw.get("x0"))) <= 1
                        or abs(float(raw.get("y1")) - float(raw.get("y0"))) <= 1):
                    candidate["placeholder"] = True
            except (TypeError, ValueError):
                pass
            candidates.append((candidate, box))

    # Layouts rendered before the tick-label scene contract still carry the
    # raw axis strip boxes; synthesize the same editable targets from them so
    # older figure versions gain tick-label edits without a re-render. Skip
    # degenerate strips (an axis without rendered labels) using the RAW box,
    # since normalize_box inflates thin boxes for hit tolerance.
    existing_roles = {target.get("role") for target, _ in candidates}
    for layout_key, role, label, path in (
        ("x_axis_px", "x_tick_labels", "X-axis tick labels", "options.x_text_angle"),
        ("y_axis_px", "y_tick_labels", "Y-axis tick labels", "options.y_tick_format"),
    ):
        if role in existing_roles:
            continue
        raw = layout.get(layout_key)
        if not isinstance(raw, dict):
            continue
        try:
            if (abs(float(raw.get("x1")) - float(raw.get("x0"))) <= 1
                    or abs(float(raw.get("y1")) - float(raw.get("y0"))) <= 1):
                continue
        except (TypeError, ValueError):
            continue
        box = normalize_box(raw)
        if box is not None:
            candidates.append(({
                "type": role, "label": label, "setting_path": path,
                "role": role, "editable": True, "bbox_source": "layout_gtable_cell",
            }, box))
    return image_width, image_height, candidates


def _intersection_area(a: tuple[float, float, float, float],
                       b: tuple[float, float, float, float]) -> float:
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(
        0.0, min(a[3], b[3]) - max(a[1], b[1])
    )


def _mark_pixel_geometry(mark: dict[str, Any], image_width: float, image_height: float) -> tuple[
    tuple[float, float, float, float] | None,
    tuple[float, float] | None,
]:
    mark_box = None
    bbox = mark.get("bbox_normalized")
    if isinstance(bbox, dict):
        try:
            x0 = float(bbox.get("x")) * image_width
            y0 = float(bbox.get("y")) * image_height
            x1 = (float(bbox.get("x")) + float(bbox.get("width"))) * image_width
            y1 = (float(bbox.get("y")) + float(bbox.get("height"))) * image_height
            values = (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
            if all(math.isfinite(value) for value in values):
                mark_box = (
                    max(0.0, min(image_width, values[0])),
                    max(0.0, min(image_height, values[1])),
                    max(0.0, min(image_width, values[2])),
                    max(0.0, min(image_height, values[3])),
                )
        except (TypeError, ValueError):
            pass

    mark_point = None
    point = mark.get("point_normalized")
    if isinstance(point, dict):
        try:
            px = float(point.get("x")) * image_width
            py = float(point.get("y")) * image_height
            if math.isfinite(px) and math.isfinite(py):
                mark_point = (px, py)
        except (TypeError, ValueError):
            pass
    return mark_box, mark_point


def _expanded_text_box(box: tuple[float, float, float, float], image_width: float,
                       image_height: float) -> tuple[float, float, float, float]:
    # Keep hand-drawn regions robust to the small gap around a gtable text
    # cell, while bounding the tolerance even for high-DPI exports.
    x_pad = max(8.0, min(24.0, image_width * 0.012))
    y_pad = max(8.0, min(24.0, image_height * 0.012))
    return (
        max(0.0, box[0] - x_pad),
        max(0.0, box[1] - y_pad),
        min(image_width, box[2] + x_pad),
        min(image_height, box[3] + y_pad),
    )


def _mark_hits_candidate(mark: dict[str, Any], box: tuple[float, float, float, float],
                         image_width: float, image_height: float,
                         *, text_tolerance: bool = False) -> bool:
    mark_box, mark_point = _mark_pixel_geometry(mark, image_width, image_height)
    hit_box = _expanded_text_box(box, image_width, image_height) if text_tolerance else box
    if mark_box is not None and _intersection_area(mark_box, hit_box) > 0:
        return True
    return bool(
        mark_point is not None
        and hit_box[0] <= mark_point[0] <= hit_box[2]
        and hit_box[1] <= mark_point[1] <= hit_box[3]
    )


def _server_resolve_mark_target(mark: dict[str, Any], layout: dict[str, Any] | None) -> dict[str, Any] | None:
    """Re-hit-test a mark against server-persisted semantic geometry.

    Label content is a distinct tier from the larger axis band. Region hits
    rank title/x/y label cells by their intersection ratio before comparing
    raw area with non-text targets, so an axis cannot win merely by being the
    larger rectangle. Client-declared targets never participate.
    """
    resolved = _server_mark_target_candidates(layout)
    if resolved is None:
        return None
    image_width, image_height, candidates = resolved
    if not candidates:
        return None
    mark_box, mark_point = _mark_pixel_geometry(mark, image_width, image_height)

    if mark_box is not None:
        text_hits = []
        for index, (target, box) in enumerate(candidates):
            if target.get("role") not in _TEXT_TIER_ROLES or target.get("placeholder"):
                continue
            expanded = _expanded_text_box(box, image_width, image_height)
            raw_overlap = _intersection_area(mark_box, box)
            tolerant_overlap = _intersection_area(mark_box, expanded)
            if tolerant_overlap <= 0:
                continue
            if raw_overlap <= 0:
                x_overlap = max(0.0, min(mark_box[2], box[2]) - max(mark_box[0], box[0]))
                y_overlap = max(0.0, min(mark_box[3], box[3]) - max(mark_box[1], box[1]))
                x_alignment = x_overlap / max(1.0, min(mark_box[2] - mark_box[0], box[2] - box[0]))
                y_alignment = y_overlap / max(1.0, min(mark_box[3] - mark_box[1], box[3] - box[1]))
                x_gap = max(0.0, box[0] - mark_box[2], mark_box[0] - box[2])
                y_gap = max(0.0, box[1] - mark_box[3], mark_box[1] - box[3])
                x_pad = expanded[2] - box[2]
                y_pad = expanded[3] - box[3]
                # A tolerance-only hit must run alongside a meaningful part
                # of the label, not merely touch one corner of its padded box.
                if not (
                    (x_gap <= x_pad and y_alignment >= 0.25)
                    or (y_gap <= y_pad and x_alignment >= 0.25)
                ):
                    continue
            label_area = max(1.0, (box[2] - box[0]) * (box[3] - box[1]))
            mark_area = max(1.0, (mark_box[2] - mark_box[0]) * (mark_box[3] - mark_box[1]))
            coverage = raw_overlap / label_area
            mark_coverage = raw_overlap / mark_area
            label_center = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
            mark_center = ((mark_box[0] + mark_box[2]) / 2, (mark_box[1] + mark_box[3]) / 2)
            distance = math.hypot(
                (label_center[0] - mark_center[0]) / image_width,
                (label_center[1] - mark_center[1]) / image_height,
            )
            text_hits.append((coverage, mark_coverage, tolerant_overlap, -distance, -index, target))
        if text_hits:
            return max(text_hits, key=lambda item: item[:5])[5]

        scored = []
        for index, (target, box) in enumerate(candidates):
            if target.get("placeholder"):
                continue
            overlap = _intersection_area(mark_box, box)
            if overlap > 0:
                scored.append((overlap, -index, target))
        if scored:
            return max(scored, key=lambda item: (item[0], item[1]))[2]

    if mark_point is not None:
        text_containing = [
            (
                0 if box[0] <= mark_point[0] <= box[2] and box[1] <= mark_point[1] <= box[3] else 1,
                (box[2] - box[0]) * (box[3] - box[1]), index, target,
            )
            for index, (target, box) in enumerate(candidates)
            if target.get("role") in _TEXT_TIER_ROLES
            and not target.get("placeholder")
            and _mark_hits_candidate(mark, box, image_width, image_height, text_tolerance=True)
        ]
        if text_containing:
            return min(text_containing, key=lambda item: (item[0], item[1], item[2]))[3]
        containing = [
            ((box[2] - box[0]) * (box[3] - box[1]), index, target)
            for index, (target, box) in enumerate(candidates)
            if not target.get("placeholder")
            and box[0] <= mark_point[0] <= box[2] and box[1] <= mark_point[1] <= box[3]
        ]
        if containing:
            return min(containing, key=lambda item: (item[0], item[1]))[2]
    return None


def _server_validate_target_override(mark: dict[str, Any], layout: dict[str, Any] | None,
                                     requested: dict[str, Any] | None,
                                     request: str) -> dict[str, Any] | None:
    """Resolve a dropdown correction to a nearby canonical editable target."""
    if not isinstance(requested, dict):
        return None
    requested_role = str(requested.get("role") or requested.get("type") or "").strip()
    requested_element_id = str(requested.get("element_id") or "").strip()
    text_target = requested_role in _EDITABLE_TEXT_TARGET_PATHS
    scene_rule_target = requested_role in _SCENE_ROLE_SETTING_RULES
    if text_target:
        if (
            not _text_target_request_compatible(request)
            or not _text_target_role_matches_request(request, requested_role)
        ):
            return None
        expected_path = _EDITABLE_TEXT_TARGET_PATHS[requested_role]
    elif scene_rule_target:
        # A visual scene target (tick labels / legend / colorbar) is only a
        # valid correction when the memo wording names one of its supported
        # operations; the canonical path comes from the stored candidate.
        if not _scene_role_paths_for_request(requested_role, request):
            return None
        expected_path = None
    elif requested_role in {"bar", "point", "cell"}:
        if (
            not requested_element_id
            or not _element_mark_id_matches_role(requested_element_id, requested_role)
            or not _element_override_fields_from_request(request)
        ):
            return None
        expected_path = f"options.element_overrides.{requested_element_id}"
    else:
        return None
    requested_path = str(requested.get("setting_path") or "").strip()
    if requested_path and expected_path is not None and requested_path != expected_path:
        return None

    resolved = _server_mark_target_candidates(layout)
    if resolved is None:
        return None
    image_width, image_height, candidates = resolved
    matches = []
    for index, (candidate, box) in enumerate(candidates):
        if candidate.get("role") != requested_role:
            continue
        if candidate.get("editable") is not True:
            continue
        candidate_path = str(candidate.get("setting_path") or "")
        if expected_path is not None and candidate_path != expected_path:
            continue
        if expected_path is None:
            if not candidate_path:
                continue
            if requested_path and requested_path != candidate_path:
                continue
        candidate_element_id = str(candidate.get("element_id") or "")
        if requested_element_id and requested_element_id != candidate_element_id:
            continue
        if not _mark_hits_candidate(
            mark, box, image_width, image_height,
            text_tolerance=text_target or requested_role in {"x_tick_labels", "y_tick_labels"},
        ):
            continue
        matches.append((0 if requested_element_id else 1, index, candidate))
    if not matches:
        return None
    # Return only the stored candidate. Client editable/path/labels are never
    # copied into the authority-bearing server target.
    return min(matches, key=lambda item: (item[0], item[1]))[2]


def _structured_edit_request_scopes(marks: list[dict[str, Any]] | None,
                                    prompt: str | None = None,
                                    layout: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Prefer validated structured marks while retaining a plain global
    request scope from the prompt. Stable mark identity comes from client
    ``id``; label/display_number are matching aliases, never replacements."""
    parsed = _extract_edit_request_scopes(prompt)
    global_scope = next((scope for scope in parsed if scope.get("scope_id") == "request"), None)
    if global_scope and str(global_scope.get("request") or "").strip() == _DEFAULT_LOCALIZED_EDIT_PROMPT:
        global_scope = None
    mark_scopes: list[dict[str, Any]] = []
    global_consumed_by_mark = False
    seen_ids: set[str] = set()
    for index, mark in enumerate((marks or [])[:20], start=1):
        if not isinstance(mark, dict):
            continue
        stable_id = str(mark.get("id") or "").strip()[:100]
        memo = str(mark.get("memo") or "").strip()[:1000]
        if not stable_id or stable_id in seen_ids:
            continue
        seen_ids.add(stable_id)
        label = str(mark.get("label") or "").strip()[:100] or f"Mark {index}"
        try:
            display_number = int(mark.get("display_number")) if mark.get("display_number") is not None else None
        except (TypeError, ValueError):
            display_number = None
        if not memo and global_scope:
            memo = str(global_scope.get("request") or "")[:1000]
            global_consumed_by_mark = True
        elif global_scope and memo == str(global_scope.get("request") or "").strip():
            global_consumed_by_mark = True
        target = mark.get("resolved_target") if isinstance(mark.get("resolved_target"), dict) else None
        requested_override = mark.get("target_override") if isinstance(mark.get("target_override"), dict) else None
        inferred_server_target = _server_resolve_mark_target(mark, layout)
        accepted_override = _server_validate_target_override(mark, layout, requested_override, memo)
        # Once a user explicitly corrects the target, never silently fall back
        # to a different inferred target if that correction is stale/forged.
        server_target = accepted_override if requested_override is not None else inferred_server_target
        override_rejection = None
        if requested_override is not None and accepted_override is None:
            override_rejection = (
                "The selected target correction could not be matched to a nearby editable semantic "
                "element in this figure version. Refresh the plan and choose a valid target."
            )
        mark_scopes.append({
            "scope_id": f"mark:{stable_id}",
            "mark_id": stable_id,
            "mark_label": label,
            "display_number": display_number,
            "mark_type": str(mark.get("type") or "").lower()[:20] or None,
            "request": memo,
            "bbox_normalized": mark.get("bbox_normalized"),
            "point_normalized": mark.get("point_normalized"),
            "declared_target": target,
            "requested_target_override": requested_override,
            "accepted_target_override": accepted_override,
            "target_override_rejection_reason": override_rejection,
            "inferred_server_target": inferred_server_target,
            "server_resolved_target": server_target,
        })
    if not mark_scopes:
        return parsed
    scopes = ([] if global_consumed_by_mark or not global_scope else [global_scope]) + mark_scopes
    return scopes


def _scope_authorization_text(scope: dict[str, Any], scopes: list[dict[str, Any]]) -> str:
    global_request = next(
        (str(item.get("request") or "") for item in scopes if item.get("scope_id") == "request"),
        "",
    )
    local_request = str(scope.get("request") or "")
    if scope.get("scope_id") == "request" or not global_request:
        return local_request
    return f"{global_request}\n{local_request}".strip()


def _text_target_request_compatible(request: str) -> bool:
    """True only for text-content operations, not visual text styling."""
    text = (request or "").lower()
    if re.search(r"\b(?:remove|clear|delete)\b|제거|삭제|없애|지워", text):
        return True
    if re.search(r"\brename\b|이름\s*바꾸|이름\s*변경", text):
        return True
    textual_subject = bool(re.search(
        r"\b(?:title|subtitle|label|text|word|phrase|caption)\b|제목|부제|라벨|텍스트|문구|글자|이름",
        text,
    ))
    change_action = bool(re.search(r"\b(?:change|replace|set)\b|바꾸|변경|교체|수정|(?:으)?로\b", text))
    visual_only = bool(re.search(
        r"\b(?:bold|italic|font|size|colou?r|blue|red|green|purple|gray|grey)\b|"
        r"굵게|기울|폰트|글꼴|크기|파랗|파란|빨갛|빨간|보라|초록|회색|색상?",
        text,
    ))
    return textual_subject and change_action and not visual_only


def _text_target_role_matches_request(request: str, role: str) -> bool:
    """Prevent a geometry hit from widening an explicitly named text target.

    Deictic requests ("this text") intentionally rely on geometry. Once the
    user says title, x-label, y-label, or subtitle, however, only that semantic
    role may gain authorization from a hit or target correction.
    """
    text = (request or "").lower()
    roles: set[str] = set()
    x_subject = bool(re.search(
        r"\bx\s*(?:[- ]?axis\s*)?(?:label|title)\b|x\s*[- ]?axis\b|x축",
        text,
    ))
    y_subject = bool(re.search(
        r"\by\s*(?:[- ]?axis\s*)?(?:label|title)\b|y\s*[- ]?axis\b|y축",
        text,
    ))
    if x_subject:
        roles.add("x_label")
    if y_subject:
        roles.add("y_label")
    if re.search(r"\bsubtitle\b|부제", text):
        roles.add("subtitle")
    legend_subject = bool(re.search(r"\blegend\b|범례", text))
    if not (x_subject or y_subject or legend_subject or "subtitle" in roles) and re.search(
        r"\btitle\b|제목", text,
    ):
        roles.add("title")
    return not roles or role in roles


def _request_allowed_patch_paths(plot_type: str, request: str, pdef: dict) -> set[str]:
    """Conservative deterministic natural-language -> patch-path whitelist.

    This is an authorization boundary, not an AI interpretation layer. False
    negatives become an explicit unsupported result; false positives would let
    the model make an unrequested edit, so every rule requires direct wording.
    """
    text = (request or "").lower()
    allowed_options = {item["key"] for item in pdef.get("options", [])} | _UNIVERSAL_OPTION_KEYS
    allowed_mapping = {item["key"] for item in pdef.get("required", []) + pdef.get("optional", [])}
    paths: set[str] = set()

    # Explicit dotted paths in a professionalized/expert request are the most
    # precise possible authorization signal.
    for key in re.findall(r"\boptions\.([a-z][a-z0-9_]*)\b", text):
        # Individual element maps are authorized only from a server-resolved
        # scene target below, never from user/provider-supplied dotted text.
        if key in allowed_options and key != "element_overrides":
            paths.add(f"options.{key}")
    for key in re.findall(r"\bmapping\.([a-z][a-z0-9_]*)\b", text):
        if key in allowed_mapping:
            paths.add(f"mapping.{key}")

    def add(key: str) -> None:
        if key in allowed_options:
            paths.add(f"options.{key}")

    if re.search(r"\b(?:theme|style\s*preset|preset)\b|테마|스타일\s*프리셋", text):
        paths.add("style_preset")

    subtitle = bool(re.search(r"\bsubtitle\b|부제", text))
    x_axis = bool(re.search(r"\bx\s*[- ]?axis\b|x축", text))
    y_axis = bool(re.search(r"\by\s*[- ]?axis\b|y축", text))
    # A continuous colour scale's "colorbar" IS the legend; users asking to
    # move/hide it rarely use the word "legend". Every rule inside the legend
    # block still requires its own operation wording, so these synonyms alone
    # never authorize a change. Spaced Korean forms require a particle/space
    # boundary after "바" so "컬러 바꿔"/"색상 바꿔" (change the color) never
    # count as a colorbar mention.
    legend = bool(re.search(
        r"\blegend\b|범례|colou?r\s*-?\s*bar|colou?rbar"
        r"|컬러바|색상바|색막대"
        r"|(?:컬러|색상)\s+바(?=$|[\s를은는이가도만의에])",
        text,
    ))
    title_or_label = bool(re.search(r"\b(?:title|label|rename)\b|제목|라벨|이름", text))
    if subtitle:
        add("subtitle")
    if title_or_label and _text_target_request_compatible(text):
        if legend:
            add("legend_title")
        elif x_axis and not y_axis:
            add("x_label")
        elif y_axis and not x_axis:
            add("y_label")
        elif x_axis and y_axis:
            add("x_label")
            add("y_label")
        elif not subtitle:
            add("title")

    if legend:
        if re.search(r"\b(?:move|position|place|top|bottom|left|right)\b|위치|위로|아래|왼쪽|오른쪽|이동|옮기|옮겨", text):
            add("legend_position")
            # Moving a guide between a side and the top/bottom usually implies
            # flipping its orientation as well (vertical colorbar on the right,
            # horizontal at the bottom), so authorize direction together.
            add("legend_direction")
        if re.search(r"\b(?:vertical|horizontal|direction)\b|세로|가로|수직|수평|방향", text):
            add("legend_direction")
        if not title_or_label and re.search(r"\b(?:hide|remove|without)\b|숨기|제거|없애", text):
            add("hide_legend")
        if re.search(r"\b(?:columns?|ncol)\b|열\s*수", text):
            add("legend_ncol")
        if re.search(r"\b(?:key\s*size|bigger\s+keys?)\b|키\s*크기", text):
            add("legend_key_size")

    if re.search(r"\b(?:dashed|dotted|solid|line\s*type)\b|점선|실선|선\s*종류", text):
        add("line_type")
    if re.search(r"\b(?:square|circle|triangle|diamond|point\s*shape|marker\s*shape)\b|네모|사각|원형|삼각|마커\s*모양|점\s*모양", text):
        add("point_shape")
    if re.search(r"\b(?:line|stroke)\b|선|라인", text) and re.search(r"#[0-9a-f]{6}|\b(?:blue|red|black|gray|grey|green|colou?r)\b|파란|빨간|검정|회색|초록|색", text):
        add("line_color")

    if x_axis and re.search(r"\b(?:range|limits?|min(?:imum)?|max(?:imum)?)\b|범위|구간|최소|최대", text):
        if re.search(r"\b(?:range|limits?)\b|범위|구간", text):
            add("x_min")
            add("x_max")
        if re.search(r"\bmin(?:imum)?\b|최소", text):
            add("x_min")
        if re.search(r"\bmax(?:imum)?\b|최대", text):
            add("x_max")
    if y_axis and re.search(r"\b(?:range|limits?|min(?:imum)?|max(?:imum)?)\b|범위|구간|최소|최대", text):
        if re.search(r"\b(?:range|limits?)\b|범위|구간", text):
            add("y_min")
            add("y_max")
        if re.search(r"\bmin(?:imum)?\b|최소", text):
            add("y_min")
        if re.search(r"\bmax(?:imum)?\b|최대", text):
            add("y_max")
    if re.search(r"\blog\s*(?:scale|x|y)?\b|로그", text):
        if x_axis:
            add("log_x")
        elif y_axis:
            add("log_y")
    if x_axis and re.search(r"\b(?:rotate|angle|overlap)\b|회전|각도|겹", text):
        add("x_text_angle")
    elif (
        not y_axis
        and re.search(r"\b(?:rotate|rotation|angle|angled|diagonal|slant|tilt)\b|회전|각도|기울", text)
        and re.search(r"\b(?:labels?|ticks?|text)\b|글자|라벨|눈금|텍스트", text)
    ):
        # "Rotate the (overlapping) labels 45deg" without naming an axis: the
        # only rotatable text the renderer supports is the x tick labels.
        add("x_text_angle")
    if x_axis and re.search(r"\b(?:tick|break|format|percent|comma|scientific|date)\b|눈금|퍼센트|날짜", text):
        for key in ("x_breaks", "x_tick_format", "x_axis_type", "date_format"):
            add(key)
    if y_axis and re.search(r"\b(?:tick|break|format|percent|comma|scientific)\b|눈금|퍼센트", text):
        for key in ("y_breaks", "y_tick_format"):
            add(key)

    if re.search(r"\b(?:error\s*bars?|uncertainty)\b|오차\s*막대", text):
        add("error_bars")
        if re.search(r"\b(?:sd|se|sem|ci95|confidence\s*interval)\b|표준\s*편차|표준\s*오차|신뢰\s*구간", text):
            add("error_type")

    if re.search(r"\b(?:palette|colou?r\s*scheme|colorblind|grayscale|greyscale)\b|팔레트|색상표|색맹|회색조", text):
        add("palette_name")
        if re.search(r"\b(?:grayscale|greyscale)\b|회색조", text):
            add("color_mode")

    if re.search(r"\bfont\s*(?:size|larger|smaller)|text\s*(?:size|larger|smaller)\b|글꼴\s*크기|글자\s*크기|폰트\s*크기", text):
        add("base_size")
        add("font_scale")
    if re.search(r"\bfont\s*family\b|글꼴\s*종류|폰트\s*종류", text):
        add("font_family")
    if re.search(r"\b(?:line\s*width|stroke\s*width|thicker|thinner)\b|선\s*두께|굵게|얇게", text):
        add("linewidth_scale")

    export_size = bool(re.search(r"\b(?:export|figure|canvas|image|plot)\s*(?:size|width|height)|\b(?:dpi|resolution)\b|내보내기|그림\s*크기|해상도|너비|높이", text))
    if export_size:
        if re.search(r"\b(?:size|single.column|double.column|wide|square)\b|크기", text):
            add("size")
        if re.search(r"\bwidth\b|너비|폭", text):
            add("width_in")
        if re.search(r"\bheight\b|높이", text):
            add("height_in")
        if re.search(r"\b(?:dpi|resolution)\b|해상도", text):
            add("dpi")

    option_rules = {
        "fill_alpha": r"\b(?:fill\s*)?(?:alpha|transparen(?:cy|t))\b|채움\s*투명|투명도",
        "point_alpha": r"\bpoint\s*(?:alpha|transparen(?:cy|t))\b|점\s*투명",
        "flip_coords": r"\b(?:flip|horizontal\s+bars?)\b|가로\s*막대|축\s*뒤집",
        "hline_at": r"\b(?:horizontal\s+reference\s+line|hline)\b|수평\s*기준선",
        "vline_at": r"\b(?:vertical\s+reference\s+line|vline)\b|수직\s*기준선",
        "facet_by": r"\b(?:facet|small\s+multiples?|panel\s+by)\b|패싯|패널\s*분할",
        "facet_scales": r"\bfacet\s*scales?\b|패싯\s*축",
        "level_order": r"\b(?:reorder|category\s+order|level\s+order)\b|범주\s*순서|정렬",
        "bar_width": r"\bbar\s*width\b|막대\s*너비|막대\s*폭",
        "bar_alpha": r"\bbar\s*(?:alpha|transparen(?:cy|t))\b|막대\s*투명",
        "bins": r"\b(?:histogram\s+)?bins?\b|히스토그램\s*구간",
        "connect_points": r"\bconnect\s+(?:the\s+)?points?\b|점\s*연결",
        "sort_desc": r"\b(?:sort\s+descending|descending\s+order)\b|내림차순",
        "stack_mode": r"\b(?:stack(?:ed)?|fill)\s+bars?\b|누적\s*막대",
        "show_data_labels": r"\b(?:show|add)\s+(?:data\s+)?labels?\b|데이터\s*라벨|값\s*표시",
        "show_values": r"\bshow\s+values?\b|값\s*표시",
        "data_label_format": r"\bdata\s+label\s+format\b|라벨\s*형식",
        "add_smooth": r"\b(?:trend|regression|smooth)\s*line\b|추세선|회귀선",
        "fit_model": r"\b(?:fit|regression)\s*model\b|회귀\s*모형",
        "show_fit_stats": r"\b(?:fit|regression)\s*stats?\b|적합\s*통계",
        "reverse_x": r"\breverse\s+x(?:\s*axis)?\b|x축\s*역순",
        "reverse_y": r"\breverse\s+y(?:\s*axis)?\b|y축\s*역순",
        "y2_column": r"\b(?:second|secondary)\s+y(?:\s*axis|\s*series)?\b|보조\s*y축",
        "y2_label": r"\b(?:second|secondary)\s+y\s*label\b|보조\s*y축\s*라벨",
        "transparent_background": r"\btransparent\s+background\b|투명\s*배경",
    }
    for key, pattern in option_rules.items():
        if re.search(pattern, text):
            add(key)
    return paths


def _category_value_relabel_unsupported_reason(scope: dict[str, Any]) -> str | None:
    """Recognize actual category-value replacement without catching axis UX.

    A marked bar/category provides authoritative semantic context. Without
    that target (for example a global request), the wording itself must say
    value/level/relabel/rename or use an explicit old-to-new replacement.
    """
    text = str(scope.get("request") or "").strip().lower()
    if not text:
        return None
    target = scope.get("server_resolved_target")
    authoritative_category_target = bool(
        isinstance(target, dict)
        and (
            str(target.get("role") or "").lower() in {
                "bar", "category", "category_value", "category_label", "category_tick",
            }
            or target.get("category") is not None
        )
    )
    category_subject = bool(re.search(r"\b(?:category|categorical)\b|카테고리|범주", text))
    marked_replacement_shorthand = bool(authoritative_category_target and re.search(r"(?:->|→)", text))
    if not category_subject and not marked_replacement_shorthand:
        return None
    # Category ordering and axis-title/axis-label edits are separate supported
    # concepts even when their prose contains the word "category".
    if re.search(
        r"\b(?:category|level)\s+order\b|\b(?:reorder|sort)\b|범주\s*순서|카테고리\s*순서|정렬",
        text,
    ):
        return None
    if re.search(r"\b[xy]\s*[- ]?axis\b|[xy]축", text):
        return None
    if re.search(
        r"colou?r|palette|fill|font|rotation|rotate|spacing|position|색|파랑|파란|빨강|빨간|"
        r"보라|초록|검정|회색|글꼴|폰트|회전|간격|위치|#[0-9a-f]{6}",
        text,
        re.IGNORECASE,
    ):
        return None

    explicit_value_or_relabel = bool(re.search(
        r"\b(?:rename|relabel|recode)\b|"
        r"\b(?:category|categorical)\s+(?:value|name|level)\b|"
        r"(?:카테고리|범주)\s*(?:값|명|이름|레벨)|(?:이름|명칭)\s*(?:변경|바꾸)|"
        r"(?:->|→)|\bcategory\b.{0,80}\bto\b|(?:카테고리|범주).{0,80}(?:으)?로\s*(?:변경|바꾸)",
        text,
        re.IGNORECASE,
    ))
    change_action = bool(re.search(
        r"\b(?:rename|relabel|recode|replace|change)\b|변경|바꾸|교체|(?:->|→)",
        text,
    ))
    if not (change_action and (authoritative_category_target or explicit_value_or_relabel)):
        return None
    return (
        "Category value relabeling is not currently supported. Rename or recode the source dataset value, "
        "or create and map a separate display-label column."
    )


def _element_override_leaf_path(element_id: str, field: str) -> str:
    return f"options.element_overrides.{element_id}.{field}"


def _element_mark_id_matches_role(element_id: str, role: str) -> bool:
    if role == "bar":
        return _GROUPED_BAR_MARK_ID_RE.fullmatch(element_id) is not None
    if role == "point":
        return _SCATTER_MARK_ID_RE.fullmatch(element_id) is not None
    if role == "cell":
        return (
            _HEATMAP_MARK_ID_RE.fullmatch(element_id) is not None
            or _CORRELATION_HEATMAP_MARK_ID_RE.fullmatch(element_id) is not None
        )
    return False


def _supported_element_override_target(target: Any) -> tuple[str, str] | None:
    """Return the exact renderer-issued ID/root for an editable mark."""
    if not isinstance(target, dict) or target.get("editable") is not True:
        return None
    role = str(target.get("role") or "")
    element_id = str(target.get("element_id") or "").strip()
    if (
        not element_id
        or len(element_id) > _MAX_ELEMENT_ID_LENGTH
        or not _element_mark_id_matches_role(element_id, role)
    ):
        return None
    expected_path = f"options.element_overrides.{element_id}"
    if str(target.get("setting_path") or "").strip() != expected_path:
        return None
    return element_id, expected_path


def _element_override_fields_from_request(request: str) -> dict[str, str]:
    """Extract the tiny visual surface authorized by a marked element memo.

    A whole-series/category request is deliberately excluded: those follow
    the existing named categorical style flow and must not be narrowed to the
    one bar under the cursor.  For an ordinary "make this bar blue" request,
    fill is the only reasonable default; stroke requires explicit border/
    outline wording.
    """
    text = (request or "").strip()
    if not text:
        return {}
    if re.search(r"\b(?:all|whole|entire)\b|전체", text, re.IGNORECASE) and re.search(
        r"\b(?:series|category|group)\b|계열|범주|카테고리|그룹", text, re.IGNORECASE,
    ):
        return {}
    color = _color_from_request_text(text.lower())
    if color is None:
        return {}
    stroke_requested = bool(re.search(
        r"\b(?:stroke|outline|border)\b|테두리|윤곽", text, re.IGNORECASE,
    ))
    fill_requested = bool(re.search(r"\bfill\b|채움", text, re.IGNORECASE))
    fields: dict[str, str] = {}
    if fill_requested or not stroke_requested:
        fields["fill"] = color
    if stroke_requested:
        fields["stroke"] = color
    return fields


def _explicit_element_override_patch_from_scope(
    scope: dict[str, Any], request: str | None = None,
) -> dict[str, Any]:
    target = scope.get("server_resolved_target")
    supported = _supported_element_override_target(target)
    fields = _element_override_fields_from_request(request or str(scope.get("request") or ""))
    if supported is None or not fields:
        return {}
    element_id, _path = supported
    return {"options": {"element_overrides": {element_id: fields}}}


def _specific_element_unsupported_reason(scope: dict[str, Any], resolved_target: str | None = None) -> str | None:
    category_reason = _category_value_relabel_unsupported_reason(scope)
    if category_reason:
        return category_reason
    target = scope.get("server_resolved_target")
    if (
        _supported_element_override_target(target) is not None
        and _element_override_fields_from_request(str(scope.get("request") or ""))
    ):
        return None
    if not scope.get("mark_id"):
        return None
    text = f"{scope.get('request') or ''} {resolved_target or ''}".lower()
    element_pattern = r"\b(?:bar|point|cell|data\s*element|data\s*point|category)\b|막대|데이터\s*점|개별\s*점|셀|카테고리|범주"
    element = re.search(element_pattern, text)
    deictic = re.search(
        r"\b(?:this|that|selected|marked|specific|single|only\s+this|one)\b|"
        r"(?:이|그|해당|선택한|표시한)\s*(?:막대|점|셀|카테고리|범주)|하나만",
        text,
    )
    limited_element = re.search(
        r"(?:\b(?:bar|point|cell|category)\b|막대|점|셀|카테고리|범주)\s*(?:하나\s*)?만",
        text,
    )
    # A category × series/time combination addresses one rendered subgroup,
    # not a category-wide style supported by category_colors.
    category_series_combination = bool(
        element
        and re.search(r"(?:\b\d+(?:\.\d+)?\s*(?:h|hr|hours?)\b|\d+\s*시간|time|series|계열)", text)
        and re.search(r"(?:\b(?:bar|point)\b|막대|점)", text)
    )
    if element and (deictic or limited_element or category_series_combination):
        return (
            "LabPlot cannot target an individual bar, point, cell, category instance, or other rendered data element. "
            "Name a categorical level for a category-wide color change, or use the manual figure editor."
        )
    return None


def _supported_series_wide_recolor(scope: dict[str, Any], target: dict[str, Any], request: str) -> bool:
    """Recognize the one grouped-bar mark recolor the renderer can express."""
    if target.get("role") != "bar" or not target.get("series"):
        return False
    text = (request or "").strip()
    if not re.search(r"\b(?:all|whole|entire)\b|전체", text, re.IGNORECASE):
        return False
    if not re.search(r"\bseries\b|계열", text, re.IGNORECASE):
        return False
    if not re.search(
        r"colou?r|색|파랑|파란|빨강|빨간|보라|초록|검정|회색|#[0-9a-f]{6}",
        text,
        re.IGNORECASE,
    ):
        return False
    series = str(target["series"])
    compact_series = re.sub(r"\s+", "", series).lower()
    compact_text = re.sub(r"\s+", "", text).lower()
    names_series = _request_names_category_label(series, text) or compact_series in compact_text
    if not names_series:
        return False
    category = str(target.get("category") or "")
    if category and _request_names_category_label(category, text):
        return False
    return True


def _resolve_suggestion_scope(suggestion: dict[str, Any], scopes: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not scopes:
        return None
    provider_id = str(suggestion.get("mark_id") or "").strip()
    provider_number = _normalize_edit_mark_id(provider_id)
    if provider_id:
        for scope in scopes:
            aliases = {
                str(scope.get("scope_id") or "").strip().lower(),
                str(scope.get("mark_id") or "").strip().lower(),
                str(scope.get("mark_label") or "").strip().lower(),
                str(scope.get("display_number") or "").strip().lower(),
            }
            if provider_id.lower() in aliases:
                return scope
            if provider_number and provider_number == _normalize_edit_mark_id(scope.get("display_number")):
                return scope
        # An explicit but unknown identity must never fall through to a
        # different mark or to the general request scope.
        return None
    marks = [scope for scope in scopes if scope.get("mark_id")]
    if marks:
        # Provider output for a marked request must carry a submitted stable
        # id or one of its aliases, even when there is only one mark.
        return None
    return next((scope for scope in scopes if scope.get("scope_id") == "request"), None)


def _request_names_category_label(label: str, request: str) -> bool:
    clean_label = label.strip()
    if not clean_label:
        return False
    escaped = re.escape(clean_label)
    if re.fullmatch(r"\d+(?:\.\d+)?\s*(?:h|hr|hours?)", clean_label, re.IGNORECASE):
        return re.sub(r"\s+", "", clean_label).lower() in re.sub(r"\s+", "", request).lower()
    # Single-character levels are especially prone to substring/article
    # collisions (for example category "A" in "make a color chart"). Require
    # explicit category syntax or a Korean object/topic particle.
    if len(clean_label) == 1:
        return bool(re.search(
            rf"(?:['\"]{escaped}['\"]|\b(?:category|series|group)\s+{escaped}\b|"
            rf"(?<![\w]){escaped}\s*(?:범주|카테고리|계열|그룹|은|는|이|가|을|를|만))",
            request,
            re.IGNORECASE,
        ))
    return bool(re.search(
        rf"(?<![\w]){escaped}(?=$|\s|[^\w]|은|는|이|가|을|를|의|만|로)",
        request,
        re.IGNORECASE,
    ))


def _filter_patch_to_request_scope(patch: dict[str, Any], allowed_paths: set[str], request: str) -> dict[str, Any]:
    filtered: dict[str, Any] = {}
    if patch.get("style_preset") and "style_preset" in allowed_paths:
        filtered["style_preset"] = patch["style_preset"]
    mapping = {
        key: value for key, value in (patch.get("mapping") or {}).items()
        if f"mapping.{key}" in allowed_paths
    }
    if mapping:
        filtered["mapping"] = mapping
    options: dict[str, Any] = {}
    for key, value in (patch.get("options") or {}).items():
        path = f"options.{key}"
        # Named categorical-level recoloring is safe only when every retained
        # label is literally present in the user's request. A marked/selected
        # bar with no named level cannot smuggle in arbitrary category keys.
        if key == "category_colors" and isinstance(value, dict) and re.search(
            r"colou?r|색|파랑|파란|빨강|빨간|보라|초록|검정|회색",
            request,
            re.IGNORECASE,
        ):
            named = {
                label: color for label, color in value.items()
                if isinstance(label, str) and _request_names_category_label(label, request)
            }
            if named:
                options[key] = named
            continue
        if key == "series_styles" and isinstance(value, dict):
            named_styles: dict[str, dict[str, Any]] = {}
            for series, style in value.items():
                if not isinstance(series, str) or not isinstance(style, dict):
                    continue
                if not _request_names_category_label(series, request):
                    continue
                retained: dict[str, Any] = {}
                if "color" in style and re.search(
                    r"colou?r|색|파랑|파란|빨강|빨간|보라|초록|검정|회색|#[0-9a-f]{6}",
                    request,
                    re.IGNORECASE,
                ):
                    retained["color"] = style["color"]
                if "linetype" in style and re.search(r"line\s*type|dashed|dotted|solid|선\s*종류|점선|실선", request, re.IGNORECASE):
                    retained["linetype"] = style["linetype"]
                if "shape" in style and re.search(r"shape|marker|point|모양|마커|점", request, re.IGNORECASE):
                    retained["shape"] = style["shape"]
                if retained:
                    named_styles[series] = retained
            if named_styles:
                options[key] = named_styles
            continue
        if key == "element_overrides" and isinstance(value, dict):
            kept_overrides: dict[str, dict[str, str]] = {}
            for element_id, style in value.items():
                if not isinstance(element_id, str) or not isinstance(style, dict):
                    continue
                kept_style = {
                    field: color
                    for field, color in style.items()
                    if field in {"fill", "stroke"}
                    and _element_override_leaf_path(element_id, field) in allowed_paths
                }
                if kept_style:
                    kept_overrides[element_id] = kept_style
            if kept_overrides:
                options[key] = kept_overrides
            continue
        if path in allowed_paths:
            options[key] = value
    if options:
        filtered["options"] = options
    return filtered


def _merge_param_patch(dst: dict[str, Any], src: dict[str, Any]) -> dict[str, Any]:
    merged = {
        "mapping": dict(dst.get("mapping") or {}),
        "options": dict(dst.get("options") or {}),
    }
    if dst.get("style_preset"):
        merged["style_preset"] = dst["style_preset"]
    if src.get("style_preset"):
        merged["style_preset"] = src["style_preset"]
    merged["mapping"].update(src.get("mapping") or {})
    merged["options"] = _merge_apply_options(merged["options"], src.get("options") or {})
    if not merged["mapping"]:
        merged.pop("mapping")
    if not merged["options"]:
        merged.pop("options")
    return merged


def _merge_apply_options(base_options: dict[str, Any], patch_options: dict[str, Any]) -> dict[str, Any]:
    """Merge partial nested style maps without deleting untouched siblings."""
    merged = dict(base_options or {})
    for key, value in (patch_options or {}).items():
        if key == "category_colors" and isinstance(value, dict):
            merged[key] = {**(merged.get(key) if isinstance(merged.get(key), dict) else {}), **value}
            continue
        if key == "series_styles" and isinstance(value, dict):
            styles = {
                series: dict(style) if isinstance(style, dict) else style
                for series, style in (merged.get(key) if isinstance(merged.get(key), dict) else {}).items()
            }
            for series, style in value.items():
                if isinstance(style, dict):
                    styles[series] = {
                        **(styles.get(series) if isinstance(styles.get(series), dict) else {}),
                        **style,
                    }
            merged[key] = styles
            continue
        if key == "element_overrides" and isinstance(value, dict):
            overrides = {
                element_id: dict(style) if isinstance(style, dict) else style
                for element_id, style in (
                    merged.get(key) if isinstance(merged.get(key), dict) else {}
                ).items()
            }
            for element_id, style in value.items():
                if isinstance(style, dict):
                    overrides[element_id] = {
                        **(
                            overrides.get(element_id)
                            if isinstance(overrides.get(element_id), dict)
                            else {}
                        ),
                        **style,
                    }
            merged[key] = overrides
            continue
        merged[key] = value
    return merged


def _edit_scope_payload(scope: dict[str, Any], *, status: str,
                        allowed_patch_keys: list[str] | None = None,
                        approved_patch: dict[str, Any] | None = None,
                        resolved_target: str | None = None,
                        reason: str | None = None,
                        confidence: Any = None) -> dict[str, Any]:
    payload = {
        "scope_id": scope.get("scope_id"),
        "mark_id": scope.get("mark_id"),
        "mark_label": scope.get("mark_label"),
        "display_number": scope.get("display_number"),
        "mark_type": scope.get("mark_type"),
        "request": str(scope.get("request") or "")[:1000],
        "status": status,
        "allowed_patch_keys": sorted(set(allowed_patch_keys or [])),
    }
    if approved_patch:
        payload["approved_patch"] = json.loads(json.dumps(approved_patch))
    if scope.get("original_request"):
        payload["original_request"] = str(scope["original_request"])[:20000]
        payload["original_request_source"] = str(
            scope.get("original_request_source") or "server"
        )[:40]
    if isinstance(scope.get("server_resolved_target"), dict):
        payload["resolved_target"] = scope["server_resolved_target"]
    if isinstance(scope.get("declared_target"), dict):
        payload["client_resolved_target"] = scope["declared_target"]
    if isinstance(scope.get("requested_target_override"), dict):
        payload["requested_target_override"] = json.loads(json.dumps(scope["requested_target_override"]))
    if isinstance(scope.get("accepted_target_override"), dict):
        payload["accepted_target_override"] = json.loads(json.dumps(scope["accepted_target_override"]))
    if scope.get("target_override_rejection_reason"):
        payload["target_override_status"] = "rejected"
        payload["target_override_rejection_reason"] = str(
            scope["target_override_rejection_reason"]
        )[:500]
    elif isinstance(scope.get("accepted_target_override"), dict):
        payload["target_override_status"] = "accepted"
    if isinstance(scope.get("inferred_server_target"), dict):
        payload["inferred_server_target"] = json.loads(json.dumps(scope["inferred_server_target"]))
    if resolved_target:
        payload["resolved_target"] = str(resolved_target).strip()[:200]
        if isinstance(scope.get("server_resolved_target"), dict):
            payload["resolved_target"] = scope["server_resolved_target"]
            payload["provider_resolved_target"] = str(resolved_target).strip()[:200]
    if reason:
        payload["reason"] = reason[:500]
    if not isinstance(confidence, bool):
        try:
            normalized_confidence = float(confidence)
        except (TypeError, ValueError):
            normalized_confidence = None
        if normalized_confidence is not None and 0 <= normalized_confidence <= 1:
            payload["confidence"] = normalized_confidence
    return payload


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
    if y_range:
        y1 = float(y_range.group(1))
        y2 = float(y_range.group(2))
        if y1 != y2:
            options["y_min"] = min(y1, y2)
            options["y_max"] = max(y1, y2)

    # Explicit tick-label rotation ("45도로 회전", "rotate 60 degrees"): the
    # angle number plus rotation wording is fully deterministic, so a provider
    # outage/incomplete plan must never block it. The x axis holds the only
    # rotatable tick labels the renderer supports.
    angle_match = re.search(r"(\d{1,2})\s*(?:°|도|deg(?:ree)?s?\b)", lowered)
    if angle_match and re.search(r"rotate|rotation|tilt(?:ed)?|slant(?:ed)?|angle|회전|기울|각도", lowered):
        options["x_text_angle"] = max(0, min(90, int(angle_match.group(1))))

    # Legend/colorbar relocation ("colorbar를 오른쪽으로 이동", "move the
    # legend to the bottom"): a guide mention plus a side plus a move verb is
    # exact. Direction follows the side the way ggplot lays guides out.
    legend_mention = re.search(
        r"\blegend\b|범례|colou?r\s*-?\s*bar|colou?rbar"
        r"|컬러바|색상바|색막대|(?:컬러|색상)\s+바(?=$|[\s를은는이가도만의에])",
        lowered,
    )
    if legend_mention and re.search(r"move|position|relocate|place|put|이동|옮기|옮겨|위치|배치|놓아|놔\s", lowered):
        side = None
        if re.search(r"\bright\b|오른쪽", lowered):
            side = "right"
        elif re.search(r"\bleft\b|왼쪽", lowered):
            side = "left"
        elif re.search(r"\bbottom\b|아래", lowered):
            side = "bottom"
        elif re.search(r"\btop\b|위(?:로|쪽)", lowered):
            side = "top"
        if side:
            options["legend_position"] = side
            options["legend_direction"] = "horizontal" if side in ("top", "bottom") else "vertical"

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
    merged_options = _merge_apply_options(base_options, patch.get("options") or {})
    return merged_options != base_options


def _color_from_request_text(text: str) -> str | None:
    explicit_hex = re.search(r"#[0-9A-Fa-f]{6}", text)
    if explicit_hex:
        return explicit_hex.group(0).upper()
    for word, color in _COLOR_WORDS.items():
        # ASCII color words require token boundaries: without them, "red"
        # inside "border" incorrectly wins before a later explicit "blue".
        if (word.isascii() and re.search(rf"\b{re.escape(word)}\b", text)) or (
            not word.isascii() and word in text
        ):
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
    if key == "legend_direction":
        return f'legend.direction = "{expected}"' in r_code, f"Looked for legend.direction = {expected!r}."
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
    if key.startswith("element_overrides."):
        # key = element_overrides.<stable id>.<fill|stroke>. Stable ids may
        # themselves contain dots, so split only at the final field segment.
        prefix, _, field = key.rpartition(".")
        element_id = prefix.removeprefix("element_overrides.")
        matched = rq(element_id) in r_code and text.upper() in r_code.upper()
        return matched, f"Looked for {field} {text!r} on semantic element {element_id!r}."
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
            if key == "element_overrides" and isinstance(expected, dict):
                actual_overrides = (
                    (version.options or {}).get(key)
                    if isinstance((version.options or {}).get(key), dict)
                    else {}
                )
                for element_id, style in expected.items():
                    if not isinstance(style, dict):
                        continue
                    actual_style = (
                        actual_overrides.get(element_id)
                        if isinstance(actual_overrides.get(element_id), dict)
                        else {}
                    )
                    for field, value in style.items():
                        items.append((
                            "options",
                            f"element_overrides.{element_id}.{field}",
                            value,
                            actual_style.get(field),
                        ))
                continue
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
    # Optimistic-concurrency guard (M4): if the caller pinned the version it
    # loaded, reject the rerender when someone else advanced the figure since.
    # Raised before any render so no version is created on conflict.
    base_version_id = getattr(req, "base_version_id", None)
    if base_version_id is not None and base_version_id != fig.current_version_id:
        raise AppError(
            status_code=409,
            detail="Figure was modified since you last loaded it; reload and retry",
            error_code="VERSION_CONFLICT",
        )
    render_current_version_id = fig.current_version_id
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
    version_id = uuid.uuid4()
    res, out_dir = _render_into_version(df, plot_type, mapping, options, preset, figure_id, version_id)

    # Rendering is intentionally performed without a row lock: R may take
    # several seconds and must not freeze readers/editors. At the commit edge,
    # serialize writers, refresh the figure from PostgreSQL, and reject this
    # render if another request advanced the base in the meantime. This closes
    # the check/render/commit race while keeping the expensive work concurrent.
    locked_fig = (
        db.query(Figure)
        .filter(Figure.id == figure_id)
        .populate_existing()
        .with_for_update()
        .one()
    )
    if locked_fig.current_version_id != render_current_version_id:
        _discard_uncommitted_render(res, out_dir)
        db.rollback()
        raise AppError(
            status_code=409,
            detail="Figure changed while this render was running; review the latest version and retry",
            error_code="VERSION_CONFLICT",
        )
    fig = locked_fig
    next_num = (db.query(func.max(FigureVersion.version_number))
                .filter(FigureVersion.figure_id == figure_id).scalar() or 0) + 1

    version = FigureVersion(
        id=version_id, figure_id=figure_id, version_number=next_num,
        mapping=mapping, options=options or {}, style_preset=preset,
        r_code=res.r_code, change_note=(req.change_note or "Re-rendered"),
        png_path=res.outputs.get("png"), svg_path=res.outputs.get("svg"),
        tiff_path=res.outputs.get("tiff"), pdf_path=res.outputs.get("pdf"),
        eps_path=res.outputs.get("eps"),
        html_path=res.outputs.get("html"),
        layout=res.layout,
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


_FIGURE_COPY_SUFFIX_RE = re.compile(r"(?:\s+\(copy(?:\s+\d+)?\))+$", re.IGNORECASE)


def _next_figure_copy_name(source_name: str | None, plot_type: str,
                           existing_names: set[str]) -> str:
    """Return a compact, unique copy name without accumulating suffixes.

    Older duplicates were named ``name (copy) (copy)`` on every generation,
    which also produced unwieldy export-pack filenames.  Collapse any legacy
    suffix chain to the meaningful base and use a short numeric suffix when a
    sibling already owns the first copy name.
    """
    raw = str(source_name or "").strip()
    base = _FIGURE_COPY_SUFFIX_RE.sub("", raw).strip()
    if not base or base.casefold() == "figure":
        definition = next((item for item in PLOT_TYPES if item.get("type") == plot_type), None)
        base = str((definition or {}).get("label") or plot_type.replace("_", " ").title() or "Figure")

    occupied = {str(name).strip().casefold() for name in existing_names if name}
    copy_number = 1
    while True:
        suffix = " (copy)" if copy_number == 1 else f" (copy {copy_number})"
        trimmed_base = base[: 255 - len(suffix)].rstrip()
        candidate = f"{trimmed_base}{suffix}"
        if candidate.casefold() not in occupied:
            return candidate
        copy_number += 1


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
    name_query = db.query(Figure.name)
    if src.project_id is None:
        name_query = name_query.filter(Figure.project_id.is_(None), Figure.owner_id == owner_id)
    else:
        name_query = name_query.filter(Figure.project_id == src.project_id)
    existing_names = {row[0] for row in name_query.all() if row and row[0]}
    copy_name = _next_figure_copy_name(src.name, plot_type, existing_names)
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
        layout=res.layout,
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
            merged = {**(tgt_base.options or {}), **style_patch}
            # Reuse the single atomic render/commit path so bulk style cannot
            # race a canvas, AI, SVG, or figure-editor version writer.
            rerender(db, target_id, owner_id, SimpleNamespace(
                mapping=mapping,
                options=merged,
                style_preset=src_preset,
                change_note="Bulk style applied",
                base_version_id=tgt_base.id,
            ))
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
    if fig.current_version_id != version_id:
        raise AppError(
            status_code=409,
            detail="Figure changed since this SVG version was opened; reload before saving",
            error_code="VERSION_CONFLICT",
        )
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
    locked_fig = (
        db.query(Figure)
        .filter(Figure.id == figure_id)
        .populate_existing()
        .with_for_update()
        .one()
    )
    if locked_fig.current_version_id != version_id:
        storage.delete_file(svg_path)
        storage.delete_file(r_path)
        shutil.rmtree(out_dir, ignore_errors=True)
        db.rollback()
        raise AppError(
            status_code=409,
            detail="Figure changed while the SVG edit was being saved; reload and retry",
            error_code="VERSION_CONFLICT",
        )
    fig = locked_fig
    next_num = (db.query(func.max(FigureVersion.version_number))
                .filter(FigureVersion.figure_id == figure_id).scalar() or 0) + 1
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
def _review_evidence(fig: Figure, version: FigureVersion) -> dict[str, Any]:
    """Serializable, user-visible grounding actually supplied to AI review."""
    edit_context = version.edit_context if isinstance(version.edit_context, dict) else {}
    dataset = getattr(fig, "dataset", None)
    profile = getattr(dataset, "column_profile", None) or []
    columns = [
        {
            "name": str(column.get("name", "")),
            "role": str(column.get("role", "")),
            "dtype": str(column.get("dtype", "")),
        }
        for column in profile[:100]
        if isinstance(column, dict)
    ]
    return {
        "render": {
            "version_id": str(version.id),
            "version_number": version.version_number,
            "image_available": bool(version.png_path and storage.exists(version.png_path)),
        },
        "plot_type": fig.plot_type,
        "style_preset": version.style_preset,
        "mapping": dict(version.mapping or {}),
        "options": dict(version.options or {}),
        "last_ai_request": edit_context.get("original_request"),
        "dataset": {
            "name": getattr(dataset, "name", None),
            "column_count": len(profile),
            "columns": columns,
            "columns_truncated": len(profile) > len(columns),
        },
    }


def review_version(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID, owner_id: uuid.UUID) -> Review:
    fig = get_figure(db, figure_id, owner_id, write=True)
    v = get_version(fig, version_id)
    if not v.png_path or not storage.exists(v.png_path):
        raise BadRequestError("Rendered image not available for review", error_code="NO_IMAGE")
    png_path = storage.materialize(v.png_path, suffix=".png")
    ds = ds_service.get_dataset(db, fig.dataset_id, owner_id)
    dataset_grounding = _figure_dataset_grounding(
        ds, fig.plot_type, v.mapping or {}, v.options or {},
    )
    result = ai_client.review_figure(
        db, png_path, fig.plot_type, v.mapping or {}, v.options or {},
        project_context=_project_context(db, fig.project_id), user_id=owner_id,
        r_code=v.r_code,
        edit_context=v.edit_context if isinstance(v.edit_context, dict) else None,
        dataset_grounding=dataset_grounding,
        style_preset=v.style_preset or fig.style_preset,
    )
    # Persist the exact review inputs as a read-only evidence summary so users
    # can see what the verdict was grounded on instead of trusting an opaque
    # “AI reviewed it” badge. No underlying data rows are included.
    result = {**result, "evidence": _review_evidence(fig, v)}
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
                    prompt: str | None = None, original_request: str | None = None,
                    annotated_image: str | None = None,
                    marks: list[dict[str, Any]] | None = None) -> list[Improvement]:
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
    user_intent = bool((prompt or "").strip() or (original_request or "").strip() or annotated_image or marks)
    request_scopes = (
        _structured_edit_request_scopes(
            marks,
            prompt,
            getattr(v, "layout", None) if isinstance(getattr(v, "layout", None), dict) else None,
        )
        if marks
        else _extract_edit_request_scopes(prompt)
    )
    if user_intent and not request_scopes:
        request_scopes = [{
            "scope_id": "request",
            "mark_id": None,
            "mark_type": None,
            "request": (prompt or original_request or "").strip()[:4000]
            or "The annotated image did not include an explicit edit memo.",
        }]
    stored_original_request = (original_request or "").strip()
    original_request_source = "explicit" if stored_original_request else "legacy_prompt"
    if not stored_original_request:
        stored_original_request = _user_edit_intent_text(prompt or "").strip()
    for scope in request_scopes:
        if stored_original_request:
            scope["original_request"] = stored_original_request[:20000]
            scope["original_request_source"] = original_request_source
    suggestions, unsupported = ai_client.improve_figure(
        db, fig.plot_type, v.mapping or {}, v.options or {}, fig.style_preset,
        last_review.payload if last_review else None, [available],
        project_context=_project_context(db, fig.project_id), user_id=owner_id,
        user_request=_professionalized_edit_request(fig.plot_type, prompt or original_request),
        rendered_image=image_payload,
        r_code=v.r_code,
        request_scopes=request_scopes if user_intent else None,
    )
    rows: list[Improvement] = []
    skipped_lists: list[list[str]] = []
    row_by_scope: dict[str, Improvement] = {}
    scope_reason: dict[str, str] = {}
    scope_confidence: dict[str, Any] = {}

    def scope_allowed_paths(scope: dict[str, Any]) -> tuple[str, set[str]]:
        authorization_text = _scope_authorization_text(scope, request_scopes)
        allowed = _request_allowed_patch_paths(fig.plot_type, authorization_text, pdef)
        # resolved_target is client-provided localization evidence. It may
        # narrow/describe a request, but it never expands this deterministic
        # natural-language authorization set.
        server_target = scope.get("server_resolved_target")
        if (
            isinstance(server_target, dict)
            and server_target.get("editable") is True
            and authorization_text.strip()
            and _text_target_request_compatible(authorization_text)
            and _text_target_role_matches_request(
                authorization_text, str(server_target.get("role") or server_target.get("type") or ""),
            )
        ):
            path = str(server_target.get("setting_path") or "").strip()
            supported_paths = {
                "style_preset",
                *(f"mapping.{key}" for key in available["mapping_keys"]),
                *(f"options.{key}" for key in ({item["key"] for item in pdef.get("options", [])} | _UNIVERSAL_OPTION_KEYS)),
            }
            if path in supported_paths:
                allowed.add(path)
        # Visual scene targets (tick labels, legend, colorbar): the verified
        # pointing gesture names the element, and the memo wording still has
        # to name a supported operation for it. This mirrors the text-target
        # branch above but for non-content edits, so "rotate 45deg" on the
        # marked tick strip authorizes exactly options.x_text_angle without
        # requiring the words "x axis" in the memo.
        if isinstance(server_target, dict) and server_target.get("editable") is True:
            scene_option_keys = _scene_role_paths_for_request(
                str(server_target.get("role") or ""), authorization_text,
            )
            if scene_option_keys:
                allowed_option_keys = (
                    {item["key"] for item in pdef.get("options", [])} | _UNIVERSAL_OPTION_KEYS
                )
                for key in scene_option_keys:
                    if key in allowed_option_keys:
                        allowed.add(f"options.{key}")
        supported_element = _supported_element_override_target(server_target)
        if supported_element is not None:
            element_id, _root_path = supported_element
            for field in _element_override_fields_from_request(authorization_text):
                allowed.add(_element_override_leaf_path(element_id, field))
        return authorization_text, allowed

    def unsupported_reason_for(scope: dict[str, Any], resolved_target: str | None = None) -> str | None:
        if scope.get("target_override_rejection_reason"):
            return str(scope["target_override_rejection_reason"])[:500]
        # Keep this deterministic guidance ahead of both provider prose and a
        # generic non-editable scene-element reason.
        category_reason = _specific_element_unsupported_reason(scope, resolved_target)
        if category_reason and category_reason.startswith("Category value relabeling"):
            return category_reason
        server_target = scope.get("server_resolved_target")
        declared = scope.get("declared_target")
        authoritative_target = server_target if isinstance(server_target, dict) else (
            declared if isinstance(declared, dict) and declared.get("editable") is False else None
        )
        if isinstance(authoritative_target, dict) and (
            authoritative_target.get("editable") is False or not authoritative_target.get("setting_path")
        ):
            authorization_text = _scope_authorization_text(scope, request_scopes)
            if _supported_series_wide_recolor(scope, authoritative_target, authorization_text):
                return None
            return str(authoritative_target.get("unsupported_reason") or (
                "The marked figure element cannot be edited independently by this chart template."
            ))[:500]
        return _specific_element_unsupported_reason(scope, resolved_target)

    for s in suggestions:
        if not isinstance(s, dict):
            continue
        scope = _resolve_suggestion_scope(s, request_scopes) if user_intent else None
        if user_intent and scope is None:
            # A multi-mark provider result without a stable mark identity is
            # ambiguous by definition; never guess which memo authorized it.
            continue
        raw_patch = s.get("param_patch", {})
        patch = _sanitize_param_patch(raw_patch, pdef, v.mapping or {}, cols)
        dropped = []
        if user_intent and scope is not None:
            if s.get("confidence") is not None:
                scope_confidence[str(scope["scope_id"])] = s.get("confidence")
            target = str(s.get("resolved_target") or "").strip()[:200] or None
            reason = unsupported_reason_for(scope, target)
            if reason:
                scope_reason.setdefault(str(scope["scope_id"]), reason)
                continue
            authorization_text, allowed = scope_allowed_paths(scope)
            patch = _filter_patch_to_request_scope(patch, allowed, authorization_text)
        if not patch or not _patch_changes_version(patch, v):
            continue
        kept_paths = set(_authorization_patch_key_paths(patch))
        dropped = [path for path in _authorization_patch_key_paths(raw_patch) if path not in kept_paths]
        edit_scope = None
        if scope is not None:
            edit_scope = _edit_scope_payload(
                scope,
                status="supported",
                allowed_patch_keys=sorted(kept_paths),
                approved_patch=patch,
                resolved_target=str(s.get("resolved_target") or "").strip()[:200] or None,
                confidence=s.get("confidence"),
            )
            existing = row_by_scope.get(str(scope["scope_id"]))
            if existing is not None:
                # Providers occasionally split one mark into several JSON
                # suggestions. Preserve the 1:1 mark contract by merging the
                # already-authorized patches into the first durable row.
                existing.param_patch = _merge_param_patch(existing.param_patch or {}, patch)
                existing_confidence = (existing.edit_scope or {}).get("confidence")
                confidence_candidates = [
                    value for value in (existing_confidence, s.get("confidence"))
                    if isinstance(value, (int, float)) and not isinstance(value, bool)
                ]
                existing.edit_scope = _edit_scope_payload(
                    scope,
                    status="supported",
                    allowed_patch_keys=_authorization_patch_key_paths(existing.param_patch),
                    approved_patch=existing.param_patch,
                    resolved_target=(existing.edit_scope or {}).get("provider_resolved_target")
                    or str(s.get("resolved_target") or "").strip()[:200]
                    or None,
                    confidence=max(confidence_candidates) if confidence_candidates else None,
                )
                try:
                    skipped_lists[rows.index(existing)].extend(dropped)
                except ValueError:
                    pass
                continue
        imp = Improvement(
            figure_version_id=version_id,
            suggestion_type=s.get("suggestion_type"),
            current_state=s.get("current"),
            recommended=s.get("recommended"),
            param_patch=patch,
            edit_scope=edit_scope,
            priority=s.get("priority"),
        )
        db.add(imp)
        rows.append(imp)
        skipped_lists.append(dropped)
        if scope is not None:
            row_by_scope[str(scope["scope_id"])] = imp

    # Deterministic supported phrases (axis range, dashed line, square marker,
    # explicit line color) close provider omissions without widening scope.
    # Merge them into that mark's existing result to keep one structured result
    # per mark instead of producing a duplicate generic card.
    if user_intent:
        for scope in request_scopes:
            scope_id = str(scope["scope_id"])
            reason = unsupported_reason_for(scope)
            if reason:
                scope_reason.setdefault(scope_id, reason)
                continue
            authorization_text, allowed = scope_allowed_paths(scope)
            explicit_raw_patch = _merge_param_patch(
                _explicit_visual_patch_from_request(fig.plot_type, authorization_text),
                _explicit_element_override_patch_from_scope(scope, authorization_text),
            )
            explicit_patch = _sanitize_param_patch(
                explicit_raw_patch,
                pdef,
                v.mapping or {},
                cols,
            )
            explicit_patch = _filter_patch_to_request_scope(explicit_patch, allowed, authorization_text)
            if not explicit_patch or not _patch_changes_version(explicit_patch, v):
                continue
            existing = row_by_scope.get(scope_id)
            if existing is not None:
                existing.param_patch = _merge_param_patch(existing.param_patch or {}, explicit_patch)
                existing.edit_scope = _edit_scope_payload(
                    scope,
                    status="supported",
                    allowed_patch_keys=_authorization_patch_key_paths(existing.param_patch),
                    approved_patch=existing.param_patch,
                    resolved_target=(existing.edit_scope or {}).get("provider_resolved_target"),
                    confidence=(existing.edit_scope or {}).get("confidence"),
                )
                continue
            imp = Improvement(
                figure_version_id=version_id,
                suggestion_type="Marked edit request" if scope.get("mark_id") else "Edit request",
                current_state="Current figure does not yet reflect the explicit edit request.",
                recommended="Apply only the visual settings explicitly requested in this scope.",
                param_patch=explicit_patch,
                edit_scope=_edit_scope_payload(
                    scope,
                    status="supported",
                    allowed_patch_keys=_authorization_patch_key_paths(explicit_patch),
                    approved_patch=explicit_patch,
                ),
                priority="high",
            )
            db.add(imp)
            rows.append(imp)
            skipped_lists.append([])
            row_by_scope[scope_id] = imp

    if not rows and not user_intent:
        imp = Improvement(
            figure_version_id=version_id,
            suggestion_type="Publication export settings",
            current_state="Current figure settings may not specify final export defaults.",
            recommended="Use a stable wide export with 300 dpi and 7 pt type for publication layout.",
            param_patch={"options": {"size": "wide", "dpi": 300, "font_scale": 1.0, "palette_name": "publication_muted_v2"}},
            priority="medium",
        )
        db.add(imp)
        rows.append(imp)
        skipped_lists.append([])
    normalized_unsupported = list(unsupported or [])
    if user_intent:
        # Every server-normalized scope must have a durable structured result,
        # supported or explicitly unsupported. Provider prose can supply a
        # reason, but never the scope identity itself.
        for scope in request_scopes:
            scope_id = str(scope["scope_id"])
            if scope_id in row_by_scope:
                continue
            matching = next((
                item for item in normalized_unsupported
                if _resolve_suggestion_scope(item, request_scopes) is scope
            ), None)
            reason = scope_reason.get(scope_id)
            if not reason and matching:
                reason = str(matching.get("reason") or "").strip()[:500]
            if matching and matching.get("confidence") is not None:
                scope_confidence[scope_id] = matching.get("confidence")
            if not reason and not scope.get("mark_id"):
                generic = next((
                    item for item in normalized_unsupported if not item.get("mark_id")
                ), None)
                if generic:
                    reason = str(generic.get("reason") or "").strip()[:500]
            if not reason:
                reason = _scope_generic_unsupported_reason(scope)
            target = None
            if matching:
                target = str(matching.get("resolved_target") or "").strip()[:200] or None
            item = {
                "request": str(scope.get("request") or "")[:300],
                "reason": reason[:300],
            }
            if scope.get("mark_id"):
                item["mark_id"] = str(scope["mark_id"])
            if target:
                item["resolved_target"] = target
            normalized_unsupported.append(item)
            imp = Improvement(
                figure_version_id=version_id,
                suggestion_type="Unsupported request",
                current_state="This request scope does not map to an independently editable parameter.",
                recommended=f"Cannot be applied as-is: {reason}"[:1000],
                param_patch={},
                edit_scope=_edit_scope_payload(
                    scope,
                    status="unsupported",
                    resolved_target=target,
                    reason=reason,
                    confidence=scope_confidence.get(scope_id),
                ),
                priority="low",
            )
            db.add(imp)
            rows.append(imp)
            skipped_lists.append([])
    elif not rows and unsupported:
        reason_text = "; ".join(
            f"“{(item.get('request') or '').strip()}” — {(item.get('reason') or '').strip()}"
            for item in unsupported[:5]
        )
        imp = Improvement(
            figure_version_id=version_id,
            suggestion_type="Unsupported request",
            current_state="No part of this request maps to a supported parameter change.",
            recommended=(f"Cannot be applied as-is: {reason_text}")[:1000],
            param_patch={},
            priority="low",
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
    # `unsupported` (U10b) is a property of this whole improve_figure call, not
    # of any one suggestion - the same normalized list is attached to every row
    # from this call (transient attribute, not a DB column, same pattern as
    # `.skipped` above) so the client can read it off any/all of them.
    for r, sk in zip(rows, skipped_lists):
        r.skipped = sk
        r.unsupported = normalized_unsupported
    return rows


def list_improvements(db: Session, figure_id: uuid.UUID, version_id: uuid.UUID, owner_id: uuid.UUID) -> list[Improvement]:
    fig = get_figure(db, figure_id, owner_id)
    get_version(fig, version_id)
    return (db.query(Improvement).filter(Improvement.figure_version_id == version_id)
            .order_by(Improvement.created_at.desc()).all())


def _merge_touched_patch(dst: dict[str, Any], patch: dict[str, Any]) -> None:
    """Union-merge `patch`'s touched style_preset/mapping/options keys into
    `dst` (last-write-wins on overlap) - the same shape used to build the
    rendered mapping/options, kept separately so apply diagnostics (U10b) can
    report {key, from, to} without needing every raw per-suggestion patch."""
    if patch.get("style_preset"):
        dst["style_preset"] = patch["style_preset"]
    if patch.get("mapping"):
        dst.setdefault("mapping", {}).update(patch["mapping"])
    if patch.get("options"):
        dst["options"] = _merge_apply_options(dst.get("options") or {}, patch["options"])


def _enforce_edit_scope_patch(patch: dict[str, Any] | None,
                              edit_scope: dict[str, Any] | None) -> tuple[dict[str, Any], list[str]]:
    """Re-enforce the durable request allow-list immediately before apply.

    Older unscoped improvements retain their existing behavior. Once an
    improvement has an edit_scope, however, that scope is an authorization
    boundary: a tampered row or stale client can never widen its patch.
    """
    raw = patch if isinstance(patch, dict) else {}
    if not isinstance(edit_scope, dict):
        return raw, []
    if edit_scope.get("status") != "supported":
        return {}, sorted(_authorization_patch_key_paths(raw))
    allowed = {
        path for path in (edit_scope.get("allowed_patch_keys") or [])
        if isinstance(path, str)
    }
    approved = edit_scope.get("approved_patch") if isinstance(edit_scope.get("approved_patch"), dict) else None
    approved_style = approved.get("style_preset") if approved else None
    filtered: dict[str, Any] = {}
    if (
        raw.get("style_preset")
        and "style_preset" in allowed
        and (approved is None or raw["style_preset"] == approved_style)
    ):
        filtered["style_preset"] = raw["style_preset"]
    mapping = {
        key: value for key, value in (raw.get("mapping") or {}).items()
        if f"mapping.{key}" in allowed
        and (
            approved is None
            or value == ((approved.get("mapping") or {}).get(key) if isinstance(approved.get("mapping"), dict) else None)
        )
    }
    options: dict[str, Any] = {}
    approved_options = approved.get("options") if approved and isinstance(approved.get("options"), dict) else {}
    for key, value in (raw.get("options") or {}).items():
        parent_path = f"options.{key}"
        approved_value = approved_options.get(key)
        if key == "category_colors" and isinstance(value, dict):
            kept = {
                label: color for label, color in value.items()
                if (
                    parent_path in allowed or f"{parent_path}.{label}" in allowed
                ) and (
                    approved is None
                    or isinstance(approved_value, dict) and approved_value.get(label) == color
                )
            }
            if kept:
                options[key] = kept
            continue
        if key == "series_styles" and isinstance(value, dict):
            kept_styles: dict[str, dict[str, Any]] = {}
            for series, style in value.items():
                if not isinstance(style, dict):
                    continue
                kept_style = {
                    field: field_value for field, field_value in style.items()
                    if (
                        parent_path in allowed or f"{parent_path}.{series}.{field}" in allowed
                    ) and (
                        approved is None
                        or isinstance(approved_value, dict)
                        and isinstance(approved_value.get(series), dict)
                        and approved_value[series].get(field) == field_value
                    )
                }
                if kept_style:
                    kept_styles[series] = kept_style
            if kept_styles:
                options[key] = kept_styles
            continue
        if key == "element_overrides" and isinstance(value, dict):
            kept_overrides: dict[str, dict[str, Any]] = {}
            for element_id, style in value.items():
                if not isinstance(element_id, str) or not isinstance(style, dict):
                    continue
                approved_style = (
                    approved_value.get(element_id)
                    if isinstance(approved_value, dict)
                    and isinstance(approved_value.get(element_id), dict)
                    else {}
                )
                kept_style = {
                    field: field_value
                    for field, field_value in style.items()
                    if field in {"fill", "stroke"}
                    and (
                        parent_path in allowed
                        or _element_override_leaf_path(element_id, field) in allowed
                    )
                    and (
                        approved is None
                        or approved_style.get(field) == field_value
                    )
                }
                if kept_style:
                    kept_overrides[element_id] = kept_style
            if kept_overrides:
                options[key] = kept_overrides
            continue
        if parent_path in allowed and (approved is None or approved_value == value):
            options[key] = value
    if mapping:
        filtered["mapping"] = mapping
    if options:
        filtered["options"] = options
    kept = set(_authorization_patch_key_paths(filtered))
    rejected = sorted(path for path in _authorization_patch_key_paths(raw) if path not in kept)
    return filtered, rejected


def _effective_option_before_value(plot_type: str, base_options: dict[str, Any], key: str) -> Any:
    """Renderer-effective value of an UNSET option, for user-facing diffs.

    Mirrors the renderer fallbacks (DEFAULT_X_TEXT_ANGLE, labplot_theme()'s
    right-hand legend, ggplot's side-driven guide direction) so a before value
    of "(unset)" never contradicts what the previous render actually drew."""
    if key == "x_text_angle":
        return DEFAULT_X_TEXT_ANGLE.get(plot_type, 0)
    if key == "legend_position":
        return "none" if base_options.get("hide_legend") else "right"
    if key == "legend_direction":
        position = base_options.get("legend_position") or (
            "none" if base_options.get("hide_legend") else "right"
        )
        if position == "none":
            return None
        return "horizontal" if position in ("top", "bottom") else "vertical"
    return None


def _fill_default_before_values(changes: list[dict[str, Any]], plot_type: str | None,
                                base_options: dict[str, Any]) -> list[dict[str, Any]]:
    """Replace a None `from` with the renderer-effective default (flagged with
    from_is_default) on user-facing option diffs. Applied AFTER the raw
    changed/dropped comparison so it can never turn a real change into a
    no-op or vice versa."""
    if not plot_type:
        return changes
    for item in changes:
        key = str(item.get("key") or "")
        if not key.startswith("options.") or item.get("from") is not None:
            continue
        effective = _effective_option_before_value(plot_type, base_options, key[len("options."):])
        if effective is not None:
            item["from"] = effective
            item["from_is_default"] = True
    return changes


def _full_version_diff(base: FigureVersion, current: FigureVersion) -> list[dict[str, Any]]:
    """Return every mapping/options/style change, not only touched patch keys."""
    changes: list[dict[str, Any]] = []
    base_style = getattr(base, "style_preset", None)
    current_style = getattr(current, "style_preset", None)
    if not (_values_match(base_style, current_style) and _values_match(current_style, base_style)):
        changes.append({"key": "style_preset", "from": base_style, "to": current_style})
    missing = object()

    def append_nested(prefix: str, before: Any, after: Any) -> None:
        if isinstance(before, dict) or isinstance(after, dict):
            before_dict = before if isinstance(before, dict) else {}
            after_dict = after if isinstance(after, dict) else {}
            for child in sorted(set(before_dict) | set(after_dict), key=str):
                append_nested(
                    f"{prefix}.{child}",
                    before_dict.get(child, missing),
                    after_dict.get(child, missing),
                )
            return
        before_value = None if before is missing else before
        after_value = None if after is missing else after
        if _values_match(before_value, after_value) and _values_match(after_value, before_value):
            return
        changes.append({"key": prefix, "from": before_value, "to": after_value})

    for section in ("mapping", "options"):
        before_values = dict(getattr(base, section, None) or {})
        after_values = dict(getattr(current, section, None) or {})
        for key in sorted(set(before_values) | set(after_values)):
            before = before_values.get(key, missing)
            after = after_values.get(key, missing)
            if section == "options" and key in {
                "category_colors", "series_styles", "element_overrides",
            }:
                append_nested(f"{section}.{key}", before, after)
            else:
                before_value = None if before is missing else before
                after_value = None if after is missing else after
                if _values_match(before_value, after_value) and _values_match(after_value, before_value):
                    continue
                changes.append({
                    "key": f"{section}.{key}", "from": before_value, "to": after_value,
                })
    plot_type = getattr(getattr(base, "figure", None), "plot_type", None)
    return _fill_default_before_values(changes, plot_type, dict(getattr(base, "options", None) or {}))


def _apply_diagnostics(touched_patch: dict[str, Any], base_mapping: dict[str, Any], base_options: dict[str, Any],
                       base_style_preset: str | None, new_version: FigureVersion) -> tuple[list[dict[str, Any]], list[str]]:
    """(U10b) Per-key diff between the pre-apply state (base_*) and the
    actually-rendered new_version, restricted to the keys `touched_patch`
    tried to change. A key is a dropped_keys entry when rerender's re-sanitize
    pass removed it entirely, or when the rendered value provably equals the
    pre-apply value (a no-op); otherwise it is an applied_changes entry
    {"key", "from", "to"}. `touched_patch` may be a single suggestion's
    already-sanitized param_patch, or a union of several (see
    _merge_touched_patch) - only which keys it touches matters here, not its
    values."""
    applied: list[dict[str, Any]] = []
    dropped: list[str] = []

    def unchanged(before: Any, after: Any) -> bool:
        return _values_match(before, after) and _values_match(after, before)

    if touched_patch.get("style_preset"):
        before, after = base_style_preset, new_version.style_preset
        if unchanged(before, after):
            dropped.append("style_preset")
        else:
            applied.append({"key": "style_preset", "from": before, "to": after})
    new_mapping = new_version.mapping or {}
    for key in (touched_patch.get("mapping") or {}):
        before, after = base_mapping.get(key), new_mapping.get(key)
        if after is None or unchanged(before, after):
            dropped.append(f"mapping.{key}")
        else:
            applied.append({"key": f"mapping.{key}", "from": before, "to": after})
    new_options = new_version.options or {}
    for key, touched_value in (touched_patch.get("options") or {}).items():
        if key == "element_overrides" and isinstance(touched_value, dict):
            base_overrides = base_options.get(key) if isinstance(base_options.get(key), dict) else {}
            new_overrides = new_options.get(key) if isinstance(new_options.get(key), dict) else {}
            for element_id, style in touched_value.items():
                if not isinstance(style, dict):
                    continue
                before_style = (
                    base_overrides.get(element_id)
                    if isinstance(base_overrides.get(element_id), dict)
                    else {}
                )
                after_style = (
                    new_overrides.get(element_id)
                    if isinstance(new_overrides.get(element_id), dict)
                    else {}
                )
                for field in style:
                    path = _element_override_leaf_path(element_id, field)
                    before, after = before_style.get(field), after_style.get(field)
                    if after is None or unchanged(before, after):
                        dropped.append(path)
                    else:
                        applied.append({"key": path, "from": before, "to": after})
            continue
        before, after = base_options.get(key), new_options.get(key)
        if after is None or unchanged(before, after):
            dropped.append(f"options.{key}")
        else:
            applied.append({"key": f"options.{key}", "from": before, "to": after})
    plot_type = getattr(getattr(new_version, "figure", None), "plot_type", None)
    return _fill_default_before_values(applied, plot_type, base_options), dropped


def _best_sanitized_patch(suggestions: list[dict], pdef: dict, base_mapping: dict[str, Any],
                          valid_columns: set[str] | None,
                          allowed_patch_keys: set[str] | None = None) -> dict[str, Any] | None:
    """Pick the highest-priority suggestion (high > medium > low > unranked)
    whose param_patch survives sanitization, for the U10c retry step ("apply
    the best suggestion's patch on top")."""
    by_priority: dict[str, list[dict]] = {"high": [], "medium": [], "low": [], None: []}
    for s in suggestions or []:
        by_priority.setdefault(s.get("priority"), by_priority[None]).append(s)
    for priority in ("high", "medium", "low", None):
        for s in by_priority.get(priority, []):
            clean = _sanitize_param_patch(s.get("param_patch", {}), pdef, base_mapping, valid_columns)
            if allowed_patch_keys is not None:
                clean, _rejected = _enforce_edit_scope_patch(clean, {
                    "status": "supported",
                    "allowed_patch_keys": sorted(allowed_patch_keys),
                })
            if clean:
                return clean
    return None


def _run_verification(db: Session, fig: Figure, owner_id: uuid.UUID, original_base: FigureVersion,
                      applied_version: FigureVersion, touched_patch: dict[str, Any],
                      original_request: str, allow_retry: bool = True,
                      allowed_patch_keys: list[str] | None = None,
                      request_scopes: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """(U10c) Self-verify loop, opt-in per apply call. Sends the pre-edit and
    post-edit renders plus the original request and applied changes to the AI;
    on an unsatisfied verdict, retries ONCE (a fresh improve_figure call with
    the feedback appended, applying only its best suggestion on top, producing
    a second new version), then verifies again to report the final verdict.
    `allow_retry=False` (the suggestion-apply paths) reports the verdict only,
    never creating a version the user did not select. At most 2 verify_edit
    calls + 1 retry improve_figure call (<=3 AI calls total) - every AI call
    goes through ai_client._run_logged, which already calls enforce_ai_quota
    before each one. Best-effort: an error before any verdict exists degrades
    to verification={skipped: <reason>}; an error after verify #1 salvages
    that verdict instead of discarding it. The apply itself never fails here."""
    final_version = applied_version
    final_patch = dict(touched_patch)
    verdict: dict[str, Any] | None = None
    attempts = 0
    allowed_source = _authorization_patch_key_paths(touched_patch) if allowed_patch_keys is None else allowed_patch_keys
    allowed = sorted(set(allowed_source))
    allowed_set = set(allowed)

    def _evidence(version: FigureVersion) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
        full_diff = _full_version_diff(original_base, version)
        requested_changes = [item for item in full_diff if item["key"] in allowed_set]
        unrequested_changes = [item for item in full_diff if item["key"] not in allowed_set]
        _touched_changes, dropped_keys = _apply_diagnostics(
            final_patch,
            original_base.mapping or {},
            original_base.options or {},
            original_base.style_preset,
            version,
        )
        return requested_changes, unrequested_changes, dropped_keys

    def _verdict_payload(current_verdict: dict[str, Any] | None,
                         unrequested_changes: list[dict[str, Any]]) -> dict[str, Any]:
        feedback = str((current_verdict or {}).get("feedback") or "").strip()
        if unrequested_changes:
            paths = ", ".join(item["key"] for item in unrequested_changes[:20])
            deterministic = f"Unrequested rendered changes detected outside the allowed edit scope: {paths}."
            feedback = f"{feedback} {deterministic}".strip()
        return {
            "attempts": attempts,
            "satisfied": bool((current_verdict or {}).get("satisfied")) and not unrequested_changes,
            "feedback": feedback[:1000],
            "allowed_patch_keys": allowed,
            "unrequested_changes": unrequested_changes[:50],
        }

    def _result(verification: dict[str, Any] | None) -> dict[str, Any]:
        applied_changes, _unrequested, dropped_keys = _evidence(final_version)
        return {"version": final_version, "applied_changes": applied_changes,
                "dropped_keys": dropped_keys, "verification": verification}

    def _skipped(reason: str) -> dict[str, Any]:
        _applied, unrequested, _dropped = _evidence(final_version)
        result = _verdict_payload(None, unrequested)
        result["skipped"] = reason[:100]
        return result

    try:
        if (not original_base.png_path or not applied_version.png_path
                or not storage.exists(original_base.png_path) or not storage.exists(applied_version.png_path)):
            return _result(_skipped("NO_IMAGE"))
        before_path = storage.materialize(original_base.png_path, suffix=".png")
        after_path = storage.materialize(applied_version.png_path, suffix=".png")
        applied_changes, unrequested_changes, _dropped = _evidence(applied_version)
        verdict = ai_client.verify_edit(
            db, before_path, after_path, original_request, applied_changes,
            user_id=owner_id,
            allowed_patch_keys=allowed,
            unrequested_changes=unrequested_changes,
        )
        attempts = 1
        if allow_retry and not unrequested_changes and not verdict.get("satisfied"):
            retry_request = (
                original_request.strip()
                + "\n\n[Automatic verification retry] A previous attempt at this exact request did not fully "
                  "satisfy it. Reviewer feedback on the previous attempt: " + (verdict.get("feedback") or "")
            )
            ds = ds_service.get_dataset(db, fig.dataset_id, owner_id)
            cols = _dataset_column_names(ds)
            pdef = _plot_def(fig.plot_type)
            available = {
                "options": pdef.get("options", []),
                "mapping_keys": [r["key"] for r in pdef["required"]] + [o["key"] for o in pdef.get("optional", [])],
                "dataset_columns": _dataset_columns_for_ai(ds),
            }
            with open(after_path, "rb") as f:
                retry_image = (f.read(), "image/png")
            suggestions, _unsupported = ai_client.improve_figure(
                db, fig.plot_type, applied_version.mapping or {}, applied_version.options or {},
                applied_version.style_preset, None, [available],
                project_context=_project_context(db, fig.project_id), user_id=owner_id,
                user_request=retry_request, rendered_image=retry_image, r_code=applied_version.r_code,
                request_scopes=request_scopes,
            )
            best_patch = _best_sanitized_patch(
                suggestions, pdef, applied_version.mapping or {}, cols,
                allowed_patch_keys=allowed_set,
            )
            if best_patch:
                retry_mapping = {**(applied_version.mapping or {}), **(best_patch.get("mapping") or {})}
                retry_options = {**(applied_version.options or {}), **(best_patch.get("options") or {})}
                retry_preset = best_patch.get("style_preset") or applied_version.style_preset

                class _RetryReq:
                    mapping = retry_mapping
                    options = retry_options
                    style_preset = retry_preset
                    change_note = f"AI edit retry after verification feedback (from v{applied_version.version_number})"
                    base_version_id = applied_version.id

                retry_result = rerender(db, fig.id, owner_id, _RetryReq())
                final_version = db.query(FigureVersion).filter(FigureVersion.id == retry_result["id"]).first() or applied_version
                _merge_touched_patch(final_patch, best_patch)
                if final_version.png_path and storage.exists(final_version.png_path):
                    after_path_2 = storage.materialize(final_version.png_path, suffix=".png")
                    final_changes, final_unrequested, _dropped2 = _evidence(final_version)
                    verdict = ai_client.verify_edit(
                        db, before_path, after_path_2, original_request, final_changes,
                        user_id=owner_id,
                        allowed_patch_keys=allowed,
                        unrequested_changes=final_unrequested,
                    )
                    attempts = 2
        _final_changes, final_unrequested, _final_dropped = _evidence(final_version)
        return _result(_verdict_payload(verdict, final_unrequested))
    except Exception as exc:
        note = f"AI edit verification interrupted: {type(exc).__name__}: {str(exc)[:300]}"
        final_version.render_log = ((final_version.render_log or "").rstrip() + "\n" + note).strip()
        db.commit()
        if verdict is not None:
            # Verify #1 completed but the retry leg failed - report the verdict
            # we already paid for instead of discarding it (its feedback
            # describes the pre-retry render, which is still the version
            # returned unless the retry rerender itself completed).
            _changes, unrequested, _dropped = _evidence(final_version)
            return _result(_verdict_payload(verdict, unrequested))
        code = getattr(exc, "error_code", None) or type(exc).__name__
        return _result(_skipped(str(code)))


def _finalize_apply_response(db: Session, fig: Figure, owner_id: uuid.UUID, base: FigureVersion,
                             new_version: FigureVersion | None, touched_patch: dict[str, Any],
                             version_result: dict, verify: bool, original_request: str | None,
                             allow_retry: bool = True,
                             verification_request: str | None = None,
                             edit_scopes: list[dict[str, Any] | None] | None = None,
                             pre_dropped_keys: list[str] | None = None) -> dict:
    """Shared tail of apply_improvement/apply_improvements (U10b/U10c): compute
    the sanitize-based applied_changes/dropped_keys diagnostic, retain the
    exact user request as provenance, and - when verification was requested
    with a non-empty original user prompt - run the self-verify loop. A
    narrower AI-generated verification_request is retained only as advisory
    audit metadata; it never replaces the original request as the verifier's
    source of truth."""
    provenance_request = (original_request or '').strip()
    advisory_verification_request = (verification_request or '').strip()
    touched_paths = set(_authorization_patch_key_paths(touched_patch))
    scoped_allowed = {
        path
        for scope in (edit_scopes or [])
        if isinstance(scope, dict)
        for path in (scope.get("allowed_patch_keys") or [])
        if isinstance(path, str)
    }
    has_legacy_scope = any(scope is None for scope in (edit_scopes or []))
    allowed_paths = sorted(
        touched_paths if not edit_scopes or has_legacy_scope
        else touched_paths & scoped_allowed
    )
    if verify and provenance_request and new_version is not None:
        outcome = _run_verification(db, fig, owner_id, base, new_version, touched_patch,
                                    provenance_request,
                                    allow_retry=allow_retry and not bool(edit_scopes),
                                    allowed_patch_keys=allowed_paths,
                                    request_scopes=[scope for scope in (edit_scopes or []) if isinstance(scope, dict)])
        final_version = outcome["version"]
        final_version.edit_context = {
            "source": "ai_edit",
            "original_request": provenance_request[:20000],
            "applied_changes": outcome["applied_changes"][:50],
            "allowed_patch_keys": allowed_paths,
            "unrequested_changes": (outcome.get("verification") or {}).get("unrequested_changes", [])[:50],
        }
        if advisory_verification_request:
            final_version.edit_context["verification_request"] = advisory_verification_request[:4000]
        if edit_scopes:
            final_version.edit_context["edit_scopes"] = [scope for scope in edit_scopes if isinstance(scope, dict)][:20]
        db.commit()
        result = version_result if final_version.id == new_version.id else version_response(final_version)
        return {
            "version": result,
            "applied_changes": outcome["applied_changes"],
            "dropped_keys": sorted(set(outcome["dropped_keys"] + (pre_dropped_keys or []))),
            "verification": outcome["verification"],
        }
    applied_changes: list[dict[str, Any]] = []
    dropped_keys: list[str] = []
    if new_version is not None:
        applied_changes, dropped_keys = _apply_diagnostics(
            touched_patch, base.mapping or {}, base.options or {}, base.style_preset, new_version
        )
        if provenance_request or advisory_verification_request or edit_scopes:
            new_version.edit_context = {
                "source": "ai_edit",
                "applied_changes": applied_changes[:50],
            }
            if provenance_request:
                new_version.edit_context["original_request"] = provenance_request[:20000]
            if advisory_verification_request:
                new_version.edit_context["verification_request"] = advisory_verification_request[:4000]
            if edit_scopes:
                new_version.edit_context["allowed_patch_keys"] = allowed_paths
                new_version.edit_context["edit_scopes"] = [
                    scope for scope in edit_scopes if isinstance(scope, dict)
                ][:20]
            db.commit()
    return {
        "version": version_result,
        "applied_changes": applied_changes,
        "dropped_keys": sorted(set(dropped_keys + (pre_dropped_keys or []))),
        "verification": None,
    }


def _resolve_apply_original_request(edit_scopes: list[dict[str, Any] | None],
                                    client_request: str | None) -> str | None:
    """Select immutable plan provenance over apply-time client text."""
    stored = {
        str(scope.get("original_request") or "").strip()
        for scope in edit_scopes
        if isinstance(scope, dict) and str(scope.get("original_request") or "").strip()
    }
    if len(stored) > 1:
        raise BadRequestError(
            "Selected suggestions do not share one original edit request.",
            error_code="MIXED_REQUEST_SCOPES",
        )
    supplied = (client_request or "").strip()
    if not stored:
        return supplied or None
    authoritative = next(iter(stored))
    explicit = any(
        isinstance(scope, dict)
        and scope.get("original_request_source") == "explicit"
        for scope in edit_scopes
    )
    if explicit and supplied and supplied != authoritative:
        raise BadRequestError(
            "The apply request does not match the reviewed AI edit plan.",
            error_code="REQUEST_PROVENANCE_MISMATCH",
        )
    return authoritative


def _guard_reviewed_improvement_base(
    fig: Figure,
    improvement_version_id: uuid.UUID,
    expected_base_version_id: uuid.UUID | None,
) -> None:
    """Reject a reviewed plan when either the figure or plan base moved."""
    if expected_base_version_id is None:
        return
    if (
        fig.current_version_id != expected_base_version_id
        or improvement_version_id != expected_base_version_id
    ):
        raise AppError(
            status_code=409,
            detail="Figure changed after this AI plan was created; review a fresh plan before applying",
            error_code="VERSION_CONFLICT",
        )


def apply_improvement(db: Session, figure_id: uuid.UUID, improvement_id: uuid.UUID, owner_id: uuid.UUID,
                      verify: bool = False, original_request: str | None = None, allow_retry: bool = True,
                      verification_request: str | None = None,
                      expected_base_version_id: uuid.UUID | None = None) -> dict:
    fig = get_figure(db, figure_id, owner_id, write=True)
    version_ids = {v.id for v in fig.versions}
    imp = db.query(Improvement).filter(Improvement.id == improvement_id).first()
    if not imp or imp.figure_version_id not in version_ids:
        raise NotFoundError("Improvement", str(improvement_id))

    _guard_reviewed_improvement_base(fig, imp.figure_version_id, expected_base_version_id)
    base = get_version(fig, imp.figure_version_id)
    imp_scope = getattr(imp, "edit_scope", None)
    authoritative_request = _resolve_apply_original_request([imp_scope], original_request)
    patch, rejected_paths = _enforce_edit_scope_patch(imp.param_patch or {}, imp_scope)
    if not (patch.get("mapping") or patch.get("options") or patch.get("style_preset")):
        # Zero-patch rows (e.g. the U10b "Unsupported request" carrier) are
        # informational only - applying them would burn render quota on a
        # byte-identical version and, with verify on, could trigger an
        # unapproved retry edit.
        raise BadRequestError("This suggestion has no applicable parameter change.", error_code="NOTHING_TO_APPLY")
    new_mapping = {**(base.mapping or {}), **(patch.get("mapping") or {})}
    new_options = _merge_apply_options(base.options or {}, patch.get("options") or {})
    new_preset = patch.get("style_preset") or base.style_preset or fig.style_preset

    class _Req:
        mapping = new_mapping
        options = new_options
        style_preset = new_preset
        change_note = f"Applied AI suggestion to v{base.version_number}: {imp.suggestion_type or 'improvement'}"
        base_version_id = expected_base_version_id

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
    return _finalize_apply_response(
        db, fig, owner_id, base, new_version, patch, result, verify, authoritative_request,
        allow_retry=allow_retry,
        verification_request=verification_request,
        edit_scopes=[imp_scope],
        pre_dropped_keys=rejected_paths,
    )


def apply_improvements(db: Session, figure_id: uuid.UUID, improvement_ids: list[uuid.UUID], owner_id: uuid.UUID,
                       verify: bool = False, original_request: str | None = None, allow_retry: bool = True,
                       verification_request: str | None = None,
                       expected_base_version_id: uuid.UUID | None = None) -> dict:
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

    _guard_reviewed_improvement_base(fig, base_version_id, expected_base_version_id)
    base = get_version(fig, base_version_id)
    selected_scopes = [getattr(imp, "edit_scope", None) for imp in ordered]
    authoritative_request = _resolve_apply_original_request(selected_scopes, original_request)
    new_mapping = dict(base.mapping or {})
    new_options = dict(base.options or {})
    new_preset = base.style_preset or fig.style_preset
    labels = []
    combined_patch: dict[str, Any] = {}
    rejected_paths: list[str] = []
    for imp in ordered:
        patch, rejected = _enforce_edit_scope_patch(imp.param_patch or {}, getattr(imp, "edit_scope", None))
        rejected_paths.extend(rejected)
        new_mapping.update(patch.get("mapping") or {})
        new_options = _merge_apply_options(new_options, patch.get("options") or {})
        new_preset = patch.get("style_preset") or new_preset
        _merge_touched_patch(combined_patch, patch)
        if imp.suggestion_type:
            labels.append(str(imp.suggestion_type))

    if not (combined_patch.get("mapping") or combined_patch.get("options") or combined_patch.get("style_preset")):
        # Same guard as apply_improvement: a selection made up entirely of
        # zero-patch informational rows must not render a no-op version.
        raise BadRequestError("The selected suggestions have no applicable parameter changes.", error_code="NOTHING_TO_APPLY")

    class _Req:
        mapping = new_mapping
        options = new_options
        style_preset = new_preset
        base_version_id = expected_base_version_id
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
    return _finalize_apply_response(
        db, fig, owner_id, base, new_version, combined_patch, result, verify, authoritative_request,
        allow_retry=allow_retry,
        verification_request=verification_request,
        edit_scopes=selected_scopes,
        pre_dropped_keys=rejected_paths,
    )


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
        # Optional coordinate space: keep only the two known values. Absence
        # (or anything else) means data coordinates. When relative, x/y/x2/y2
        # are fractions of the panel, so clamp them to [0,1].
        coord = item.get("coord")
        if isinstance(coord, str) and coord in ("data", "relative"):
            entry["coord"] = coord
            if coord == "relative":
                for coord_key in ("x", "y", "x2", "y2"):
                    if coord_key in entry:
                        entry[coord_key] = max(0.0, min(1.0, entry[coord_key]))
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


def _sanitize_element_overrides(
    value: Any, plot_type: str | None = None,
) -> dict[str, dict[str, str]] | None:
    """Sanitize stable scene-element visual overrides.

    This map is intentionally much narrower than a generic ggplot layer:
    only renderer-issued IDs for the active plot type and literal fill/stroke
    colors are retained. No geometry, data, labels, alpha, width, or arbitrary
    R values can cross this boundary. The bounded map also prevents a crafted
    request from producing an unreasonably large R script.
    """
    if not isinstance(value, dict):
        return None
    allowed_pattern = _ELEMENT_MARK_ID_RE_BY_PLOT.get(plot_type or "")
    # Internal legacy callers without a plot type still get a strict renderer
    # grammar, never an open-ended `mark:*` surface.
    allowed_patterns = (
        (allowed_pattern,)
        if allowed_pattern is not None
        else tuple(_ELEMENT_MARK_ID_RE_BY_PLOT.values())
    )
    cleaned: dict[str, dict[str, str]] = {}
    for raw_id, raw_style in value.items():
        if len(cleaned) >= _MAX_ELEMENT_OVERRIDES:
            break
        if not isinstance(raw_id, str) or not isinstance(raw_style, dict):
            continue
        element_id = raw_id.strip()
        if (
            not element_id
            or len(element_id) > _MAX_ELEMENT_ID_LENGTH
            or not any(pattern.fullmatch(element_id) for pattern in allowed_patterns)
        ):
            continue
        style: dict[str, str] = {}
        for field in ("fill", "stroke"):
            color = _clean_hex(raw_style.get(field))
            if color is not None:
                style[field] = color
        if style:
            cleaned[element_id] = style
    return cleaned or None


def _sanitize_option(
    key: str,
    value: Any,
    valid_columns: set[str] | None = None,
    *,
    plot_type: str | None = None,
) -> Any:
    if key in {"title", "subtitle", "legend_title", "x_label", "y_label"} and value == "":
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
    if key in {"axis_break_x", "axis_break_y"}:
        # A single [from, to] break range: exactly 2 finite floats with from<to.
        # Any other shape drops the key entirely so the render cannot break.
        if not isinstance(value, (list, tuple)) or len(value) != 2:
            return None
        try:
            lo = float(value[0])
            hi = float(value[1])
        except (TypeError, ValueError):
            return None
        if not (math.isfinite(lo) and math.isfinite(hi)) or lo >= hi:
            return None
        return [lo, hi]
    if key == "annotations":
        return _sanitize_annotations(value)
    if key == "series_styles":
        return _sanitize_series_styles(value)
    if key == "element_overrides":
        return _sanitize_element_overrides(value, plot_type)
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
        if key == "base_size":
            # Absolute font size in points: integer, clamped to a sane range.
            return int(max(5, min(14, round(num))))
        if key == "linewidth_scale":
            # Global line-thickness multiplier (×default). Clamped so it can
            # never zero out lines or blow them up. 1.0 == the figure default.
            return max(0.25, min(4.0, num))
        if key in {"axis_line_width_pt", "data_line_width_pt"}:
            # Publication tokens are stored in points and converted to ggplot2
            # millimetres only when the reproducible R script is generated.
            return max(0.1, min(3.0, num))
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
            sanitized = _sanitize_option(
                key, value, valid_columns, plot_type=str(pdef.get("type") or ""),
            )
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


def _authorization_patch_key_paths(patch: dict[str, Any] | None) -> list[str]:
    """Flatten security-sensitive nested option patches to leaf paths."""
    paths = _patch_key_paths(patch)
    if not isinstance(patch, dict) or not isinstance(patch.get("options"), dict):
        return paths
    options = patch["options"]
    for key in ("category_colors", "series_styles", "element_overrides"):
        value = options.get(key)
        if not isinstance(value, dict):
            continue
        parent = f"options.{key}"
        paths = [path for path in paths if path != parent]
        for first, child in value.items():
            if isinstance(child, dict):
                paths.extend(f"{parent}.{first}.{leaf}" for leaf in child)
            else:
                paths.append(f"{parent}.{first}")
    return paths


def _score_value(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


_RECOMMENDATION_SCORE_KEYS = (
    "data_structure_fit",
    "user_intent_match",
    "statistical_suitability",
    "overall",
)


def _bounded_recommendation_score(value: Any, fallback: float = 0.0) -> float:
    parsed = _score_value(value)
    if parsed is None:
        parsed = fallback
    return max(0.0, min(1.0, parsed))


def _replicate_id_column(semantic_values: dict[str, Any], column_names: set[str]) -> str | None:
    """Return an explicitly identified repeated-unit column, never a group guess."""
    for key in (
        "subject_id", "participant_id", "replicate_id", "sample_id",
        "subject", "participant", "replicate",
    ):
        value = semantic_values.get(key)
        if isinstance(value, str) and value in column_names:
            return value

    candidates = []
    for column_name in column_names:
        normalized = _normalized_semantic_key(column_name)
        if re.search(
            r"^(?:subject|participant|replicate|sample)(?:_?id)?$|"
            r"^(?:subject|participant|replicate|sample)_id(?:_|$)",
            normalized,
        ):
            candidates.append(column_name)
    return candidates[0] if len(candidates) == 1 else None


def _individual_observation_support(*, plot_type: str, requested: bool,
                                    has_replicate_id: bool) -> dict[str, str]:
    """Report whether the concrete renderer/options satisfy raw-point intent.

    This is deliberately based on generated renderer behavior rather than the
    provider's prose.  In particular, the current line template groups only by
    its display-group mapping; it cannot group trajectories by a separate
    subject/replicate ID.
    """
    if not requested:
        return {"status": "not_requested", "mode": "not_requested"}
    if plot_type == "grouped_bar":
        return {"status": "satisfied", "mode": "individual_points_with_summary"}
    if plot_type in {"box", "violin", "scatter", "sina", "curve_fit"}:
        return {"status": "satisfied", "mode": "individual_points"}
    if plot_type == "line":
        return {
            "status": "selection_required",
            "mode": "raw_trajectories",
            "reason": (
                "renderer_cannot_group_by_replicate"
                if has_replicate_id else "replicate_id_required"
            ),
        }
    return {
        "status": "unsupported",
        "mode": "summary_only",
        "reason": "renderer_does_not_show_individual_observations",
    }


def _line_recommendation_policy(*, show_individual: bool, replicate_id: str | None,
                                suggested_options: dict[str, Any]) -> dict[str, Any]:
    """Describe only line behavior the current renderer can actually produce."""
    del suggested_options  # Reserved for a future explicit summary renderer.
    if not show_individual:
        return {
            "replicate_id_column": replicate_id,
            "raw_trajectory_grouping": "not_requested",
            "same_time_replicates": "do_not_connect_without_aggregation",
            "summary_mode": "not_configured",
            "error_summary": "none",
            "support_status": "not_requested",
            "requires_confirmation": False,
        }
    return {
        "replicate_id_column": replicate_id,
        # Even when the ID is known, it is not a line mapping supported by the
        # renderer. Never advertise within-replicate grouping until generated R
        # actually uses that column.
        "raw_trajectory_grouping": (
            "not_supported_by_renderer" if replicate_id else "replicate_id_required"
        ),
        "same_time_replicates": "do_not_connect_without_aggregation",
        "summary_mode": "selection_required",
        "error_summary": "none",
        "support_status": "selection_required",
        "blocking_reason": (
            "renderer_cannot_group_by_replicate"
            if replicate_id else "replicate_id_required"
        ),
        "requires_confirmation": True,
    }


def _recommendation_score_breakdown(
    raw: dict[str, Any], *, plot_type: str,
    show_individual: bool, has_replicate_id: bool,
    mapping_complete: bool,
    individual_support: dict[str, str] | None = None,
) -> dict[str, float]:
    """Normalize provider/legacy scores and enforce explicit presentation intent."""
    raw_scores = raw.get("scores") if isinstance(raw.get("scores"), dict) else {}
    legacy_score = _bounded_recommendation_score(raw.get("score"))
    data_fit = _bounded_recommendation_score(
        raw_scores.get("data_structure_fit"), legacy_score
    )
    intent_match = _bounded_recommendation_score(
        raw_scores.get("user_intent_match"), data_fit
    )
    statistical_fit = _bounded_recommendation_score(
        raw_scores.get("statistical_suitability"), data_fit
    )

    if show_individual:
        # Explicit presentation intent is checked against concrete renderer
        # behavior. Statistical suitability remains the provider/rule score:
        # showing points does not prove that a statistical design is suitable.
        support = individual_support or _individual_observation_support(
            plot_type=plot_type,
            requested=True,
            has_replicate_id=has_replicate_id,
        )
        if support.get("status") == "satisfied":
            intent_match = {
                "grouped_bar": 1.0,
                "box": 0.98,
                "violin": 0.96,
                "sina": 0.96,
                "scatter": 0.94,
                "curve_fit": 0.72,
            }.get(plot_type, 0.9)
        elif support.get("status") == "selection_required":
            intent_match = 0.25 if has_replicate_id else 0.15
        else:
            intent_match = (
                0.3 if plot_type == "error_bar"
                else 0.15 if plot_type == "bar"
                else 0.25
            )
        overall = 0.35 * data_fit + 0.45 * intent_match + 0.20 * statistical_fit
    else:
        overall = 0.45 * data_fit + 0.25 * intent_match + 0.30 * statistical_fit

    if not mapping_complete:
        overall *= 0.6
    values = {
        "data_structure_fit": data_fit,
        "user_intent_match": intent_match,
        "statistical_suitability": statistical_fit,
        "overall": overall,
    }
    return {
        key: round(_bounded_recommendation_score(values[key]), 4)
        for key in _RECOMMENDATION_SCORE_KEYS
    }


_INDIVIDUAL_OBSERVATIONS_RE = re.compile(
    r"(?:\b(?:individual|raw)\s+(?:replicates?|observations?|data\s*points?)\b|"
    r"\b(?:show|display|include|plot)\s+(?:all|each|the)?\s*(?:individual\s+)?(?:replicates?|observations?|data\s*points?)\b|"
    r"개별\s*(?:replicate|replicates|반복(?:값|측정)?|관측(?:값)?|데이터|점)|"
    r"(?:replicate|replicates|반복(?:값|측정)?)\s*(?:도|를|을)?\s*(?:표시|보여|포함))",
    re.IGNORECASE,
)

# `required_vars` is semantic by design, while `suggested_mapping` must use the
# exact renderer keys. Providers occasionally return a useful semantic value
# (for example {"series": "Time"}) but omit the renderer's required `group`
# key. These aliases repair only values that are real dataset columns; they
# never guess a column from its position or fabricate one.
_RECOMMENDATION_MAPPING_ALIASES: dict[str, tuple[str, ...]] = {
    "x": ("x", "category", "genotype", "time"),
    "y": ("y", "value", "expression", "response", "measurement"),
    "group": ("group", "series", "genotype", "method", "condition", "treatment", "time", "status", "category", "color", "colour"),
    "value": ("value", "y", "expression", "response", "measurement"),
    "axis": ("axis", "metric"),
    "columns": ("columns", "features", "values"),
}

_LINE_GROUP_ALIASES = (
    "group", "series", "genotype", "method", "condition", "treatment",
    "status", "category", "color", "colour", "cohort", "arm",
)
_LINE_GROUP_INTENT_RE = re.compile(
    r"\b(?:groups?|series|genotypes?|methods?|conditions?|treatments?|cohorts?|arms?)\b|"
    r"(?:그룹|집단|조건|처리군|대조군|유전자형|계열|군별|별도\s*선)",
    re.IGNORECASE,
)


def _normalized_semantic_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower()).strip("_")


def _valid_recommendation_mapping_value(value: Any, *, multi: bool,
                                        column_names: set[str]) -> Any | None:
    if multi:
        if not isinstance(value, list):
            return None
        clean = [item for item in value if isinstance(item, str) and item in column_names]
        return clean or None
    if isinstance(value, str) and value in column_names:
        return value
    return None


def _prepare_recommendations(suggestions: list[dict], column_names: set[str],
                             chart_prompt: str | None = None,
                             *, column_profile: list[dict[str, Any]] | None = None) -> list[dict]:
    """Validate/repair recommendations before either persistence or response.

    The returned contract explicitly reports incomplete required mappings and
    carries structured user intent plus renderer-supported options. This keeps
    a high model fit score from being mistaken for a render-ready mapping.
    """
    parsed_individual_intent = bool(_INDIVIDUAL_OBSERVATIONS_RE.search(chart_prompt or ""))
    prepared: list[dict] = []
    for raw in suggestions or []:
        if not isinstance(raw, dict):
            continue
        plot_type = str(raw.get("plot_type") or "")
        try:
            pdef = _plot_def(plot_type)
        except BadRequestError:
            continue

        required = pdef.get("required", [])
        optional = pdef.get("optional", [])
        fields = {field["key"]: field for field in [*required, *optional]}
        mapping: dict[str, Any] = {}
        raw_mapping = raw.get("suggested_mapping")
        if isinstance(raw_mapping, dict):
            for key, value in raw_mapping.items():
                field = fields.get(key)
                if not field:
                    continue
                clean = _valid_recommendation_mapping_value(
                    value,
                    multi=bool(field.get("multi")),
                    column_names=column_names,
                )
                if clean is not None:
                    mapping[key] = clean

        required_vars = raw.get("required_vars") if isinstance(raw.get("required_vars"), dict) else {}
        semantic_values = {
            _normalized_semantic_key(key): value for key, value in required_vars.items()
        }
        existing_intent = raw.get("intent") if isinstance(raw.get("intent"), dict) else {}
        # Also accept a provider putting semantic aliases directly into the
        # suggested mapping (e.g. `series`) while still dropping that invalid
        # alias from the final renderer mapping.
        if isinstance(raw_mapping, dict):
            for key, value in raw_mapping.items():
                semantic_values.setdefault(_normalized_semantic_key(key), value)

        # Provider/cache compatibility: an observed recommendation encoded a
        # categorical series as unsupported mapping.y2.  For the two templates
        # where that payload is unambiguous in practice, move the real column to
        # their group field instead of presenting a blank required/optional
        # series selector.  Do not apply this broadly to templates that truly
        # support a second-y mapping.
        legacy_y2_column: str | None = None
        if (
            plot_type in {"grouped_bar", "line"}
            and "group" in fields
            and "y2" not in fields
            and isinstance(raw_mapping, dict)
        ):
            legacy_series = _valid_recommendation_mapping_value(
                raw_mapping.get("y2"),
                multi=False,
                column_names=column_names,
            )
            used_columns = {
                item
                for mapped in mapping.values()
                for item in (mapped if isinstance(mapped, list) else [mapped])
                if isinstance(item, str)
            }
            group_aliases = (
                "group", "series", "genotype", "method", "condition",
                "treatment", "status", "category", "color", "colour",
            ) + (("time",) if plot_type == "grouped_bar" else ())
            semantic_group_values = {
                _valid_recommendation_mapping_value(
                    semantic_values.get(alias), multi=False, column_names=column_names
                )
                for alias in group_aliases
            }
            normalized_legacy_name = _normalized_semantic_key(legacy_series)
            name_signals_group = any(
                normalized_legacy_name == alias
                or normalized_legacy_name.startswith(f"{alias}_")
                or normalized_legacy_name.endswith(f"_{alias}")
                for alias in group_aliases
            )
            group_evidence = legacy_series in semantic_group_values or name_signals_group
            if legacy_series is not None and legacy_series not in used_columns:
                if group_evidence:
                    if "group" not in mapping:
                        mapping["group"] = legacy_series
                elif plot_type == "line":
                    # A non-categorical line y2 is a secondary numeric axis,
                    # represented by an option rather than a mapping field.
                    legacy_y2_column = legacy_series

        if plot_type == "grouped_bar":
            genotype_candidate = _valid_recommendation_mapping_value(
                semantic_values.get("genotype"), multi=False, column_names=column_names
            )
            time_candidate = _valid_recommendation_mapping_value(
                semantic_values.get("time"), multi=False, column_names=column_names
            )
            used_columns = {
                item
                for mapped in mapping.values()
                for item in (mapped if isinstance(mapped, list) else [mapped])
                if isinstance(item, str)
            }
            if (
                "x" not in mapping
                and genotype_candidate is not None
                and genotype_candidate not in used_columns
            ):
                mapping["x"] = genotype_candidate
            used_columns = {
                item
                for mapped in mapping.values()
                for item in (mapped if isinstance(mapped, list) else [mapped])
                if isinstance(item, str)
            }
            if "group" not in mapping and time_candidate is not None and time_candidate not in used_columns:
                mapping["group"] = time_candidate

        if plot_type == "grouped_bar" and "group" not in mapping:
            # In a grouped bar the time/series semantic belongs to the grouped
            # series in the reported workflow (Genotype on x, Time as series).
            # Reserve it before general x-alias repair so the same Time column
            # cannot be consumed by both x and group.
            used_columns = {
                item
                for mapped in mapping.values()
                for item in (mapped if isinstance(mapped, list) else [mapped])
                if isinstance(item, str)
            }
            for alias in ("group", "series", "method", "condition", "treatment", "time", "status", "category", "genotype", "color", "colour"):
                candidate = _valid_recommendation_mapping_value(
                    semantic_values.get(alias),
                    multi=False,
                    column_names=column_names,
                )
                if candidate is not None and candidate not in used_columns:
                    mapping["group"] = candidate
                    break

        for field in required:
            key = field["key"]
            multi = bool(field.get("multi"))
            current = _valid_recommendation_mapping_value(
                mapping.get(key),
                multi=multi,
                column_names=column_names,
            )
            if current is not None:
                continue
            aliases = _RECOMMENDATION_MAPPING_ALIASES.get(key, (key,))
            used_columns = {
                item
                for mapped_key, mapped in mapping.items()
                if mapped_key != key
                for item in (mapped if isinstance(mapped, list) else [mapped])
                if isinstance(item, str)
            }
            # Explicit provider semantics outrank column-name heuristics. This
            # preserves line/scatter required_vars.time -> x even when a
            # different column happens to be named Genotype.
            for alias in aliases:
                candidate = _valid_recommendation_mapping_value(
                    semantic_values.get(alias),
                    multi=multi,
                    column_names=column_names,
                )
                candidate_items = candidate if isinstance(candidate, list) else [candidate]
                if candidate is not None and not any(item in used_columns for item in candidate_items):
                    mapping[key] = candidate
                    break
            if key in mapping or multi:
                continue
            # With no usable semantic value, match one real column by alias
            # priority and never reuse a column already assigned elsewhere.
            for alias in aliases:
                name_candidates = []
                for column_name in column_names - used_columns:
                    normalized_name = _normalized_semantic_key(column_name)
                    if (
                        normalized_name == alias
                        or normalized_name.startswith(f"{alias}_")
                        or normalized_name.endswith(f"_{alias}")
                    ):
                        name_candidates.append(column_name)
                if len(name_candidates) == 1:
                    mapping[key] = name_candidates[0]
                    break

        # A display group is optional for an ungrouped line, but becomes part
        # of the recommendation contract as soon as the provider/user says the
        # line is split by group/series. Providers sometimes return only x/y
        # even though the focused dataset has a clear group-role column. Repair
        # that omission deterministically; when more than one group-role column
        # remains, report the ambiguity instead of selecting the first column.
        line_group_required = False
        line_group_candidates: list[str] = []
        if plot_type == "line" and "group" in fields:
            used_columns = {
                item
                for mapped_key, mapped in mapping.items()
                if mapped_key != "group"
                for item in (mapped if isinstance(mapped, list) else [mapped])
                if isinstance(item, str)
            }
            explicit_group_keys = [alias for alias in _LINE_GROUP_ALIASES if alias in semantic_values]
            explicit_group_candidates: list[str] = []
            for alias in explicit_group_keys:
                candidate = _valid_recommendation_mapping_value(
                    semantic_values.get(alias), multi=False, column_names=column_names
                )
                if (
                    isinstance(candidate, str)
                    and candidate not in used_columns
                    and candidate not in explicit_group_candidates
                ):
                    explicit_group_candidates.append(candidate)

            intent_text = " ".join(
                str(value or "")
                for value in (
                    chart_prompt,
                    raw.get("title"),
                    raw.get("rationale"),
                )
            )
            normalized_intent_text = f"_{_normalized_semantic_key(intent_text)}_"
            line_group_required = bool(
                existing_intent.get("group_mapping_required")
                or explicit_group_keys
                or _LINE_GROUP_INTENT_RE.search(intent_text)
            )

            if "group" not in mapping and len(explicit_group_candidates) == 1:
                mapping["group"] = explicit_group_candidates[0]

            if "group" not in mapping:
                profiled_candidates: list[str] = []
                fallback_candidates: list[str] = []
                for column in column_profile or []:
                    if not isinstance(column, dict):
                        continue
                    name = column.get("name")
                    role = _normalized_semantic_key(column.get("role"))
                    if not isinstance(name, str) or name not in column_names or name in used_columns:
                        continue
                    if role == "group" and name not in profiled_candidates:
                        profiled_candidates.append(name)
                    elif role in {"category", "status"} and name not in fallback_candidates:
                        fallback_candidates.append(name)

                # Profile roles are authoritative. Name matching is retained
                # for old cached/unit payloads that predate profile propagation.
                role_candidates = profiled_candidates or fallback_candidates
                if not role_candidates and column_profile is None:
                    for column_name in sorted(column_names - used_columns):
                        normalized_name = _normalized_semantic_key(column_name)
                        if any(
                            normalized_name == alias
                            or normalized_name.startswith(f"{alias}_")
                            or normalized_name.endswith(f"_{alias}")
                            for alias in _LINE_GROUP_ALIASES
                        ):
                            role_candidates.append(column_name)

                # A named candidate in the objective/title is unambiguous even
                # when the dataset contains several legitimate group columns.
                mention_pool = profiled_candidates + [
                    candidate for candidate in fallback_candidates
                    if candidate not in profiled_candidates
                ]
                if column_profile is None:
                    mention_pool = role_candidates
                mentioned_candidates = [
                    candidate for candidate in mention_pool
                    if f"_{_normalized_semantic_key(candidate)}_" in normalized_intent_text
                ]
                if len(mentioned_candidates) == 1:
                    mapping["group"] = mentioned_candidates[0]
                    line_group_required = True
                elif len(role_candidates) == 1:
                    mapping["group"] = role_candidates[0]
                else:
                    line_group_candidates = list(role_candidates)

            if "group" in mapping:
                line_group_candidates = [str(mapping["group"])]
            elif explicit_group_candidates:
                line_group_candidates = explicit_group_candidates

        missing = []
        for field in required:
            if _valid_recommendation_mapping_value(
                mapping.get(field["key"]),
                multi=bool(field.get("multi")),
                column_names=column_names,
            ) is None:
                missing.append({"key": field["key"], "label": field["label"]})

        if (
            plot_type == "line"
            and line_group_required
            and _valid_recommendation_mapping_value(
                mapping.get("group"), multi=False, column_names=column_names
            ) is None
        ):
            missing.append({"key": "group", "label": fields["group"]["label"]})

        show_individual = parsed_individual_intent or bool(existing_intent.get("show_individual_observations"))

        option_definitions = {option["key"]: option for option in pdef.get("options", [])}
        allowed_options = set(option_definitions) | _UNIVERSAL_OPTION_KEYS
        suggested_options: dict[str, Any] = {}
        raw_options = raw.get("suggested_options")
        if isinstance(raw_options, dict):
            for key, value in raw_options.items():
                if key not in allowed_options:
                    continue
                clean = _sanitize_option(
                    key, value, column_names, plot_type=plot_type,
                )
                choices = option_definitions.get(key, {}).get("choices")
                if choices and clean not in choices:
                    continue
                if clean is not None:
                    suggested_options[key] = clean
        if legacy_y2_column is not None and "y2_column" not in suggested_options:
            suggested_options["y2_column"] = legacy_y2_column

        # Deterministic intent bridge: a free-text request for individual
        # replicates must not disappear merely because a provider omitted
        # optional JSON fields. Only enable options the chosen renderer uses.
        if show_individual:
            if plot_type == "grouped_bar":
                suggested_options.update({
                    "stat": "mean",
                    "show_points": True,
                    "error_bars": True,
                    "error_type": "sd",
                })
            elif plot_type in {"box", "violin", "curve_fit"}:
                suggested_options["show_points"] = True

        replicate_id = _replicate_id_column(semantic_values, column_names) if plot_type == "line" else None
        individual_support = _individual_observation_support(
            plot_type=plot_type,
            requested=show_individual,
            has_replicate_id=replicate_id is not None,
        )
        intent = dict(existing_intent)
        intent["show_individual_observations"] = show_individual
        intent["individual_observation_support"] = individual_support
        if plot_type == "line":
            intent["group_mapping_required"] = line_group_required
            intent["group_mapping_status"] = (
                "satisfied"
                if isinstance(mapping.get("group"), str)
                else "selection_required" if line_group_required else "not_requested"
            )
            intent["group_mapping_candidates"] = line_group_candidates
            intent["line_policy"] = _line_recommendation_policy(
                show_individual=show_individual,
                replicate_id=replicate_id,
                suggested_options=suggested_options,
            )

        scores = _recommendation_score_breakdown(
            raw,
            plot_type=plot_type,
            show_individual=show_individual,
            has_replicate_id=replicate_id is not None,
            mapping_complete=not missing,
            individual_support=individual_support,
        )

        item = dict(raw)
        item["required_vars"] = required_vars
        item["suggested_mapping"] = mapping
        item["suggested_options"] = suggested_options
        item["intent"] = intent
        item["mapping_complete"] = not missing
        item["missing_required_mappings"] = missing
        item["scores"] = scores
        # Backward-compatible scalar with one unambiguous meaning.
        item["score"] = scores["overall"]
        prepared.append(item)

    prepared.sort(
        key=lambda item: _score_value((item.get("scores") or {}).get("overall")) or 0,
        reverse=True,
    )
    for rank, item in enumerate(prepared[:5], start=1):
        item["rank"] = rank
    return prepared[:5]


def _recommendation_record_to_item(row: Recommendation) -> dict[str, Any] | None:
    if row.plot_type == "_none":
        return None
    stored = row.required_vars if isinstance(row.required_vars, dict) else {}
    if "required_vars" in stored or "suggested_mapping" in stored:
        required_vars = stored.get("required_vars")
        suggested_mapping = stored.get("suggested_mapping")
        suggested_options = stored.get("suggested_options")
        intent = stored.get("intent")
        mapping_complete = stored.get("mapping_complete")
        missing_required_mappings = stored.get("missing_required_mappings")
        scores = stored.get("scores")
        fit = stored.get("fit")
        rank = stored.get("rank")
    else:
        required_vars = stored
        suggested_mapping = None
        suggested_options = None
        intent = None
        mapping_complete = None
        missing_required_mappings = None
        scores = None
        fit = None
        rank = None
    item: dict[str, Any] = {
        "plot_type": row.plot_type,
        "title": row.title,
        "score": _score_value(row.score),
        "rationale": row.rationale,
        "required_vars": required_vars if isinstance(required_vars, dict) else None,
        "suggested_mapping": suggested_mapping if isinstance(suggested_mapping, dict) else None,
        "suggested_options": suggested_options if isinstance(suggested_options, dict) else {},
        "intent": intent if isinstance(intent, dict) else {},
        "mapping_complete": mapping_complete if isinstance(mapping_complete, bool) else None,
        "missing_required_mappings": (
            missing_required_mappings if isinstance(missing_required_mappings, list) else []
        ),
        "scores": scores if isinstance(scores, dict) else {},
        "example_usage": row.example_usage,
        "source": row.source,
    }
    if isinstance(rank, int):
        item["rank"] = rank
    if isinstance(fit, str):
        item["fit"] = fit
    return item


def cached_recommendations(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID) -> tuple[list[dict], bool]:
    ds = ds_service.get_dataset(db, dataset_id, owner_id)
    rows = (
        db.query(Recommendation)
        .filter(Recommendation.dataset_id == dataset_id)
        .order_by(Recommendation.created_at.asc())
        .all()
    )
    if not rows:
        return [], False
    items = [item for row in rows if (item := _recommendation_record_to_item(row)) is not None]
    column_profile = ds_service.focused_column_profile(ds)
    focused_columns = _profile_column_names(column_profile)
    return _prepare_recommendations(
        items, focused_columns, column_profile=column_profile
    ), True


def _save_recommendations(db: Session, dataset_id: uuid.UUID, suggestions: list[dict],
                          column_names: set[str], chart_prompt: str | None = None,
                          *, column_profile: list[dict[str, Any]] | None = None) -> list[dict]:
    suggestions = _prepare_recommendations(
        suggestions, column_names, chart_prompt, column_profile=column_profile
    )
    db.query(Recommendation).filter(Recommendation.dataset_id == dataset_id).delete(synchronize_session=False)
    if not suggestions:
        db.add(Recommendation(dataset_id=dataset_id, plot_type="_none", source="ai", required_vars={"empty": True}))
        db.commit()
        return []
    for index, suggestion in enumerate(suggestions, start=1):
        payload = {
            "required_vars": suggestion.get("required_vars") if isinstance(suggestion.get("required_vars"), dict) else {},
            "suggested_mapping": suggestion.get("suggested_mapping") if isinstance(suggestion.get("suggested_mapping"), dict) else {},
            "suggested_options": suggestion.get("suggested_options") if isinstance(suggestion.get("suggested_options"), dict) else {},
            "intent": suggestion.get("intent") if isinstance(suggestion.get("intent"), dict) else {},
            "mapping_complete": bool(suggestion.get("mapping_complete")),
            "missing_required_mappings": suggestion.get("missing_required_mappings") if isinstance(suggestion.get("missing_required_mappings"), list) else [],
            "scores": suggestion.get("scores") if isinstance(suggestion.get("scores"), dict) else {},
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
    return suggestions


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
    return _save_recommendations(
        db, dataset_id, suggestions, _profile_column_names(column_profile), clean_prompt or None,
        column_profile=column_profile,
    )


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
    suggestions = ai_client.recommend_from_reference_image(
        db, column_profile, image_bytes, mime, project_context=ctx, user_id=owner_id,
        dataset_preview=(ds.preview or [])[:10],
    )
    return _prepare_recommendations(
        suggestions,
        _profile_column_names(column_profile),
        column_profile=column_profile,
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
