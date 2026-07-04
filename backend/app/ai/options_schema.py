"""Builds the AI-facing `options` patch JSON schema from the real renderer
option metadata, instead of a hand-maintained list (U10a).

Import direction note: app.figures.service imports app.ai.client (for the AI
figure-improvement features), so app.ai.client must not import
app.figures.service directly or indirectly - that would be circular. This
module therefore only imports:
  - app.figures.option_metadata: the sanitize-time universal option sets
    (extracted out of figures/service.py into a leaf module for exactly this
    reason - see that module's docstring).
  - app.r_engine.templates: the per-plot-type option definitions (key/type/
    choices), which has no app-internal imports at all.
Neither of those imports app.ai.client, so this module is safe to import from
app.ai.client at module import time.

The generated schema is intentionally a flat union across every plot type
(exactly like the schema it replaces): the AI always receives the full set of
option keys the renderer can ever consume, and the real gate is still
`figures.service.sanitize_options` / `_sanitize_param_patch`, which restrict a
patch to the keys valid for the CURRENT plot type plus the universal keys.
Widening what the AI can express here never widens what the server accepts.
"""
from __future__ import annotations

from app.figures.option_metadata import (
    _BOOL_OPTIONS,
    _INTEGER_NUMBER_KEYS,
    _NUMBER_OPTIONS,
    _OPTION_CHOICES,
    _UNIVERSAL_OPTION_KEYS,
)
from app.r_engine.templates import PLOT_TYPES

# Keys that sanitize_options/_sanitize_option would accept but are
# deliberately excluded from the AI-editable schema. Each exclusion is
# reasoned, not incidental - this is the only hand-listed set in this module.
_EXCLUDED_OPTION_KEYS = {
    # Structured overlay list with its own dedicated inspector UI
    # (FigureAnnotationEditor) and shape-validating sanitizer
    # (_sanitize_annotations). Free-form AI generation of a whole annotations
    # array risks silently replacing/clobbering user-authored overlays instead
    # of making a scoped edit, and item coordinates are in figure-space units
    # the model has no reliable way to target from a rendered PNG alone.
    "annotations",
    # Structured per-series style overrides dict with its own dedicated
    # inspector UI (FigureSeriesStyleEditor) and shape-validating sanitizer
    # (_sanitize_series_styles). Never part of the hand-maintained AI schema
    # either; keeping it excluded here preserves that behavior rather than
    # silently expanding the AI's write surface to a structured, per-key
    # override map.
    "series_styles",
    # Raw hex color list for a *custom* saved palette. This is bulk color data
    # sourced only from a user's saved Palette record or the custom-palette
    # editor UI, not a "visual parameter" - letting the AI invent hex lists
    # here would bypass the user's saved palettes rather than adjust styling.
    "custom_palette_values",
    # Free-form label paired 1:1 with custom_palette_values above; meaningless
    # on its own and excluded for the same reason.
    "custom_palette_label",
    # Gates the (slower, heavier) self-contained interactive Plotly HTML
    # export. This is an export-format workflow choice, not a visual
    # improvement; letting the AI flip it on every applied suggestion would
    # silently multiply render cost/time for no requested benefit.
    "interactive_html",
}


def _enum_schema(key: str) -> dict:
    return {"type": "string", "enum": sorted(_OPTION_CHOICES[key])}


def _number_schema(key: str) -> dict:
    return {"type": "integer"} if key in _INTEGER_NUMBER_KEYS else {"type": "number"}


# Structural shapes for keys whose sanitize acceptance shape is not a plain
# bool/number/enum/string (mirrors the special-cased branches at the top of
# figures/service.py:_sanitize_option). This is shape metadata, not an option
# allow-list: which keys exist is still driven entirely by
# _UNIVERSAL_OPTION_KEYS and the per-plot-type option keys below.
_STRUCTURAL_SHAPES = {
    "category_colors": {"type": "object", "additionalProperties": {"type": "string"}},
    "level_order": {"type": "array", "items": {"type": "string"}},
    "axis_break_x": {"type": "array", "items": {"type": "number"}},
    "axis_break_y": {"type": "array", "items": {"type": "number"}},
}


def _schema_for_key(key: str) -> dict:
    """The JSON-Schema shape sanitize_options would actually accept for `key`,
    following the exact same precedence _sanitize_option uses: structural
    special-cases first, then the enum table, then bool/number sets, then a
    plain length-capped string fallback."""
    if key in _STRUCTURAL_SHAPES:
        return _STRUCTURAL_SHAPES[key]
    if key in _OPTION_CHOICES:
        return _enum_schema(key)
    if key in _BOOL_OPTIONS:
        return {"type": "boolean"}
    if key in _NUMBER_OPTIONS:
        return _number_schema(key)
    # Plain strings: labels/titles, line_color (hex, validated on sanitize),
    # facet_by/y2_column (must be a real dataset column, validated on
    # sanitize), y2_label, series_1_label/series_2_label, etc.
    return {"type": "string"}


def _all_option_keys() -> set[str]:
    """Every option key sanitize_options can reach for SOME plot type: the
    universal keys plus the union of every plot type's declared per-type
    option keys (r_engine/templates.py). This is the single point of truth
    for "does the renderer support this option" - no option name is
    hand-listed beyond _EXCLUDED_OPTION_KEYS above."""
    keys = set(_UNIVERSAL_OPTION_KEYS)
    for plot_type in PLOT_TYPES:
        for option in plot_type.get("options", []):
            key = option.get("key")
            if isinstance(key, str) and key:
                keys.add(key)
    return keys - _EXCLUDED_OPTION_KEYS


def build_options_patch_schema() -> dict:
    """Build the `options` patch JSON schema the AI editor is allowed to
    propose, generated from the real render/sanitize metadata rather than a
    hand-maintained list. Called once at import time; the result is a plain
    dict (mutating it after import is the caller's responsibility, same
    contract as the schema it replaces)."""
    keys = _all_option_keys()
    return {
        "type": "object",
        "properties": {key: _schema_for_key(key) for key in sorted(keys)},
    }
