"""Compose rendered figure PNGs into a labeled multi-panel canvas (PNG + PDF).

The composition R script relies only on packages already present in the render
image: png (readPNG), grid (rasterGrob/textGrob) and gridExtra (arrangeGrob).
Panel image files are written by Python into the disposable work directory
under fixed, Python-generated names (panel_1.png, ...), so no user-controlled
path ever reaches the R script; panel labels are the only user strings in the
script and are escaped with the same rq() quoting used by templates.py.

Subprocess hardening (scrubbed env, resource limits, Rscript resolution) is
reused from renderer.py rather than duplicated.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

from app.config import settings
from app.r_engine.renderer import _resource_limit_preexec, _rscript_bin, _scrubbed_env
from app.r_engine.templates import rq

# Canvas dimensions are expressed in CSS-like pixels (96 px/inch) and rendered
# at print resolution for the PNG output.
_PX_PER_INCH = 96.0
_CANVAS_DPI = 300

MAX_GRID_DIM = 4
MAX_PANELS = 16


class ComposeResult:
    def __init__(self, success: bool, r_code: str, outputs: dict, log: str):
        self.success = success
        self.r_code = r_code
        self.outputs = outputs  # {"png": path, "pdf": path, "r": path}
        self.log = log


def build_compose_script(rows: int, cols: int, panels: list[dict],
                         width_px: int, height_px: int, dpi: int = _CANVAS_DPI) -> str:
    """Build the R script arranging panel PNGs into a rows x cols grid.

    ``panels`` items: {"filename": str (Python-generated, inside the work dir),
    "row": int, "col": int, "label": str}. Labels are drawn bold at each
    panel's top-left corner; empty labels are skipped.
    """
    n_row = int(rows)
    n_col = int(cols)
    if not (1 <= n_row <= MAX_GRID_DIM and 1 <= n_col <= MAX_GRID_DIM):
        raise ValueError("Canvas grid must be between 1x1 and 4x4")
    if not panels or len(panels) > MAX_PANELS:
        raise ValueError(f"Canvas needs between 1 and {MAX_PANELS} panels")

    files_vec = ", ".join(rq(p["filename"]) for p in panels)
    labels_vec = ", ".join(rq(str(p.get("label") or "")[:8]) for p in panels)
    rows_vec = ", ".join(f"{int(p['row'])}L" for p in panels)
    cols_vec = ", ".join(f"{int(p['col'])}L" for p in panels)
    w_in = max(1.0, float(width_px) / _PX_PER_INCH)
    h_in = max(1.0, float(height_px) / _PX_PER_INCH)
    dpi = int(dpi)

    return f"""# LabPlot AI - multi-panel canvas composition
suppressPackageStartupMessages({{
  library(grid); library(gridExtra); library(png)
}})

files     <- c({files_vec})
labels    <- c({labels_vec})
panel_row <- c({rows_vec})
panel_col <- c({cols_vec})
n_row <- {n_row}L
n_col <- {n_col}L

make_panel <- function(path, label) {{
  img <- png::readPNG(path)
  g <- grid::rasterGrob(img, interpolate = TRUE)
  if (!nzchar(label)) return(grid::grobTree(g))
  lab <- grid::textGrob(
    label,
    x = grid::unit(2, "mm"), y = grid::unit(1, "npc") - grid::unit(2, "mm"),
    just = c("left", "top"),
    gp = grid::gpar(fontface = "bold", fontsize = 12, col = "black")
  )
  grid::grobTree(g, lab)
}}

cells <- vector("list", n_row * n_col)
for (i in seq_along(files)) {{
  idx <- (panel_row[i] - 1L) * n_col + panel_col[i]
  cells[[idx]] <- make_panel(files[i], labels[i])
}}
for (j in seq_len(n_row * n_col)) {{
  if (is.null(cells[[j]])) cells[[j]] <- grid::nullGrob()
}}
composite <- gridExtra::arrangeGrob(grobs = cells, nrow = n_row, ncol = n_col)

png("canvas.png", width = {w_in:g} * {dpi}, height = {h_in:g} * {dpi}, res = {dpi}, bg = "white")
grid::grid.newpage(); grid::grid.draw(composite); invisible(dev.off())

.pdf_device <- if (isTRUE(capabilities("cairo"))) grDevices::cairo_pdf else grDevices::pdf
.pdf_device("canvas.pdf", width = {w_in:g}, height = {h_in:g}, bg = "white")
grid::grid.newpage(); grid::grid.draw(composite); invisible(dev.off())
"""


def compose(panels: list[dict], rows: int, cols: int,
            width_px: int, height_px: int, out_dir: str) -> ComposeResult:
    """Arrange panel PNGs into a grid, producing canvas.png/canvas.pdf in out_dir.

    ``panels`` items: {"png_bytes": bytes, "row": int, "col": int, "label": str}.
    """
    os.makedirs(out_dir, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="labplot_canvas_") as work:
        spec = []
        for i, panel in enumerate(panels, start=1):
            filename = f"panel_{i}.png"
            with open(os.path.join(work, filename), "wb") as f:
                f.write(panel["png_bytes"])
            spec.append({
                "filename": filename,
                "row": panel["row"],
                "col": panel["col"],
                "label": panel.get("label") or "",
            })
        r_code = build_compose_script(rows, cols, spec, width_px, height_px)
        with open(os.path.join(work, "canvas.R"), "w") as f:
            f.write(r_code)

        try:
            proc = subprocess.run(
                [_rscript_bin(), "canvas.R"],
                cwd=work,
                capture_output=True,
                text=True,
                timeout=settings.RENDER_TIMEOUT_SEC,
                env=_scrubbed_env(work),
                preexec_fn=_resource_limit_preexec(),
            )
        except subprocess.TimeoutExpired:
            return ComposeResult(False, r_code, {}, "Canvas composition timed out")
        except FileNotFoundError as e:
            return ComposeResult(False, r_code, {}, f"Rscript not found: {e}")

        log = (proc.stdout or "") + "\n" + (proc.stderr or "")
        if proc.returncode != 0:
            return ComposeResult(False, r_code, {}, log.strip())

        outputs = {}
        for ext in ("png", "pdf"):
            src = os.path.join(work, f"canvas.{ext}")
            if os.path.exists(src) and os.path.getsize(src) > 0:
                dst = os.path.join(out_dir, f"canvas.{ext}")
                shutil.copyfile(src, dst)
                outputs[ext] = dst
        # keep the reproducible composition script alongside the outputs
        with open(os.path.join(out_dir, "canvas.R"), "w") as f:
            f.write(r_code)
        outputs["r"] = os.path.join(out_dir, "canvas.R")

        if "png" not in outputs or "pdf" not in outputs:
            return ComposeResult(False, r_code, outputs, "No canvas outputs produced.\n" + log.strip())
        return ComposeResult(True, r_code, outputs, log.strip())
