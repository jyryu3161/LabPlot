"""Assemble a self-contained R script, execute it, collect output images."""
from __future__ import annotations

import math
import os
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


def _rscript_bin() -> str:
    if settings.RSCRIPT_PATH and os.path.isfile(settings.RSCRIPT_PATH):
        return settings.RSCRIPT_PATH
    found = shutil.which("Rscript")
    return found or settings.RSCRIPT_PATH


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


def build_script(plot_type: str, mapping: dict, options: dict, preset: str,
                 data_filename: str = "data.csv") -> str:
    if preset not in PRESETS:
        preset = "nature"
    opts = options or {}
    color_mode = opts.get("color_mode", "color")
    font_scale = opts.get("font_scale", 1.0)
    plot_r = build_plot_r(plot_type, mapping, opts)
    w, h, dpi = _dimensions(opts)
    head = ("# LabPlot AI - reproducible figure script\n"
            f"# plot type: {plot_type} | style: {preset} | color: {color_mode}\n"
            "# generated with LabPlot academic figure rules: 7 pt text, restrained palettes, white background, no gridlines\n"
            + _HEADER
            + f'\ndf <- readr::read_csv("{data_filename}", show_col_types = FALSE)\n'
            + "df <- as.data.frame(df)\n")

    # ---- device-rendered plots (ComplexHeatmap etc.): template defines draw_plot() ----
    if plot_type in DEVICE_TYPES:
        export = f"""
png("figure.png", width = {w} * {dpi}, height = {h} * {dpi}, res = {dpi}, pointsize = 7, bg = "white"); draw_plot(); invisible(dev.off())
svglite::svglite("figure.svg", width = {w}, height = {h}, pointsize = 7, bg = "white"); draw_plot(); invisible(dev.off())
tiff("figure.tiff", width = {w} * {dpi}, height = {h} * {dpi}, res = {dpi}, pointsize = 7, compression = "lzw", bg = "white"); draw_plot(); invisible(dev.off())
pdf("figure.pdf", width = {w}, height = {h}, pointsize = 7); draw_plot(); invisible(dev.off())
"""
        return head + plot_r + export

    # ---- ggplot-based plots ----
    theme_append = "" if plot_type in NO_THEME_TYPES else "\np <- p + labplot_theme()\n"
    post = ""
    if plot_type not in NO_THEME_TYPES:
        lt = opts.get("legend_title")
        if lt:
            post += f"p <- p + labs(fill = {rq(lt)}, colour = {rq(lt)})\n"
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
                post += f"p <- p + theme(axis.text.x = element_text(angle = {angle:g}, hjust = {hjust}, vjust = {vjust}))\n"
            except (TypeError, ValueError):
                pass
        if opts.get("log_y"):
            post += "p <- p + scale_y_log10()\n"
        if opts.get("log_x"):
            post += "p <- p + scale_x_log10()\n"
        y_min = _finite_float_option(opts, "y_min")
        y_max = _finite_float_option(opts, "y_max")
        has_y_range = y_min is not None or y_max is not None
        if has_y_range and (y_min is None or y_max is None or y_min < y_max):
            lower = "-Inf" if y_min is None else f"{y_min:g}"
            upper = "Inf" if y_max is None else f"{y_max:g}"
            if opts.get("flip_coords"):
                post += f"p <- p + coord_flip(ylim = c({lower}, {upper}))\n"
            else:
                post += f"p <- p + coord_cartesian(ylim = c({lower}, {upper}))\n"
        elif opts.get("flip_coords"):
            post += "p <- p + coord_flip()\n"

    export = f"""
ggsave("figure.png",  p, width = {w}, height = {h}, dpi = {dpi}, bg = "white", limitsize = FALSE)
ggsave("figure.svg",  p, width = {w}, height = {h}, bg = "white", limitsize = FALSE)
ggsave("figure.tiff", p, width = {w}, height = {h}, dpi = {dpi}, bg = "white", compression = "lzw", limitsize = FALSE)
ggsave("figure.pdf",  p, width = {w}, height = {h}, bg = "white", limitsize = FALSE)
"""
    return (head
            + theme_r(preset, color_mode, font_scale, opts.get("palette_name"), opts.get("custom_palette_values"))
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
            )
        except subprocess.TimeoutExpired:
            return RenderResult(False, r_code, {}, "Rendering timed out")
        except FileNotFoundError as e:
            return RenderResult(False, r_code, {}, f"Rscript not found: {e}")

        log = (proc.stdout or "") + "\n" + (proc.stderr or "")
        if proc.returncode != 0:
            return RenderResult(False, r_code, {}, log.strip())

        outputs = {}
        for ext in ("png", "svg", "tiff", "pdf"):
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
