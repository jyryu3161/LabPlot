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

from functools import lru_cache

from app.figures.option_metadata import (
    _BOOL_OPTIONS,
    _INTEGER_NUMBER_KEYS,
    _NUMBER_OPTIONS,
    _OPTION_CHOICES,
    _UNIVERSAL_OPTION_KEYS,
)
from app.r_engine.option_support import potentially_supported_option_keys, supported_option_keys
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
#
# category_colors and element_overrides are modeled as ARRAYS here, not the
# maps sanitize_options actually wants, because Gemini's responseSchema
# (providers._to_gemini_schema) rejects any JSON-Schema object without a
# `properties` key - which an open `additionalProperties` map necessarily is.
# Without this, run_structured_with_usage silently falls back to prompt-only
# JSON for every improve_figure call on Gemini (verified root cause of
# "AI edits not applied" - M-A1.1). client._denormalize_patch_lists() converts
# these array shapes back to the map shape sanitize_options expects before
# anything else consumes a suggestion's param_patch.
_STRUCTURAL_SHAPES = {
    # Array of {level, color} pairs; denormalized to {level: color} in
    # client._denormalize_patch_lists() before sanitize_options sees it.
    "category_colors": {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "level": {"type": "string"},
                "color": {"type": "string"},
            },
            "required": ["level", "color"],
        },
    },
    # Array of {id, fill?, stroke?} entries - the same stable
    # scene-element id -> tiny visual patch semantics as the map shape, just
    # flattened to an array so every entry has a fixed `properties` set. The
    # service sanitizer remains authoritative for the id grammar, entry
    # bound, and #RRGGBB validation; this schema only constrains model output
    # to the renderer-supported fill/stroke surface. Denormalized back to
    # {id: {fill, stroke}} in client._denormalize_patch_lists().
    "element_overrides": {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "fill": {"type": "string"},
                "stroke": {"type": "string"},
            },
            "required": ["id"],
        },
    },
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


def _plot_type_option_keys(plot_type: str) -> set[str]:
    """Every option key the R generator could actually consume for
    `plot_type`, per app.r_engine.option_support's registry (A1.3(a)) - the
    union of keys consumed for a bare/default mapping+options AND keys only
    conditionally consumed (e.g. error_type, which needs error_bars on; a
    fresh figure would otherwise have it silently dropped from the schema
    just because error_bars happens to be off right now), minus the
    excluded-by-design keys."""
    keys = supported_option_keys(plot_type, None, None) | potentially_supported_option_keys(plot_type)
    return keys - _EXCLUDED_OPTION_KEYS


@lru_cache(maxsize=None)
def build_options_patch_schema(plot_type: str | None = None) -> dict:
    """Build the `options` patch JSON schema the AI editor is allowed to
    propose, generated from the real render/sanitize metadata rather than a
    hand-maintained list.

    `plot_type=None` (the default, and what the import-time Gemini-
    compatibility guard in app.ai.client validates) keeps the original flat
    union across every plot type. A concrete `plot_type` narrows the schema
    to only the option keys app.r_engine.option_support says this plot type
    could ever consume, so the model is not offered (and cannot be graded
    against) a key like `error_type` on a plot type that never reads it.
    Cached per plot_type (functools.lru_cache) since option_support's own
    per-type computation walks every builder's source via `inspect` once.
    """
    keys = _all_option_keys() if plot_type is None else _plot_type_option_keys(plot_type)
    return {
        "type": "object",
        "properties": {key: _schema_for_key(key) for key in sorted(keys)},
    }
