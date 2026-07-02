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
from app.r_engine.presets import PRESETS, theme_r
from app.r_engine.templates import build_plot_r, rq, DEVICE_TYPES, NO_THEME_TYPES

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
    values <- labplot_palette(length(limits))
    names(values) <- limits
    values[hits] <- .override[hits]
    suppressMessages(current_plot + scale_fun(values = values))
  }}
  plot <- .apply(plot, "fill", ggplot2::scale_fill_manual)
  plot <- .apply(plot, "colour", ggplot2::scale_colour_manual)
  plot
}}
p <- labplot_apply_category_colors(p)
"""


def build_script(plot_type: str, mapping: dict, options: dict, preset: str,
                 data_filename: str = "data.csv") -> str:
    if preset not in PRESETS:
        preset = "nature"
    opts = options or {}
    color_mode = opts.get("color_mode", "color")
    # Sanitize before interpolating into the R comment so a stray newline/quote
    # cannot break out of the comment line. theme_r() only compares this value
    # (never interpolates it into R), so the raw value stays safe for palette logic.
    safe_color_mode = color_mode if color_mode in ("color", "grayscale") else "color"
    font_scale = opts.get("font_scale", 1.0)
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
            + "df <- as.data.frame(df)\n")

    # ---- device-rendered plots (ComplexHeatmap etc.): template defines draw_plot() ----
    if plot_type in DEVICE_TYPES:
        export = f"""
.pdf_device <- if (isTRUE(capabilities("cairo"))) grDevices::cairo_pdf else grDevices::pdf
png("figure.png", width = {w} * {dpi}, height = {h} * {dpi}, res = {dpi}, pointsize = 7, bg = {bg_r}); draw_plot(); invisible(dev.off())
svglite::svglite("figure.svg", width = {w}, height = {h}, pointsize = 7, bg = {bg_r}); draw_plot(); invisible(dev.off())
tiff("figure.tiff", width = {w} * {dpi}, height = {h} * {dpi}, res = {dpi}, pointsize = 7, compression = "lzw", bg = {bg_r}); draw_plot(); invisible(dev.off())
.pdf_device("figure.pdf", width = {w}, height = {h}, pointsize = 7, bg = {bg_r}); draw_plot(); invisible(dev.off())
if (isTRUE(capabilities("cairo"))) {{
  tryCatch({{
    grDevices::cairo_ps("figure.eps", width = {w}, height = {h}, pointsize = 7, bg = {bg_r}, fallback_resolution = 600)
    draw_plot(); invisible(dev.off())
  }}, error = function(e) message("EPS export skipped: ", conditionMessage(e)))
}}
"""
        return head + plot_r + export

    # ---- ggplot-based plots ----
    theme_append = "" if plot_type in NO_THEME_TYPES else "\np <- p + labplot_theme()\n"
    post = ""
    if plot_type not in NO_THEME_TYPES:
        lt = opts.get("legend_title")
        if lt:
            post += f"p <- p + labs(fill = {rq(lt)}, colour = {rq(lt)})\n"
        post += _category_color_override_r(opts)
        legend_position = opts.get("legend_position")
        if opts.get("hide_legend") or legend_position == "none":
            post += 'p <- p + theme(legend.position = "none")\n'
        elif legend_position in {"right", "bottom"}:
            post += f'p <- p + theme(legend.position = "{legend_position}")\n'
        x_angle = opts.get("x_text_angle")
        if x_angle not in (None, ""):
            try:
                angle = max(0, min(90, float(x_angle)))
                hjust = 1 if angle >= 30 else 0.5
                vjust = 0.5 if angle >= 30 else 1
                title_margin = ", axis.title.x = element_text(margin = margin(t = 8))" if angle >= 30 else ""
                post += f"p <- p + theme(axis.text.x = element_text(angle = {angle:g}, hjust = {hjust}, vjust = {vjust}){title_margin})\n"
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
{html_export}"""
    return (head
            + theme_r(preset, color_mode, font_scale, opts.get("palette_name"),
                      opts.get("custom_palette_values"), opts.get("font_family"),
                      bool(opts.get("transparent_background")),
                      legend_key_size=opts.get("legend_key_size"))
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
    r_code = build_script(plot_type, mapping, options, preset)
    os.makedirs(out_dir, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="labplot_") as work:
        df.to_csv(os.path.join(work, "data.csv"), index=False)
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

        if "png" not in outputs:
            return RenderResult(False, r_code, outputs, "No PNG produced.\n" + log.strip())
        return RenderResult(True, r_code, outputs, log.strip())
