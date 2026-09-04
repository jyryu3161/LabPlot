"""A1.4 authorization inventory for `_request_allowed_patch_paths`.

`_request_allowed_patch_paths` is a conservative, deterministic
natural-language -> patch-path allow-list: an AI-proposed param_patch key
only ever reaches the render if BOTH sanitize_options/option_support accept
it AND (for a scoped user_intent edit) the user's own request text is judged
to authorize that specific path. This test is the coverage sweep for the
second half: every option key the AI schema can ever propose
(`app.ai.options_schema._all_option_keys()`) must be reachable by AT LEAST
ONE request phrase, or be on the documented SKIPPED_KEYS list with a reason.

Every non-skipped key must have a dedicated natural-language rule in
POSITIVE_PHRASES - a realistic phrase a user could actually type, proven to
authorize that key via `_request_allowed_patch_paths`. The literal dotted-path
escape hatch at the top of `_request_allowed_patch_paths` (`options.<key>`
appearing verbatim in the text) IS a real code path (used by
figures/service._professionalized_edit_request's expert rewrite of a user's
request), but it is naming the key, not natural language, so it does NOT
count as inventory coverage here - a key reachable only that way is a real
gap (an AI-schema key a user has no plain-English way to ask for), not
documented coverage.

SKIPPED_KEYS documents keys deliberately NOT reachable by user request text
at all (see each key's comment for why).
"""
from __future__ import annotations

import unittest

from app.ai.options_schema import _all_option_keys
from app.figures import service as figure_service
from app.r_engine.templates import PLOT_TYPES

_PDEF_BY_TYPE = {p["type"]: p for p in PLOT_TYPES}


def _a_plot_type_for(key: str, default: str = "scatter") -> str:
    """Any plot type that declares `key` as one of its own options, else the
    default (used for universal keys, which every plot type accepts)."""
    for pdef in PLOT_TYPES:
        if any(o.get("key") == key for o in pdef.get("options", [])):
            return pdef["type"]
    return default


def allowed(plot_type: str, text: str) -> set[str]:
    return figure_service._request_allowed_patch_paths(plot_type, text, _PDEF_BY_TYPE[plot_type])


# ---------------------------------------------------------------------------
# Keys with NO request-text authorization path at all (not even the dotted
# "options.<key>" escape hatch). Each entry documents why.
# ---------------------------------------------------------------------------
SKIPPED_KEYS: dict[str, str] = {
    "element_overrides": (
        "Per-mark style overrides are authorized ONLY from a server-resolved "
        "scene target (a verified click/mark_id), never from free NL request "
        "text - see _request_allowed_patch_paths's dotted-path loop, which "
        "explicitly excludes this key, and _element_override_fields_from_request "
        "/ scope_allowed_paths in improve_version for the real authorization path."
    ),
}


# ---------------------------------------------------------------------------
# Dedicated natural-language phrases, one (plot_type, EN phrase) per key that
# has a rule in _request_allowed_patch_paths beyond the dotted-path fallback.
# Keys not listed here are still required to be reachable via the dotted
# "options.<key>" fallback (see test_every_non_skipped_key_is_reachable).
# ---------------------------------------------------------------------------
POSITIVE_PHRASES: dict[str, tuple[str, str]] = {
    "title": ("scatter", "change the title to Expression by treatment"),
    "subtitle": ("scatter", "change the subtitle to n=24 per group"),
    "x_label": ("scatter", "rename the x axis label to Time (h)"),
    "y_label": ("bar", "rename the y axis title to Expression (log2)"),
    "legend_title": ("scatter", "rename the legend title to Genotype"),
    "legend_position": ("scatter", "move the legend to the bottom"),
    "legend_direction": ("scatter", "make the legend horizontal"),
    "hide_legend": ("scatter", "hide the legend"),
    "legend_ncol": ("bar", "put the legend in 2 columns"),
    "legend_key_size": ("scatter", "make the legend key size bigger"),
    "line_type": ("line", "make the line dashed"),
    "point_shape": ("line", "use a square point shape"),
    "line_color": ("line", "make the line blue"),
    "x_min": ("scatter", "set the x axis minimum to 0"),
    "x_max": ("scatter", "set the x axis maximum to 100"),
    "y_min": ("scatter", "set the y axis minimum to 0"),
    "y_max": ("scatter", "set the y axis maximum to 100"),
    "log_x": ("scatter", "use a log scale for the x axis"),
    "log_y": ("scatter", "use a log scale for the y axis"),
    "x_text_angle": ("scatter", "rotate the x axis labels 45 degrees"),
    "x_breaks": ("scatter", "change the x axis tick format"),
    "x_tick_format": ("scatter", "show the x axis ticks as percent"),
    "x_axis_type": ("scatter", "use a date axis"),
    "date_format": ("scatter", "use a date axis"),
    "y_breaks": ("scatter", "change the y axis tick format"),
    "y_tick_format": ("scatter", "show the y axis ticks as percent"),
    "error_bars": ("bar", "add error bars"),
    "error_type": ("bar", "show the standard deviation"),
    "palette_name": ("scatter", "use a colorblind-safe palette"),
    "color_mode": ("scatter", "use grayscale"),
    "base_size": ("scatter", "make the font size larger"),
    "font_scale": ("scatter", "make the text size larger"),
    "font_family": ("scatter", "change the font family"),
    "linewidth_scale": ("scatter", "make the lines thicker"),
    "axis_line_width_pt": ("scatter", "make the axis lines width 1pt"),
    "data_line_width_pt": ("line", "make the data lines width 2pt"),
    "size": ("scatter", "change the figure size to wide"),
    "width_in": ("scatter", "change the export width"),
    "height_in": ("scatter", "change the export height"),
    "dpi": ("scatter", "increase the export resolution/dpi"),
    "fill_alpha": ("scatter", "make the fill more transparent"),
    "point_alpha": ("scatter", "make the points more transparent"),
    "flip_coords": ("bar", "flip to horizontal bars"),
    "hline_at": ("scatter", "add a horizontal reference line"),
    "vline_at": ("scatter", "add a vertical reference line"),
    "facet_by": ("scatter", "facet by treatment"),
    "facet_scales": ("scatter", "use free facet scales"),
    "level_order": ("bar", "reorder the categories"),
    "bar_width": ("grouped_bar", "change the bar width"),
    "bar_alpha": ("overlap_bar", "increase bar transparency"),
    "bins": ("histogram", "change the number of bins"),
    "connect_points": ("error_bar", "connect the points"),
    "sort_desc": ("dot_plot", "sort descending"),
    "stack_mode": ("area", "use stacked bars"),
    "show_data_labels": ("bar", "show data labels"),
    "show_values": ("correlation_heatmap", "show values"),
    "data_label_format": ("bar", "change the data label format"),
    "add_smooth": ("scatter", "add a trend line"),
    "fit_model": ("curve_fit", "use a logistic regression model"),
    "show_fit_stats": ("scatter", "show the fit stats"),
    "reverse_x": ("scatter", "reverse x axis"),
    "reverse_y": ("scatter", "reverse y axis"),
    "y2_column": ("scatter", "add a secondary y axis"),
    "y2_label": ("scatter", "change the secondary y label"),
    "transparent_background": ("scatter", "use a transparent background"),
    "show_significance": ("bar", "add significance stars"),
    "show_n": ("bar", "show the sample size n= for each group"),
    "axis_break_x": ("scatter", "add an x axis break"),
    "axis_break_y": ("scatter", "add a y axis break"),
    "color_midpoint": ("heatmap", "set the color scale midpoint to zero"),
    "category_colors": ("bar", "color the treatment groups blue and red"),
    "show_box": ("violin", "hide the box"),
    "show_points": ("box", "show the points"),
    "show_rug": ("density", "add rug marks"),
    "show_density": ("histogram", "show the density overlay"),
    "show_labels": ("network", "show the labels"),
    "show_line": ("qq", "show the line"),
    "show_violin": ("sina", "show the violin"),
    # Previously reachable ONLY via the "options.<key>" dotted-path escape
    # hatch (a real code path, but naming the key is not a natural-language
    # proof of reachability - see the module docstring). Each phrase below is
    # plain wording a user could plausibly type.
    "cluster_rows": ("annotated_heatmap", "cluster the rows"),
    "cluster_cols": ("annotated_heatmap", "cluster the columns"),
    "color_bars": ("bar", "color the bars by category"),
    "corr_method": ("correlation_heatmap", "use spearman correlation"),
    "fc_threshold": ("volcano", "change the fold change threshold"),
    "p_threshold": ("volcano", "change the p-value threshold"),
    "label_top": ("volcano", "label the top 10"),
    "layout": ("network", "use a circular layout"),
    "overlap": ("ridge", "change the ridge overlap"),
    "paired_rows_only": ("overlap_bar", "use only paired rows"),
    "palette": ("heatmap", "use the viridis palette"),
    "redundant_series_encoding": ("line", "use colorblind-friendly lines"),
    "ref_line": ("forest", "add a reference line"),
    "scale_rows": ("heatmap", "z-score the rows"),
    "series_1_label": ("overlap_bar", "rename the first series label"),
    "series_2_label": ("overlap_bar", "rename the second series label"),
    "show_cluster_labels": ("embedding", "label the clusters"),
    "show_contour_lines": ("contour", "show contour lines"),
    "show_row_names": ("annotated_heatmap", "show row names"),
    "show_sample_labels": ("scatter", "show sample labels"),
    "sig_threshold": ("manhattan", "change the significance line"),
    "sort_by_estimate": ("forest", "sort by estimate"),
    "stat": ("bar", "change the bar statistic to sum"),
}

# A smaller Korean cross-check: the keys most directly touched by A1.4 (new
# rules, or the y_label/legend_ncol combined-request fix), each with a
# natural Korean phrase.
POSITIVE_PHRASES_KO: dict[str, tuple[str, str]] = {
    "y_label": ("bar", "범례 열 수를 2로 하고 y축 제목을 Expression (log2)로 바꿔줘"),
    "legend_ncol": ("bar", "범례 열 수를 2로 하고 y축 제목을 Expression (log2)로 바꿔줘"),
    "x_label": ("scatter", "x축 제목을 Time (h)로 바꿔줘"),
    "show_significance": ("bar", "유의성 별표를 추가해줘"),
    "show_n": ("bar", "각 그룹의 표본 수를 표시해줘"),
    "error_type": ("bar", "표준편차를 표시해줘"),
    "color_midpoint": ("heatmap", "색상 스케일의 중간값을 0으로 해줘"),
    "category_colors": ("bar", "처리 그룹을 파란색과 빨간색으로 칠해줘"),
    "legend_direction": ("scatter", "범례를 가로로 배치해줘"),
    "point_alpha": ("scatter", "점을 더 투명하게 해줘"),
    "x_axis_type": ("scatter", "날짜 축을 사용해줘"),
    "date_format": ("scatter", "날짜 축을 사용해줘"),
}


class AuthorizationInventoryTest(unittest.TestCase):
    """Every AI-schema option key is reachable by at least one request phrase,
    unless it is on SKIPPED_KEYS (documented, deliberate exclusion)."""

    def test_skipped_keys_are_real_and_documented(self):
        all_keys = _all_option_keys()
        for key, reason in SKIPPED_KEYS.items():
            self.assertIn(key, all_keys, f"{key!r} is not even a real AI-schema key any more")
            self.assertTrue(reason.strip())

    def test_every_non_skipped_key_is_reachable(self):
        # Naming a key via the dotted "options.<key>" escape hatch is NOT
        # accepted as inventory proof here - it demonstrates the escape hatch
        # works, not that a real user request reaches the key. Every
        # non-skipped key must have a dedicated POSITIVE_PHRASES entry.
        all_keys = _all_option_keys()
        no_dedicated_phrase = []
        unreachable = []
        for key in sorted(all_keys):
            if key in SKIPPED_KEYS:
                continue
            if key not in POSITIVE_PHRASES:
                no_dedicated_phrase.append(key)
                continue
            plot_type, phrase = POSITIVE_PHRASES[key]
            result = allowed(plot_type, phrase)
            if f"options.{key}" not in result:
                unreachable.append((key, plot_type, phrase, sorted(result)))
        self.assertEqual(
            no_dedicated_phrase, [],
            f"Keys with no dedicated natural-language phrase (only reachable via the "
            f"options.<key> dotted-path escape hatch, which is not NL proof): {no_dedicated_phrase}",
        )
        self.assertEqual(unreachable, [], f"Keys not authorized by any phrase: {unreachable}")

    def test_dotted_path_escape_hatch_still_reaches_every_key(self):
        # The escape hatch itself (options.<key> appearing verbatim, used by
        # _professionalized_edit_request's expert rewrite) must still work
        # for every real key, even though it no longer counts toward the NL
        # inventory above.
        all_keys = _all_option_keys()
        unreachable = []
        for key in sorted(all_keys):
            if key in SKIPPED_KEYS:
                continue
            plot_type = _a_plot_type_for(key)
            phrase = f"options.{key}"
            result = allowed(plot_type, phrase)
            if f"options.{key}" not in result:
                unreachable.append((key, plot_type, phrase, sorted(result)))
        self.assertEqual(unreachable, [], f"Keys not reachable via the dotted-path escape hatch: {unreachable}")

    def test_korean_phrases_reach_their_keys(self):
        mismatches = []
        for key, (plot_type, phrase) in POSITIVE_PHRASES_KO.items():
            result = allowed(plot_type, phrase)
            if f"options.{key}" not in result:
                mismatches.append((key, plot_type, phrase, sorted(result)))
        self.assertEqual(mismatches, [], f"Korean phrases that failed to authorize their key: {mismatches}")


class AuthorizationRegressionTest(unittest.TestCase):
    """Specific regressions called out during A1.4 review."""

    def test_combined_legend_columns_and_y_axis_title_rename_authorizes_both(self):
        # A live-baseline bug: a multi-clause request mentioning "legend" for
        # one clause and "y axis title" for another used to let the mere
        # presence of the word "legend" anywhere in the sentence steal the
        # y_label authorization and grant legend_title instead.
        text = "Put the legend in 2 columns and rename the y axis title to Expression (log2)"
        result = allowed("bar", text)
        self.assertIn("options.legend_ncol", result)
        self.assertIn("options.y_label", result)
        self.assertNotIn("options.legend_title", result)

    def test_combined_legend_columns_and_y_axis_title_rename_korean(self):
        text = "범례 열 수를 2로 하고 y축 제목을 Expression (log2)로 바꿔줘"
        result = allowed("bar", text)
        self.assertIn("options.legend_ncol", result)
        self.assertIn("options.y_label", result)

    def test_legend_ncol_r_code_check_looks_for_guide_legend(self):
        # T3/A1.4: legend_ncol previously had no specific R-code string check,
        # so a stale "applied" report on the OLD code (no guide_legend call
        # at all) could slip through _ai_edit_checklist as "applied".
        match, note = figure_service._r_code_check_for_patch(
            "options", "legend_ncol", 2,
            type("V", (), {"r_code": "p <- p + labplot_theme()\n"})(),
        )
        self.assertFalse(match)
        match2, _note2 = figure_service._r_code_check_for_patch(
            "options", "legend_ncol", 2,
            type("V", (), {"r_code": "p <- p + guide_legend(ncol = 2)\n"})(),
        )
        self.assertTrue(match2)

    def test_transparent_background_alone_does_not_authorize_fill_alpha(self):
        result = allowed("scatter", "transparent background")
        self.assertIn("options.transparent_background", result)
        self.assertNotIn("options.fill_alpha", result)

    def test_vague_polish_request_authorizes_nothing(self):
        self.assertEqual(allowed("scatter", "make it nicer"), set())

    def test_category_colors_literal_retention_narrows_to_named_label_for_color_word(self):
        # A colour NAME (not the literal word "colour") authorizes the parent
        # options.category_colors path; the literal-level retention filter
        # must fire on that same signal so only the named label survives, not
        # every label in the model's patch.
        patch = {"options": {"category_colors": {
            "Treatment": "#EA580C", "Control": "#000000", "Placebo": "#FF0000",
        }}}
        allowed_paths = figure_service._request_allowed_patch_paths(
            "bar", "Make the Treatment group red", _PDEF_BY_TYPE["bar"],
        )
        self.assertIn("options.category_colors", allowed_paths)
        filtered = figure_service._filter_patch_to_request_scope(
            patch, allowed_paths, "Make the Treatment group red",
        )
        self.assertEqual(filtered, {"options": {"category_colors": {"Treatment": "#EA580C"}}})

    def test_category_colors_literal_retention_narrows_to_named_label_for_hex(self):
        patch = {"options": {"category_colors": {
            "Treatment": "#EA580C", "Control": "#000000", "Placebo": "#FF0000",
        }}}
        allowed_paths = figure_service._request_allowed_patch_paths(
            "bar", "Set the Control group to #EA580C", _PDEF_BY_TYPE["bar"],
        )
        self.assertIn("options.category_colors", allowed_paths)
        filtered = figure_service._filter_patch_to_request_scope(
            patch, allowed_paths, "Set the Control group to #EA580C",
        )
        self.assertEqual(filtered, {"options": {"category_colors": {"Control": "#000000"}}})


if __name__ == "__main__":
    unittest.main()
