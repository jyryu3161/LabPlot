"""Publication style presets -> R theme + palette code (uses base ggplot2 only)."""
from __future__ import annotations

import re

# Self-defending guard for any color interpolated into generated R code. Even
# though the service layer validates palettes, the R-construction layer must not
# trust its inputs: only strict 6-digit hex colors are ever emitted.
_HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")

_JOURNAL_MUTED = ["#4C6F91", "#B24745", "#6A8A6B", "#8E6C8A", "#B79A43",
                  "#5D8D8A", "#8C7A6B", "#7A7A7A", "#A06B5F"]

# Immutable palette for figures created with the current publication defaults.
# Keep this separate from _JOURNAL_MUTED: stored legacy FigureVersion rows refer
# to the old key and must reproduce the same colors during rerender/export.
_PUBLICATION_MUTED_V2 = [
    "#62B9C5",  # teal
    "#E4776B",  # coral
    "#7569AE",  # indigo
    "#61A574",  # green
    "#E7A85A",  # amber
    "#C36CA5",  # magenta
    "#8BB8D4",  # sky
    "#B5BAC0",  # neutral
]
_PUBLICATION_MUTED_V2_STROKES = [
    "#2F8998",
    "#B94A3F",
    "#51458E",
    "#347B49",
    "#B97626",
    "#913C75",
    "#557E9E",
    "#707780",
]

DEFAULT_NEW_FIGURE_PALETTE = "publication_muted_v2"
DEFAULT_NEW_FIGURE_OPTIONS = {
    "palette_name": DEFAULT_NEW_FIGURE_PALETTE,
    # The backend image does not contain the proprietary Arial face. Persist
    # the exact installed family used by R instead of silently aliasing Arial.
    "font_family": "dejavu_sans",
    "base_size": 7,
    # Publication dimensions are authored in points, then converted explicitly
    # to ggplot2's millimetre linewidth unit in generated R.
    "axis_line_width_pt": 0.5,
    "data_line_width_pt": 0.8,
    # User-facing multiplier around the point tokens above. Legacy versions
    # without point tokens retain the old multiplier-only behavior.
    "linewidth_scale": 1.0,
    # New grouped line figures use color plus linetype/marker, so information
    # is not encoded by hue alone. Existing versions omit this opt-in key.
    "redundant_series_encoding": True,
}

PALETTES = {
    "nature": _JOURNAL_MUTED,
    "science": ["#4F658C", "#8C5D5B", "#5F7E63", "#8B7B55", "#6E648B",
                "#6A8584", "#8C7A73", "#9A9A9A"],
    "cell": ["#526D87", "#8D6B67", "#668467", "#B0A06C", "#7A7195",
             "#6D8B8B", "#987A71", "#9A9A9A"],
    "minimal": ["#333333", "#777777", "#AAAAAA", "#555555", "#999999", "#CCCCCC",
                "#222222", "#888888"],
    "colorblind": ["#000000", "#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2",
                   "#D55E00", "#CC79A7"],
}

_BASE = {
    "nature":     {"size": 7, "base": "theme_classic", "grid": False},
    "science":    {"size": 7, "base": "theme_classic", "grid": False},
    "cell":       {"size": 7, "base": "theme_classic", "grid": False},
    "minimal":    {"size": 7, "base": "theme_classic", "grid": False},
    "colorblind": {"size": 7, "base": "theme_classic", "grid": False},
}

PRESETS = list(_BASE.keys())

PRESET_LABELS = {
    "nature": "Clean Classic",
    "science": "Science Classic",
    "cell": "Biomedical Classic",
    "minimal": "Minimal Classic",
    "colorblind": "Colorblind-safe",
}

PRESET_DESCRIPTIONS = {
    "nature": "Default manuscript theme with restrained academic colors.",
    "science": "Compact classic theme with cool muted colors and no gridlines.",
    "cell": "Biomedical theme with soft categorical colors and no gridlines.",
    "minimal": "Monochrome classic theme for simple publication figures.",
    "colorblind": "Classic theme using a colorblind-safe default palette.",
}

# ---------------------------------------------------------------------------
# Journal submission specifications (DATA ONLY — does not affect theme/palette
# output). Real, published figure requirements per style preset: column widths
# converted mm -> inches, resolution bounds, preferred font family, and accepted
# file formats. Consumed by the deterministic compliance check and submission
# bundle to compare a rendered version against its target journal.
#
# Column widths use widely-cited published values, e.g. Nature single 89 mm
# (3.50 in) / double 183 mm (7.20 in); Science single 55 mm (2.17 in) / double
# 120 mm (4.72 in); Cell single 85 mm (3.35 in) / double 174 mm (6.85 in).
# ---------------------------------------------------------------------------
JOURNAL_SPECS = {
    "nature": {
        "journal": "Nature",
        "single_col_in": 3.50,   # 89 mm
        "double_col_in": 7.20,   # 183 mm
        "min_dpi": 300,
        "max_dpi": 1200,
        "preferred_font": "sans",              # Helvetica / Arial
        "preferred_formats": ["tiff", "eps", "pdf"],
    },
    "science": {
        "journal": "Science",
        "single_col_in": 2.17,   # 55 mm
        "double_col_in": 4.72,   # 120 mm
        "min_dpi": 300,
        "max_dpi": 1200,
        "preferred_font": "sans",              # Helvetica
        "preferred_formats": ["tiff", "eps", "pdf"],
    },
    "cell": {
        "journal": "Cell (Cell Press)",
        "single_col_in": 3.35,   # 85 mm
        "double_col_in": 6.85,   # 174 mm
        "min_dpi": 300,
        "max_dpi": 1200,
        "preferred_font": "sans",              # Arial / Helvetica
        "preferred_formats": ["tiff", "eps", "pdf"],
    },
    "minimal": {
        "journal": "Generic print (single/double column)",
        "single_col_in": 3.50,
        "double_col_in": 7.00,
        "min_dpi": 300,
        "max_dpi": 1200,
        "preferred_font": "sans",
        "preferred_formats": ["pdf", "tiff", "eps", "svg"],
    },
    "colorblind": {
        "journal": "Generic print (colorblind-safe)",
        "single_col_in": 3.50,
        "double_col_in": 7.00,
        "min_dpi": 300,
        "max_dpi": 1200,
        "preferred_font": "sans",
        "preferred_formats": ["pdf", "tiff", "eps", "svg"],
    },
    # ---- Additional published specs for journals that are not yet distinct
    # style presets. journal_spec() resolves any of these keys; they are kept
    # here for forward-compatibility if/when matching presets are added. ----
    "plos": {
        "journal": "PLOS",
        "single_col_in": 5.20,
        "double_col_in": 7.50,
        "min_dpi": 300,
        "max_dpi": 600,
        "preferred_font": "sans",              # Arial / Helvetica
        "preferred_formats": ["tiff", "eps"],
    },
    "ieee": {
        "journal": "IEEE",
        "single_col_in": 3.50,
        "double_col_in": 7.16,
        "min_dpi": 300,
        "max_dpi": 1200,
        "preferred_font": "serif",             # Times New Roman for text/labels
        "preferred_formats": ["tiff", "eps", "pdf"],
    },
}


def journal_spec(preset: str | None) -> dict:
    """Return the journal submission spec for a style preset (fallback: nature).

    Pure data lookup used by the compliance check and submission bundle; never
    affects theme/palette rendering.
    """
    return JOURNAL_SPECS.get(preset or "", JOURNAL_SPECS["nature"])


# Distinguishable greyscale ramp for print/monochrome figures
_GREYS = ["#1a1a1a", "#666666", "#999999", "#cccccc", "#4d4d4d", "#808080", "#b3b3b3", "#000000"]

# Allow-listed font families -> R element_text(family = ...) value.
#
# Keys are a stable allow-list; the value is the exact fontconfig family name
# passed to R. Any user-supplied value not present here falls back to "" (the
# ggplot/device default), so no untrusted string ever reaches R. Every non-empty
# target below was verified to resolve to a REAL installed face (not a silent
# default fallback) via `fc-match "<name>"` inside the backend container:
#
#   DejaVu Sans   -> DejaVuSans.ttf  "DejaVu Sans"   (metric-ish Helvetica/Arial)
#   DejaVu Serif  -> DejaVuSerif.ttf "DejaVu Serif"  (Times substitute)
#   Noto Sans     -> NotoSans-Regular.ttf  "Noto Sans"
#   Noto Serif    -> NotoSerif-Regular.ttf "Noto Serif"
#
# NOTE: "Nimbus Sans"/"Nimbus Roman" are NOT installed in this image (fc-match
# falls back to DejaVu), so Helvetica/Arial/Times are mapped to the DejaVu faces
# that actually resolve. "sans" stays "" so default output is byte-for-byte
# unchanged; "serif"/"mono" keep the R generic families for back-compat.
_FONT_FAMILIES = {
    "sans": "",                 # ggplot default sans (unchanged default output)
    "serif": "serif",           # R generic serif (back-compat)
    "mono": "mono",             # R generic mono (back-compat)
    "helvetica": "DejaVu Sans",  # metric-compatible sans
    "arial": "DejaVu Sans",      # metric-compatible sans
    "dejavu_sans": "DejaVu Sans",  # exact installed fallback exposed in UI/R
    "times": "DejaVu Serif",     # Times substitute
    "noto_sans": "Noto Sans",
    "noto_serif": "Noto Serif",
}

# Allow-listed font family keys (for callers/sanitizers that need the choice set).
FONT_FAMILIES = tuple(_FONT_FAMILIES.keys())

# Named discrete palettes the user can pick by name (verified hex). Overrides the
# preset palette when set. Curated for scientific figures; cb = colorblind-safe.
NAMED_PALETTES = {
    "publication_muted_v2": _PUBLICATION_MUTED_V2,
    "journal_muted": _JOURNAL_MUTED,
    "okabe_ito":  ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#000000"],
    "tol_bright": ["#4477AA", "#EE6677", "#228833", "#CCBB44", "#66CCEE", "#AA3377", "#BBBBBB", "#000000"],
    "set2":       ["#66C2A5", "#FC8D62", "#8DA0CB", "#E78AC3", "#A6D854", "#FFD92F", "#E5C494", "#B3B3B3"],
    "npg":        ["#E64B35", "#4DBBD5", "#00A087", "#3C5488", "#F39B7F", "#8491B4", "#91D1C2", "#DC0000"],
    "tableau10":  ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7"],
}
NAMED_PALETTE_STROKES = {
    "publication_muted_v2": _PUBLICATION_MUTED_V2_STROKES,
}
_PALETTE_META = {
    "publication_muted_v2": ("Muted publication · teal/coral", False),
    "journal_muted": ("LabPlot Academic muted", False),
    "okabe_ito":  ("Okabe–Ito (colorblind-safe)", True),
    "tol_bright": ("Paul Tol Bright (colorblind-safe)", True),
    "set2":       ("ColorBrewer Set2 (soft)", False),
    "npg":        ("Nature (NPG)", False),
    "tableau10":  ("Tableau 10", False),
}
_PALETTE_USAGE_NOTES = {
    "publication_muted_v2": (
        "Teal/coral-first fills with darker line strokes. Grouped line charts "
        "also use marker and line-type redundancy; verify dense figures in grayscale."
    ),
}


def list_palettes(custom_palettes: list[dict] | None = None) -> list[dict]:
    out = [{
        "key": "preset",
        "label": "Match style preset",
        "colorblind_safe": False,
        "hex": [],
        "is_default_for_new_figures": False,
    }]
    for k, hexes in NAMED_PALETTES.items():
        label, cb = _PALETTE_META.get(k, (k, False))
        out.append({
            "key": k,
            "label": label,
            "colorblind_safe": cb,
            "hex": hexes,
            "is_default_for_new_figures": k == DEFAULT_NEW_FIGURE_PALETTE,
            "usage_note": _PALETTE_USAGE_NOTES.get(k),
        })
    if custom_palettes:
        out.extend({**palette, "is_default_for_new_figures": False} for palette in custom_palettes)
    return out


def resolve_base_size(base_size, font_scale=1.0, preset_size=7):
    """Resolve the absolute base font size (pt) for a render.

    `base_size` (absolute pt) is the single source of truth when set: coerced to
    an int and clamped to [5, 14]. When unset (None) or non-numeric, fall back to
    the legacy `font_scale` multiplier over the preset size (default 7). Lives
    here so the renderer can import it for the R device pointsize and stay in sync
    with the theme text size.
    """
    if base_size is not None:
        try:
            return max(5, min(14, int(round(float(base_size)))))
        except (TypeError, ValueError):
            pass
    return max(7, int(round(preset_size * float(font_scale or 1.0))))


def theme_r(preset: str, color_mode: str = "color", font_scale: float = 1.0,
            palette_name: str | None = None, custom_palette_values: list[str] | None = None,
            font_family: str | None = None, transparent_background: bool = False,
            legend_key_size: float | None = None,
            base_size: int | float | None = None,
            axis_line_width_pt: int | float | None = None,
            data_line_width_pt: int | float | None = None) -> str:
    cfg = _BASE.get(preset, _BASE["nature"])
    fam = _FONT_FAMILIES.get(font_family or "sans", "")
    family_arg = f', family = "{fam}"' if fam else ""
    # Legend key size (theme-level). Numeric-coerced + clamped to a sane pt range
    # so no untrusted value reaches R; None leaves the theme default untouched.
    legend_key_line = ""
    if legend_key_size is not None:
        try:
            lk = max(4.0, min(40.0, float(legend_key_size)))
            legend_key_line = f'legend.key.size = grid::unit({lk:g}, "pt"),\n    '
        except (TypeError, ValueError):
            legend_key_line = ""
    if color_mode == "grayscale":
        pal = _GREYS
        stroke_pal = pal
    elif palette_name and (palette_name == "custom" or palette_name.startswith("custom:")) and custom_palette_values:
        pal = custom_palette_values
        stroke_pal = pal
    elif palette_name and palette_name in NAMED_PALETTES:
        pal = NAMED_PALETTES[palette_name]
        stroke_pal = NAMED_PALETTE_STROKES.get(palette_name, pal)
    else:
        pal = PALETTES.get(preset, PALETTES["nature"])
        stroke_pal = pal
    # Validate/normalize every color before it reaches generated R. Drop anything
    # that is not a strict 6-digit hex; fall back to the built-in Nature palette
    # if nothing valid remains. Built-in palettes are already valid hex, so this
    # does not change output for legitimate inputs (only uppercases them).
    valid = [c.upper() for c in pal if isinstance(c, str) and _HEX_COLOR_RE.fullmatch(c)]
    if not valid:
        valid = [c.upper() for c in PALETTES["nature"]]
    valid_strokes = [
        c.upper() for c in stroke_pal
        if isinstance(c, str) and _HEX_COLOR_RE.fullmatch(c)
    ]
    if not valid_strokes:
        valid_strokes = valid
    pal_r = ", ".join(f'"{c}"' for c in valid)
    stroke_pal_r = ", ".join(f'"{c}"' for c in valid_strokes)
    size = resolve_base_size(base_size, font_scale, cfg["size"])
    pt_helper = ""
    axis_line_width_r = "0.4"
    axis_tick_width_r = "0.35"
    if axis_line_width_pt is not None or data_line_width_pt is not None:
        pt_helper = "labplot_pt_to_mm <- function(pt) pt * 25.4 / 72.27\n\n"
    if axis_line_width_pt is not None:
        try:
            axis_pt = max(0.1, min(3.0, float(axis_line_width_pt)))
            axis_line_width_r = f"labplot_pt_to_mm({axis_pt:g})"
            axis_tick_width_r = axis_line_width_r
        except (TypeError, ValueError):
            pass
    grid_line = (
        'panel.grid.major = element_line(colour = "grey92", linewidth = 0.18), panel.grid.minor = element_blank(),'
        if cfg["grid"] else
        'panel.grid = element_blank(),'
    )
    bg_fill = "NA" if transparent_background else '"white"'
    return f"""
{pt_helper}labplot_palette <- function(n = 100) {{
  pal <- c({pal_r})
  rep(pal, length.out = max(n, length(pal)))
}}

labplot_stroke_palette <- function(n = 100) {{
  pal <- c({stroke_pal_r})
  rep(pal, length.out = max(n, length(pal)))
}}

labplot_accent <- function() {{
  c({pal_r})[[1]]
}}

labplot_theme <- function() {{
  {cfg['base']}(base_size = {size}) +
  theme(
    text = element_text(size = {size}{family_arg}),
    plot.title = element_text(face = "bold", hjust = 0.5, size = {size}),
    plot.subtitle = element_text(size = {size}, colour = "grey30", hjust = 0.5),
    plot.caption = element_text(size = {size}, colour = "grey35"),
    axis.title = element_text(face = "bold", colour = "black", size = {size}),
    axis.text = element_text(colour = "black", size = {size}),
    axis.line = element_line(colour = "black", linewidth = {axis_line_width_r}),
    axis.ticks = element_line(colour = "black", linewidth = {axis_tick_width_r}),
    axis.ticks.length = grid::unit(2.2, "pt"),
    legend.position = "right",
    {legend_key_line}legend.title = element_text(face = "bold", colour = "black", size = {size}),
    legend.text = element_text(colour = "black", size = {size}),
    legend.key = element_blank(),
    strip.text = element_text(face = "bold", colour = "black", size = {size}),
    {grid_line}
    plot.background = element_rect(fill = {bg_fill}, colour = NA),
    panel.background = element_rect(fill = {bg_fill}, colour = NA),
    plot.margin = margin(10, 12, 10, 10)
  )
}}
"""
