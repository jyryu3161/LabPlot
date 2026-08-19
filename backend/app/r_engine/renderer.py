"""Assemble a self-contained R script, execute it, collect output images."""
from __future__ import annotations

import math
import os
import re
import shutil
import subprocess
import tempfile
import uuid

import pandas as pd

from app.config import settings
from app.r_engine.presets import PRESETS, resolve_base_size, theme_r
from app.r_engine.templates import (
    DEFAULT_X_TEXT_ANGLE,
    DEVICE_TYPES,
    NO_THEME_TYPES,
    POST_THEME_R,
    build_plot_r,
    rq,
)

_SIZES = {
    "single_column": (3.6, 3.2),
    "wide": (7.0, 4.2),
    "double_column": (7.0, 4.2),
    "square": (4.5, 4.5),
}

_HEADER = (
    "suppressPackageStartupMessages({\n"
    "  library(ggplot2); library(dplyr); library(tidyr); library(readr); library(scales)\n"
    "})\n"
)
_HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
_SOURCE_ROW_ID_COLUMN = ".labplot_source_row_id"


def _source_row_identity(value: object) -> str:
    """Canonical, reorder-stable identity for a pandas source-row index.

    The type tag prevents an object index containing both ``1`` and ``"1"``
    from collapsing to one semantic point. Values are later URL-encoded by R;
    no part of this string is interpolated into executable code.
    """
    type_name = type(value).__name__
    text = str(value)
    return f"{type_name}:{text if text else '(empty)'}"


def _unused_source_row_id_column(columns: object) -> str:
    """Choose a renderer-private column without overwriting user data."""
    existing = {str(column) for column in columns}
    candidate = _SOURCE_ROW_ID_COLUMN
    suffix = 0
    while candidate in existing:
        suffix += 1
        candidate = f"{_SOURCE_ROW_ID_COLUMN}_{suffix}"
    return candidate


def _rscript_bin() -> str:
    if settings.RSCRIPT_PATH and os.path.isfile(settings.RSCRIPT_PATH):
        return settings.RSCRIPT_PATH
    found = shutil.which("Rscript")
    return found or settings.RSCRIPT_PATH


def _scrubbed_env(work: str) -> dict[str, str]:
    """Build a minimal environment for the R subprocess.

    The child must NOT inherit application secrets (JWT_SECRET,
    DATA_ENCRYPTION_KEY, DATABASE_URL, API keys, SMTP_PASSWORD, S3 credentials,
    ...). Only PATH plus a handful of R/locale variables are forwarded; HOME and
    TMPDIR are pinned to the disposable work directory.
    """
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": work,
        "TMPDIR": work,
    }
    for name in ("R_HOME", "R_LIBS", "R_LIBS_USER", "R_LIBS_SITE"):
        value = os.environ.get(name)
        if value:
            env[name] = value
    # Force a UTF-8 locale so R reads non-ASCII (e.g. CJK) CSV column names and
    # labels correctly. Without this the child inherits the container default
    # (often the "C" locale), and readr parses UTF-8 headers as bytes, so column
    # names like "개수" fail to match the UTF-8 strings embedded in the script.
    # Honor an explicitly-set UTF-8 parent locale, otherwise pin C.UTF-8.
    for name in ("LANG", "LC_ALL"):
        value = os.environ.get(name)
        env[name] = value if value and "UTF-8" in value.upper() else "C.UTF-8"
    return env


def _resource_limit_preexec():
    """Return a preexec_fn capping the R subprocess, or None when unsupported
    (e.g. Windows, or if the POSIX ``resource`` module is unavailable)."""
    try:
        import resource
    except Exception:
        return None

    cpu_seconds = int(settings.RENDER_TIMEOUT_SEC) + 10
    limits = (
        ("RLIMIT_AS", 2 * 1024 * 1024 * 1024),   # 2 GB address space
        ("RLIMIT_CPU", cpu_seconds),             # CPU seconds (timeout + buffer)
        ("RLIMIT_FSIZE", 200 * 1024 * 1024),     # 200 MB max output file size
    )

    def _apply() -> None:
        for name, limit in limits:
            res_id = getattr(resource, name, None)
            if res_id is None:
                continue
            try:
                _soft, hard = resource.getrlimit(res_id)
                if hard != resource.RLIM_INFINITY:
                    limit = min(limit, hard)
                resource.setrlimit(res_id, (limit, limit))
            except (ValueError, OSError):
                continue

    return _apply


def _dimensions(options: dict) -> tuple[float, float, int]:
    size = options.get("size", "wide")
    if size == "custom":
        w = float(options.get("width_in", 6.0) or 6.0)
        h = float(options.get("height_in", 4.0) or 4.0)
    else:
        w, h = _SIZES.get(size, _SIZES["wide"])
    dpi = int(options.get("dpi", 300) or 300)
    return w, h, dpi


def _finite_float_option(options: dict, key: str) -> float | None:
    try:
        value = float(options.get(key))
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


_FACET_SCALES = ("fixed", "free", "free_x", "free_y")


def _facet_r(options: dict) -> str:
    """facet_wrap snippet for `facet_by`, or "" when unset. Column via rq()."""
    col = options.get("facet_by")
    if not isinstance(col, str) or not col.strip():
        return ""
    scales = options.get("facet_scales")
    if scales not in _FACET_SCALES:
        scales = "fixed"
    return f'p <- p + facet_wrap(vars(.data[[{rq(col)}]]), scales = "{scales}")\n'


def _category_color_override_r(options: dict) -> str:
    raw = options.get("category_colors")
    if not isinstance(raw, dict):
        return ""
    items: list[tuple[str, str]] = []
    for level, color in raw.items():
        if not isinstance(level, str) or not isinstance(color, str):
            continue
        label = level.strip()
        hex_color = color.strip()
        if not label or not _HEX_COLOR_RE.fullmatch(hex_color):
            continue
        items.append((label[:120], hex_color.upper()))
    if not items:
        return ""
    vec = ", ".join(f"{rq(label)} = {rq(color)}" for label, color in items[:80])
    return f"""
labplot_apply_category_colors <- function(plot) {{
  .override <- c({vec})
  .apply <- function(current_plot, aesthetic, scale_fun) {{
    built <- tryCatch(ggplot2::ggplot_build(current_plot), error = function(e) NULL)
    if (is.null(built)) return(current_plot)
    sc <- built$plot$scales$get_scales(aesthetic)
    if (is.null(sc)) return(current_plot)
    is_discrete <- tryCatch(isTRUE(sc$is_discrete()), error = function(e) FALSE)
    if (!is_discrete) return(current_plot)
    limits <- tryCatch(sc$get_limits(), error = function(e) character())
    limits <- as.character(limits[!is.na(limits)])
    if (!length(limits)) return(current_plot)
    hits <- intersect(names(.override), limits)
    if (!length(hits)) return(current_plot)
    values <- if (identical(aesthetic, "colour")) labplot_stroke_palette(length(limits)) else labplot_palette(length(limits))
    names(values) <- limits
    values[hits] <- .override[hits]
    # Keep the original scale name so colour continues to merge with any
    # redundant linetype/shape guide created for the same grouping variable.
    suppressMessages(current_plot + scale_fun(name = sc$name, values = values))
  }}
  plot <- .apply(plot, "fill", ggplot2::scale_fill_manual)
  plot <- .apply(plot, "colour", ggplot2::scale_colour_manual)
  plot
}}
p <- labplot_apply_category_colors(p)
"""


def build_script(plot_type: str, mapping: dict, options: dict, preset: str,
                 data_filename: str = "data.csv", *,
                 source_row_id_column: str = _SOURCE_ROW_ID_COLUMN) -> str:
    if preset not in PRESETS:
        preset = "nature"
    if not re.fullmatch(r"\.labplot_source_row_id(?:_[0-9]+)?", source_row_id_column):
        source_row_id_column = _SOURCE_ROW_ID_COLUMN
    opts = {**(options or {}), "_source_row_id_column": source_row_id_column}
    color_mode = opts.get("color_mode", "color")
    # Sanitize before interpolating into the R comment so a stray newline/quote
    # cannot break out of the comment line. theme_r() only compares this value
    # (never interpolates it into R), so the raw value stays safe for palette logic.
    safe_color_mode = color_mode if color_mode in ("color", "grayscale") else "color"
    font_scale = opts.get("font_scale", 1.0)
    # Absolute base font size in pt. Single source of truth for both the ggplot
    # theme text size (theme_r base_size=) and the non-ggplot device pointsize.
    # A Python int (clamped 5-14 when base_size set, else legacy font_scale path)
    # so it is safe to interpolate directly into the generated R.
    resolved_pt = resolve_base_size(opts.get("base_size"), opts.get("font_scale", 1.0))
    plot_r = build_plot_r(plot_type, mapping, opts)
    w, h, dpi = _dimensions(opts)
    # svglite/ggsave require bg as a string, so use "transparent" (not NA) for
    # an alpha=0 background that every device (png/svg/tiff/cairo_pdf) accepts.
    bg_r = '"transparent"' if opts.get("transparent_background") else '"white"'
    head = ("# LabPlot AI - reproducible figure script\n"
            f"# plot type: {plot_type} | style: {preset} | color: {safe_color_mode}\n"
            "# generated with LabPlot academic figure rules: 7 pt text, restrained palettes, white background, no gridlines\n"
            + _HEADER
            + f'\ndf <- readr::read_csv("{data_filename}", show_col_types = FALSE)\n'
            + "df <- as.data.frame(df)\n"
            + f"if (!{rq(source_row_id_column)} %in% names(df)) "
              f"df[[{rq(source_row_id_column)}]] <- paste0('row:', seq_len(nrow(df)))\n"
            + f"df[[{rq(source_row_id_column)}]] <- as.character(df[[{rq(source_row_id_column)}]])\n")

    # ---- device-rendered plots (ComplexHeatmap etc.): template defines draw_plot() ----
    if plot_type in DEVICE_TYPES:
        export = f"""
.pdf_device <- if (isTRUE(capabilities("cairo"))) grDevices::cairo_pdf else grDevices::pdf
png("figure.png", width = {w} * {dpi}, height = {h} * {dpi}, res = {dpi}, pointsize = {resolved_pt}, bg = {bg_r}); draw_plot(); invisible(dev.off())
svglite::svglite("figure.svg", width = {w}, height = {h}, pointsize = {resolved_pt}, bg = {bg_r}); draw_plot(); invisible(dev.off())
tiff("figure.tiff", width = {w} * {dpi}, height = {h} * {dpi}, res = {dpi}, pointsize = {resolved_pt}, compression = "lzw", bg = {bg_r}); draw_plot(); invisible(dev.off())
.pdf_device("figure.pdf", width = {w}, height = {h}, pointsize = {resolved_pt}, bg = {bg_r}); draw_plot(); invisible(dev.off())
if (isTRUE(capabilities("cairo"))) {{
  tryCatch({{
    grDevices::cairo_ps("figure.eps", width = {w}, height = {h}, pointsize = {resolved_pt}, bg = {bg_r}, fallback_resolution = 600)
    draw_plot(); invisible(dev.off())
  }}, error = function(e) message("EPS export skipped: ", conditionMessage(e)))
}}
"""
        return head + plot_r + export

    # ---- ggplot-based plots ----
    theme_append = "" if plot_type in NO_THEME_TYPES else "\np <- p + labplot_theme()\n"
    # Template-intent theme tweaks (grid removal, blank axes, ...) that must
    # survive the complete labplot_theme(); user option-driven `post` lines are
    # appended after this so explicit settings always take precedence.
    theme_append += "" if plot_type in NO_THEME_TYPES else POST_THEME_R.get(plot_type, "")
    post = ""
    if plot_type not in NO_THEME_TYPES:
        lt = opts.get("legend_title")
        if lt:
            post += f"p <- p + labs(fill = {rq(lt)}, colour = {rq(lt)})\n"
        post += _category_color_override_r(opts)
        legend_position = opts.get("legend_position")
        legend_hidden = bool(opts.get("hide_legend")) or legend_position == "none"
        if legend_hidden:
            post += 'p <- p + theme(legend.position = "none")\n'
        elif legend_position in {"right", "bottom", "top", "left"}:
            post += f'p <- p + theme(legend.position = "{legend_position}")\n'
        legend_direction = opts.get("legend_direction")
        if not legend_hidden and legend_direction in {"vertical", "horizontal"}:
            # theme(legend.direction) covers discrete legends AND continuous
            # colourbars (guide_colourbar inherits it in ggplot2 >= 3.5).
            post += f'p <- p + theme(legend.direction = "{legend_direction}")\n'
        x_angle = opts.get("x_text_angle")
        if x_angle in (None, ""):
            # Template-default rotation (e.g. heatmap 45deg) rides the same
            # post-theme block so labplot_theme() can never reset it; an
            # explicit user option above always wins over the default.
            x_angle = DEFAULT_X_TEXT_ANGLE.get(plot_type)
        if x_angle not in (None, ""):
            try:
                angle = max(0, min(90, float(x_angle)))
                if angle < 30:
                    hjust, vjust = 0.5, 1.0
                elif angle >= 80:
                    # Near-vertical labels read top-to-bottom: end-anchor at
                    # the tick, centred on it horizontally.
                    hjust, vjust = 1.0, 0.5
                else:
                    # Diagonal labels: anchor the text END at the tick and its
                    # TOP edge against the axis. vjust=0.5 centred every label
                    # inside the tall rotated text band, which opened a ~20pt
                    # visual gap between the axis and the first glyph.
                    hjust, vjust = 1.0, 1.0
                # Tight explicit gap (~1.5pt) between the ticks and the labels;
                # a rendered x title keeps a modest 4pt offset below the band.
                title_margin = ", axis.title.x = element_text(margin = margin(t = 4))" if angle >= 30 else ""
                post += (
                    f"p <- p + theme(axis.text.x = element_text(angle = {angle:g}, "
                    f"hjust = {hjust:g}, vjust = {vjust:g}, "
                    f"margin = margin(t = 1.5)){title_margin})\n"
                )
            except (TypeError, ValueError):
                pass
        if opts.get("log_y"):
            post += "p <- p + scale_y_log10()\n"
        if opts.get("log_x"):
            post += "p <- p + scale_x_log10()\n"
        x_min = _finite_float_option(opts, "x_min")
        x_max = _finite_float_option(opts, "x_max")
        y_min = _finite_float_option(opts, "y_min")
        y_max = _finite_float_option(opts, "y_max")
        has_x_range = x_min is not None or x_max is not None
        has_y_range = y_min is not None or y_max is not None
        coord_args = []
        if has_x_range and (x_min is None or x_max is None or x_min < x_max):
            lower = "-Inf" if x_min is None else f"{x_min:g}"
            upper = "Inf" if x_max is None else f"{x_max:g}"
            coord_args.append(f"xlim = c({lower}, {upper})")
        if has_y_range and (y_min is None or y_max is None or y_min < y_max):
            lower = "-Inf" if y_min is None else f"{y_min:g}"
            upper = "Inf" if y_max is None else f"{y_max:g}"
            coord_args.append(f"ylim = c({lower}, {upper})")
        if coord_args:
            coord_fn = "coord_flip" if opts.get("flip_coords") else "coord_cartesian"
            post += f"p <- p + {coord_fn}({', '.join(coord_args)})\n"
        elif opts.get("flip_coords"):
            post += "p <- p + coord_flip()\n"
        hline = _finite_float_option(opts, "hline_at")
        if hline is not None:
            post += f'p <- p + geom_hline(yintercept = {hline:g}, linetype = "dashed", linewidth = 0.3, colour = "grey50")\n'
        vline = _finite_float_option(opts, "vline_at")
        if vline is not None:
            post += f'p <- p + geom_vline(xintercept = {vline:g}, linetype = "dashed", linewidth = 0.3, colour = "grey50")\n'
        post += _facet_r(opts)

    # Global line-thickness multiplier (Edit-panel "Line width"). Runs for ALL
    # ggplot types (incl. NO_THEME ones like network, hence outside the block
    # above) — DEVICE_TYPES already returned. Post-multiplies the fixed
    # `linewidth` aes-param of every layer that sets one (the templates set it
    # explicitly on line/bar/box/etc geoms), so no template needs to change.
    # Guarded so a non-ggplot or layer without linewidth is left untouched.
    lw_scale = opts.get("linewidth_scale")
    data_line_width_pt = _finite_float_option(opts, "data_line_width_pt")
    if lw_scale is not None or data_line_width_pt is not None:
        try:
            _mult = max(0.25, min(4.0, float(lw_scale if lw_scale is not None else 1.0)))
        except (TypeError, ValueError):
            _mult = 1.0
        if data_line_width_pt is not None:
            _data_pt = max(0.1, min(3.0, data_line_width_pt))
            post += (
                f".labplot_data_linewidth_mm <- labplot_pt_to_mm({_data_pt:g})\n"
                "p <- (function(.p) {\n"
                '  if (!inherits(.p, "ggplot") || is.null(.p$layers)) return(.p)\n'
                '  .data_line_geoms <- c("GeomLine", "GeomPath", "GeomStep", "GeomSmooth", "GeomDensity", "GeomFreqpoly")\n'
                "  for (.i in seq_along(.p$layers)) {\n"
                "    .is_data_line <- class(.p$layers[[.i]]$geom)[[1]] %in% .data_line_geoms\n"
                '    for (.slot in c("aes_params", "geom_params")) {\n'
                "      .pl <- .p$layers[[.i]][[.slot]]\n"
                "      if (!is.null(.pl) && is.numeric(.pl$linewidth)) {\n"
                f"        .p$layers[[.i]][[.slot]]$linewidth <- if (.is_data_line) .labplot_data_linewidth_mm * {_mult:g} else .pl$linewidth * {_mult:g}\n"
                "      }\n"
                "    }\n"
                "  }\n"
                "  .p\n"
                "})(p)\n"
            )
        elif abs(_mult - 1.0) > 1e-6:
            # Scale a numeric `linewidth` fixed-param wherever a geom keeps it —
            # aes_params (geom_line/path/step/smooth/violin/bar/col/tile/
            # histogram and geom_boxplot's overall stroke) or geom_params (some
            # geoms/versions). Only the `linewidth` key is touched, so width
            # RATIOS (e.g. boxplot staplewidth) are never distorted. Reference
            # semantics on the layer ggproto objects — the standard post-build
            # mutation idiom (verified on ggplot2 4.0).
            post += (
                "p <- (function(.p) {\n"
                '  if (!inherits(.p, "ggplot") || is.null(.p$layers)) return(.p)\n'
                "  for (.i in seq_along(.p$layers)) {\n"
                '    for (.slot in c("aes_params", "geom_params")) {\n'
                "      .pl <- .p$layers[[.i]][[.slot]]\n"
                "      if (!is.null(.pl) && is.numeric(.pl$linewidth)) "
                f".p$layers[[.i]][[.slot]]$linewidth <- .pl$linewidth * {_mult:g}\n"
                "    }\n"
                "  }\n"
                "  .p\n"
                "})(p)\n"
            )

    # Opt-in interactive HTML (self-contained plotly). Best-effort: wrapped in
    # tryCatch so a missing pandoc / non-convertible plot never fails the static
    # render. Only attempted on the standard ggplot path (p is a ggplot here).
    # Render to a scratch name first and only promote to figure.html once the
    # self-contained write fully succeeds. saveWidget(selfcontained = TRUE) leaves
    # a partial, non-self-contained stub (referencing an external libs dir we do
    # not collect) on failure -- e.g. when pandoc is missing -- so promoting only
    # on success keeps res.outputs["html"] a valid standalone file or nothing.
    html_export = ""
    if opts.get("interactive_html"):
        html_export = """
tryCatch({
  .ply <- plotly::ggplotly(p)
  htmlwidgets::saveWidget(.ply, "figure_interactive.html", selfcontained = TRUE)
  file.rename("figure_interactive.html", "figure.html")
}, error = function(e) message("Interactive HTML export skipped: ", conditionMessage(e)))
"""

    # Panel geometry sidecar: map the plot PANEL to PNG pixel bounds (y from the
    # image TOP) plus the data ranges, so the frontend can convert pointer
    # positions to panel-relative / data coordinates for annotation placement.
    # Computed against a scratch png device at the SAME width/height/dpi as
    # figure.png. Entirely wrapped in tryCatch so a layout failure never breaks
    # the render (figure_layout.json is simply absent).
    # Gtable label cells are positional. coord_flip swaps which semantic axis
    # label occupies the bottom/left cell, so scene IDs and setting paths must
    # follow the rendered label rather than the cell name.
    if opts.get("flip_coords"):
        xlab_scene = ("element:axis:y:label", "y_label", "options.y_label")
        ylab_scene = ("element:axis:x:label", "x_label", "options.x_label")
    else:
        xlab_scene = ("element:axis:x:label", "x_label", "options.x_label")
        ylab_scene = ("element:axis:y:label", "y_label", "options.y_label")

    layout_export = f"""
tryCatch({{
  .w <- {w}; .h <- {h}; .dpi <- {dpi}
  .imgh <- .h * .dpi; .imgw <- .w * .dpi
  # Build once and reuse for the gtable, the discrete scales and panel ranges so
  # every derived key describes the SAME render.
  .gb <- ggplot2::ggplot_build(p)
  .gt <- ggplot2::ggplot_gtable(.gb)
  grDevices::png(tempfile(fileext = ".png"), width = .w, height = .h, units = "in", res = .dpi)
  grid::grid.newpage(); grid::grid.draw(.gt); grid::grid.force()
  .lsv <- grid::grid.ls(grobs = FALSE, viewports = TRUE, print = FALSE)$name
  # device-pixel box (y measured from image TOP) of the currently-sought viewport
  .vp_box <- function() {{
    .bl <- grid::deviceLoc(grid::unit(0, "npc"), grid::unit(0, "npc"))
    .tr <- grid::deviceLoc(grid::unit(1, "npc"), grid::unit(1, "npc"))
    .x0 <- as.numeric(grid::convertX(.bl$x, "in")) * .dpi
    .x1 <- as.numeric(grid::convertX(.tr$x, "in")) * .dpi
    .yb <- as.numeric(grid::convertY(.bl$y, "in")) * .dpi
    .yt <- as.numeric(grid::convertY(.tr$y, "in")) * .dpi
    list(x0 = .x0, x1 = .x1, y0 = .imgh - .yt, y1 = .imgh - .yb)
  }}
  .panel_names <- .lsv[grepl("^panel", .lsv)]
  # ---- legacy keys (exact shape preserved: first panel only) ----
  grid::seekViewport(.panel_names[1])
  .panel <- .vp_box()
  .bp <- .gb$layout$panel_params[[1]]
  .xr <- .bp$x.range; .yr <- .bp$y.range
  .disc_x <- !is.null(.bp$x$is_discrete) && isTRUE(.bp$x$is_discrete())
  .disc_y <- !is.null(.bp$y$is_discrete) && isTRUE(.bp$y$is_discrete())
  .obj <- list(panel_px = .panel, img_px = list(w = .imgw, h = .imgh),
               x_range = .xr, y_range = .yr, x_discrete = .disc_x, y_discrete = .disc_y)
  # Internal PANEL lookup used to convert built geom coordinates into the same
  # device-pixel space as panel_px. It is not serialized separately.
  .scene_panel_px <- list("1" = .panel)
  .scene_panel_params <- list("1" = .bp)
  # ---- NEW: all facet panels (additive; first entry == legacy panel_px) ----
  tryCatch({{
    .panels <- list()
    for (.i in seq_along(.panel_names)) {{
      .pp <- .gb$layout$panel_params[[.i]]
      if (is.null(.pp)) next
      grid::seekViewport(.panel_names[.i])
      .pb <- .vp_box()
      .pid <- tryCatch(as.character(.gb$layout$layout$PANEL[.i]), error = function(e) as.character(.i))
      if (!length(.pid) || is.na(.pid) || !nzchar(.pid)) .pid <- as.character(.i)
      .scene_panel_px[[.pid]] <- .pb
      .scene_panel_params[[.pid]] <- .pp
      .pdx <- !is.null(.pp$x$is_discrete) && isTRUE(.pp$x$is_discrete())
      .pdy <- !is.null(.pp$y$is_discrete) && isTRUE(.pp$y$is_discrete())
      .panels[[length(.panels) + 1]] <- list(
        panel_px = .pb, x_range = .pp$x.range, y_range = .pp$y.range,
        x_discrete = .pdx, y_discrete = .pdy)
    }}
    if (length(.panels)) .obj$panels <- .panels
  }}, error = function(e) {{}})
  # ---- NEW: series_hex — resolved discrete colour/fill mapping actually rendered ----
  .disc_scale <- NULL
  tryCatch({{
    .sc <- .gb$plot$scales$get_scales("colour")
    if (is.null(.sc) || !isTRUE(tryCatch(.sc$is_discrete(), error = function(e) FALSE))) {{
      .sc <- .gb$plot$scales$get_scales("fill")
    }}
    if (!is.null(.sc) && isTRUE(tryCatch(.sc$is_discrete(), error = function(e) FALSE))) {{
      .disc_scale <- .sc
      .lv <- as.character(.sc$get_limits())
      .mp <- toupper(substr(as.character(.sc$map(.lv)), 1, 7))
      .ok <- !is.na(.mp) & grepl("^#[0-9A-F]{{6}}$", .mp)
      if (any(.ok)) {{
        .sh <- as.list(.mp[.ok]); names(.sh) <- .lv[.ok]
        .obj$series_hex <- .sh
      }}
    }}
  }}, error = function(e) {{}})
  # ---- NEW: legend_keys — per-series legend key-box pixels (Nth key == Nth level) ----
  tryCatch({{
    .kv <- .lsv[grepl("key-.*-bg", .lsv)]
    if (length(.kv)) {{
      .mm <- regmatches(.kv, regexec("key-(\\\\d+)-(\\\\d+)-bg", .kv))
      .rr <- sapply(.mm, function(z) if (length(z) >= 3) as.integer(z[2]) else NA_integer_)
      .cc <- sapply(.mm, function(z) if (length(z) >= 3) as.integer(z[3]) else NA_integer_)
      .kv <- .kv[order(.rr, .cc)]
      .lvl <- if (!is.null(.disc_scale)) as.character(.disc_scale$get_limits()) else character()
      .keys <- list()
      for (.j in seq_along(.kv)) {{
        grid::seekViewport(.kv[.j])
        .series <- if (.j <= length(.lvl)) .lvl[.j] else NA
        .keys[[length(.keys) + 1]] <- list(series = .series, px = .vp_box())
      }}
      if (length(.keys)) .obj$legend_keys <- .keys
    }}
  }}, error = function(e) {{}})
  # ---- NEW: element hit boxes — title/labels/axis strips for click-to-edit ----
  # Viewport names are built from the MAIN gtable's layout cells (name + t-l-b-r)
  # so a legend's internal "title" cell can never be confused with the plot
  # title. Facet axis strips (axis-b-1-1, ...) union into one bbox per side.
  # Zero-height boxes (e.g. no title set) are still emitted: y marks where the
  # element WOULD render, which the editor uses for its "add title" band.
  tryCatch({{
    .cells <- .gt$layout
    .cell_box <- function(pat) {{
      .rows <- .cells[grepl(pat, .cells$name), , drop = FALSE]
      if (!nrow(.rows)) return(NULL)
      # Two accumulators: prefer the union of NON-degenerate cells. Faceted
      # gtables contain zero-size interior axis cells (axis-b-1-1 at panel
      # boundaries) whose naive union engulfs whole panel rows/columns; the
      # zero-size union is kept only as a fallback so absent title/subtitle
      # still yield their "add here" band position.
      .merge <- function(.a, .bb) {{
        if (is.null(.a)) return(.bb)
        .a$x0 <- min(.a$x0, .bb$x0); .a$x1 <- max(.a$x1, .bb$x1)
        .a$y0 <- min(.a$y0, .bb$y0); .a$y1 <- max(.a$y1, .bb$y1)
        .a
      }}
      .b <- NULL; .bz <- NULL
      for (.k in seq_len(nrow(.rows))) {{
        # gtable viewport names are name.t-r-b-l (NOT t-l-b-r) — verified
        # empirically: layout t=3,l=7,b=3,r=15 -> viewport "title.3-15-3-7".
        # Order only matters for column-spanning cells (facet titles/xlab).
        .vn <- paste0(.rows$name[.k], ".", .rows$t[.k], "-", .rows$r[.k], "-", .rows$b[.k], "-", .rows$l[.k])
        .bb <- tryCatch({{ grid::seekViewport(.vn); .vp_box() }}, error = function(e) NULL)
        if (is.null(.bb)) next
        if ((.bb$x1 - .bb$x0) > 0 && (.bb$y1 - .bb$y0) > 0) .b <- .merge(.b, .bb)
        .bz <- .merge(.bz, .bb)
      }}
      if (!is.null(.b)) .b else .bz
    }}
    .bx <- .cell_box("^title$");    if (!is.null(.bx)) .obj$title_px <- .bx
    .bx <- .cell_box("^subtitle$"); if (!is.null(.bx)) .obj$subtitle_px <- .bx
    .bx <- .cell_box("^xlab-b");    if (!is.null(.bx)) .obj$xlab_px <- .bx
    .bx <- .cell_box("^ylab-l");    if (!is.null(.bx)) .obj$ylab_px <- .bx
    .bx <- .cell_box("^axis-b");    if (!is.null(.bx)) .obj$x_axis_px <- .bx
    .bx <- .cell_box("^axis-l");    if (!is.null(.bx)) .obj$y_axis_px <- .bx
  }}, error = function(e) {{}})
  # ---- NEW: scene_elements — stable semantic hit targets (additive contract) ----
  # Text nodes reuse the gtable cell boxes above. Bar nodes are appended from
  # ggplot_build layers below after coordinate transformation.
  .scene <- list()
  .add_text_scene <- function(.id, .role, .box, .path) {{
    if (is.null(.box)) return(invisible(NULL))
    # A degenerate cell means the element is NOT rendered (e.g. labs(x = NULL)):
    # keep it as the "add here" band for explicit corrections, but flag it so
    # hit-testing never resolves a drawn mark onto invisible text.
    .placeholder <- ((.box$x1 - .box$x0) <= 1) || ((.box$y1 - .box$y0) <= 1)
    .scene[[length(.scene) + 1]] <<- list(
      id = .id, kind = "text", role = .role, bbox_px = .box,
      bbox_source = "gtable_cell", editable = TRUE, setting_path = .path,
      placeholder = .placeholder)
  }}
  .add_text_scene("element:title", "title", .obj$title_px, "options.title")
  .add_text_scene({rq(xlab_scene[0])}, {rq(xlab_scene[1])}, .obj$xlab_px, {rq(xlab_scene[2])})
  .add_text_scene({rq(ylab_scene[0])}, {rq(ylab_scene[1])}, .obj$ylab_px, {rq(ylab_scene[2])})
  # ---- NEW: axis tick-label strips as first-class semantic targets ----
  # theme(axis.text.x/y) is positional, so the BOTTOM strip always maps to the
  # x_text_angle option even under coord_flip. Only real (non-degenerate)
  # strips are emitted - there is nothing to click on an axis without labels.
  .add_axis_text_scene <- function(.id, .role, .box, .path) {{
    if (is.null(.box)) return(invisible(NULL))
    if (((.box$x1 - .box$x0) <= 1) || ((.box$y1 - .box$y0) <= 1)) return(invisible(NULL))
    .scene[[length(.scene) + 1]] <<- list(
      id = .id, kind = "text", role = .role, bbox_px = .box,
      bbox_source = "gtable_cell", editable = TRUE, setting_path = .path,
      placeholder = FALSE)
  }}
  .add_axis_text_scene("element:axis:x:tick_labels", "x_tick_labels", .obj$x_axis_px, "options.x_text_angle")
  .add_axis_text_scene("element:axis:y:tick_labels", "y_tick_labels", .obj$y_axis_px, "options.y_tick_format")
  # ---- NEW: legend / continuous colorbar box (gtable guide-box-* cells) ----
  # ggplot2 keeps one guide-box cell per side; only the rendered side is
  # non-degenerate, so .cell_box's non-degenerate union is exactly the visible
  # guide area. A continuous colour/fill scale without any discrete scale
  # renders a colorbar; everything else is a discrete legend box.
  tryCatch({{
    if (exists(".cell_box", inherits = FALSE)) {{
      # ggplot2 >= 3.5 keeps one guide-box cell per side plus a panel-sized
      # guide-box-inside cell; empty side cells are zero-size while the inside
      # cell is panel-sized even when unused, so measure each rendered side
      # separately and never union across guide-box cells.
      .gbx <- NULL
      for (.side in c("right", "left", "bottom", "top")) {{
        .bb <- .cell_box(paste0("^guide-box-", .side, "$"))
        if (!is.null(.bb) && (.bb$x1 - .bb$x0) > 4 && (.bb$y1 - .bb$y0) > 4) {{
          .gbx <- .bb
          break
        }}
      }}
      if (is.null(.gbx)) {{
        .bb <- .cell_box("^guide-box$")  # single-cell layout of older ggplot2
        if (!is.null(.bb) && (.bb$x1 - .bb$x0) > 4 && (.bb$y1 - .bb$y0) > 4) .gbx <- .bb
      }}
      if (!is.null(.gbx)) {{
        .cont_scale <- NULL
        for (.aes in c("fill", "colour")) {{
          .scc <- tryCatch(.gb$plot$scales$get_scales(.aes), error = function(e) NULL)
          if (!is.null(.scc) && !isTRUE(tryCatch(.scc$is_discrete(), error = function(e) TRUE))) {{
            .cont_scale <- .scc
            break
          }}
        }}
        .guide_role <- if (is.null(.disc_scale) && !is.null(.cont_scale)) "colorbar" else "legend"
        .scene[[length(.scene) + 1]] <- list(
          id = if (identical(.guide_role, "colorbar")) "element:legend:colorbar" else "element:legend:box",
          kind = "guide", role = .guide_role, bbox_px = .gbx,
          bbox_source = "gtable_cell", editable = TRUE,
          setting_path = "options.legend_position",
          placeholder = FALSE)
      }}
    }}
  }}, error = function(e) {{}})
  grDevices::dev.off()
  # ---- NEW: layer_geom — bounded per-layer data-space geometry for hit-testing ----
  tryCatch({{
    .lg <- list()
    for (.li in seq_along(.gb$data)) {{
      .d <- .gb$data[[.li]]
      if (is.null(.d) || !nrow(.d)) next
      .geom <- tryCatch(tolower(sub("^Geom", "", class(.gb$plot$layers[[.li]]$geom)[1])),
                        error = function(e) NA_character_)
      .rng <- function(cols) {{
        .v <- unlist(lapply(intersect(cols, names(.d)), function(cn) suppressWarnings(as.numeric(.d[[cn]]))))
        .v <- .v[is.finite(.v)]
        if (length(.v)) range(.v) else c(NA_real_, NA_real_)
      }}
      .xr2 <- .rng(c("x", "xmin", "xmax")); .yr2 <- .rng(c("y", "ymin", "ymax"))
      .cols <- intersect(c("x", "y", "xmin", "xmax", "ymin", "ymax", "fill", "colour", "group"), names(.d))
      .samp <- NULL
      if (length(.cols)) {{
        .idx <- if (nrow(.d) > 200) sort(sample.int(nrow(.d), 200)) else seq_len(nrow(.d))
        .samp <- .d[.idx, .cols, drop = FALSE]
      }}
      .entry <- list(geom = .geom, n = nrow(.d),
                     box = list(xmin = .xr2[1], xmax = .xr2[2], ymin = .yr2[1], ymax = .yr2[2]))
      if (!is.null(.samp)) .entry$pts <- .samp
      .lg[[length(.lg) + 1]] <- .entry

      # grouped_bar's geom_col carries inert semantic aesthetics through the
      # build. Transform its rectangle edges through the active coord (handles
      # dodge, scale transforms, coord_flip and coord_cartesian limits), then
      # map panel-normalized coordinates into device pixels with top-origin y.
      .mark_cols <- c("labplot_mark_id", "labplot_category", "labplot_series",
                      "PANEL", "xmin", "xmax", "ymin", "ymax")
      if (identical(.geom, "col") && all(.mark_cols %in% names(.d))) {{
        for (.pid in unique(as.character(.d$PANEL))) {{
          .pbx <- .scene_panel_px[[.pid]]
          .ppx <- .scene_panel_params[[.pid]]
          if (is.null(.pbx) || is.null(.ppx)) next
          .rows <- which(as.character(.d$PANEL) == .pid)
          .pd <- .d[.rows, , drop = FALSE]
          .tr <- tryCatch(.gb$plot$coordinates$transform(.pd, .ppx), error = function(e) NULL)
          if (is.null(.tr) || !all(c("xmin", "xmax", "ymin", "ymax") %in% names(.tr))) next
          .pw <- .pbx$x1 - .pbx$x0; .ph <- .pbx$y1 - .pbx$y0
          for (.ri in seq_len(nrow(.tr))) {{
            .xv <- suppressWarnings(as.numeric(c(.tr$xmin[.ri], .tr$xmax[.ri])))
            .yv <- suppressWarnings(as.numeric(c(.tr$ymin[.ri], .tr$ymax[.ri])))
            if (length(.xv) != 2 || length(.yv) != 2 || any(!is.finite(c(.xv, .yv)))) next
            .xlo <- max(0, min(1, min(.xv))); .xhi <- max(0, min(1, max(.xv)))
            .ylo <- max(0, min(1, min(.yv))); .yhi <- max(0, min(1, max(.yv)))
            if (.xhi <= .xlo || .yhi <= .ylo) next
            .src <- .rows[.ri]
            .mark_id <- as.character(.d$labplot_mark_id[.src])
            .element_editable <- nchar(.mark_id, type = "bytes") <= 512 &&
              sum(as.character(.d$labplot_mark_id) == .mark_id, na.rm = TRUE) == 1
            .fill <- if ("fill" %in% names(.d)) as.character(.d$fill[.src]) else NA_character_
            .stroke <- if ("colour" %in% names(.d)) as.character(.d$colour[.src]) else NA_character_
            if (.element_editable && exists(".labplot_element_fill_overrides", inherits = FALSE)) {{
              .override <- unname(.labplot_element_fill_overrides[.mark_id])
              if (length(.override) && !is.na(.override)) .fill <- as.character(.override)
            }}
            if (.element_editable && exists(".labplot_element_stroke_overrides", inherits = FALSE)) {{
              .override <- unname(.labplot_element_stroke_overrides[.mark_id])
              if (length(.override) && !is.na(.override)) .stroke <- as.character(.override)
            }}
            .scene[[length(.scene) + 1]] <- list(
              id = .mark_id,
              kind = "mark", role = "bar", geom = "col",
              category = as.character(.d$labplot_category[.src]),
              series = as.character(.d$labplot_series[.src]),
              panel_id = suppressWarnings(as.integer(.pid)),
              layer_index = .li,
              fill = .fill,
              stroke = .stroke,
              bbox_px = list(
                x0 = .pbx$x0 + .xlo * .pw,
                x1 = .pbx$x0 + .xhi * .pw,
                y0 = .pbx$y1 - .yhi * .ph,
                y1 = .pbx$y1 - .ylo * .ph),
              editable = .element_editable,
              setting_path = if (.element_editable) paste0("options.element_overrides.", .mark_id) else NA_character_)
          }}
        }}
      }}

      # Scatter's primary geom_point carries a stable source-row identity.
      # Overlay layers deliberately omit these inert aesthetics, so only the
      # original data mark becomes a hit target and legend semantics cannot be
      # duplicated by a localized recolor.
      .point_mark_cols <- c("labplot_mark_id", "labplot_row_identity", "PANEL", "x", "y")
      if (identical(.geom, "point") && all(.point_mark_cols %in% names(.d))) {{
        for (.pid in unique(as.character(.d$PANEL))) {{
          .pbx <- .scene_panel_px[[.pid]]
          .ppx <- .scene_panel_params[[.pid]]
          if (is.null(.pbx) || is.null(.ppx)) next
          .rows <- which(as.character(.d$PANEL) == .pid)
          .pd <- .d[.rows, , drop = FALSE]
          .tr <- tryCatch(.gb$plot$coordinates$transform(.pd, .ppx), error = function(e) NULL)
          if (is.null(.tr) || !all(c("x", "y") %in% names(.tr))) next
          .pw <- .pbx$x1 - .pbx$x0; .ph <- .pbx$y1 - .pbx$y0
          for (.ri in seq_len(nrow(.tr))) {{
            .xn <- suppressWarnings(as.numeric(.tr$x[.ri]))
            .yn <- suppressWarnings(as.numeric(.tr$y[.ri]))
            if (!is.finite(.xn) || !is.finite(.yn) || .xn < 0 || .xn > 1 || .yn < 0 || .yn > 1) next
            .src <- .rows[.ri]
            .mark_id <- as.character(.d$labplot_mark_id[.src])
            .element_editable <- !is.na(.mark_id) && nzchar(.mark_id) &&
              nchar(.mark_id, type = "bytes") <= 512 &&
              sum(as.character(.d$labplot_mark_id) == .mark_id, na.rm = TRUE) == 1
            .fill <- if ("colour" %in% names(.d)) as.character(.d$colour[.src]) else "black"
            # The solid base glyph uses its colour for both interior and edge.
            # Fill-only overlays use shape 21 and inherit this same mapped
            # colour as their outline, so report it as the effective stroke.
            .stroke <- .fill
            if (.element_editable && exists(".labplot_element_fill_overrides", inherits = FALSE)) {{
              .override <- unname(.labplot_element_fill_overrides[.mark_id])
              if (length(.override) && !is.na(.override)) .fill <- as.character(.override)
            }}
            if (.element_editable && exists(".labplot_element_stroke_overrides", inherits = FALSE)) {{
              .override <- unname(.labplot_element_stroke_overrides[.mark_id])
              if (length(.override) && !is.na(.override)) .stroke <- as.character(.override)
            }}
            .cx <- .pbx$x0 + .xn * .pw
            .cy <- .pbx$y1 - .yn * .ph
            .size_mm <- if ("size" %in% names(.d)) suppressWarnings(as.numeric(.d$size[.src])) else 2
            .stroke_mm <- if ("stroke" %in% names(.d)) suppressWarnings(as.numeric(.d$stroke[.src])) else 0
            if (!is.finite(.size_mm)) .size_mm <- 2
            if (!is.finite(.stroke_mm)) .stroke_mm <- 0
            .radius <- max(7, (.size_mm + .stroke_mm) * .dpi / 25.4 / 2)
            .scene[[length(.scene) + 1]] <- list(
              id = .mark_id,
              kind = "mark", role = "point", geom = "point",
              row_identity = as.character(.d$labplot_row_identity[.src]),
              x_value = if ("labplot_x_value" %in% names(.d)) as.character(.d$labplot_x_value[.src]) else NULL,
              y_value = if ("labplot_y_value" %in% names(.d)) as.character(.d$labplot_y_value[.src]) else NULL,
              panel_id = suppressWarnings(as.integer(.pid)),
              layer_index = .li,
              fill = .fill,
              stroke = .stroke,
              alpha = if ("alpha" %in% names(.d)) suppressWarnings(as.numeric(.d$alpha[.src])) else 1,
              bbox_source = "ggplot_build_coord_transform",
              bbox_px = list(
                x0 = max(.pbx$x0, .cx - .radius),
                x1 = min(.pbx$x1, .cx + .radius),
                y0 = max(.pbx$y0, .cy - .radius),
                y1 = min(.pbx$y1, .cy + .radius)),
              editable = .element_editable,
              setting_path = if (.element_editable) paste0("options.element_overrides.", .mark_id) else NA_character_)
          }}
        }}
      }}

      # Heatmaps carry semantic row/column labels on their base geom_tile.
      # The rectangle transform is identical to grouped bars, but cell IDs are
      # never derived from color/value or display order.
      .cell_mark_cols <- c("labplot_mark_id", "PANEL", "xmin", "xmax", "ymin", "ymax")
      .has_cell_semantics <- all(c("labplot_row", "labplot_col") %in% names(.d)) ||
        all(c("labplot_x", "labplot_y") %in% names(.d))
      if (identical(.geom, "tile") && .has_cell_semantics && all(.cell_mark_cols %in% names(.d))) {{
        for (.pid in unique(as.character(.d$PANEL))) {{
          .pbx <- .scene_panel_px[[.pid]]
          .ppx <- .scene_panel_params[[.pid]]
          if (is.null(.pbx) || is.null(.ppx)) next
          .rows <- which(as.character(.d$PANEL) == .pid)
          .pd <- .d[.rows, , drop = FALSE]
          .tr <- tryCatch(.gb$plot$coordinates$transform(.pd, .ppx), error = function(e) NULL)
          if (is.null(.tr) || !all(c("xmin", "xmax", "ymin", "ymax") %in% names(.tr))) next
          .pw <- .pbx$x1 - .pbx$x0; .ph <- .pbx$y1 - .pbx$y0
          for (.ri in seq_len(nrow(.tr))) {{
            .xv <- suppressWarnings(as.numeric(c(.tr$xmin[.ri], .tr$xmax[.ri])))
            .yv <- suppressWarnings(as.numeric(c(.tr$ymin[.ri], .tr$ymax[.ri])))
            if (length(.xv) != 2 || length(.yv) != 2 || any(!is.finite(c(.xv, .yv)))) next
            .xlo <- max(0, min(1, min(.xv))); .xhi <- max(0, min(1, max(.xv)))
            .ylo <- max(0, min(1, min(.yv))); .yhi <- max(0, min(1, max(.yv)))
            if (.xhi <= .xlo || .yhi <= .ylo) next
            .src <- .rows[.ri]
            .mark_id <- as.character(.d$labplot_mark_id[.src])
            .element_editable <- !is.na(.mark_id) && nzchar(.mark_id) &&
              nchar(.mark_id, type = "bytes") <= 512 &&
              sum(as.character(.d$labplot_mark_id) == .mark_id, na.rm = TRUE) == 1
            .fill <- if ("fill" %in% names(.d)) as.character(.d$fill[.src]) else NA_character_
            .stroke <- if ("colour" %in% names(.d)) as.character(.d$colour[.src]) else NA_character_
            if (.element_editable && exists(".labplot_element_fill_overrides", inherits = FALSE)) {{
              .override <- unname(.labplot_element_fill_overrides[.mark_id])
              if (length(.override) && !is.na(.override)) .fill <- as.character(.override)
            }}
            if (.element_editable && exists(".labplot_element_stroke_overrides", inherits = FALSE)) {{
              .override <- unname(.labplot_element_stroke_overrides[.mark_id])
              if (length(.override) && !is.na(.override)) .stroke <- as.character(.override)
            }}
            .scene[[length(.scene) + 1]] <- list(
              id = .mark_id,
              kind = "mark", role = "cell", geom = "tile",
              row = if ("labplot_row" %in% names(.d)) as.character(.d$labplot_row[.src]) else NULL,
              column = if ("labplot_col" %in% names(.d)) as.character(.d$labplot_col[.src]) else NULL,
              x_value = if ("labplot_x" %in% names(.d)) as.character(.d$labplot_x[.src]) else NULL,
              y_value = if ("labplot_y" %in% names(.d)) as.character(.d$labplot_y[.src]) else NULL,
              value = if ("labplot_value" %in% names(.d)) suppressWarnings(as.numeric(.d$labplot_value[.src])) else NULL,
              panel_id = suppressWarnings(as.integer(.pid)),
              layer_index = .li,
              fill = .fill,
              stroke = .stroke,
              bbox_source = "ggplot_build_coord_transform",
              bbox_px = list(
                x0 = .pbx$x0 + .xlo * .pw,
                x1 = .pbx$x0 + .xhi * .pw,
                y0 = .pbx$y1 - .yhi * .ph,
                y1 = .pbx$y1 - .ylo * .ph),
              editable = .element_editable,
              setting_path = if (.element_editable) paste0("options.element_overrides.", .mark_id) else NA_character_)
          }}
        }}
      }}
    }}
    if (length(.lg)) .obj$layer_geom <- .lg
  }}, error = function(e) {{}})
  if (length(.scene)) .obj$scene_elements <- .scene
  jsonlite::write_json(.obj, "figure_layout.json", auto_unbox = TRUE, digits = 6)
}}, error = function(e) message("layout skip: ", conditionMessage(e)))
"""

    export = f"""
.pdf_device <- if (isTRUE(capabilities("cairo"))) grDevices::cairo_pdf else grDevices::pdf
ggsave("figure.png",  p, width = {w}, height = {h}, dpi = {dpi}, bg = {bg_r}, limitsize = FALSE)
ggsave("figure.svg",  p, width = {w}, height = {h}, bg = {bg_r}, limitsize = FALSE)
ggsave("figure.tiff", p, width = {w}, height = {h}, dpi = {dpi}, bg = {bg_r}, compression = "lzw", limitsize = FALSE)
ggsave("figure.pdf",  p, width = {w}, height = {h}, bg = {bg_r}, device = .pdf_device, limitsize = FALSE)
if (isTRUE(capabilities("cairo"))) {{
  tryCatch(
    ggsave("figure.eps", p, width = {w}, height = {h}, bg = {bg_r}, device = grDevices::cairo_ps, fallback_resolution = 600, limitsize = FALSE),
    error = function(e) message("EPS export skipped: ", conditionMessage(e))
  )
}}
{layout_export}{html_export}"""
    return (head
            + theme_r(preset, color_mode, font_scale, opts.get("palette_name"),
                      opts.get("custom_palette_values"), opts.get("font_family"),
                      bool(opts.get("transparent_background")),
                      legend_key_size=opts.get("legend_key_size"),
                      base_size=opts.get("base_size"),
                      axis_line_width_pt=opts.get("axis_line_width_pt"),
                      data_line_width_pt=opts.get("data_line_width_pt"))
            + plot_r
            + theme_append
            + post
            + export)


class RenderResult:
    def __init__(self, success, r_code, outputs, log):
        self.success = success
        self.r_code = r_code
        self.outputs = outputs       # {"png": path, ...}
        self.log = log


def render(plot_type: str, mapping: dict, options: dict, preset: str,
           df: pd.DataFrame, out_dir: str) -> RenderResult:
    source_row_id_column = _unused_source_row_id_column(df.columns)
    r_code = build_script(
        plot_type,
        mapping,
        options,
        preset,
        source_row_id_column=source_row_id_column,
    )
    os.makedirs(out_dir, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="labplot_") as work:
        render_df = df.copy()
        render_df[source_row_id_column] = [_source_row_identity(value) for value in df.index]
        render_df.to_csv(os.path.join(work, "data.csv"), index=False)
        with open(os.path.join(work, "figure.R"), "w") as f:
            f.write(r_code)
        try:
            proc = subprocess.run(
                [_rscript_bin(), "figure.R"],
                cwd=work,
                capture_output=True,
                text=True,
                timeout=settings.RENDER_TIMEOUT_SEC,
                env=_scrubbed_env(work),
                preexec_fn=_resource_limit_preexec(),
            )
        except subprocess.TimeoutExpired:
            return RenderResult(False, r_code, {}, "Rendering timed out")
        except FileNotFoundError as e:
            return RenderResult(False, r_code, {}, f"Rscript not found: {e}")

        log = (proc.stdout or "") + "\n" + (proc.stderr or "")
        if proc.returncode != 0:
            return RenderResult(False, r_code, {}, log.strip())

        outputs = {}
        for ext in ("png", "svg", "tiff", "pdf", "eps", "html"):
            src = os.path.join(work, f"figure.{ext}")
            if os.path.exists(src):
                dst = os.path.join(out_dir, f"figure.{ext}")
                shutil.copyfile(src, dst)
                outputs[ext] = dst
        # save the reproducible script alongside outputs
        with open(os.path.join(out_dir, "figure.R"), "w") as f:
            f.write(r_code)
        outputs["r"] = os.path.join(out_dir, "figure.R")

        # panel-geometry sidecar (standard ggplot path only; best-effort). Not an
        # image: the service parses this JSON into the version's `layout` column
        # rather than serving it as an asset.
        layout_src = os.path.join(work, "figure_layout.json")
        if os.path.exists(layout_src):
            layout_dst = os.path.join(out_dir, "figure_layout.json")
            shutil.copyfile(layout_src, layout_dst)
            outputs["layout"] = layout_dst

        if "png" not in outputs:
            return RenderResult(False, r_code, outputs, "No PNG produced.\n" + log.strip())
        return RenderResult(True, r_code, outputs, log.strip())
