"""Per-plot-type "consumed options" registry (A1.3(a)).

Problem this solves: an AI edit (or a human, via the options JSON) can set an
option key that the R generator (``app.r_engine.templates`` /
``app.r_engine.renderer``) never reads for the figure's plot type -- the
stored options dict changes, the edit is reported "applied", but the render is
byte-identical. ``option_support()`` answers, for a given
``(plot_type, mapping, options)``, whether each option key would actually
change ``renderer.build_script``'s output.

Sources of truth (read, not guessed -- see the docstring of each helper this
module imports for the line-level contract):
  * ``templates.DEVICE_TYPES`` / ``templates.NO_THEME_TYPES`` -- which whole
    post-processing blocks ``renderer.build_script`` skips for a plot type.
  * ``templates.scale_editable_axes()`` -- the SAME gate ``_post_layers`` uses
    for x_breaks/y_breaks/x_tick_format/y_tick_format/reverse_x/reverse_y
    (log-scale, temporal-x and discrete-axis all fold in here already).
  * ``templates.has_discrete_color_scale()`` / ``has_visible_discrete_legend()``
    -- precise, mapping/options-aware predicates for whether a plot type's
    builder emits (and, for legend_ncol, actually shows) a discrete
    fill/colour/shape/linetype scale for category_colors / custom_palette_values
    / legend_ncol to act on. Renderer.build_script gates the emission of
    ``_category_color_override_r`` / ``_legend_ncol_r`` on the SAME
    predicates, so script text and this registry's verdict agree exactly
    (not the coarser, type-only ``templates.is_color_editable()``, which
    remains for figures/router.py's static per-type CanvasColorEditor flag).
  * ``option_metadata._ELEMENT_MARK_ID_RE_BY_PLOT`` -- which plot types the
    renderer issues per-mark ``element_overrides`` IDs for.
  * ``templates._UNIVERSAL_TYPES`` / ``templates._DATA_LABEL_TARGETS`` /
    ``templates._TEMPORAL_X_TYPES`` -- the plot-type sets
    ``renderer.build_script``'s shared post-processing helpers
    (``_post_layers``, ``_data_labels_layer``, ``_temporal_x``) gate on.

For the handful of options whose consumption is decided INSIDE one specific
builder function (``templates._BUILDERS[plot_type]``) rather than by one of
the shared gates above -- title/subtitle/x_label/y_label (via the shared
``_labs()`` helper, or a handful of builders that read ``options['title']``
etc. directly for a base-R plot), fill_alpha/point_alpha (via ``_alpha_r()``),
level_order (via ``_level_order_vec()``), y2_column/y2_label (via
``_y2_axis()``), fit_model/show_fit_stats and the ``color_mode`` direct reads
inside a few base-R (DEVICE_TYPES) builders -- this module inspects the
builder function SOURCE (``inspect.getsource``) once at import time for the
literal call/lookup pattern, instead of hand-copying a plot-type list that
could silently drift from templates.py. This is still "derive from
templates.py", just via introspection rather than a constant.

Everything else (a genuine cross-option dependency, e.g. ``error_type`` only
mattering when ``error_bars`` is truthy, or ``width_in``/``height_in`` only
mattering when ``size == "custom"``) is a small explicit rule below, each
commented with the templates.py/renderer.py line it mirrors.

``option_support()`` reports "consumed" as a claim about the RENDERED
figure, not merely about whether the R generator emits different script
text. ``category_colors`` and ``legend_ncol`` are precisely gated: renderer
only emits ``_category_color_override_r`` / ``_legend_ncol_r`` when
``templates.has_discrete_color_scale()`` / ``has_visible_discrete_legend()``
say the mapping/options actually produce (a visible) discrete scale, and this
registry uses the identical predicates -- so for those two keys, script text
changing and "consumed" always agree; no KNOWN_EXCEPTIONS are needed.

``custom_palette_values`` is the one remaining documented exception:
``theme_r()`` ALWAYS defines ``labplot_palette()``/``labplot_stroke_palette()``
from it (a real script-text change) for every plot type outside
``NO_THEME_TYPES``, even when has_discrete_color_scale() is False and no
builder call site will ever invoke either helper -- e.g. heatmap (continuous
fill), dot_plot/lollipop (constant point colour), or bar without
``color_bars``. Detecting that from build_script's text alone would require
executing R (ggplot_build), which this module deliberately does not do;
custom_palette_values is therefore reported NOT consumed for those
(plot_type, mapping) combinations even though build_script's text does
change -- the mandatory honesty test documents exactly this small set in
KNOWN_EXCEPTIONS rather than silently reporting "consumed" (and therefore
"applied") for a palette definition no discrete scale ever reads.

The mandatory honesty test (tests/test_option_support_registry.py) builds
``renderer.build_script()`` with and without a sentinel value for every
(plot_type, key) pair and asserts the script text changes if and only if this
module says "consumed". Treat that test, not this docstring, as the final
authority; KNOWN_EXCEPTIONS in the test documents the (very few) pairs this
static approach cannot decide without executing R.
"""
from __future__ import annotations

import inspect
import re

from app.figures.option_metadata import _ELEMENT_MARK_ID_RE_BY_PLOT, _UNIVERSAL_OPTION_KEYS
from app.r_engine.templates import (
    DEVICE_TYPES,
    NO_THEME_TYPES,
    PLOT_TYPES,
    PLOT_TYPE_KEYS,
    _BUILDERS,
    _DATA_LABEL_TARGETS,
    _TEMPORAL_X_TYPES,
    _UNIVERSAL_TYPES,
    has_discrete_color_scale,
    has_visible_discrete_legend,
    scale_editable_axes,
)

_PLOT_DEFS: dict[str, dict] = {p["type"]: p for p in PLOT_TYPES}


def _own_option_keys(plot_type: str) -> set[str]:
    pdef = _PLOT_DEFS.get(plot_type)
    return {o["key"] for o in pdef.get("options", [])} if pdef else set()


# ---------------------------------------------------------------------------
# Introspection: which plot-type builders textually reference a given key /
# helper call. Computed once at import time directly from templates.py's own
# source, so it can never silently drift from a hand-copied table.
# ---------------------------------------------------------------------------
def _builders_matching(pattern: str) -> frozenset[str]:
    regex = re.compile(pattern)
    hits: set[str] = set()
    failures = 0
    for plot_type, fn in _BUILDERS.items():
        try:
            src = inspect.getsource(fn)
        except (OSError, TypeError):  # pragma: no cover - defensive only
            failures += 1
            continue
        if regex.search(src):
            hits.add(plot_type)
    if _BUILDERS and failures == len(_BUILDERS):
        # inspect.getsource() failed for EVERY builder -- fail loudly at
        # import time instead of silently returning an empty set here (and
        # for every OTHER _builders_matching() call below, since they all
        # share the same failure mode). An empty set here would make
        # _universal_reason() report title/subtitle/x_label/y_label/
        # fill_alpha/point_alpha/level_order/y2_column/fit_model/
        # show_fit_stats/redundant_series_encoding "not consumed" for EVERY
        # plot type -- the exact silent-closed failure this guard exists to
        # catch. This typically means Python source is unavailable at
        # runtime (e.g. running from a zipped/frozen package), which
        # inspect.getsource() requires.
        raise RuntimeError(
            "app.r_engine.option_support: inspect.getsource() failed for "
            f"every one of {len(_BUILDERS)} templates._BUILDERS entries "
            f"(pattern {pattern!r}) -- introspection-derived option support "
            "would silently misreport every plot type as unsupported for "
            "several option keys. Refusing to import with broken "
            "introspection instead of failing silently at request time."
        )
    return frozenset(hits)


# title/subtitle/x_label/y_label: the shared `_labs(o, ...)` helper (defined
# once in templates.py) is what most builders use to turn these into a ggplot
# `labs(...)` call; a handful of builders (device-rendered or hand-rolled
# titles) read the option directly instead.
_HAS_LABS_HELPER = _builders_matching(r"_labs\(")
_TITLE_DIRECT = _builders_matching(r"""get\(\s*['"]title['"]""")
_X_LABEL_DIRECT = _builders_matching(r"""get\(\s*['"]x_label['"]""")
_Y_LABEL_DIRECT = _builders_matching(r"""get\(\s*['"]y_label['"]""")
# color_mode is ALSO consumed via theme_r() for every non-DEVICE_TYPES plot
# type (see _universal_reason below); this set only captures the DEVICE_TYPES
# builders (annotated_heatmap, ...) that additionally read it directly to
# pick a base-R diverging colour ramp.
_COLOR_MODE_DIRECT = _builders_matching(r"""['"]color_mode['"]""")
_FILL_ALPHA_TYPES = _builders_matching(r"""_alpha_r\(o,\s*['"]fill_alpha['"]""")
_POINT_ALPHA_TYPES = _builders_matching(r"""_alpha_r\(o,\s*['"]point_alpha['"]""")
_LEVEL_ORDER_TYPES = _builders_matching(r"_level_order_vec\(o\)")
_Y2_TYPES = _builders_matching(r"_y2_axis\(")
_FIT_MODEL_TYPES = _builders_matching(r"""['"]fit_model['"]""")
_SHOW_FIT_STATS_TYPES = _builders_matching(r"""['"]show_fit_stats['"]""")
_REDUNDANT_SERIES_TYPES = _builders_matching(r"""['"]redundant_series_encoding['"]""")


# ---------------------------------------------------------------------------
# Small helpers mirroring cross-option / value-validity rules the R generator
# itself applies. Each cites the source line(s) it mirrors.
# ---------------------------------------------------------------------------
def _legend_hidden(options: dict) -> bool:
    """Mirrors renderer.build_script's `legend_hidden` (post-block, ~line 273):
    ``bool(opts.get("hide_legend")) or legend_position == "none"``."""
    return bool(options.get("hide_legend")) or options.get("legend_position") == "none"


def _range_pair_reason(options: dict, lo_key: str, hi_key: str) -> str | None:
    """Mirrors renderer.build_script's coord_cartesian/coord_flip guard
    (~line 325): a pair is dropped in full when both bounds are given and
    ``lo >= hi``. Also mirrors the new `_validate_axis_ranges` sanitizer
    (figures/service.py) which drops the same pair before it is even stored."""
    lo, hi = options.get(lo_key), options.get(hi_key)
    if isinstance(lo, (int, float)) and isinstance(hi, (int, float)) and lo >= hi:
        return f"{lo_key}/{hi_key} form an inverted or degenerate range ({lo_key} >= {hi_key}); the renderer drops the whole pair"
    return None


_AXIS_KEYS = {
    "x": ("x_breaks", "x_tick_format", "reverse_x"),
    "y": ("y_breaks", "y_tick_format", "reverse_y"),
}


def _axis_unsupported_reason(plot_type: str, mapping: dict, options: dict, axis: str) -> str | None:
    if plot_type not in _UNIVERSAL_TYPES:
        return f"{plot_type!r} does not receive the universal post-processing layer that scale_{axis}_continuous() rides on"
    flags = scale_editable_axes(plot_type, mapping, options)
    if flags.get(axis):
        return None
    # scale_editable_axes folds in: axis not continuous for this template,
    # log_x/log_y set, or (x only) a temporal x axis -- give the most likely
    # reason without duplicating its private internals.
    if options.get(f"log_{axis}"):
        return f"{axis} axis is log-scaled (log_{axis}=True)"
    if axis == "x" and plot_type in _TEMPORAL_X_TYPES and options.get("x_axis_type") in ("date", "datetime"):
        return "x axis is temporal (x_axis_type=date/datetime)"
    if axis == "y" and plot_type in ("scatter", "line") and isinstance(options.get("y2_column"), str) and options.get("y2_column").strip():
        return "y axis is shared with a secondary axis (y2_column is set)"
    if plot_type == "line" and axis == "x":
        # _AXIS_CONT["line"] == ("y",) not because line's x is genuinely
        # discrete/categorical (it may be a real continuous or temporal
        # value) but because the template deliberately withholds
        # scale_x_continuous() to avoid breaking category/date x axes --
        # see the "x may be time/category -> skip to avoid breakage" comment
        # next to _AXIS_CONT in templates.py.
        return "the x axis of 'line' is not scale-editable in this template"
    return f"{axis} axis is discrete/categorical for plot type {plot_type!r} (not in templates._AXIS_CONT)"


def _data_label_unsupported_reason(plot_type: str, mapping: dict, options: dict) -> str | None:
    """Mirrors templates._data_labels_layer exactly (including its early
    `show_n`/`show_values` collision guard) so show_data_labels AND
    data_label_format share one true source."""
    if plot_type not in _DATA_LABEL_TARGETS:
        return f"plot type {plot_type!r} has no data-label layer (only {sorted(_DATA_LABEL_TARGETS)})"
    if options.get("show_n") or options.get("show_values"):
        return "show_n/show_values already occupies the value-label layer for this render"
    if plot_type == "bar":
        stat = options.get("stat", mapping.get("stat", "mean"))
        if stat == "count" or not mapping.get("y"):
            return "bar chart is in count mode (no y mapping / stat='count') -- no scalar value to label"
    elif plot_type in ("scatter", "line") and not mapping.get("y"):
        return "no y mapping to label"
    return None


# ---------------------------------------------------------------------------
# Universal-key rules
# ---------------------------------------------------------------------------
def _universal_reason(plot_type: str, mapping: dict, options: dict, key: str) -> str | None:
    device = plot_type in DEVICE_TYPES
    no_theme = plot_type in NO_THEME_TYPES  # DEVICE_TYPES ⊆ NO_THEME_TYPES

    # -- dimensions / device-level (renderer._dimensions, build_script head) --
    if key in ("size", "dpi"):
        return None
    if key in ("width_in", "height_in"):
        if options.get("size") != "custom":
            return "only used when options.size == 'custom' (renderer._dimensions ignores it otherwise)"
        return None
    if key == "transparent_background":
        # bg_r is computed before the DEVICE_TYPES branch and used by BOTH
        # the base-R device export block and the ggplot path (ggsave bg=).
        return None
    if key in ("font_scale", "base_size"):
        # resolved_pt (device pointsize) is computed and used before the
        # DEVICE_TYPES branch; theme_r()'s base_size= is only reached for
        # non-NO_THEME_TYPES (NO_THEME but ggplot-path types like `network`
        # never call theme_r() at all -- see build_script's
        # `theme_append = "" if plot_type in NO_THEME_TYPES else ...`).
        if device:
            return None
        if no_theme:
            return f"{plot_type!r} is a no-theme ggplot type -- labplot_theme() is never applied, so theme text size is fixed by the template"
        return None

    # -- theme_r()-only keys: theme_r() itself is always CALLED for every
    # non-DEVICE_TYPES plot type (its output is unconditionally concatenated
    # into build_script's return value), but for NO_THEME_TYPES that are NOT
    # DEVICE_TYPES (`network`) the resulting labplot_theme()/labplot_palette()
    # definitions are simply never referenced by the plot -- build_script's
    # `theme_append` (which appends `p <- p + labplot_theme()`) is empty for
    # every NO_THEME_TYPES member, and `_network`'s ggplot uses theme_void()
    # + hardcoded colours instead of labplot_palette(). So these keys must
    # gate on `no_theme` (DEVICE_TYPES ⊆ NO_THEME_TYPES, so the device case
    # is preserved), not merely `device`. --
    if key == "color_mode":
        # `safe_color_mode` (a sanitized copy of color_mode) is embedded into
        # the "# ... | color: ..." comment at the very top of build_script's
        # `head`, BEFORE the DEVICE_TYPES/NO_THEME_TYPES branch -- so it
        # always changes the script TEXT, even for NO_THEME/DEVICE types
        # that also ignore it functionally (see the (network, color_mode)
        # KNOWN_EXCEPTIONS entry in the honesty test). A few DEVICE_TYPES
        # builders (see _COLOR_MODE_DIRECT, e.g. annotated_heatmap)
        # additionally read it to pick a base-R diverging colour ramp.
        if device:
            return None
        if no_theme:
            return f"{plot_type!r} is a no-theme ggplot type -- theme_r()'s labplot_palette()/labplot_stroke_palette() (the only consumers of color_mode's grayscale switch) are never applied"
        return None
    if key in ("palette_name", "font_family", "axis_line_width_pt", "legend_key_size"):
        if no_theme:
            return f"{plot_type!r} is a no-theme plot type -- theme_r()'s labplot_theme()/labplot_palette() definitions are never applied"
        return None
    if key == "custom_palette_values":
        if no_theme:
            return f"{plot_type!r} is a no-theme plot type -- theme_r()'s labplot_palette()/labplot_stroke_palette() definitions are never applied"
        if not has_discrete_color_scale(plot_type, mapping, options):
            # theme_r() still emits labplot_palette()/labplot_stroke_palette()
            # (changing the script TEXT) but no builder call site for this
            # plot_type/mapping ever invokes either helper -- see this
            # module's docstring and the matching category_colors case below.
            return "no discrete colour/fill scale for this mapping/options -- no builder call site reads labplot_palette()/labplot_stroke_palette()"
        palette_name = options.get("palette_name")
        if not (palette_name == "custom" or (isinstance(palette_name, str) and palette_name.startswith("custom:"))):
            return "only used when palette_name == 'custom' (or 'custom:<id>')"
        return None
    if key == "custom_palette_label":
        return "cosmetic palette-name bookkeeping only -- never passed into theme_r() / the generated R script"

    # -- renderer.build_script's global linewidth post-block: runs for every
    # non-DEVICE_TYPES plot type (explicitly incl. NO_THEME_TYPES; see the
    # "Runs for ALL ggplot types" comment above it) --
    if key in ("linewidth_scale", "data_line_width_pt"):
        return None if not device else "device-rendered plot type has no ggplot `p` object to post-multiply linewidths on"

    # -- labels: shared _labs() helper, or a builder-specific direct read --
    if key == "title":
        if plot_type in _HAS_LABS_HELPER or plot_type in _TITLE_DIRECT:
            return None
        return f"builder for {plot_type!r} never renders a title (no _labs() call, no direct title read)"
    if key == "subtitle":
        if plot_type in _HAS_LABS_HELPER:
            return None
        return f"builder for {plot_type!r} does not use the shared _labs() helper (the only place subtitle is read)"
    if key == "x_label":
        if plot_type in _HAS_LABS_HELPER or plot_type in _X_LABEL_DIRECT:
            return None
        return f"builder for {plot_type!r} never renders an x-axis label"
    if key == "y_label":
        if plot_type in _HAS_LABS_HELPER or plot_type in _Y_LABEL_DIRECT:
            return None
        return f"builder for {plot_type!r} never renders a y-axis label"

    # -- universal post-block, gated ONLY by NO_THEME_TYPES (no _UNIVERSAL_TYPES
    # gate): legend/axis/range/reference-line/facet options. See
    # renderer.build_script lines ~266-345. --
    if key == "legend_title":
        return None if not no_theme else f"{plot_type!r} is a no-theme plot type -- the legend/axis post-processing block never runs"
    if key == "hide_legend":
        return None if not no_theme else f"{plot_type!r} is a no-theme plot type -- theme(legend.position) is never set"
    if key == "legend_position":
        return None if not no_theme else f"{plot_type!r} is a no-theme plot type -- theme(legend.position) is never set"
    if key == "legend_direction":
        if no_theme:
            return f"{plot_type!r} is a no-theme plot type -- theme(legend.direction) is never set"
        if _legend_hidden(options):
            return "legend is hidden (hide_legend or legend_position='none')"
        return None
    if key == "legend_ncol":
        if no_theme:
            return f"{plot_type!r} is a no-theme plot type -- the legend-guide post-processing block never runs"
        if _legend_hidden(options):
            return "legend is hidden (hide_legend or legend_position='none')"
        if not has_visible_discrete_legend(plot_type, mapping, options):
            return (
                "no VISIBLE discrete fill/colour/shape/linetype legend to page into columns "
                "for this mapping/options (no discrete scale at all, a continuous colour/fill "
                "scale, or the template hardcodes this legend hidden)"
            )
        return None
    if key == "x_text_angle":
        return None if not no_theme else f"{plot_type!r} is a no-theme plot type -- axis.text.x rotation is never set"
    if key == "log_x":
        return None if not no_theme else f"{plot_type!r} is a no-theme plot type -- scale_x_log10() is never added"
    if key == "log_y":
        return None if not no_theme else f"{plot_type!r} is a no-theme plot type -- scale_y_log10() is never added"
    if key in ("x_min", "x_max"):
        if no_theme:
            return f"{plot_type!r} is a no-theme plot type -- coord_cartesian()/coord_flip() ranges are never added"
        return _range_pair_reason(options, "x_min", "x_max")
    if key in ("y_min", "y_max"):
        if no_theme:
            return f"{plot_type!r} is a no-theme plot type -- coord_cartesian()/coord_flip() ranges are never added"
        return _range_pair_reason(options, "y_min", "y_max")
    if key == "hline_at":
        return None if not no_theme else f"{plot_type!r} is a no-theme plot type -- geom_hline() is never added"
    if key == "vline_at":
        return None if not no_theme else f"{plot_type!r} is a no-theme plot type -- geom_vline() is never added"
    if key == "facet_by":
        return None if not no_theme else f"{plot_type!r} is a no-theme plot type -- facet_wrap() is never added"
    if key == "facet_scales":
        if no_theme:
            return f"{plot_type!r} is a no-theme plot type -- facet_wrap() is never added"
        facet_by = options.get("facet_by")
        if not (isinstance(facet_by, str) and facet_by.strip()):
            return "only used together with facet_by (facet_wrap is not added without it)"
        return None
    if key == "category_colors":
        # renderer.build_script now gates _category_color_override_r's
        # emission on has_discrete_color_scale() (not just NO_THEME_TYPES),
        # so script text and this verdict agree exactly -- see this module's
        # docstring.
        if no_theme:
            return f"{plot_type!r} is a no-theme plot type -- the category-colour override is never emitted"
        if not has_discrete_color_scale(plot_type, mapping, options):
            return "no discrete fill/colour scale for this mapping/options -- no categories to recolour"
        return None
    if key == "flip_coords":
        # Scene-metadata (xlab/ylab role swap in the layout sidecar) is
        # unconditional for the whole non-DEVICE_TYPES path; the actual
        # coord_flip()/coord_cartesian(...) call additionally needs
        # `not no_theme`, but the scene-swap alone already changes the script.
        return None if not device else f"{plot_type!r} is device-rendered -- build_script returns before the coord_flip / scene-layout code"

    # -- _UNIVERSAL_TYPES-gated post layers (annotations/series/axis-break) --
    if key in ("annotations", "series_styles", "axis_break_x", "axis_break_y"):
        if plot_type in _UNIVERSAL_TYPES:
            return None
        return f"{plot_type!r} does not receive the universal post-processing layer ({sorted(_UNIVERSAL_TYPES)})"

    # -- data labels --
    if key == "show_data_labels":
        return _data_label_unsupported_reason(plot_type, mapping, options)
    if key == "data_label_format":
        reason = _data_label_unsupported_reason(plot_type, mapping, options)
        if reason is not None:
            return reason
        if not options.get("show_data_labels"):
            return "only used when show_data_labels is enabled"
        return None

    # -- axis scale layer (x_breaks/y_breaks/x_tick_format/y_tick_format/
    # reverse_x/reverse_y) -- scale_editable_axes IS the single source of
    # truth (see its own docstring). --
    for axis, keys in _AXIS_KEYS.items():
        if key in keys:
            return _axis_unsupported_reason(plot_type, mapping, options, axis)

    # -- element_overrides: only plot types with stable per-mark IDs --
    if key == "element_overrides":
        if plot_type in _ELEMENT_MARK_ID_RE_BY_PLOT:
            return None
        return f"{plot_type!r} has no per-mark element IDs (only {sorted(_ELEMENT_MARK_ID_RE_BY_PLOT)})"

    # -- temporal x axis --
    if key == "x_axis_type":
        if plot_type in _TEMPORAL_X_TYPES:
            return None
        return f"{plot_type!r} has no date/datetime x-axis support (only {sorted(_TEMPORAL_X_TYPES)})"
    if key == "date_format":
        if plot_type not in _TEMPORAL_X_TYPES:
            return f"{plot_type!r} has no date/datetime x-axis support (only {sorted(_TEMPORAL_X_TYPES)})"
        if options.get("x_axis_type") not in ("date", "datetime"):
            return "only used when x_axis_type is 'date' or 'datetime'"
        return None

    # -- fill/point alpha (templates._alpha_r call sites) --
    if key == "fill_alpha":
        return None if plot_type in _FILL_ALPHA_TYPES else f"builder for {plot_type!r} has no fill layer with adjustable alpha"
    if key == "point_alpha":
        if plot_type not in _POINT_ALPHA_TYPES:
            return f"builder for {plot_type!r} has no point layer with adjustable alpha"
        # templates._box / templates._violin / templates._grouped_bar only
        # emit their point overlay (and therefore only interpolate
        # point_alpha into the script -- `pt_a` is computed unconditionally
        # but is embedded in the returned string ONLY inside the
        # `if show_points` branch) when the EFFECTIVE show_points value is
        # truthy. templates._box defaults show_points to True; templates.
        # _violin / templates._grouped_bar default it to False. Every other
        # _POINT_ALPHA_TYPES builder (scatter/sina/embedding) plots points
        # unconditionally, with no show_points gate at all.
        _point_alpha_default = {"box": True, "violin": False, "grouped_bar": False}
        if plot_type in _point_alpha_default and not options.get("show_points", _point_alpha_default[plot_type]):
            return f"only used when show_points is enabled (defaults to {_point_alpha_default[plot_type]} for this plot type)"
        return None

    # -- level_order (templates._level_order_vec call sites) --
    if key == "level_order":
        return None if plot_type in _LEVEL_ORDER_TYPES else f"builder for {plot_type!r} does not support explicit category ordering"

    # -- secondary y axis (templates._y2_axis call sites) --
    if key == "y2_column":
        return None if plot_type in _Y2_TYPES else f"{plot_type!r} has no secondary-axis support (only {sorted(_Y2_TYPES)})"
    if key == "y2_label":
        if plot_type not in _Y2_TYPES:
            return f"{plot_type!r} has no secondary-axis support (only {sorted(_Y2_TYPES)})"
        y2_column = options.get("y2_column")
        if not (isinstance(y2_column, str) and y2_column.strip()):
            return "only used together with y2_column"
        return None

    # -- curve-fit model / R^2 stats overlay --
    if key == "fit_model":
        return None if plot_type in _FIT_MODEL_TYPES else f"builder for {plot_type!r} has no fit-model overlay (only {sorted(_FIT_MODEL_TYPES)})"
    if key == "show_fit_stats":
        return None if plot_type in _SHOW_FIT_STATS_TYPES else f"builder for {plot_type!r} has no fit-stats overlay (only {sorted(_SHOW_FIT_STATS_TYPES)})"

    # -- redundant colour+linetype/shape encoding (line only) --
    if key == "redundant_series_encoding":
        return None if plot_type in _REDUNDANT_SERIES_TYPES else f"builder for {plot_type!r} does not support redundant series encoding (only {sorted(_REDUNDANT_SERIES_TYPES)})"

    # -- error-bar type: statistical-annotation contract (bar/grouped_bar
    # own their `error_bars` option; error_type is universal so it passes the
    # allow-list everywhere) --
    if key == "error_type":
        if plot_type == "bar":
            # templates._bar: `if stat == "mean" and o.get("error_bars", True):`
            stat = options.get("stat", mapping.get("stat", "mean"))
            if stat != "mean" or not mapping.get("y"):
                return "bar chart is in count mode (no y mapping / stat != 'mean')"
            if not options.get("error_bars", True):
                return "only used when error_bars is enabled (bar defaults error_bars=True when unset)"
            return None
        if plot_type == "grouped_bar":
            # templates._grouped_bar: `if stat == "mean" and o.get("error_bars", False):`
            stat = options.get("stat", "mean")
            if stat != "mean":
                return "only used when stat == 'mean'"
            if not options.get("error_bars", False):
                return "only used when error_bars is enabled (grouped_bar defaults error_bars=False when unset)"
            return None
        return f"builder for {plot_type!r} has no error-bar layer that reads error_type"
    if key == "color_midpoint":
        if plot_type == "heatmap":
            return None
        return f"builder for {plot_type!r} has no diverging colour scale that reads color_midpoint (only 'heatmap')"
    if key in ("show_n", "show_significance"):
        # Declared per-type in PLOT_TYPES (box/violin/bar) but universal so the
        # allow-list passes them anywhere; the builders themselves gate on type.
        if plot_type not in ("box", "violin", "bar"):
            return f"builder for {plot_type!r} has no n= / significance-bracket layer"
        if key == "show_significance" and plot_type == "bar":
            # templates._bar's count-mode branch (`stat == "count" or not
            # m.get("y")`) returns BEFORE the `if o.get("show_significance")`
            # check further down -- unlike show_n, whose _group_n_layer call
            # is duplicated into that early branch too (`count_extra`), so
            # show_significance has no bracket layer at all in count mode.
            stat = options.get("stat", mapping.get("stat", "mean"))
            if stat == "count" or not mapping.get("y"):
                return "bar chart is in count mode (no y mapping / stat='count') -- no significance-bracket layer in that branch"
        return None
    if key == "interactive_html":
        # build_script's html_export block runs on "the standard ggplot path"
        # only -- i.e. anything that is not DEVICE_TYPES.
        return None if not device else "device-rendered plot type has no ggplot `p` object for plotly::ggplotly() to convert"

    # Should be unreachable: every _UNIVERSAL_OPTION_KEYS member is handled
    # above. Fail loudly rather than silently mis-reporting "consumed".
    raise AssertionError(f"option_support: no rule for universal key {key!r}")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def unsupported_reason(plot_type: str, key: str, mapping: dict | None = None, options: dict | None = None) -> str | None:
    """None if the R generator would consume `key` for `plot_type` given the
    current mapping/options, else a short human-readable reason it would not."""
    mapping = mapping or {}
    options = options or {}
    if plot_type not in PLOT_TYPE_KEYS:
        return f"unknown plot type {plot_type!r}"
    # IMPORTANT: check _UNIVERSAL_OPTION_KEYS BEFORE the per-type "own options"
    # shortcut below. templates.py's `_extend_options()` COPIES several
    # universal keys (x_breaks/x_tick_format/reverse_x/annotations/
    # series_styles/show_data_labels/... via _X_AXIS_TARGETS/_Y_AXIS_TARGETS/
    # _DATA_LABEL_TARGETS/_ANNOTATION_TARGETS/_TEMPORAL_TARGETS) into each
    # matching plot type's own PLOT_TYPES["options"] list purely for frontend
    # enumeration -- and those target sets are already known to overstate
    # reality (e.g. "line" is listed in _X_AXIS_TARGETS even though
    # _AXIS_CONT["line"] excludes x, so x_breaks/x_tick_format/reverse_x are
    # NEVER actually consumed for "line" -- exactly the bug this registry
    # exists to catch). Trusting "declared in this type's own options list"
    # for a universal key would silently reproduce that same bug.
    if key in _UNIVERSAL_OPTION_KEYS:
        return _universal_reason(plot_type, mapping, options, key)
    if key in _own_option_keys(plot_type):
        # Genuinely per-type-only options (e.g. "stat" for bar, "corr_method"
        # for correlation_heatmap) are declared exactly once, by the type that
        # reads them in its own builder function -- that contract is trusted
        # as-is (the mandatory honesty test only covers _UNIVERSAL_OPTION_KEYS).
        return None
    return f"{key!r} is not a recognized option for plot type {plot_type!r}"


def option_support(plot_type: str, mapping: dict | None = None, options: dict | None = None) -> dict[str, str | None]:
    """``{key: None | reason}`` for every _UNIVERSAL_OPTION_KEYS key plus
    `plot_type`'s own declared option keys."""
    mapping = mapping or {}
    options = options or {}
    keys = set(_UNIVERSAL_OPTION_KEYS) | _own_option_keys(plot_type)
    return {key: unsupported_reason(plot_type, key, mapping, options) for key in sorted(keys)}


def supported_option_keys(plot_type: str, mapping: dict | None = None, options: dict | None = None) -> set[str]:
    support = option_support(plot_type, mapping, options)
    return {key for key, reason in support.items() if reason is None}


# ---------------------------------------------------------------------------
# "Potentially supported" -- for building an AI edit schema that must not
# hide a key just because the CURRENT mapping/options happen to leave its
# companion condition off (e.g. error_type would be dropped for a fresh
# figure because error_bars isn't set on it yet, even though the AI is
# perfectly able to turn error_bars on first).
# ---------------------------------------------------------------------------
# Per-key companion options that unlock a conditionally-consumed universal
# key, mirroring test_option_support_registry.py's `_companion_context` (kept
# independent on purpose -- the test's copy is the honesty check, this one
# only needs to be permissive enough to make `unsupported_reason` clear).
_COMPANION_CONTEXT: dict[str, dict] = {
    "date_format": {"x_axis_type": "date"},
    "data_label_format": {"show_data_labels": True},
    "error_type": {"error_bars": True},
    "facet_scales": {"facet_by": "__probe_facet__"},
    "y2_label": {"y2_column": "__probe_y2__"},
    # bar's discrete fill scale (for category_colors / custom_palette_values)
    # is conditional on the `color_bars` OPTION, not a mapping slot -- unlike
    # every other plot type's discrete-scale companion, which is already
    # covered by `_permissive_mapping` filling every optional mapping slot.
    # legend_ncol deliberately has NO companion here: bar's legend is
    # hardcoded hidden (`guides(fill = "none")`) regardless of color_bars, so
    # legend_ncol is never actually consumable there (see
    # templates._LEGEND_ALWAYS_HIDDEN_TYPES).
    "custom_palette_values": {"palette_name": "custom", "color_bars": True},
    "category_colors": {"color_bars": True},
    "width_in": {"size": "custom"},
    "height_in": {"size": "custom"},
    "point_alpha": {"show_points": True},
}


def _permissive_mapping(plot_type: str) -> dict:
    """A synthetic mapping filling every required+optional slot `plot_type`
    declares with a real (truthy, string) column name, so companion checks
    that read `mapping.get(...)` (e.g. error_type needing `mapping['y']`)
    see a realistic figure rather than an empty one. Mirrors
    test_option_support_registry.py's `_synthetic_mapping`."""
    pdef = _PLOT_DEFS.get(plot_type)
    if not pdef:
        return {}
    mapping: dict = {}
    counter = [0]

    def _next_col() -> str:
        counter[0] += 1
        return f"__probe_col_{counter[0]}__"

    for field in list(pdef.get("required", [])) + list(pdef.get("optional", [])):
        key = field["key"]
        mapping[key] = [_next_col(), _next_col()] if field.get("multi") else _next_col()
    return mapping


def potentially_supported_option_keys(plot_type: str) -> set[str]:
    """Keys `unsupported_reason` would clear to None for `plot_type` under
    SOME realistic mapping/options -- i.e. every key that is only
    conditionally consumed, not just the ones consumed for the figure's
    CURRENT mapping/options. Used to build the AI edit schema
    (options_schema.build_options_patch_schema) so a key like `error_type`
    is still offered even when `error_bars` happens to be off right now."""
    mapping = _permissive_mapping(plot_type)
    keys = set(_UNIVERSAL_OPTION_KEYS) | _own_option_keys(plot_type)
    out: set[str] = set()
    for key in keys:
        context = dict(_COMPANION_CONTEXT.get(key, {}))
        if unsupported_reason(plot_type, key, mapping, context) is None:
            out.add(key)
    return out
