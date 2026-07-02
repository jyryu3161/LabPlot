from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import uuid

from sqlalchemy.orm import Session

from app.canvases.schemas import PreviewRenderRequest
from app.common import storage
from app.common.encryption import decrypt_private_bytes
from app.common.exceptions import BadRequestError
from app.config import settings
from app.datasets import service as ds_service
from app.datasets.models import Dataset
from app.figures import service as figures_service
from app.r_engine import renderer
from app.r_engine.presets import PRESETS

# mm clamps (design §5): panel 10-500 mm/side. Enforced again defensively here
# even though the request schema already validates the range, so a degenerate
# value can never reach the R device.
_PANEL_MM_MIN = 10.0
_PANEL_MM_MAX = 500.0

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


def _object_cache_ref(digest: str) -> str:
    return storage.object_uri(storage.object_key(*_PREVIEW_PARTS, f"{digest}.svg"))


def render_preview(db: Session, owner_id: uuid.UUID, req: PreviewRenderRequest) -> dict:
    """Ephemeral single-SVG preview render (design decision 4, §3, §4).

    Renders the figure's current (or pinned) version at a custom physical size
    with an optional color/base_size overlay, WITHOUT creating a FigureVersion
    and WITHOUT touching the rerender() path. Content-hash cached: an identical
    request returns the cached SVG with cached=True and never re-renders.
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
            return {"svg_url": figures_service._url(cache_ref), "cached": True}
    else:
        cache_path = _local_cache_path(digest)
        if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
            return {"svg_url": figures_service._url(cache_path), "cached": True}

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

        if storage.object_storage_enabled():
            key = storage.object_key(*_PREVIEW_PARTS, f"{digest}.svg")
            cache_ref = storage.upload_file(svg_src, key, content_type="image/svg+xml")
            return {"svg_url": figures_service._url(cache_ref), "cached": False}

        cache_path = _local_cache_path(digest)
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        shutil.copyfile(svg_src, cache_path)
        return {"svg_url": figures_service._url(cache_path), "cached": False}
