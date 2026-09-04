"""A1.3(a) honesty test for app.r_engine.option_support.

The registry (option_support / supported_option_keys / unsupported_reason)
claims, for a given (plot_type, mapping, options), whether each option key
would actually change the R script `renderer.build_script` generates. This
test is the mandatory cross-check: for every plot type in
`templates.PLOT_TYPES` and every key in `_UNIVERSAL_OPTION_KEYS`, it builds
the script with and without a sentinel value for that key and asserts
`script_changed == (registry says consumed)`.

`renderer.build_script` is pure Python (it only ever executes R inside
`renderer.render`, never here), so this whole sweep runs in well under a
second with no R installation required.
"""
from __future__ import annotations

import unittest

from app.figures.option_metadata import _UNIVERSAL_OPTION_KEYS
from app.r_engine.option_support import option_support, supported_option_keys, unsupported_reason
from app.r_engine.presets import theme_r
from app.r_engine.renderer import build_script
from app.r_engine.templates import DEVICE_TYPES, NO_THEME_TYPES, PLOT_TYPES, has_discrete_color_scale

# ---------------------------------------------------------------------------
# Synthetic mapping: for every plot type, assign a unique real-looking column
# name to every required + optional mapping slot (multi-slots get a 2-column
# list). build_plot_r only ever interpolates these as R column references
# (df[["col_N"]]) -- it never needs real data, so this is enough to exercise
# every builder without touching a CSV. (Mirrors the same pattern
# test_renderer_scene_elements.py / test_publication_defaults.py use, just
# generalized across all ~50 plot types instead of one at a time.)
# ---------------------------------------------------------------------------
def _synthetic_mapping(pdef: dict) -> dict:
    mapping: dict = {}
    counter = [0]

    def _next_col() -> str:
        counter[0] += 1
        return f"col_{counter[0]}"

    for field in list(pdef.get("required", [])) + list(pdef.get("optional", [])):
        key = field["key"]
        mapping[key] = [_next_col(), _next_col()] if field.get("multi") else _next_col()
    return mapping


# Minimal mapping: REQUIRED slots only, no optional color/group/fill/series
# slot mapped and no color_bars -- the P3 regression scenario (a figure with
# no discrete legend at all) for the legend_ncol/category_colors/
# custom_palette_values sweep below, as distinct from _synthetic_mapping's
# fully-mapped figure used by the main honesty sweep above.
def _minimal_mapping(pdef: dict) -> dict:
    mapping: dict = {}
    counter = [0]

    def _next_col() -> str:
        counter[0] += 1
        return f"col_{counter[0]}"

    for field in pdef.get("required", []):
        key = field["key"]
        mapping[key] = [_next_col(), _next_col()] if field.get("multi") else _next_col()
    return mapping


_ELEMENT_ID_BY_TYPE = {
    "scatter": "mark:scatter:row=1",
    "grouped_bar": "mark:grouped_bar:category=a&series=b",
    "heatmap": "mark:heatmap:row=a&col=b",
    "correlation_heatmap": "mark:correlation_heatmap:x=a&y=b",
}

# Non-structured sentinel values, keyed by option name. Chosen per the option's
# declared shape in app.figures.option_metadata: True for bools, a non-default
# choice for _OPTION_CHOICES members, a representative mid-range value for
# _NUMBER_OPTIONS members.
_SENTINELS = {
    # bools
    "hide_legend": True, "log_x": True, "log_y": True, "flip_coords": True,
    "reverse_x": True, "reverse_y": True, "redundant_series_encoding": True,
    "interactive_html": True, "transparent_background": True,
    "show_n": True, "show_significance": True, "show_fit_stats": True,
    "show_data_labels": True,
    # choices
    "legend_position": "left", "legend_direction": "horizontal",
    "palette_name": "okabe_ito", "color_mode": "grayscale", "font_family": "serif",
    "x_tick_format": "comma", "y_tick_format": "comma", "x_axis_type": "date",
    "fit_model": "logistic", "data_label_format": "percent",
    "error_type": "ci95", "facet_scales": "free",
    "date_format": "%Y-%m",
    # numbers
    "x_min": 1.0, "y_min": 1.0, "x_max": 100.0, "y_max": 100.0,
    "font_scale": 1.6, "base_size": 12, "dpi": 150,
    "width_in": 8.5, "height_in": 8.5,
    "fill_alpha": 0.33, "point_alpha": 0.33, "color_midpoint": 2.5,
    "hline_at": 3.3, "vline_at": 3.3, "x_breaks": 9, "y_breaks": 9,
    "legend_key_size": 22.0, "legend_ncol": 2,
    "linewidth_scale": 2.5, "axis_line_width_pt": 1.7, "data_line_width_pt": 1.7,
    "x_text_angle": 60, "size": "square",
    # free text
    "title": "Sentinel title", "subtitle": "Sentinel subtitle",
    "x_label": "Sentinel x", "y_label": "Sentinel y", "legend_title": "Sentinel legend",
    "custom_palette_label": "My palette",
    # structured
    "level_order": ["b", "a"],
    "category_colors": {"a": "#112233"},
    "annotations": [{"kind": "text", "x": 1, "y": 1, "text": "hi"}],
    "series_styles": {"a": {"color": "#112233"}},
    "axis_break_x": [1.0, 2.0], "axis_break_y": [1.0, 2.0],
    "custom_palette_values": ["#112233", "#445566"],
}

assert set(_SENTINELS) | {"y2_column", "y2_label", "facet_by", "element_overrides"} == set(_UNIVERSAL_OPTION_KEYS), (
    set(_UNIVERSAL_OPTION_KEYS) - set(_SENTINELS) - {"y2_column", "y2_label", "facet_by", "element_overrides"}
)

# A handful of keys only have an observable effect together with a companion
# key (mirrors a real cross-option dependency the R generator itself has:
# error_type needs error_bars, date_format needs x_axis_type=date, ...). The
# sweep below builds BOTH the base and the sentinel-probe script with this
# companion context already applied, so the sentinel toggle is a fair
# single-key test and matches what unsupported_reason() is told via `options`.
def _first_column_name(mapping: dict) -> str:
    """A real (string) synthetic column name usable as a facet-by / secondary
    axis probe, regardless of which mapping slots this plot type declares
    (some map only to a "columns" multi-slot with no scalar string value)."""
    for value in mapping.values():
        if isinstance(value, str):
            return value
        if isinstance(value, list) and value and isinstance(value[0], str):
            return value[0]
    return "col_1"


def _companion_context(plot_type: str, key: str, mapping: dict) -> dict:
    if key == "date_format":
        return {"x_axis_type": "date"}
    if key == "data_label_format":
        return {"show_data_labels": True}
    if key == "error_type":
        return {"error_bars": True}
    if key == "facet_scales":
        return {"facet_by": _first_column_name(mapping)}
    if key == "y2_label":
        return {"y2_column": mapping.get("y") or _first_column_name(mapping)}
    if key == "custom_palette_values":
        return {"palette_name": "custom"}
    return {}


def _sentinel_value(plot_type: str, key: str, mapping: dict):
    if key == "y2_column":
        return mapping.get("y") or _first_column_name(mapping)
    if key == "y2_label":
        return "Sentinel y2"
    if key == "facet_by":
        return _first_column_name(mapping)
    if key == "element_overrides":
        return {_ELEMENT_ID_BY_TYPE.get(plot_type, "mark:scatter:row=1"): {"fill": "#112233"}}
    return _SENTINELS[key]


# renderer.build_script now gates _category_color_override_r / _legend_ncol_r
# emission on templates.has_discrete_color_scale() / has_visible_discrete_legend()
# -- the SAME predicates option_support.py's registry uses -- so category_colors
# and legend_ncol script text and registry verdict always agree; no
# KNOWN_EXCEPTIONS are needed for either key any more.
#
# custom_palette_values is the one remaining, deliberately narrow exception:
# theme_r() (unconditionally concatenated into build_script's output for
# every non-NO_THEME_TYPES type) always defines labplot_palette()/
# labplot_stroke_palette() FROM custom_palette_values -- a real script TEXT
# change -- even for a (plot_type, mapping/options) combination where
# has_discrete_color_scale() is False and no builder call site will ever
# invoke either helper (heatmap's continuous fill, dot_plot's constant point
# colour, bar without color_bars, ...). Detecting that from text alone would
# require executing R (ggplot_build); the registry therefore reports
# custom_palette_values NOT consumed there even though the script text does
# change -- computed here (not hand-copied) from the exact predicate/mapping/
# companion-context the sweep below itself uses, so it can never silently
# drift from templates.py or from `_companion_context`.
KNOWN_EXCEPTIONS: set[tuple[str, str]] = {
    (pdef["type"], "custom_palette_values")
    for pdef in PLOT_TYPES
    if pdef["type"] not in NO_THEME_TYPES  # no_theme already returns a matching reason; theme_r() text is stripped below too
    and not has_discrete_color_scale(
        pdef["type"],
        _synthetic_mapping(pdef),
        _companion_context(pdef["type"], "custom_palette_values", _synthetic_mapping(pdef)),
    )
}
# color_mode's sanitized value is embedded in build_script's very first
# header COMMENT line (renderer.py's `head`, before the DEVICE_TYPES/
# NO_THEME_TYPES branch), so it always changes script text -- but for
# `network` (NO_THEME_TYPES, not DEVICE_TYPES) the registry now correctly
# reports color_mode NOT consumed (theme_r()'s labplot_palette()/
# labplot_stroke_palette() grayscale switch, the only functional consumer of
# color_mode outside DEVICE_TYPES, is never applied -- see
# option_support._universal_reason). The mismatch is confined to that one
# header-comment line, which the theme_r()-stripping below does not touch.
KNOWN_EXCEPTIONS.add(("network", "color_mode"))


def _theme_r_text(options: dict) -> str:
    """Reconstructs exactly the theme_r(...) substring build_script("nature", ...)
    concatenates into its output for the given options, so the honesty sweep
    can strip it before comparing NO_THEME_TYPES scripts (see build_script:
    `theme_append` is empty for every NO_THEME_TYPES member, so labplot_theme()
    is defined but never applied -- only the DEFINITION text, not any rendered
    effect, would otherwise make these scripts differ)."""
    color_mode = options.get("color_mode", "color")
    if color_mode not in ("color", "grayscale"):
        color_mode = "color"
    return theme_r(
        "nature", color_mode, options.get("font_scale", 1.0),
        options.get("palette_name"), options.get("custom_palette_values"),
        options.get("font_family"), bool(options.get("transparent_background")),
        legend_key_size=options.get("legend_key_size"),
        base_size=options.get("base_size"),
        axis_line_width_pt=options.get("axis_line_width_pt"),
        data_line_width_pt=options.get("data_line_width_pt"),
    )


class OptionSupportHonestyTest(unittest.TestCase):
    """Exhaustive (plot_type, key) sweep: script_changed == registry-consumed."""

    def test_registry_matches_build_script_for_every_type_and_universal_key(self):
        mismatches = []
        for pdef in PLOT_TYPES:
            plot_type = pdef["type"]
            mapping = _synthetic_mapping(pdef)
            for key in sorted(_UNIVERSAL_OPTION_KEYS):
                context = _companion_context(plot_type, key, mapping)
                sentinel = _sentinel_value(plot_type, key, mapping)
                base_script = build_script(plot_type, mapping, context, "nature")
                probe_options = dict(context)
                probe_options[key] = sentinel
                probe_script = build_script(plot_type, mapping, probe_options, "nature")
                if plot_type in NO_THEME_TYPES:
                    # theme_r()'s definition text always differs whenever a
                    # theme-only key's sentinel does, even though NO_THEME_TYPES
                    # never applies it (labplot_theme()/labplot_palette() are
                    # defined but not referenced) -- compare only the
                    # RENDER-relevant remainder of the script.
                    base_script = base_script.replace(_theme_r_text(context), "", 1)
                    probe_script = probe_script.replace(_theme_r_text(probe_options), "", 1)
                script_changed = probe_script != base_script
                reason = unsupported_reason(plot_type, key, mapping, context)
                consumed = reason is None
                if script_changed != consumed and (plot_type, key) not in KNOWN_EXCEPTIONS:
                    mismatches.append(
                        f"{plot_type}/{key}: script_changed={script_changed} "
                        f"registry_consumed={consumed} reason={reason!r}"
                    )
        self.assertEqual(mismatches, [], "\n" + "\n".join(mismatches))

    def test_registry_matches_build_script_under_minimal_mapping_for_color_keys(self):
        """P3 regression: unlike the sweep above (which uses `_synthetic_mapping`
        to fill EVERY optional slot, including any color/group/fill slot),
        this sweep uses `_minimal_mapping` (required slots only -- no optional
        colour slot mapped, no color_bars) for legend_ncol/category_colors, so
        a figure with genuinely no discrete legend (scatter without `color`,
        bar without `color_bars`, ...) is exercised too. custom_palette_values
        is deliberately NOT swept here: unlike legend_ncol/category_colors
        (whose emission is now gated on the exact same has_discrete_color_scale
        predicate the registry uses, so text and verdict always agree),
        custom_palette_values always changes theme_r()'s text regardless of
        mapping -- that mapping-dependent divergence is the documented,
        R-execution-required exception this module's docstring already
        describes; it is covered by KNOWN_EXCEPTIONS under the (fixed, full)
        mapping the main sweep above uses, not by a second, differently-mapped
        sweep."""
        mismatches = []
        for pdef in PLOT_TYPES:
            plot_type = pdef["type"]
            mapping = _minimal_mapping(pdef)
            for key in ("legend_ncol", "category_colors"):
                context = _companion_context(plot_type, key, mapping)
                sentinel = _sentinel_value(plot_type, key, mapping)
                base_script = build_script(plot_type, mapping, context, "nature")
                probe_options = dict(context)
                probe_options[key] = sentinel
                probe_script = build_script(plot_type, mapping, probe_options, "nature")
                if plot_type in NO_THEME_TYPES:
                    base_script = base_script.replace(_theme_r_text(context), "", 1)
                    probe_script = probe_script.replace(_theme_r_text(probe_options), "", 1)
                script_changed = probe_script != base_script
                reason = unsupported_reason(plot_type, key, mapping, context)
                consumed = reason is None
                if script_changed != consumed and (plot_type, key) not in KNOWN_EXCEPTIONS:
                    mismatches.append(
                        f"[minimal] {plot_type}/{key}: script_changed={script_changed} "
                        f"registry_consumed={consumed} reason={reason!r}"
                    )
        self.assertEqual(mismatches, [], "\n" + "\n".join(mismatches))

    def test_no_stale_known_exceptions(self):
        # If KNOWN_EXCEPTIONS is ever populated, each entry must be a real
        # plot type / universal key pair (catches typos/rot immediately
        # rather than silently no-op'ing a mismatch check forever).
        plot_types = {p["type"] for p in PLOT_TYPES}
        for plot_type, key in KNOWN_EXCEPTIONS:
            self.assertIn(plot_type, plot_types)
            self.assertIn(key, _UNIVERSAL_OPTION_KEYS)


class OptionSupportSpecificAssertionsTest(unittest.TestCase):
    """Targeted assertions called out in the A1.3(a)/A1.4 spec."""

    def test_legend_ncol_unsupported_for_bar_no_discrete_legend_ever(self):
        # bar's discrete fill scale exists only with color_bars=True, and
        # EVEN THEN both _bar branches hardcode `guides(fill = "none")` --
        # legend_ncol never has a legend to page for "bar", with or without
        # color_bars (templates._LEGEND_ALWAYS_HIDDEN_TYPES).
        mapping = {"x": "cat", "y": "val"}
        self.assertIsNotNone(unsupported_reason("bar", "legend_ncol", mapping, {}))
        self.assertIsNotNone(unsupported_reason("bar", "legend_ncol", mapping, {"color_bars": True}))
        self.assertIsNotNone(
            unsupported_reason("network", "legend_ncol", {"source": "a", "target": "b"}, {})
        )

    def test_legend_ncol_consumed_for_grouped_bar_not_when_hidden(self):
        # grouped_bar's fill legend is unconditional and visible (required
        # `group` slot, no hardcoded guides(fill = "none")) -- unlike bar.
        mapping = {"x": "cat", "y": "val", "group": "series"}
        self.assertIsNone(unsupported_reason("grouped_bar", "legend_ncol", mapping, {}))
        self.assertIsNotNone(
            unsupported_reason("grouped_bar", "legend_ncol", mapping, {"legend_position": "none"})
        )
        self.assertIsNotNone(
            unsupported_reason("grouped_bar", "legend_ncol", mapping, {"hide_legend": True})
        )

    def test_legend_ncol_conditional_on_optional_color_mapping(self):
        # scatter's discrete colour legend only exists once `color` is mapped.
        self.assertIsNotNone(unsupported_reason("scatter", "legend_ncol", {"x": "c1", "y": "c2"}, {}))
        self.assertIsNone(
            unsupported_reason("scatter", "legend_ncol", {"x": "c1", "y": "c2", "color": "grp"}, {})
        )

    def test_category_colors_consumed_for_continuous_fill_types_with_a_discrete_manual_scale(self):
        # P1 regression: roc_pr_curve/parallel_coordinates/radar/embedding/
        # calibration_curve/chemical_space are CONTINUOUS_FILL_TYPES members
        # whose builder ALSO emits a genuine discrete
        # scale_(colour|fill)_manual(values = labplot_palette()) -- so
        # category_colors is a real, consumed, runtime recolour for them.
        self.assertIsNone(
            unsupported_reason("roc_pr_curve", "category_colors", {"score": "s", "label": "l"}, {})
        )
        self.assertIsNone(
            unsupported_reason(
                "parallel_coordinates", "category_colors", {"columns": ["c1", "c2"]}, {}
            )
        )
        self.assertIsNone(unsupported_reason("radar", "category_colors", {"axis": "a", "value": "v"}, {}))
        self.assertIsNotNone(
            unsupported_reason(
                "embedding", "category_colors", {"x": "c1", "y": "c2"}, {}
            )
        )  # color unmapped -- genuinely no discrete scale yet
        self.assertIsNone(
            unsupported_reason(
                "embedding", "category_colors", {"x": "c1", "y": "c2", "color": "grp"}, {}
            )
        )
        # heatmap/correlation_heatmap/contour/confusion_matrix/network never
        # emit a discrete manual scale at all -- still not consumed.
        self.assertIsNotNone(
            unsupported_reason("heatmap", "category_colors", {"columns": ["c1", "c2"]}, {})
        )

    def test_x_tick_format_not_consumed_for_bar_discrete_x(self):
        reason = unsupported_reason("bar", "x_tick_format", {"x": "cat", "y": "val"}, {})
        self.assertIsNotNone(reason)
        self.assertIn("discrete", reason.lower())

    def test_x_breaks_not_consumed_when_log_x(self):
        reason = unsupported_reason("scatter", "x_breaks", {"x": "c1", "y": "c2"}, {"log_x": True})
        self.assertIsNotNone(reason)
        self.assertIn("log", reason.lower())

    def test_element_overrides_scope(self):
        self.assertIsNone(unsupported_reason("scatter", "element_overrides", {"x": "c1", "y": "c2"}, {}))
        self.assertIsNotNone(unsupported_reason("line", "element_overrides", {"x": "c1", "y": "c2"}, {}))

    def test_x_min_not_consumed_when_range_inverted(self):
        mapping = {"x": "c1", "y": "c2"}
        reason = unsupported_reason("scatter", "x_min", mapping, {"x_min": 10, "x_max": 2})
        self.assertIsNotNone(reason)
        self.assertIn("invert", reason.lower())

    def test_legend_ncol_script_text_discrete_grouped_bar_vs_heatmap_vs_bar(self):
        grouped_bar_script = build_script(
            "grouped_bar", {"x": "cat", "y": "val", "group": "series"}, {"legend_ncol": 2}, "nature"
        )
        heatmap_script = build_script(
            "heatmap", {"columns": ["c1", "c2"]}, {"legend_ncol": 2}, "nature"
        )
        bar_script = build_script(
            "bar", {"x": "cat", "y": "val"}, {"legend_ncol": 2, "color_bars": True}, "nature"
        )
        self.assertIn("guide_legend(ncol = 2)", grouped_bar_script)
        self.assertNotIn("guide_legend(ncol = 2)", heatmap_script)
        # bar's guide is hardcoded hidden regardless of color_bars -- the
        # helper is skipped entirely (has_visible_discrete_legend() is False).
        self.assertNotIn("guide_legend(ncol = 2)", bar_script)

    def test_legend_ncol_r_merges_into_existing_guide_instead_of_replacing_it(self):
        # P1 regression: the emitted helper must inspect/copy the EXISTING
        # guide (plot-level guides() or the scale's own guide=) rather than
        # blindly adding a fresh guide_legend(), which would drop a
        # template's guide_legend(title = ...) and resurrect a
        # guides(<aes> = "none") legend the template hid on purpose.
        script = build_script(
            "grouped_bar", {"x": "cat", "y": "val", "group": "series"}, {"legend_ncol": 2}, "nature"
        )
        self.assertIn("plot$guides$guides[[.aes]]", script)
        self.assertIn("GuideLegend", script)
        self.assertIn("ggproto(NULL, .g)", script)

    def test_supported_option_keys_helper(self):
        keys = supported_option_keys("bar", {"x": "cat", "y": "val"}, {})
        self.assertIn("hide_legend", keys)
        self.assertNotIn("x_tick_format", keys)
        self.assertNotIn("legend_ncol", keys)  # bar's legend is always hidden by template

    def test_option_support_covers_universal_and_own_keys(self):
        support = option_support("bar", {"x": "cat", "y": "val"}, {})
        self.assertIn("error_type", support)  # universal
        self.assertIn("color_bars", support)  # bar's own declared option
        self.assertIn("stat", support)


class ValidateAxisRangesTest(unittest.TestCase):
    """Surgical edit #2 (figures/service.py sanitize_options): an inverted
    x_min/x_max (or y_min/y_max) pair is dropped in full, matching the
    renderer's own coord_cartesian/coord_flip guard."""

    def test_inverted_x_range_is_dropped_by_sanitize_options(self):
        from app.figures import service as figure_service

        clean = figure_service.sanitize_options(
            "scatter", {"x_min": 10, "x_max": 2, "title": "kept"}, valid_columns=None
        )
        self.assertNotIn("x_min", clean)
        self.assertNotIn("x_max", clean)
        self.assertEqual(clean.get("title"), "kept")

    def test_inverted_y_range_is_dropped_by_sanitize_options(self):
        from app.figures import service as figure_service

        clean = figure_service.sanitize_options("scatter", {"y_min": 5, "y_max": 5}, valid_columns=None)
        self.assertNotIn("y_min", clean)
        self.assertNotIn("y_max", clean)

    def test_valid_range_survives_sanitize_options(self):
        from app.figures import service as figure_service

        clean = figure_service.sanitize_options("scatter", {"x_min": 1, "x_max": 10}, valid_columns=None)
        self.assertEqual(clean.get("x_min"), 1)
        self.assertEqual(clean.get("x_max"), 10)


class BuilderInternalGateRegressionTests(unittest.TestCase):
    """Confirmed (not dropped) items from the adversarial review's UNVERIFIED
    list: builder-internal gates option_support.py did not mirror."""

    def test_point_alpha_unsupported_for_box_with_show_points_false(self):
        # templates._box computes `pt_a = _alpha_r(o, "point_alpha", ...)`
        # unconditionally, but only interpolates it into the script inside
        # `if o.get("show_points", True)` -- with show_points explicitly
        # False, point_alpha never reaches the generated R at all.
        mapping = {"x": "cat", "y": "val"}
        self.assertIsNone(unsupported_reason("box", "point_alpha", mapping, {}))
        self.assertIsNone(unsupported_reason("box", "point_alpha", mapping, {"show_points": True}))
        self.assertIsNotNone(
            unsupported_reason("box", "point_alpha", mapping, {"show_points": False})
        )
        base = build_script("box", mapping, {"show_points": False}, "nature")
        probe = build_script("box", mapping, {"show_points": False, "point_alpha": 0.1}, "nature")
        self.assertEqual(base, probe)

    def test_point_alpha_still_gated_by_show_points_for_violin_and_grouped_bar(self):
        self.assertIsNotNone(
            unsupported_reason("violin", "point_alpha", {"x": "cat", "y": "val"}, {})
        )
        self.assertIsNotNone(
            unsupported_reason(
                "grouped_bar", "point_alpha", {"x": "cat", "y": "val", "group": "g"}, {}
            )
        )

    def test_show_significance_unsupported_for_bar_in_count_mode(self):
        # templates._bar's count-mode branch (stat == "count" or no y mapped)
        # returns BEFORE the `if o.get("show_significance")` check further
        # down -- unlike show_n, whose n= layer IS duplicated into that
        # early branch (count_extra), so show_significance has no effect.
        self.assertIsNotNone(
            unsupported_reason("bar", "show_significance", {"x": "cat"}, {})
        )
        self.assertIsNotNone(
            unsupported_reason(
                "bar", "show_significance", {"x": "cat", "y": "val"}, {"stat": "count"}
            )
        )
        self.assertIsNone(
            unsupported_reason("bar", "show_significance", {"x": "cat", "y": "val"}, {})
        )
        base = build_script("bar", {"x": "cat"}, {}, "nature")
        probe = build_script("bar", {"x": "cat"}, {"show_significance": True}, "nature")
        self.assertEqual(base, probe)

    def test_show_n_unaffected_by_bar_count_mode(self):
        # show_n's n= layer IS duplicated into bar's count-mode branch, so
        # (unlike show_significance) it stays consumed there.
        self.assertIsNone(unsupported_reason("bar", "show_n", {"x": "cat"}, {}))

    def test_builders_matching_raises_when_getsource_fails_for_every_builder(self):
        # Import-time introspection must fail LOUD, not silently return an
        # empty set (which would make every label/alpha/level_order/... key
        # look unsupported for every plot type with no signal anything broke).
        from unittest import mock

        from app.r_engine import option_support as osup

        broken_fn = eval("lambda: 0")  # noqa: S307 - no source file, getsource raises OSError
        with mock.patch.object(osup, "_BUILDERS", {"box": broken_fn, "violin": broken_fn}):
            with self.assertRaises(RuntimeError):
                osup._builders_matching(r"_labs\(")


if __name__ == "__main__":
    unittest.main()
