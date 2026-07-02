"""Publication style presets -> R theme + palette code (uses base ggplot2 only)."""
from __future__ import annotations

import re

# Self-defending guard for any color interpolated into generated R code. Even
# though the service layer validates palettes, the R-construction layer must not
# trust its inputs: only strict 6-digit hex colors are ever emitted.
_HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")

_JOURNAL_MUTED = ["#4C6F91", "#B24745", "#6A8A6B", "#8E6C8A", "#B79A43",
                  "#5D8D8A", "#8C7A6B", "#7A7A7A", "#A06B5F"]

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

# Allow-listed base font families -> R element_text(family = ...) value.
# "sans" maps to "" (ggplot default) so default output is unchanged.
_FONT_FAMILIES = {"sans": "", "serif": "serif", "mono": "mono"}

# Named discrete palettes the user can pick by name (verified hex). Overrides the
# preset palette when set. Curated for scientific figures; cb = colorblind-safe.
NAMED_PALETTES = {
    "journal_muted": _JOURNAL_MUTED,
    "okabe_ito":  ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#000000"],
    "tol_bright": ["#4477AA", "#EE6677", "#228833", "#CCBB44", "#66CCEE", "#AA3377", "#BBBBBB", "#000000"],
    "set2":       ["#66C2A5", "#FC8D62", "#8DA0CB", "#E78AC3", "#A6D854", "#FFD92F", "#E5C494", "#B3B3B3"],
    "npg":        ["#E64B35", "#4DBBD5", "#00A087", "#3C5488", "#F39B7F", "#8491B4", "#91D1C2", "#DC0000"],
    "tableau10":  ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7"],
}
_PALETTE_META = {
    "journal_muted": ("LabPlot Academic muted", False),
    "okabe_ito":  ("Okabe–Ito (colorblind-safe)", True),
    "tol_bright": ("Paul Tol Bright (colorblind-safe)", True),
    "set2":       ("ColorBrewer Set2 (soft)", False),
    "npg":        ("Nature (NPG)", False),
    "tableau10":  ("Tableau 10", False),
}


def list_palettes(custom_palettes: list[dict] | None = None) -> list[dict]:
    out = [{"key": "preset", "label": "Match style preset", "colorblind_safe": False, "hex": []}]
    for k, hexes in NAMED_PALETTES.items():
        label, cb = _PALETTE_META.get(k, (k, False))
        out.append({"key": k, "label": label, "colorblind_safe": cb, "hex": hexes})
    if custom_palettes:
        out.extend(custom_palettes)
    return out


def theme_r(preset: str, color_mode: str = "color", font_scale: float = 1.0,
            palette_name: str | None = None, custom_palette_values: list[str] | None = None,
            font_family: str | None = None, transparent_background: bool = False) -> str:
    cfg = _BASE.get(preset, _BASE["nature"])
    fam = _FONT_FAMILIES.get(font_family or "sans", "")
    family_arg = f', family = "{fam}"' if fam else ""
    if color_mode == "grayscale":
        pal = _GREYS
    elif palette_name and (palette_name == "custom" or palette_name.startswith("custom:")) and custom_palette_values:
        pal = custom_palette_values
    elif palette_name and palette_name in NAMED_PALETTES:
        pal = NAMED_PALETTES[palette_name]
    else:
        pal = PALETTES.get(preset, PALETTES["nature"])
    # Validate/normalize every color before it reaches generated R. Drop anything
    # that is not a strict 6-digit hex; fall back to the built-in Nature palette
    # if nothing valid remains. Built-in palettes are already valid hex, so this
    # does not change output for legitimate inputs (only uppercases them).
    valid = [c.upper() for c in pal if isinstance(c, str) and _HEX_COLOR_RE.fullmatch(c)]
    if not valid:
        valid = [c.upper() for c in PALETTES["nature"]]
    pal_r = ", ".join(f'"{c}"' for c in valid)
    try:
        size = max(7, int(round(cfg["size"] * float(font_scale))))
    except (TypeError, ValueError):
        size = cfg["size"]
    grid_line = (
        'panel.grid.major = element_line(colour = "grey92", linewidth = 0.18), panel.grid.minor = element_blank(),'
        if cfg["grid"] else
        'panel.grid = element_blank(),'
    )
    bg_fill = "NA" if transparent_background else '"white"'
    return f"""
labplot_palette <- function(n = 100) {{
  pal <- c({pal_r})
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
    axis.line = element_line(colour = "black", linewidth = 0.4),
    axis.ticks = element_line(colour = "black", linewidth = 0.35),
    axis.ticks.length = grid::unit(2.2, "pt"),
    legend.position = "right",
    legend.title = element_text(face = "bold", colour = "black", size = {size}),
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
