from __future__ import annotations

import os
import re
import shutil
import uuid
import xml.etree.ElementTree as ET
from types import SimpleNamespace
from typing import Any

from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from app.ai import client as ai_client
from app.auth.models import User
from app.common import storage
from app.common.exceptions import BadRequestError, NotFoundError
from app.common.quotas import enforce_render_quota
from app.config import settings
from app.datasets.models import Dataset
from app.datasets import service as ds_service
from app.figures.models import Figure, FigureCodeArtifact, FigureTemplateFavorite, FigureVersion, Improvement, Recommendation, Review
from app.palettes import service as palette_service
from app.projects.models import Project
from app.r_engine import renderer
from app.r_engine.presets import PRESETS
from app.r_engine.templates import PLOT_TYPES, PLOT_TYPE_KEYS, rq

_STATIC_ROOT = os.path.dirname(settings.figures_dir.rstrip("/"))
_UNIVERSAL_OPTION_KEYS = {
    "palette_name", "size", "width_in", "height_in", "color_mode", "font_scale", "dpi",
    "title", "subtitle", "x_label", "y_label", "legend_title",
    "hide_legend", "log_x", "log_y", "flip_coords", "x_text_angle", "legend_position",
    "y_min", "y_max",
    "custom_palette_values", "custom_palette_label",
}
_OPTION_CHOICES = {
    "palette_name": {"preset", "journal_muted", "okabe_ito", "tol_bright", "set2", "npg", "tableau10"},
    "size": {"single_column", "wide", "double_column", "square", "custom"},
    "color_mode": {"color", "grayscale"},
    "stat": {"mean", "sum", "count"},
    "palette": {"viridis", "magma", "inferno", "plasma", "cividis"},
    "corr_method": {"pearson", "spearman"},
    "layout": {"fr", "kk", "circle", "stress"},
    "legend_position": {"right", "bottom", "none"},
    "line_type": {"solid", "dashed", "dotted", "dotdash", "longdash"},
    "point_shape": {"circle", "square", "triangle", "diamond", "none"},
}
_BOOL_OPTIONS = {
    "show_points", "show_box", "error_bars", "scale_rows", "add_smooth", "show_density", "show_rug",
    "show_values", "hide_legend", "log_x", "log_y", "flip_coords", "connect_points", "show_contour_lines",
    "cluster_rows", "cluster_cols", "show_row_names", "show_labels", "color_bars", "paired_rows_only",
}
_NUMBER_OPTIONS = {
    "fc_threshold", "p_threshold", "label_top", "font_scale", "dpi", "width_in", "height_in",
    "bins", "sig_threshold", "bar_alpha", "bar_width", "x_text_angle", "y_min", "y_max",
}
_MAX_SVG_BYTES = 5 * 1024 * 1024
_BLOCKED_SVG_TAGS = {"script", "foreignobject", "iframe", "object", "embed", "link"}


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


def sanitize_options(plot_type: str, options: dict | None) -> dict:
    pdef = _plot_def(plot_type)
    allowed_options = {o["key"] for o in pdef.get("options", [])} | _UNIVERSAL_OPTION_KEYS
    clean: dict[str, Any] = {}
    if not isinstance(options, dict):
        return clean
    for key, value in options.items():
        if key not in allowed_options:
            continue
        sanitized = _sanitize_option(key, value)
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
    style_preset = fig.style_preset
    if version:
        thumb_path = version.png_path or version.svg_path
        source_version_id = version.id
        style_preset = version.style_preset or fig.style_preset
    return {
        "id": favorite.id,
        "figure_id": fig.id,
        "source_version_id": source_version_id,
        "name": favorite.name or fig.name,
        "figure_name": fig.name,
        "plot_type": fig.plot_type,
        "style_preset": style_preset,
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
    rows = q.order_by(Figure.updated_at.desc()).all()
    favorite_ids = _favorite_figure_ids(db, owner_id, [f.id for f, _ in rows])
    out = []
    for f, png_path in rows:
        out.append({
            "id": f.id, "name": f.name, "plot_type": f.plot_type, "style_preset": f.style_preset,
            "status": f.status, "dataset_id": f.dataset_id, "project_id": f.project_id,
            "created_at": f.created_at, "updated_at": f.updated_at,
            "is_favorite": f.id in favorite_ids,
            "thumb_url": _url(png_path),
        })
    return sorted(out, key=lambda item: (item["is_favorite"], item["updated_at"]), reverse=True)


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
        db.query(Figure, FigureVersion, Dataset.name, Project.name, User.display_name, User.email)
        .join(FigureVersion, Figure.current_version_id == FigureVersion.id)
        .outerjoin(Dataset, Figure.dataset_id == Dataset.id)
        .outerjoin(Project, Figure.project_id == Project.id)
        .outerjoin(User, Figure.owner_id == User.id)
        .filter(Figure.current_version_id.isnot(None), Figure.status == "ready")
        .order_by(Figure.updated_at.desc())
        .limit(limit)
        .all()
    )

    out = []
    for f, current, dataset_name, project_name, owner_name, owner_email in rows:
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
            "owner_name": owner_name,
            "owner_email": owner_email,
            "current_version_id": f.current_version_id,
            "created_at": f.created_at,
            "updated_at": f.updated_at,
            "is_favorite": bool(f.is_favorite),
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
        "versions": [version_response(v) for v in sorted(fig.versions, key=lambda x: x.version_number)],
    }


def update_figure(db: Session, figure_id: uuid.UUID, owner_id: uuid.UUID, data: dict) -> dict:
    favorite_value = data.pop("is_favorite", None) if "is_favorite" in data else None
    metadata = {k: v for k, v in data.items() if k in {"name", "description", "legend"} and v is not None}
    if metadata:
        fig = get_figure(db, figure_id, owner_id, write=True)
        for key, value in metadata.items():
            setattr(fig, key, value)
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
    if favorite:
        favorite.source_version_id = source_version.id if source_version else None
        favorite.name = cleaned_name
    else:
        favorite = FigureTemplateFavorite(
            user_id=owner_id,
            figure_id=figure_id,
            source_version_id=source_version.id if source_version else None,
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
    options = sanitize_options(data.plot_type, data.options)
    options = _resolve_custom_palette_options(db, owner_id, options)
    df = ds_service.load_dataframe(ds)

    figure_id = uuid.uuid4()
    version_id = uuid.uuid4()
    res, _ = _render_into_version(df, data.plot_type, data.mapping, options, preset, figure_id, version_id)

    fig = Figure(
        id=figure_id, owner_id=owner_id, dataset_id=ds.id, project_id=ds.project_id, name=data.name,
        plot_type=data.plot_type, style_preset=preset, status="ready",
        current_version_id=version_id,
    )
    db.add(fig)
    db.flush()
    version = FigureVersion(
        id=version_id, figure_id=figure_id, version_number=1,
        mapping=data.mapping, options=options, style_preset=preset,
        r_code=res.r_code, change_note="Initial figure",
        png_path=res.outputs.get("png"), svg_path=res.outputs.get("svg"),
        tiff_path=res.outputs.get("tiff"), pdf_path=res.outputs.get("pdf"),
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
        patch = _combined_quality_patch(suggestions, pdef, mapping or {}, options or {}, preset)
        _drop_unneeded_auto_x_rotation(patch, df, mapping or {}, options or {})
        if not patch:
            return
        new_mapping = {**(mapping or {}), **(patch.get("mapping") or {})}
        new_options = {**(options or {}), **(patch.get("options") or {})}
        new_preset = patch.get("style_preset") or preset
        validate_mapping(plot_type, new_mapping)
        new_options = sanitize_options(plot_type, new_options)
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
            r_path=res.outputs.get("r"),
            render_log=res.log,
        )
        db.add(corrected)
        fig.current_version_id = corrected_id
        fig.style_preset = new_preset
        fig.status = "ready"
        for suggestion in suggestions:
            clean = _sanitize_param_patch(suggestion.get("param_patch", {}), pdef, mapping or {})
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
                            base_options: dict[str, Any], base_preset: str) -> dict[str, Any]:
    combined: dict[str, Any] = {}
    for suggestion in suggestions or []:
        clean = _sanitize_param_patch(suggestion.get("param_patch", {}), pdef, base_mapping)
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
    options = sanitize_options(plot_type, options)
    options = _resolve_custom_palette_options(db, owner_id, options)

    ds = ds_service.get_dataset(db, fig.dataset_id, owner_id)
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
        png_path=None, svg_path=svg_path, tiff_path=None, pdf_path=None,
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

    file_refs = [version.png_path, version.svg_path, version.tiff_path, version.pdf_path, version.r_path]
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
                    prompt: str | None = None) -> list[Improvement]:
    fig = get_figure(db, figure_id, owner_id, write=True)
    v = get_version(fig, version_id)
    last_review = (db.query(Review).filter(Review.figure_version_id == version_id)
                   .order_by(Review.created_at.desc()).first())
    pdef = _plot_def(fig.plot_type)
    available = {"options": pdef.get("options", []),
                 "mapping_keys": [r["key"] for r in pdef["required"]] + [o["key"] for o in pdef.get("optional", [])]}
    suggestions = ai_client.improve_figure(
        db, fig.plot_type, v.mapping or {}, v.options or {}, fig.style_preset,
        last_review.payload if last_review else None, [available],
        project_context=_project_context(db, fig.project_id), user_id=owner_id,
        user_request=(prompt or "").strip() or None,
    )
    rows = []
    for s in suggestions:
        patch = _sanitize_param_patch(s.get("param_patch", {}), pdef, v.mapping or {})
        if not patch:
            continue
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
    if not rows:
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
    db.commit()
    for r in rows:
        db.refresh(r)
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
    imp.applied = True
    db.commit()
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
    for imp in ordered:
        imp.applied = True
    db.commit()
    return result


def _known_mapping_values(mapping: dict[str, Any]) -> set[str]:
    values: set[str] = set()
    for value in mapping.values():
        if isinstance(value, str) and value:
            values.add(value)
        elif isinstance(value, list):
            values.update(v for v in value if isinstance(v, str) and v)
    return values


def _sanitize_option(key: str, value: Any) -> Any:
    if value in (None, ""):
        return None
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
        if key == "bar_width":
            return max(0.2, min(1.0, num))
        if key == "x_text_angle":
            return max(0, min(90, num))
        if key in {"width_in", "height_in"}:
            return max(1.0, min(20.0, num))
        return num
    if isinstance(value, str):
        return value[:200]
    return None


def _sanitize_param_patch(patch: dict[str, Any], pdef: dict, base_mapping: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(patch, dict):
        return {}

    clean: dict[str, Any] = {}
    style = patch.get("style_preset")
    if isinstance(style, str) and style in PRESETS:
        clean["style_preset"] = style

    allowed_mapping = {r["key"] for r in pdef["required"]} | {o["key"] for o in pdef.get("optional", [])}
    known_columns = _known_mapping_values(base_mapping)
    mapping_patch = {}
    raw_mapping = patch.get("mapping")
    if isinstance(raw_mapping, dict):
        for key, value in raw_mapping.items():
            if key not in allowed_mapping:
                continue
            if isinstance(value, str) and value in known_columns:
                mapping_patch[key] = value
            elif isinstance(value, list):
                vals = [v for v in value if isinstance(v, str) and v in known_columns]
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
            sanitized = _sanitize_option(key, value)
            if sanitized is not None:
                options_patch[key] = sanitized
    if options_patch:
        clean["options"] = options_patch
    return clean


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
        .filter(Figure.id == figure_id, Figure.status == "ready")
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
