"""Shared option-sanitization metadata for figure mapping/options patches.

Extracted out of app/figures/service.py (which imports app.ai.client for AI
features) so that app/ai/options_schema.py can build the AI-facing patch
schema from the SAME authoritative sets without a circular import:
  figures.service -> ai.client -> ai.options_schema -> figures.service (BAD)
This leaf module has no app-internal imports, so both
  figures.service -> figures.option_metadata (OK)
  ai.options_schema -> figures.option_metadata (OK)
are safe.

These sets are the single source of truth for what `_sanitize_option` /
`sanitize_options` (figures/service.py) accept. Do not duplicate them
elsewhere - importers must reference these objects (not copy the literals).
"""
from __future__ import annotations

_UNIVERSAL_OPTION_KEYS = {
    "palette_name", "size", "width_in", "height_in", "color_mode", "font_scale", "base_size", "dpi",
    # Global line-thickness multiplier (×default). Universal: scales every
    # geom's linewidth in the renderer post-pass; ignored by device types.
    "linewidth_scale",
    "title", "subtitle", "x_label", "y_label", "legend_title",
    "hide_legend", "log_x", "log_y", "flip_coords", "x_text_angle", "legend_position",
    "x_min", "x_max", "y_min", "y_max",
    "custom_palette_values", "custom_palette_label", "category_colors",
    # New visual/layout options (contract with the R-engine agent). Universal so
    # they pass the allow-list for any plot type that renders them; unused keys
    # are simply ignored by templates that do not consume them.
    "fill_alpha", "point_alpha", "error_type", "color_midpoint", "level_order",
    "facet_by", "facet_scales", "hline_at", "vline_at", "font_family", "transparent_background",
    # Gates the self-contained interactive plotly HTML export (bool).
    "interactive_html",
    # Statistical-annotation / model-fit options (contract with the plot-types
    # agent in templates.py). Universal so they pass the allow-list for any plot
    # type that renders them; unused keys are ignored by templates that do not.
    "fit_model", "show_n", "show_significance", "show_fit_stats",
    # Secondary-axis options (contract with the plot-types agent in
    # templates.py): y2_column must reference a real dataset column and
    # y2_label is a plain axis-label string.
    "y2_column", "y2_label",
    # Data-label / axis-tick / legend-layout options (contract with the
    # templates.py & presets.py agents). Universal so they pass the allow-list
    # for any plot type; unused keys are ignored by templates that do not render
    # them. Bool/number/choice shapes are enforced in _sanitize_option.
    "show_data_labels", "data_label_format",
    "reverse_x", "reverse_y", "x_breaks", "y_breaks",
    "x_tick_format", "y_tick_format",
    "legend_key_size", "legend_ncol",
    # Structured overlays (custom-sanitized to shape-safe dicts/lists below):
    # free-form annotations and per-series style overrides.
    "annotations", "series_styles",
    # Axis-type / date-formatting / axis-break options (contract with the
    # templates.py agent + frontend). x_axis_type/date_format are choice-shaped;
    # axis_break_x/axis_break_y are 2-element [from,to] float lists validated in
    # _sanitize_option.
    "x_axis_type", "date_format", "axis_break_x", "axis_break_y",
}
_OPTION_CHOICES = {
    "palette_name": {"preset", "journal_muted", "okabe_ito", "tol_bright", "set2", "npg", "tableau10"},
    "size": {"single_column", "wide", "double_column", "square", "custom"},
    "color_mode": {"color", "grayscale"},
    "stat": {"mean", "sum", "count"},
    "palette": {"blue_red", "viridis", "magma", "inferno", "plasma", "cividis"},
    "corr_method": {"pearson", "spearman"},
    "layout": {"fr", "kk", "circle", "stress"},
    "legend_position": {"right", "bottom", "none"},
    "line_type": {"solid", "dashed", "dotted", "dotdash", "longdash"},
    "point_shape": {"circle", "square", "triangle", "diamond", "none"},
    "error_type": {"sd", "se", "ci95"},
    "facet_scales": {"fixed", "free", "free_x", "free_y"},
    # Superset of the base families plus the extra families the presets agent
    # adds; unknown values are dropped by the membership check.
    "font_family": {"sans", "serif", "mono", "helvetica", "arial", "times", "noto_sans", "noto_serif"},
    # Number formatting for on-plot data labels and axis ticks.
    "data_label_format": {"number", "percent", "comma"},
    "x_tick_format": {"number", "comma", "percent", "scientific"},
    "y_tick_format": {"number", "comma", "percent", "scientific"},
    # Curve-fit model for regression/dose-response templates (default "linear"
    # applied by the template; invalid values are dropped so the render falls
    # back to that default).
    "fit_model": {"linear", "4pl", "mm", "exponential", "logistic"},
    # Stacked-area stacking mode.
    "stack_mode": {"stack", "fill"},
    # Axis-scale interpretation for the x axis (unknown values dropped so the
    # template falls back to auto-detection).
    "x_axis_type": {"auto", "number", "date", "datetime"},
    # Allow-listed strftime formats for date/datetime axes. Arbitrary format
    # strings are rejected so nothing outside this set reaches the R generator.
    "date_format": {
        "%Y-%m-%d", "%Y/%m/%d", "%Y-%m", "%b %Y", "%Y",
        "%m/%d", "%d %b", "%b %d", "%H:%M", "%m-%d", "%b",
    },
}
_BOOL_OPTIONS = {
    "show_points", "show_box", "error_bars", "scale_rows", "add_smooth", "show_density", "show_rug",
    "show_values", "hide_legend", "log_x", "log_y", "flip_coords", "connect_points", "show_contour_lines",
    "cluster_rows", "cluster_cols", "show_row_names", "show_labels", "color_bars", "paired_rows_only",
    "transparent_background",
    "show_sample_labels",
    "show_n", "show_significance", "show_fit_stats",
    # Per-type toggles for the new plot types (sina/qq/forest/dot_plot/lollipop/embedding).
    "show_violin", "show_line", "sort_by_estimate", "sort_desc", "show_cluster_labels",
    # Data-label toggle and axis reversal.
    "show_data_labels", "reverse_x", "reverse_y",
    # Gates the self-contained interactive plotly HTML export.
    "interactive_html",
}
_NUMBER_OPTIONS = {
    "fc_threshold", "p_threshold", "label_top", "font_scale", "base_size", "dpi", "width_in", "height_in",
    "bins", "sig_threshold", "bar_alpha", "bar_width", "x_text_angle", "x_min", "x_max", "y_min", "y_max",
    "fill_alpha", "point_alpha", "color_midpoint", "hline_at", "vline_at",
    # Forest reference line + ridgeline overlap factor (new plot types).
    "ref_line", "overlap",
    # Axis tick-count hints and legend layout sizing (clamped in _sanitize_option).
    "x_breaks", "y_breaks", "legend_key_size", "legend_ncol",
    # Global line-thickness multiplier (float, clamped in _sanitize_option).
    "linewidth_scale",
}
# Of _NUMBER_OPTIONS, the subset _sanitize_option casts to int(...) rather than
# a clamped float. Used by ai/options_schema.py to pick "integer" vs "number".
# Keep in sync with the int(...) casts in figures/service.py:_sanitize_option.
_INTEGER_NUMBER_KEYS = {"dpi", "label_top", "bins", "base_size", "x_breaks", "y_breaks", "legend_ncol"}
