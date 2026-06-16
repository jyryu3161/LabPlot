"""Publication style presets -> R theme + palette code (uses base ggplot2 only)."""
from __future__ import annotations

PALETTES = {
    "nature": ["#E64B35", "#4DBBD5", "#00A087", "#3C5488", "#F39B7F", "#8491B4",
               "#91D1C2", "#DC0000", "#7E6148", "#B09C85"],
    "science": ["#3B4992", "#EE0000", "#008B45", "#631879", "#008280", "#BB0021",
                "#5F559B", "#A20056", "#808180", "#1B1919"],
    "cell": ["#3C5488", "#E64B35", "#00A087", "#F39B7F", "#4DBBD5", "#8491B4",
             "#91D1C2", "#DC0000", "#7E6148", "#B09C85"],
    "minimal": ["#333333", "#777777", "#AAAAAA", "#555555", "#999999", "#CCCCCC",
                "#222222", "#888888"],
    "colorblind": ["#000000", "#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2",
                   "#D55E00", "#CC79A7"],
}

_BASE = {
    "nature":     {"size": 7, "base": "theme_classic", "grid": False},
    "science":    {"size": 7, "base": "theme_bw",      "grid": True},
    "cell":       {"size": 7, "base": "theme_classic", "grid": False},
    "minimal":    {"size": 7, "base": "theme_minimal", "grid": True},
    "colorblind": {"size": 7, "base": "theme_classic", "grid": False},
}

PRESETS = list(_BASE.keys())

PRESET_LABELS = {
    "nature": "Clean Classic",
    "science": "Grid Classic",
    "cell": "Biomedical",
    "minimal": "Minimal",
    "colorblind": "Colorblind-safe",
}

# Distinguishable greyscale ramp for print/monochrome figures
_GREYS = ["#1a1a1a", "#666666", "#999999", "#cccccc", "#4d4d4d", "#808080", "#b3b3b3", "#000000"]

# Named discrete palettes the user can pick by name (verified hex). Overrides the
# preset palette when set. Curated for scientific figures; cb = colorblind-safe.
NAMED_PALETTES = {
    "okabe_ito":  ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7", "#000000"],
    "tol_bright": ["#4477AA", "#EE6677", "#228833", "#CCBB44", "#66CCEE", "#AA3377", "#BBBBBB", "#000000"],
    "set2":       ["#66C2A5", "#FC8D62", "#8DA0CB", "#E78AC3", "#A6D854", "#FFD92F", "#E5C494", "#B3B3B3"],
    "npg":        ["#E64B35", "#4DBBD5", "#00A087", "#3C5488", "#F39B7F", "#8491B4", "#91D1C2", "#DC0000"],
    "tableau10":  ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7"],
}
_PALETTE_META = {
    "okabe_ito":  ("Okabe–Ito (colorblind-safe)", True),
    "tol_bright": ("Paul Tol Bright (colorblind-safe)", True),
    "set2":       ("ColorBrewer Set2 (soft)", False),
    "npg":        ("Nature (NPG)", False),
    "tableau10":  ("Tableau 10", False),
}


def list_palettes() -> list[dict]:
    out = [{"key": "preset", "label": "Match style preset", "colorblind_safe": False, "hex": []}]
    for k, hexes in NAMED_PALETTES.items():
        label, cb = _PALETTE_META.get(k, (k, False))
        out.append({"key": k, "label": label, "colorblind_safe": cb, "hex": hexes})
    return out


def theme_r(preset: str, color_mode: str = "color", font_scale: float = 1.0, palette_name: str | None = None) -> str:
    cfg = _BASE.get(preset, _BASE["nature"])
    if color_mode == "grayscale":
        pal = _GREYS
    elif palette_name and palette_name in NAMED_PALETTES:
        pal = NAMED_PALETTES[palette_name]
    else:
        pal = PALETTES.get(preset, PALETTES["nature"])
    pal_r = ", ".join(f'"{c}"' for c in pal)
    try:
        size = max(7, int(round(cfg["size"] * float(font_scale))))
    except (TypeError, ValueError):
        size = cfg["size"]
    grid_line = (
        'panel.grid.major = element_line(colour = "grey92", linewidth = 0.18), panel.grid.minor = element_blank(),'
        if cfg["grid"] else
        'panel.grid = element_blank(),'
    )
    return f"""
labplot_palette <- function(n = 100) {{
  pal <- c({pal_r})
  rep(pal, length.out = max(n, length(pal)))
}}

labplot_theme <- function() {{
  {cfg['base']}(base_size = {size}) +
  theme(
    text = element_text(size = {size}),
    plot.title = element_text(face = "bold", hjust = 0.5, size = {size}),
    plot.subtitle = element_text(size = {size}, colour = "grey30", hjust = 0.5),
    plot.caption = element_text(size = {size}, colour = "grey35"),
    axis.title = element_text(face = "bold", colour = "black", size = {size}),
    axis.text = element_text(colour = "black", size = {size}),
    axis.line = element_line(colour = "black", linewidth = 0.3),
    axis.ticks = element_line(colour = "black", linewidth = 0.3),
    axis.ticks.length = grid::unit(2.2, "pt"),
    legend.position = "right",
    legend.title = element_text(face = "bold", colour = "black", size = {size}),
    legend.text = element_text(colour = "black", size = {size}),
    legend.key = element_blank(),
    strip.text = element_text(face = "bold", colour = "black", size = {size}),
    {grid_line}
    plot.background = element_rect(fill = "white", colour = NA),
    panel.background = element_rect(fill = "white", colour = NA),
    plot.margin = margin(10, 12, 10, 10)
  )
}}
"""
