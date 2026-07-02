"""Generate self-contained R (ggplot2) code per plot type.

Each builder returns an R snippet that constructs a ggplot object `p` from a
data frame `df`, using literal column names via tidy-eval `.data[["col"]]`.
Only packages available in the r-viz env are used: ggplot2, dplyr, tidyr,
readr, scales, viridisLite (+ base stats/grDevices).
"""
from __future__ import annotations

import re
from typing import Any

_HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


# ---------------------------------------------------------------- helpers
def rq(s: Any) -> str:
    """R-quote a python str, or NULL for None."""
    if s is None:
        return "NULL"
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _data(col: str) -> str:
    return f'.data[[{rq(col)}]]'


def _num(v, default):
    try:
        return float(v)
    except (TypeError, ValueError):
        return float(default)


def _finite_num(v):
    """Return a finite float for v, or None when v is missing / not finite."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return f


def _alpha_r(o, key, default_literal):
    """R alpha literal for option ``key``.

    Returns the user's value clamped to [0.05, 1.0] when set, otherwise the
    unchanged ``default_literal`` string -- guaranteeing byte-identical output
    when the option is absent.
    """
    v = o.get(key)
    if v is None or (isinstance(v, str) and not v.strip()):
        return default_literal
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default_literal
    if f != f:  # NaN
        return default_literal
    f = max(0.05, min(1.0, f))
    return f"{f:g}"


def _level_order_vec(o):
    """R character vector for an explicit ``level_order``, or None when unset."""
    lv = o.get("level_order")
    if not isinstance(lv, list) or not lv:
        return None
    items = [rq(str(s)) for s in lv if s is not None and str(s) != ""]
    if not items:
        return None
    return "c(" + ", ".join(items) + ")"


_VIRIDIS_OPTIONS = ("viridis", "magma", "inferno", "plasma", "cividis")
_HEATMAP_OPTIONS = _VIRIDIS_OPTIONS + ("blue_red",)
_GRAPH_LAYOUTS = ("fr", "kk", "circle", "stress")
_LINE_TYPES = ("solid", "dashed", "dotted", "dotdash", "longdash")
_POINT_SHAPES = {
    "circle": 16,
    "square": 15,
    "triangle": 17,
    "diamond": 18,
    "none": None,
}
_GEOM_TEXT_SIZE_7PT = 2.46


def _choice(value, allowed: tuple[str, ...], default: str) -> str:
    return value if isinstance(value, str) and value in allowed else default


# ---- date/time x-axis (scatter / line / area) --------------------------------
_TEMPORAL_X_TYPES = {"scatter", "line", "area"}
_X_AXIS_TYPES = ("auto", "number", "date", "datetime")
# ggplot2 geom text `size` is in mm; font point size = size * .pt.
_GGPLOT_PT = 72.27 / 25.4


def _clamp01(v):
    """Finite float clamped to [0, 1], or None when v is missing / non-finite."""
    f = _finite_num(v)
    if f is None:
        return None
    return max(0.0, min(1.0, f))


def _x_axis_type(o) -> str:
    return _choice(o.get("x_axis_type"), _X_AXIS_TYPES, "auto")


def _x_is_temporal(plot_type: str, m, o) -> bool:
    return (plot_type in _TEMPORAL_X_TYPES and bool(m.get("x"))
            and _x_axis_type(o) in ("date", "datetime"))


def _temporal_x(o, x) -> tuple[str, str]:
    """``(pre, post)`` R for a date/datetime x axis; ``("", "")`` when off.

    ``pre`` coerces ``df[[x]]`` to Date/POSIXct *before* ``ggplot(df, ...)``
    captures it, guarded so an all-NA parse leaves x untouched (no crash).
    ``post`` appends the matching ``scale_x_date`` / ``scale_x_datetime``,
    itself guarded on ``.xt_ok`` so a fallback never attaches a temporal scale
    to a non-temporal aesthetic. Empty strings preserve byte-identical output
    when ``x_axis_type`` is unset / "auto" / "number".
    """
    xt = _x_axis_type(o)
    if xt not in ("date", "datetime") or not x:
        return "", ""
    if xt == "date":
        coerce = f'as.Date(as.character(df[[{rq(x)}]]))'
        scale_fn = "scale_x_date"
    else:
        coerce = f'as.POSIXct(as.character(df[[{rq(x)}]]))'
        scale_fn = "scale_x_datetime"
    fmt = o.get("date_format")
    if isinstance(fmt, str) and fmt.strip():
        labels_arg = f"date_labels = {rq(fmt.strip())}"
    else:
        labels_arg = "labels = scales::label_date_short()"
    pre = (f"\n.xt_raw <- suppressWarnings({coerce})\n"
           f".xt_ok <- !all(is.na(.xt_raw))\n"
           f"if (.xt_ok) {{ df[[{rq(x)}]] <- .xt_raw }}\n")
    post = f"\nif (.xt_ok) {{ p <- p + {scale_fn}({labels_arg}) }}\n"
    return pre, post


def _labs(options: dict, default_x="", default_y="", default_fill="NULL_DEFAULT") -> str:
    title = options.get("title")
    subtitle = options.get("subtitle")
    xlab = options.get("x_label", default_x)
    ylab = options.get("y_label", default_y)
    parts = []
    parts.append(f"title = {rq(title)}" if title else "title = NULL")
    if subtitle:
        parts.append(f"subtitle = {rq(subtitle)}")
    parts.append(f"x = {rq(xlab) if xlab else 'NULL'}")
    parts.append(f"y = {rq(ylab) if ylab else 'NULL'}")
    return "labs(" + ", ".join(parts) + ")"


_ORDERED_FACTOR_R = """
.labplot_ordered_factor <- function(x) {
  x_chr <- as.character(x)
  levels <- unique(x_chr[!is.na(x_chr)])
  level_num <- suppressWarnings(as.numeric(levels))
  if (length(levels) > 0 && all(!is.na(level_num))) {
    levels <- levels[order(level_num)]
  }
  factor(x_chr, levels = levels)
}
"""


# Explicit level ordering: user-given levels present in the data come first (in
# the given order), remaining levels follow in the numeric-aware auto order.
_LEVEL_ORDER_R = """
.labplot_ordered_levels <- function(x, explicit) {
  x_chr <- as.character(x)
  base <- unique(x_chr[!is.na(x_chr)])
  base_num <- suppressWarnings(as.numeric(base))
  if (length(base) > 0 && all(!is.na(base_num))) {
    base <- base[order(base_num)]
  }
  explicit <- as.character(explicit)
  present <- explicit[explicit %in% base]
  rest <- base[!(base %in% explicit)]
  factor(x_chr, levels = c(present, rest))
}
"""


# ------------------------------------------------ on-figure stat annotations
def _group_n_layer(x_fac_expr, y_col, at="top"):
    """geom_text 'n=' per x-group appended to `p` (opt-in, default off).

    ``y_col=None`` -> count bars: label sits at the bar top (the count itself).
    ``at='top'`` -> above each group's data max; ``at='base'`` -> at the axis.
    """
    if y_col is None:
        return f"""
.n_lab <- df %>% dplyr::transmute(.gx = {x_fac_expr}) %>%
  dplyr::filter(!is.na(.gx)) %>% dplyr::count(.gx, name = ".n")
p <- p + geom_text(data = .n_lab, aes(x = .gx, y = .n, label = paste0("n=", .n)),
                   inherit.aes = FALSE, vjust = -0.4, size = {_GEOM_TEXT_SIZE_7PT}, colour = "grey30")
"""
    ypos, vjust = ("0", "1.3") if at == "base" else ("max(.yy, na.rm = TRUE)", "-0.9")
    return f"""
.n_lab <- df %>% dplyr::transmute(.gx = {x_fac_expr}, .yy = suppressWarnings(as.numeric({_data(y_col)}))) %>%
  dplyr::filter(!is.na(.gx), !is.na(.yy)) %>%
  dplyr::group_by(.gx) %>%
  dplyr::summarise(.ypos = {ypos}, .n = dplyr::n(), .groups = "drop")
p <- p + geom_text(data = .n_lab, aes(x = .gx, y = .ypos, label = paste0("n=", .n)),
                   inherit.aes = FALSE, vjust = {vjust}, size = {_GEOM_TEXT_SIZE_7PT}, colour = "grey30")
"""


def _sig_layer(x_fac_expr, y_col):
    """Pairwise significance brackets (2-4 groups) appended to `p`.

    Per-pair Welch t-tests; stars *** / ** / * / ns drawn on stacked segments.
    Fully wrapped in tryCatch so a degenerate group set silently draws nothing.
    """
    return f"""
invisible(tryCatch({{
  .sd <- df %>% dplyr::transmute(.gx = {x_fac_expr}, .yy = suppressWarnings(as.numeric({_data(y_col)}))) %>%
    dplyr::filter(!is.na(.gx), !is.na(.yy))
  .gx_f <- factor(.sd$.gx)
  .levs <- levels(.gx_f); .levs <- .levs[.levs %in% as.character(.sd$.gx)]
  if (length(.levs) >= 2 && length(.levs) <= 4) {{
    .ymax <- max(.sd$.yy, na.rm = TRUE); .ymin <- min(.sd$.yy, na.rm = TRUE)
    .rng <- .ymax - .ymin; if (!is.finite(.rng) || .rng <= 0) .rng <- abs(.ymax) + 1
    .step <- .rng * 0.12; .k <- 0
    .seg <- data.frame(x = numeric(0), xend = numeric(0), y = numeric(0), yend = numeric(0))
    .txt <- data.frame(x = numeric(0), y = numeric(0), label = character(0))
    for (.pr in utils::combn(.levs, 2, simplify = FALSE)) {{
      .a <- .sd$.yy[as.character(.sd$.gx) == .pr[1]]
      .b <- .sd$.yy[as.character(.sd$.gx) == .pr[2]]
      if (length(.a) < 2 || length(.b) < 2) next
      .pv <- tryCatch(stats::t.test(.a, .b)$p.value, error = function(e) NA_real_)
      if (!is.finite(.pv)) next
      .k <- .k + 1
      .yb <- .ymax + .step * .k
      .xa <- match(.pr[1], .levs); .xb <- match(.pr[2], .levs)
      .star <- if (.pv < 0.001) "***" else if (.pv < 0.01) "**" else if (.pv < 0.05) "*" else "ns"
      .seg <- rbind(.seg, data.frame(x = .xa, xend = .xb, y = .yb, yend = .yb))
      .txt <- rbind(.txt, data.frame(x = (.xa + .xb) / 2, y = .yb, label = .star, stringsAsFactors = FALSE))
    }}
    if (nrow(.seg) > 0) {{
      p <<- p + geom_segment(data = .seg, aes(x = x, xend = xend, y = y, yend = yend),
                             inherit.aes = FALSE, linewidth = 0.3, colour = "grey25") +
                geom_text(data = .txt, aes(x = x, y = y, label = label),
                          inherit.aes = FALSE, vjust = -0.2, size = {_GEOM_TEXT_SIZE_7PT}, colour = "grey15")
    }}
  }}
}}, error = function(e) NULL))
"""


def _fit_stats_layer(x_col, y_col):
    """Annotate lm R-squared and slope/intercept for a scatter (opt-in, off)."""
    return f"""
invisible(tryCatch({{
  .fx <- suppressWarnings(as.numeric({_col(x_col)})); .fy <- suppressWarnings(as.numeric({_col(y_col)}))
  .ok <- is.finite(.fx) & is.finite(.fy)
  if (sum(.ok) >= 3 && stats::sd(.fx[.ok]) > 0) {{
    .fit <- stats::lm(.fy[.ok] ~ .fx[.ok])
    .co <- stats::coef(.fit)
    .lab <- sprintf("y = %.3g x + %.3g\\nR\\u00b2 = %.3f", .co[[2]], .co[[1]], summary(.fit)$r.squared)
    p <<- p + annotate("text", x = min(.fx[.ok]), y = max(.fy[.ok]),
                       label = .lab, hjust = 0, vjust = 1, size = {_GEOM_TEXT_SIZE_7PT}, colour = "grey20")
  }}
}}, error = function(e) NULL))
"""


# ------------------------------------------------ secondary Y axis (line/scatter)
def _y2_axis(o, x, y, geom: str, grouped: bool) -> tuple[str, str]:
    """Secondary-Y-axis snippets for ``options["y2_column"]`` (line/scatter).

    Returns ``(pre_r, post_r)``: ``pre_r`` rescales the y2 series onto the
    primary y range *before* ``p <- ggplot(df, ...)`` captures df; ``post_r``
    appends a fixed-colour layer plus a ``sec_axis`` back-transform. Both are
    empty strings when ``y2_column`` is unset. Column/label go through rq().
    """
    y2 = o.get("y2_column")
    if not isinstance(y2, str) or not y2.strip():
        return "", ""
    label = o.get("y2_label")
    if not isinstance(label, str) or not label.strip():
        label = y2
    # Second palette colour normally; when a group/colour column already maps
    # series to the palette, fall back to the fixed auxiliary blue used for
    # smooth lines so the y2 layer cannot collide with a series colour.
    colour_r = 'labplot_palette(2)[[2]]' if not grouped else '"#4C6F91"'
    pre = f"""
.y1r <- range(suppressWarnings(as.numeric(df[[{rq(y)}]])), na.rm = TRUE)
.y2r <- range(suppressWarnings(as.numeric(df[[{rq(y2)}]])), na.rm = TRUE)
.y2span <- diff(.y2r); if (!is.finite(.y2span) || .y2span == 0) .y2span <- 1
.y2_scale <- diff(.y1r) / .y2span; if (!is.finite(.y2_scale) || .y2_scale == 0) .y2_scale <- 1
.y2_shift <- .y1r[[1]] - .y2r[[1]] * .y2_scale
df$.y2_scaled <- suppressWarnings(as.numeric(df[[{rq(y2)}]])) * .y2_scale + .y2_shift
.y2_colour <- {colour_r}
"""
    if geom == "line":
        layer = (f'geom_line(aes(x = {_data(x)}, y = .data[[".y2_scaled"]], group = 1), '
                 'colour = .y2_colour, linewidth = 0.35, linetype = "dashed", alpha = 0.9, '
                 'na.rm = TRUE, inherit.aes = FALSE)')
    else:
        layer = (f'geom_point(aes(x = {_data(x)}, y = .data[[".y2_scaled"]]), '
                 'colour = .y2_colour, size = 2.0, alpha = 0.7, '
                 'na.rm = TRUE, inherit.aes = FALSE)')
    post = (f"p <- p + {layer} +\n"
            f"  scale_y_continuous(sec.axis = sec_axis(~ (. - .y2_shift) / .y2_scale, name = {rq(label)}))\n")
    return pre, post


# ---------------------------------------------------------------- builders
def _box(m, o):
    x, y = m["x"], m["y"]
    color = m.get("color") or x
    fill_a = _alpha_r(o, "fill_alpha", "0.9")
    pt_a = _alpha_r(o, "point_alpha", "0.45")
    order_vec = _level_order_vec(o)
    if order_vec:
        helper = _LEVEL_ORDER_R
        x_fac = f".labplot_ordered_levels({_data(x)}, {order_vec})"
        fill_fac = f".labplot_ordered_levels({_data(color)}, {order_vec})"
    else:
        helper = ""
        x_fac = f"factor({_data(x)})"
        fill_fac = f"factor({_data(color)})"
    points = f"  geom_jitter(width = 0.15, size = 1.1, alpha = {pt_a}) +\n" if o.get("show_points", True) else ""
    extra = ""
    if o.get("show_n"):
        extra += _group_n_layer(x_fac, y, at="top")
    if o.get("show_significance"):
        extra += _sig_layer(x_fac, y)
    return f"""{helper}
p <- ggplot(df, aes(x = {x_fac}, y = {_data(y)}, fill = {fill_fac})) +
  geom_boxplot(outlier.size = 0.8, alpha = {fill_a}, width = 0.65,
               box.linewidth = 0.35, whisker.linewidth = 0.35, median.linewidth = 0.35) +
{points}  scale_fill_manual(values = labplot_palette()) +
  {_labs(o, x, y)} + guides(fill = guide_legend(title = {rq(color)}))
{extra}"""


def _violin(m, o):
    x, y = m["x"], m["y"]
    color = m.get("color") or x
    fill_a = _alpha_r(o, "fill_alpha", "0.85")
    pt_a = _alpha_r(o, "point_alpha", "0.4")
    order_vec = _level_order_vec(o)
    if order_vec:
        helper = _LEVEL_ORDER_R
        x_fac = f".labplot_ordered_levels({_data(x)}, {order_vec})"
        fill_fac = f".labplot_ordered_levels({_data(color)}, {order_vec})"
    else:
        helper = ""
        x_fac = f"factor({_data(x)})"
        fill_fac = f"factor({_data(color)})"
    inner = (
        "  geom_boxplot(width = 0.12, fill = \"white\", alpha = 0.7, outlier.shape = NA, "
        "box.linewidth = 0.3, whisker.linewidth = 0.3, median.linewidth = 0.3) +\n"
    ) if o.get("show_box", True) else ""
    points = f"  geom_jitter(width = 0.12, size = 1.0, alpha = {pt_a}) +\n" if o.get("show_points", False) else ""
    extra = ""
    if o.get("show_n"):
        extra += _group_n_layer(x_fac, y, at="top")
    if o.get("show_significance"):
        extra += _sig_layer(x_fac, y)
    return f"""{helper}
p <- ggplot(df, aes(x = {x_fac}, y = {_data(y)}, fill = {fill_fac})) +
  geom_violin(trim = FALSE, alpha = {fill_a}, scale = "width", linewidth = 0.35) +
{inner}{points}  scale_fill_manual(values = labplot_palette()) +
  {_labs(o, x, y)} + guides(fill = guide_legend(title = {rq(color)}))
{extra}"""


def _scatter(m, o):
    x, y = m["x"], m["y"]
    color = m.get("color")
    smooth = '  geom_smooth(method = "lm", se = TRUE, colour = "#4C6F91", fill = "grey80", alpha = 0.4, linewidth = 0.35) +\n' if o.get("add_smooth", False) else ""
    if color:
        aes = f"aes(x = {_data(x)}, y = {_data(y)}, colour = factor({_data(color)}))"
        scale = "  scale_colour_manual(values = labplot_palette()) +\n"
        guide = f" + guides(colour = guide_legend(title = {rq(color)}))"
    else:
        aes = f"aes(x = {_data(x)}, y = {_data(y)})"
        scale = ""
        guide = ""
    pt_a = _alpha_r(o, "point_alpha", "0.8")
    fit_extra = _fit_stats_layer(x, y) if o.get("show_fit_stats") else ""
    y2_pre, y2_post = _y2_axis(o, x, y, "point", grouped=bool(color))
    t_pre, t_post = _temporal_x(o, x)
    return f"""{t_pre}
{y2_pre}p <- ggplot(df, {aes}) +
{smooth}  geom_point(size = 2.0, alpha = {pt_a}) +
{scale}  {_labs(o, x, y)}{guide}
{y2_post}{fit_extra}{t_post}"""


def _bar(m, o):
    x = m["x"]
    stat = o.get("stat", m.get("stat", "mean"))
    color_bars = bool(o.get("color_bars", False))
    fill_a = _alpha_r(o, "fill_alpha", "0.9")
    order_vec = _level_order_vec(o)
    order_helper = _LEVEL_ORDER_R if order_vec else ""

    def _fac(expr):
        return f".labplot_ordered_levels({expr}, {order_vec})" if order_vec else f".labplot_ordered_factor({expr})"

    count_extra = _group_n_layer(_fac(_data(x)), None) if o.get("show_n") else ""
    if stat == "count" or not m.get("y"):
        if color_bars:
            return f"""
{_ORDERED_FACTOR_R}{order_helper}
p <- ggplot(df, aes(x = {_fac(_data(x))}, fill = {_fac(_data(x))})) +
  geom_bar(alpha = {fill_a}, colour = "grey25", linewidth = 0.25) +
  scale_fill_manual(values = labplot_palette()) +
  {_labs(o, x, "count")} + guides(fill = "none")
{count_extra}"""
        return f"""
{_ORDERED_FACTOR_R}{order_helper}
p <- ggplot(df, aes(x = {_fac(_data(x))})) +
  geom_bar(fill = labplot_accent(), alpha = {fill_a}, colour = "grey25", linewidth = 0.25) +
  {_labs(o, x, "count")} + guides(fill = "none")
{count_extra}"""
    y = m["y"]
    fun = "mean" if stat == "mean" else "sum"
    error_type = _choice(o.get("error_type"), ("sd", "se", "ci95"), "sd")
    err = ""
    n_line = ""
    if stat == "mean" and o.get("error_bars", True):
        if error_type == "se":
            n_line = "\n                   .n = dplyr::n(),"
            err_expr = ".sd / sqrt(.n)"
        elif error_type == "ci95":
            n_line = "\n                   .n = dplyr::n(),"
            err_expr = "1.96 * .sd / sqrt(.n)"
        else:
            err_expr = ".sd"
        err = f"""  geom_errorbar(aes(ymin = .val - {err_expr}, ymax = .val + {err_expr}), width = 0.2, linewidth = 0.25) +
"""
    fill_aes = ", fill = .grp" if color_bars else ""
    fill_layer = (
        f"  geom_col(width = 0.7, alpha = {fill_a}, colour = \"grey25\", linewidth = 0.25) +\n"
        "  scale_fill_manual(values = labplot_palette()) +\n"
        if color_bars else
        f"  geom_col(width = 0.7, alpha = {fill_a}, fill = labplot_accent(), colour = \"grey25\", linewidth = 0.25) +\n"
    )
    mean_extra = ""
    if o.get("show_n"):
        mean_extra += f"""
.n_bar <- df %>% dplyr::mutate(.grp = {_fac(_data(x))}) %>%
  dplyr::group_by(.grp) %>% dplyr::summarise(.n = dplyr::n(), .groups = "drop")
.lab_df <- dplyr::left_join(.summ, .n_bar, by = ".grp")
.lab_df$.ypos <- .lab_df$.val + ifelse(is.na(.lab_df$.sd), 0, abs(.lab_df$.sd))
p <- p + geom_text(data = .lab_df, aes(x = .grp, y = .ypos, label = paste0("n=", .n)),
                   inherit.aes = FALSE, vjust = -0.6, size = {_GEOM_TEXT_SIZE_7PT}, colour = "grey30")
"""
    if o.get("show_significance"):
        mean_extra += _sig_layer(_fac(_data(x)), y)
    return f"""
{_ORDERED_FACTOR_R}{order_helper}
.summ <- df %>% dplyr::mutate(.grp = {_fac(_data(x))}) %>%
  dplyr::group_by(.grp) %>%
  dplyr::summarise(.val = {fun}({_data(y)}, na.rm = TRUE),
                   .sd = stats::sd({_data(y)}, na.rm = TRUE),{n_line} .groups = "drop")
.summ$.sd[is.na(.summ$.sd)] <- 0
p <- ggplot(.summ, aes(x = .grp, y = .val{fill_aes})) +
{fill_layer}{err}  {_labs(o, x, f"{fun}({y})")} + guides(fill = "none")
{mean_extra}"""


def _grouped_bar(m, o):
    x, y, group = m["x"], m["y"], m["group"]
    stat = o.get("stat", "mean")
    fun = "sum" if stat == "sum" else "mean"
    width = max(0.2, min(1.0, _num(o.get("bar_width"), 0.68)))
    legend = o.get("legend_title") or group
    order_vec = _level_order_vec(o)
    order_helper = _LEVEL_ORDER_R if order_vec else ""
    x_fac = f".labplot_ordered_levels(.x_raw, {order_vec})" if order_vec else ".labplot_ordered_factor(.x_raw)"
    return f"""
{_ORDERED_FACTOR_R}{order_helper}
.plot <- df %>%
  dplyr::transmute(.x_raw = {_data(x)},
                   .value_raw = suppressWarnings(as.numeric({_data(y)})),
                   .series = factor({_data(group)})) %>%
  dplyr::filter(!is.na(.x_raw), !is.na(.value_raw), !is.na(.series)) %>%
  dplyr::group_by(.x_raw, .series) %>%
  dplyr::summarise(.value = {fun}(.value_raw, na.rm = TRUE), .groups = "drop") %>%
  dplyr::mutate(.x = {x_fac})
p <- ggplot(.plot, aes(x = .x, y = .value, fill = .series)) +
  geom_col(position = position_dodge(width = 0.76), width = {width}, alpha = 0.9,
           colour = "grey25", linewidth = 0.25) +
  scale_fill_manual(values = labplot_palette()) +
  {_labs(o, x, y)} + guides(fill = guide_legend(title = {rq(legend)}))
"""


def _overlap_bar(m, o):
    x = m["x"]
    y = m["y"]
    x2 = m.get("x2") or x
    y2 = m.get("y2")
    group = m.get("group")
    alpha = max(0.15, min(1.0, _num(o.get("bar_alpha"), 0.45)))
    width = max(0.2, min(1.0, _num(o.get("bar_width"), 0.75)))

    if y2:
        label1 = o.get("series_1_label") or y
        label2 = o.get("series_2_label") or y2
        if o.get("paired_rows_only", True):
            base = (
                f".base <- df %>% dplyr::filter(!is.na({_data(x)}), !is.na({_data(y)}), "
                f"!is.na({_data(x2)}), !is.na({_data(y2)}))\n"
            )
        else:
            base = ".base <- df\n"
        data_block = f"""
{base}.s1 <- .base %>%
  dplyr::transmute(.x = as.character({_data(x)}), .value = suppressWarnings(as.numeric({_data(y)})), .series = {rq(label1)})
.s2 <- .base %>%
  dplyr::transmute(.x = as.character({_data(x2)}), .value = suppressWarnings(as.numeric({_data(y2)})), .series = {rq(label2)})
.plot <- dplyr::bind_rows(.s1, .s2) %>%
  dplyr::filter(!is.na(.x), !is.na(.value)) %>%
  dplyr::mutate(.x_f = .labplot_ordered_factor(.x)) %>%
  dplyr::group_by(.x_f, .series) %>%
  dplyr::summarise(.value = sum(.value, na.rm = TRUE), .groups = "drop")
"""
    elif group:
        data_block = f"""
.plot <- df %>%
  dplyr::transmute(.x = as.character({_data(x)}), .value = suppressWarnings(as.numeric({_data(y)})), .series = factor({_data(group)})) %>%
  dplyr::filter(!is.na(.x), !is.na(.value), !is.na(.series)) %>%
  dplyr::mutate(.x_f = .labplot_ordered_factor(.x)) %>%
  dplyr::group_by(.x_f, .series) %>%
  dplyr::summarise(.value = sum(.value, na.rm = TRUE), .groups = "drop")
"""
    else:
        data_block = f"""
.plot <- df %>%
  dplyr::transmute(.x = as.character({_data(x)}), .value = suppressWarnings(as.numeric({_data(y)})), .series = {rq(y)}) %>%
  dplyr::filter(!is.na(.x), !is.na(.value)) %>%
  dplyr::mutate(.x_f = .labplot_ordered_factor(.x)) %>%
  dplyr::group_by(.x_f, .series) %>%
  dplyr::summarise(.value = sum(.value, na.rm = TRUE), .groups = "drop")
"""

    return f"""
{_ORDERED_FACTOR_R}
{data_block}
p <- ggplot(.plot, aes(x = .x_f, y = .value, fill = .series)) +
  geom_col(position = "identity", alpha = {alpha}, width = {width}, colour = "grey25", linewidth = 0.25) +
  scale_fill_manual(values = labplot_palette()) +
  {_labs(o, x, y)} + guides(fill = guide_legend(title = {rq(o.get("legend_title") or "Series")}))
"""


def _line(m, o):
    x, y = m["x"], m["y"]
    group = m.get("group")
    line_type = _choice(o.get("line_type"), _LINE_TYPES, "solid")
    point_shape = _choice(o.get("point_shape"), tuple(_POINT_SHAPES.keys()), "circle")
    point_r_shape = _POINT_SHAPES[point_shape]
    line_color = o.get("line_color") if isinstance(o.get("line_color"), str) and o.get("line_color") else None
    if group:
        aes = f"aes(x = {_data(x)}, y = {_data(y)}, colour = factor({_data(group)}), group = factor({_data(group)}))"
        scale = "  scale_colour_manual(values = labplot_palette()) +\n"
        guide = f" + guides(colour = guide_legend(title = {rq(group)}))"
        line_color_arg = ""
        point_color_arg = ""
    else:
        aes = f"aes(x = {_data(x)}, y = {_data(y)}, group = 1)"
        scale = ""
        guide = ""
        line_color_arg = f", colour = {rq(line_color)}" if line_color else ""
        point_color_arg = f", colour = {rq(line_color)}" if line_color else ""
    point_layer = "" if point_r_shape is None else f"  geom_point(size = 1.8, shape = {point_r_shape}{point_color_arg}) +\n"
    y2_pre, y2_post = _y2_axis(o, x, y, "line", grouped=bool(group))
    t_pre, t_post = _temporal_x(o, x)
    return f"""{t_pre}
{y2_pre}p <- ggplot(df, {aes}) +
  geom_line(linewidth = 0.35, linetype = {rq(line_type)}{line_color_arg}) +
{point_layer}{scale}  {_labs(o, x, y)}{guide}
{y2_post}{t_post}"""


def _histogram(m, o):
    value = m["value"]
    group = m.get("group")
    bins = int(_num(o.get("bins", 30), 30))
    bins = max(5, min(120, bins))
    density = bool(o.get("show_density", False))
    if group:
        aes = f"aes(x = {_data(value)}, fill = factor({_data(group)}))"
        scale = "  scale_fill_manual(values = labplot_palette()) +\n"
        guide = f" + guides(fill = guide_legend(title = {rq(group)}))"
        position = ', position = "identity"'
    else:
        aes = f"aes(x = {_data(value)})"
        scale = ""
        guide = ""
        position = ""
    density_layer = (
        f"  geom_density(aes(y = after_stat(count)), linewidth = 0.35, colour = \"grey20\", fill = NA) +\n"
        if density and not group else ""
    )
    fill_a = _alpha_r(o, "fill_alpha", "0.85")
    return f"""
p <- ggplot(df, {aes}) +
  geom_histogram(bins = {bins}, colour = "white", linewidth = 0.15, alpha = {fill_a}{position}) +
{density_layer}{scale}  {_labs(o, value, "count")}{guide}
"""


def _density(m, o):
    value = m["value"]
    group = m.get("group")
    rug = bool(o.get("show_rug", False))
    if group:
        aes = f"aes(x = {_data(value)}, colour = factor({_data(group)}), fill = factor({_data(group)}))"
        scale = "  scale_colour_manual(values = labplot_palette()) +\n  scale_fill_manual(values = labplot_palette()) +\n"
        guide = f" + guides(colour = guide_legend(title = {rq(group)}), fill = guide_legend(title = {rq(group)}))"
    else:
        aes = f"aes(x = {_data(value)})"
        scale = ""
        guide = ""
    rug_layer = "  geom_rug(alpha = 0.25, linewidth = 0.15) +\n" if rug else ""
    fill_a = _alpha_r(o, "fill_alpha", "0.28")
    return f"""
p <- ggplot(df, {aes}) +
  geom_density(alpha = {fill_a}, linewidth = 0.35) +
{rug_layer}{scale}  {_labs(o, value, "density")}{guide}
"""


def _correlation_heatmap(m, o):
    cols = m["columns"]
    if not isinstance(cols, list) or len(cols) < 2:
        raise ValueError("correlation heatmap requires at least 2 numeric columns")
    col_vec = "c(" + ", ".join(rq(c) for c in cols) + ")"
    method = o.get("corr_method", "pearson")
    if method not in ("pearson", "spearman"):
        method = "pearson"
    show_values = "TRUE" if o.get("show_values", True) else "FALSE"
    return f"""
.cols <- {col_vec}
.mat <- as.matrix(df[, .cols, drop = FALSE])
storage.mode(.mat) <- "double"
.cor <- stats::cor(.mat, use = "pairwise.complete.obs", method = {rq(method)})
.long <- as.data.frame(as.table(.cor))
colnames(.long) <- c("x", "y", "value")
.long$x <- factor(.long$x, levels = .cols)
.long$y <- factor(.long$y, levels = rev(.cols))
p <- ggplot(.long, aes(x = x, y = y, fill = value)) +
  geom_tile(colour = "white", linewidth = 0.2) +
  scale_fill_gradient2(low = "#4C6F91", mid = "white", high = "#B24745", midpoint = 0,
                       limits = c(-1, 1), name = "r") +
  {_labs(o, "", "")} +
  coord_equal() +
  theme(axis.text.x = element_text(angle = 45, hjust = 1),
        panel.grid = element_blank())
if ({show_values}) {{
  p <- p + geom_text(aes(label = sprintf("%.2f", value)), size = {_GEOM_TEXT_SIZE_7PT}, colour = "grey20")
}}
"""


def _heatmap(m, o):
    cols = m["columns"]
    if not isinstance(cols, list) or len(cols) < 1:
        raise ValueError("heatmap requires a non-empty 'columns' list")
    col_vec = "c(" + ", ".join(rq(c) for c in cols) + ")"
    row_label = m.get("row_label")
    if row_label:
        rowid = f'as.character(df[[{rq(row_label)}]])'
    else:
        rowid = "as.character(seq_len(nrow(df)))"
    scale_rows_on = bool(o.get("scale_rows", False))
    scale_rows = ""
    if scale_rows_on:
        scale_rows = ".mat <- t(scale(t(.mat)));\n"
    palette = _choice(o.get("palette"), _HEATMAP_OPTIONS, "blue_red")
    if o.get("color_mode") == "grayscale":
        fill_scale = 'scale_fill_gradient(low = "grey92", high = "grey15", na.value = "grey85")'
    elif palette == "blue_red":
        mp = _finite_num(o.get("color_midpoint"))
        if mp is not None:
            midpoint_r = f"{mp:g}"
        elif scale_rows_on:
            # z-scored data is already centred at 0
            midpoint_r = "0"
        else:
            # centre the diverging ramp on the data so all-positive matrices
            # are not squashed into a single hue
            midpoint_r = "stats::median(.long$value, na.rm = TRUE)"
        fill_scale = f'scale_fill_gradient2(low = "#4C6F91", mid = "white", high = "#B24745", midpoint = {midpoint_r}, na.value = "grey90")'
    else:
        fill_scale = f"scale_fill_viridis_c(option = {rq(palette)}, na.value = \"grey85\")"
    return f"""
.cols <- {col_vec}
.mat <- as.matrix(df[, .cols, drop = FALSE])
storage.mode(.mat) <- "double"
.rowid <- {rowid}
{scale_rows}.long <- data.frame(
  row = factor(rep(.rowid, times = ncol(.mat)), levels = rev(unique(.rowid))),
  col = factor(rep(.cols, each = nrow(.mat)), levels = .cols),
  value = as.vector(.mat)
)
p <- ggplot(.long, aes(x = col, y = row, fill = value)) +
  geom_tile(colour = "grey90", linewidth = 0.1) +
  {fill_scale} +
  {_labs(o, "", "")} +
  theme(axis.text.x = element_text(angle = 45, hjust = 1),
        axis.text.y = element_text(size = 7))
"""


def _volcano(m, o):
    lfc, pv = m["log2fc"], m["pvalue"]
    gene = m.get("gene_label")
    fc_t = _num(o.get("fc_threshold", 1.0), 1.0)
    p_t = _num(o.get("p_threshold", 0.05), 0.05)
    label_top = int(o.get("label_top", 10) or 0)
    label_block = ""
    if label_top > 0 and gene:
        label_block = f"""
.top <- .d[.d$.sig != "NS", ]
.top <- .top[order(-.top$.neglogp), ]
if (nrow(.top) > {label_top}) .top <- .top[1:{label_top}, ]
p <- p + geom_text(data = .top, aes(label = {_data(gene)}), size = {_GEOM_TEXT_SIZE_7PT}, vjust = -0.6, show.legend = FALSE)
"""
    return f"""
.d <- df
.d$.lfc <- as.numeric(.d[[{rq(lfc)}]])
.d$.p <- as.numeric(.d[[{rq(pv)}]])
.minp <- suppressWarnings(min(.d$.p[.d$.p > 0], na.rm = TRUE))
if (!is.finite(.minp)) .minp <- 1e-300
.d$.p[is.na(.d$.p) | .d$.p <= 0] <- .minp
.d$.neglogp <- -log10(.d$.p)
.d$.sig <- ifelse(.d$.p < {p_t} & abs(.d$.lfc) > {fc_t},
                  ifelse(.d$.lfc > 0, "Up", "Down"), "NS")
.d$.sig <- factor(.d$.sig, levels = c("Down", "NS", "Up"))
p <- ggplot(.d, aes(x = .lfc, y = .neglogp, colour = .sig)) +
  geom_point(alpha = 0.75, size = 1.6) +
  {'scale_colour_manual(values = c(Down = "grey60", NS = "grey85", Up = "black"))' if o.get("color_mode") == "grayscale" else 'scale_colour_manual(values = c(Down = "#6C9EB3", NS = "grey70", Up = "#B24745"))'} +
  geom_vline(xintercept = c(-{fc_t}, {fc_t}), linetype = "dashed", colour = "grey50", linewidth = 0.25) +
  geom_hline(yintercept = -log10({p_t}), linetype = "dashed", colour = "grey50", linewidth = 0.25) +
  {_labs(o, "log2 fold change", "-log10(p-value)")} +
  guides(colour = guide_legend(title = NULL))
{label_block}"""


def _pca(m, o):
    cols = m["columns"]
    col_vec = "c(" + ", ".join(rq(c) for c in cols) + ")"
    color = m.get("color")
    if color:
        color_block = f"""
.scores$grp <- factor(df[[{rq(color)}]][.ok])
p <- ggplot(.scores, aes(x = PC1, y = PC2, colour = grp)) +
  geom_point(size = 2.4, alpha = 0.85) +
  scale_colour_manual(values = labplot_palette()) +
  guides(colour = guide_legend(title = {rq(color)})) +
"""
    else:
        color_block = """
p <- ggplot(.scores, aes(x = PC1, y = PC2)) +
  geom_point(size = 2.4, alpha = 0.85, colour = "#4C6F91") +
"""
    title = rq(o.get("title")) if o.get("title") else "NULL"
    return f"""
.cols <- {col_vec}
.X <- as.matrix(df[, .cols, drop = FALSE])
storage.mode(.X) <- "double"
.ok <- stats::complete.cases(.X)
.X <- .X[.ok, , drop = FALSE]
.keep <- apply(.X, 2, function(z) stats::sd(z, na.rm = TRUE) > 0)
.X <- .X[, .keep, drop = FALSE]
if (ncol(.X) < 2) stop("PCA needs at least 2 numeric columns with variance")
.pc <- stats::prcomp(.X, center = TRUE, scale. = TRUE)
.var <- (.pc$sdev^2) / sum(.pc$sdev^2) * 100
.scores <- as.data.frame(.pc$x[, 1:2, drop = FALSE])
colnames(.scores) <- c("PC1", "PC2")
{color_block}  labs(title = {title},
       x = sprintf("PC1 (%.1f%%)", .var[1]),
       y = sprintf("PC2 (%.1f%%)", .var[2]))
"""


def _kaplan_meier(m, o):
    time, status = m["time"], m["status"]
    group = m.get("group")
    grp_line = (
        f'.grp <- as.character(df[[{rq(group)}]])'
        if group else
        '.grp <- rep("All", nrow(df))'
    )
    legend = "none" if not group else "right"
    return f"""
.time <- suppressWarnings(as.numeric(df[[{rq(time)}]]))
.sv <- tolower(trimws(as.character(df[[{rq(status)}]])))
.status <- as.integer(.sv %in% c("1", "1.0", "dead", "deceased", "event", "yes", "true", "relapse", "recurred"))
{grp_line}
.ok <- !is.na(.time)
.time <- .time[.ok]; .status <- .status[.ok]; .grp <- .grp[.ok]

km_one <- function(tt, ss) {{
  ev_times <- sort(unique(tt[ss == 1]))
  res_t <- c(0); res_s <- c(1); sp <- 1
  for (t in ev_times) {{
    at_risk <- sum(tt >= t)
    d <- sum(tt == t & ss == 1)
    if (at_risk > 0) sp <- sp * (1 - d / at_risk)
    res_t <- c(res_t, t); res_s <- c(res_s, sp)
  }}
  data.frame(time = res_t, surv = res_s)
}}

.curves <- do.call(rbind, lapply(unique(.grp), function(g) {{
  idx <- .grp == g
  cur <- km_one(.time[idx], .status[idx])
  cur$grp <- g
  cur
}}))

p <- ggplot(.curves, aes(x = time, y = surv, colour = factor(grp))) +
  geom_step(linewidth = 0.35) +
  scale_colour_manual(values = labplot_palette()) +
  coord_cartesian(ylim = c(0, 1)) +
  {_labs(o, "Time", "Survival probability")} +
  guides(colour = guide_legend(title = {rq(group) if group else 'NULL'})) +
  theme(legend.position = "{legend}")
"""


def _error_bar(m, o):
    x, y = m["x"], m["y"]
    group = m.get("group")
    ymin, ymax, err = m.get("ymin"), m.get("ymax"), m.get("error")
    grp_expr = f"factor({_col(group)})" if group else 'factor("All")'
    guide = f" + guides(colour = guide_legend(title = {rq(group)}))" if group else ' + guides(colour = "none")'
    connect = "TRUE" if o.get("connect_points", True) else "FALSE"
    if ymin and ymax:
        interval_block = f"""
.plot <- df %>%
  dplyr::mutate(.x_raw = {_col(x)}, .y = suppressWarnings(as.numeric({_col(y)})),
                .ymin = suppressWarnings(as.numeric({_col(ymin)})),
                .ymax = suppressWarnings(as.numeric({_col(ymax)})), .grp = {grp_expr})
"""
    elif err:
        interval_block = f"""
.plot <- df %>%
  dplyr::mutate(.x_raw = {_col(x)}, .y = suppressWarnings(as.numeric({_col(y)})),
                .error = suppressWarnings(as.numeric({_col(err)})),
                .ymin = .y - .error, .ymax = .y + .error, .grp = {grp_expr})
"""
    else:
        interval_block = f"""
.plot <- df %>%
  dplyr::mutate(.x_raw = {_col(x)}, .y_raw = suppressWarnings(as.numeric({_col(y)})), .grp = {grp_expr}) %>%
  dplyr::group_by(.x_raw, .grp) %>%
  dplyr::summarise(.y = mean(.y_raw, na.rm = TRUE),
                   .sd = stats::sd(.y_raw, na.rm = TRUE), .n = dplyr::n(), .groups = "drop") %>%
  dplyr::mutate(.sd = ifelse(is.na(.sd), 0, .sd), .ymin = .y - .sd, .ymax = .y + .sd)
"""
    return f"""
{interval_block}
.plot <- .plot[stats::complete.cases(.plot[, c(".y", ".ymin", ".ymax")]), ]
.plot$.x <- if (is.numeric(.plot$.x_raw) || inherits(.plot$.x_raw, "Date")) .plot$.x_raw else factor(as.character(.plot$.x_raw), levels = unique(as.character(.plot$.x_raw)))
.err_width <- if (is.numeric(.plot$.x)) diff(range(.plot$.x, na.rm = TRUE)) * 0.015 else 0.15
if (!is.finite(.err_width) || .err_width <= 0) .err_width <- 0.15
p <- ggplot(.plot, aes(x = .x, y = .y, colour = .grp, group = .grp)) +
  geom_errorbar(aes(ymin = .ymin, ymax = .ymax), width = .err_width,
                linewidth = 0.35, position = position_dodge(width = 0.35)) +
  geom_point(size = 1.8, position = position_dodge(width = 0.35)) +
  scale_colour_manual(values = labplot_palette()) +
  {_labs(o, x, y)}{guide}
if ({connect}) {{
  p <- p + geom_line(linewidth = 0.35, position = position_dodge(width = 0.35))
}}
"""


def _ribbon(m, o):
    x, y = m["x"], m["y"]
    group = m.get("group")
    ymin, ymax = m.get("ymin"), m.get("ymax")
    grp_expr = f"factor({_col(group)})" if group else 'factor("All")'
    guide = f" + guides(colour = guide_legend(title = {rq(group)}), fill = guide_legend(title = {rq(group)}))" if group else ' + guides(colour = "none", fill = "none")'
    if ymin and ymax:
        interval_block = f"""
.plot <- df %>%
  dplyr::mutate(.x = {_col(x)}, .y = suppressWarnings(as.numeric({_col(y)})),
                .ymin = suppressWarnings(as.numeric({_col(ymin)})),
                .ymax = suppressWarnings(as.numeric({_col(ymax)})), .grp = {grp_expr})
"""
    else:
        interval_block = f"""
.plot <- df %>%
  dplyr::mutate(.x = {_col(x)}, .y_raw = suppressWarnings(as.numeric({_col(y)})), .grp = {grp_expr}) %>%
  dplyr::group_by(.x, .grp) %>%
  dplyr::summarise(.y = mean(.y_raw, na.rm = TRUE),
                   .sd = stats::sd(.y_raw, na.rm = TRUE), .n = dplyr::n(), .groups = "drop") %>%
  dplyr::mutate(.sd = ifelse(is.na(.sd), 0, .sd), .se = .sd / sqrt(pmax(.n, 1)),
                .ymin = .y - .se, .ymax = .y + .se)
"""
    return f"""
{interval_block}
.plot <- .plot[stats::complete.cases(.plot[, c(".x", ".y", ".ymin", ".ymax")]), ]
.plot <- .plot[order(.plot$.grp, .plot$.x), ]
p <- ggplot(.plot, aes(x = .x, y = .y, colour = .grp, fill = .grp, group = .grp)) +
  geom_ribbon(aes(ymin = .ymin, ymax = .ymax), alpha = 0.18, colour = NA) +
  geom_line(linewidth = 0.35) +
  scale_colour_manual(values = labplot_palette()) +
  scale_fill_manual(values = labplot_palette()) +
  {_labs(o, x, y)}{guide}
"""


def _contour(m, o):
    x, y, z = m["x"], m["y"], m["z"]
    bins = int(_num(o.get("bins", 10), 10))
    bins = max(3, min(40, bins))
    palette = _choice(o.get("palette"), _VIRIDIS_OPTIONS, "viridis")
    show_lines = "TRUE" if o.get("show_contour_lines", True) else "FALSE"
    return f"""
.plot <- data.frame(
  .x = suppressWarnings(as.numeric({_col(x)})),
  .y = suppressWarnings(as.numeric({_col(y)})),
  .z = suppressWarnings(as.numeric({_col(z)}))
)
.plot <- .plot[stats::complete.cases(.plot), ]
if (length(unique(.plot$.x)) < 2 || length(unique(.plot$.y)) < 2) stop("Contour plot needs at least two unique x and y values")
p <- ggplot(.plot, aes(x = .x, y = .y, z = .z)) +
  geom_contour_filled(bins = {bins}, alpha = 0.92) +
  scale_fill_viridis_d(option = {rq(palette)}, name = {rq(z)}) +
  coord_equal(expand = FALSE) +
  {_labs(o, x, y)}
if ({show_lines}) {{
  p <- p + geom_contour(bins = {bins}, colour = "black", linewidth = 0.18, alpha = 0.55)
}}
"""


def _radar(m, o):
    axis, value = m["axis"], m["value"]
    group = m.get("group")
    grp_expr = f"factor({_col(group)})" if group else 'factor("All")'
    guide = f" + guides(colour = guide_legend(title = {rq(group)}), fill = guide_legend(title = {rq(group)}))" if group else ' + guides(colour = "none", fill = "none")'
    return f"""
.axis_levels <- unique(as.character({_col(axis)}))
.plot <- data.frame(
  .axis = factor(as.character({_col(axis)}), levels = .axis_levels),
  .value = suppressWarnings(as.numeric({_col(value)})),
  .grp = {grp_expr}
)
.plot <- .plot[stats::complete.cases(.plot), ]
.plot <- .plot[order(.plot$.grp, .plot$.axis), ]
.closed <- do.call(rbind, lapply(split(.plot, .plot$.grp), function(d) rbind(d, d[1, , drop = FALSE])))
p <- ggplot(.closed, aes(x = .axis, y = .value, group = .grp, colour = .grp, fill = .grp)) +
  geom_polygon(alpha = 0.12, linewidth = 0.35) +
  geom_point(size = 1.6) +
  scale_colour_manual(values = labplot_palette()) +
  scale_fill_manual(values = labplot_palette()) +
  scale_y_continuous(limits = c(0, NA)) +
  coord_polar() +
  {_labs(o, axis, value)}{guide}
"""


_BUILDERS = {
    "box": _box,
    "violin": _violin,
    "scatter": _scatter,
    "bar": _bar,
    "grouped_bar": _grouped_bar,
    "overlap_bar": _overlap_bar,
    "line": _line,
    "error_bar": _error_bar,
    "ribbon": _ribbon,
    "contour": _contour,
    "radar": _radar,
    "histogram": _histogram,
    "density": _density,
    "correlation_heatmap": _correlation_heatmap,
    "heatmap": _heatmap,
    "volcano": _volcano,
    "pca": _pca,
    "kaplan_meier": _kaplan_meier,
}


# plot-type registry exposed via /api/plot-types
PLOT_TYPES = [
    {"type": "box", "label": "Box plot",
     "required": [{"key": "x", "label": "Group (X)", "roles": ["group", "category", "status"]},
                  {"key": "y", "label": "Value (Y)", "roles": ["numeric", "log2fc", "pvalue"]}],
     "optional": [{"key": "color", "label": "Color by", "roles": ["group", "category", "status"]}],
     "options": [{"key": "show_points", "label": "Show points", "type": "bool", "default": True},
                 {"key": "show_n", "label": "Show sample size (n)", "type": "bool", "default": False},
                 {"key": "show_significance", "label": "Significance brackets", "type": "bool", "default": False}]},
    {"type": "violin", "label": "Violin plot",
     "required": [{"key": "x", "label": "Group (X)", "roles": ["group", "category", "status"]},
                  {"key": "y", "label": "Value (Y)", "roles": ["numeric", "log2fc", "pvalue"]}],
     "optional": [{"key": "color", "label": "Color by", "roles": ["group", "category", "status"]}],
     "options": [{"key": "show_box", "label": "Inner boxplot", "type": "bool", "default": True},
                 {"key": "show_points", "label": "Show points", "type": "bool", "default": False},
                 {"key": "show_n", "label": "Show sample size (n)", "type": "bool", "default": False},
                 {"key": "show_significance", "label": "Significance brackets", "type": "bool", "default": False}]},
    {"type": "scatter", "label": "Scatter plot",
     "required": [{"key": "x", "label": "X (numeric)", "roles": ["numeric", "log2fc", "pvalue", "time"]},
                  {"key": "y", "label": "Y (numeric)", "roles": ["numeric", "log2fc", "pvalue"]}],
     "optional": [{"key": "color", "label": "Color by", "roles": ["group", "category", "status"]}],
     "options": [{"key": "add_smooth", "label": "Regression line", "type": "bool", "default": False},
                 {"key": "show_fit_stats", "label": "Show fit stats (R², slope)", "type": "bool", "default": False},
                 {"key": "y2_column", "label": "Secondary Y column", "type": "text", "default": ""},
                 {"key": "y2_label", "label": "Secondary Y-axis label", "type": "text", "default": ""},
                 {"key": "x_min", "label": "X-axis minimum", "type": "number", "default": None},
                 {"key": "x_max", "label": "X-axis maximum", "type": "number", "default": None},
                 {"key": "y_min", "label": "Y-axis minimum", "type": "number", "default": None},
                 {"key": "y_max", "label": "Y-axis maximum", "type": "number", "default": None}]},
    {"type": "bar", "label": "Bar plot",
     "required": [{"key": "x", "label": "Category / bin (X)", "roles": ["group", "category", "status", "numeric", "time"]}],
     "optional": [{"key": "y", "label": "Value (Y)", "roles": ["numeric", "log2fc"]}],
     "options": [{"key": "stat", "label": "Statistic", "type": "select", "choices": ["mean", "sum", "count"], "default": "mean"},
                 {"key": "error_bars", "label": "Error bars", "type": "bool", "default": True},
                 {"key": "error_type", "label": "Error bar type", "type": "select", "choices": ["sd", "se", "ci95"], "default": "sd"},
                 {"key": "color_bars", "label": "Color bars by category", "type": "bool", "default": False},
                 {"key": "show_n", "label": "Show sample size (n)", "type": "bool", "default": False},
                 {"key": "show_significance", "label": "Significance brackets", "type": "bool", "default": False}]},
    {"type": "grouped_bar", "label": "Grouped bar chart",
     "required": [{"key": "x", "label": "Category / benchmark (X)", "roles": ["group", "category", "status", "time", "numeric"]},
                  {"key": "y", "label": "Value / score (Y)", "roles": ["numeric", "log2fc"]},
                  {"key": "group", "label": "Series / method", "roles": ["group", "category", "status"]}],
     "optional": [],
     "options": [{"key": "stat", "label": "Statistic", "type": "select", "choices": ["mean", "sum"], "default": "mean"},
                 {"key": "bar_width", "label": "Bar width", "type": "number", "default": 0.68}]},
    {"type": "overlap_bar", "label": "Overlapped bar chart",
     "required": [{"key": "x", "label": "X / bin", "roles": ["numeric", "group", "category", "time"]},
                  {"key": "y", "label": "Value / count", "roles": ["numeric"]}],
     "optional": [{"key": "x2", "label": "Second X / bin", "roles": ["numeric", "group", "category", "time"]},
                  {"key": "y2", "label": "Second value / count", "roles": ["numeric"]},
                  {"key": "group", "label": "Series / group", "roles": ["group", "category", "status"]}],
     "options": [{"key": "bar_alpha", "label": "Bar transparency", "type": "number", "default": 0.45},
                 {"key": "bar_width", "label": "Bar width", "type": "number", "default": 0.75},
                 {"key": "paired_rows_only", "label": "Use only paired rows", "type": "bool", "default": True},
                 {"key": "series_1_label", "label": "First series label", "type": "text", "default": ""},
                 {"key": "series_2_label", "label": "Second series label", "type": "text", "default": ""}]},
    {"type": "line", "label": "Line plot",
     "required": [{"key": "x", "label": "X (time/order)", "roles": ["time", "numeric", "category"]},
                  {"key": "y", "label": "Y (numeric)", "roles": ["numeric"]}],
     "optional": [{"key": "group", "label": "Group/Color", "roles": ["group", "category", "status"]}],
     "options": [{"key": "line_type", "label": "Line type", "type": "select",
                 "choices": list(_LINE_TYPES), "default": "solid"},
                 {"key": "point_shape", "label": "Point shape", "type": "select",
                  "choices": list(_POINT_SHAPES.keys()), "default": "circle"},
                 {"key": "line_color", "label": "Line color", "type": "text", "default": ""},
                 {"key": "y2_column", "label": "Secondary Y column", "type": "text", "default": ""},
                 {"key": "y2_label", "label": "Secondary Y-axis label", "type": "text", "default": ""},
                 {"key": "x_min", "label": "X-axis minimum", "type": "number", "default": None},
                 {"key": "x_max", "label": "X-axis maximum", "type": "number", "default": None},
                 {"key": "y_min", "label": "Y-axis minimum", "type": "number", "default": None},
                 {"key": "y_max", "label": "Y-axis maximum", "type": "number", "default": None}]},
    {"type": "error_bar", "label": "Error bar plot",
     "required": [{"key": "x", "label": "X (group/time)", "roles": ["group", "category", "time", "numeric"]},
                  {"key": "y", "label": "Mean / value", "roles": ["numeric"]}],
     "optional": [{"key": "group", "label": "Series / group", "roles": ["group", "category", "status"]},
                  {"key": "ymin", "label": "Lower bound", "roles": ["numeric"]},
                  {"key": "ymax", "label": "Upper bound", "roles": ["numeric"]},
                  {"key": "error", "label": "Symmetric error", "roles": ["numeric"]}],
     "options": [{"key": "connect_points", "label": "Connect points", "type": "bool", "default": True}]},
    {"type": "ribbon", "label": "Ribbon / interval plot",
     "required": [{"key": "x", "label": "X (time/order)", "roles": ["time", "numeric"]},
                  {"key": "y", "label": "Mean / value", "roles": ["numeric"]}],
     "optional": [{"key": "group", "label": "Series / group", "roles": ["group", "category", "status"]},
                  {"key": "ymin", "label": "Lower bound", "roles": ["numeric"]},
                  {"key": "ymax", "label": "Upper bound", "roles": ["numeric"]}],
     "options": []},
    {"type": "contour", "label": "Contour / response surface",
     "required": [{"key": "x", "label": "X coordinate", "roles": ["numeric"]},
                  {"key": "y", "label": "Y coordinate", "roles": ["numeric"]},
                  {"key": "z", "label": "Response / Z", "roles": ["numeric"]}],
     "optional": [],
     "options": [{"key": "bins", "label": "Contour levels", "type": "number", "default": 10},
                 {"key": "show_contour_lines", "label": "Contour lines", "type": "bool", "default": True},
                 {"key": "palette", "label": "Palette", "type": "select", "choices": ["viridis", "magma", "inferno", "plasma", "cividis"], "default": "viridis"}]},
    {"type": "radar", "label": "Radar / polar plot",
     "required": [{"key": "axis", "label": "Axis / metric", "roles": ["group", "category", "text"]},
                  {"key": "value", "label": "Value", "roles": ["numeric"]}],
     "optional": [{"key": "group", "label": "Series / group", "roles": ["group", "category", "status"]}],
     "options": []},
    {"type": "histogram", "label": "Histogram",
     "required": [{"key": "value", "label": "Value", "roles": ["numeric", "log2fc", "pvalue"]}],
     "optional": [{"key": "group", "label": "Group/Fill", "roles": ["group", "category", "status"]}],
     "options": [{"key": "bins", "label": "Bins", "type": "number", "default": 30},
                 {"key": "show_density", "label": "Density overlay", "type": "bool", "default": False}]},
    {"type": "density", "label": "Density plot",
     "required": [{"key": "value", "label": "Value", "roles": ["numeric", "log2fc", "pvalue"]}],
     "optional": [{"key": "group", "label": "Group/Color", "roles": ["group", "category", "status"]}],
     "options": [{"key": "show_rug", "label": "Rug marks", "type": "bool", "default": False}]},
    {"type": "correlation_heatmap", "label": "Correlation heatmap",
     "required": [{"key": "columns", "label": "Numeric columns", "roles": ["numeric", "log2fc", "pvalue"], "multi": True}],
     "optional": [],
     "options": [{"key": "corr_method", "label": "Correlation", "type": "select", "choices": ["pearson", "spearman"], "default": "pearson"},
                 {"key": "show_values", "label": "Show r values", "type": "bool", "default": True}]},
    {"type": "heatmap", "label": "Heatmap",
     "required": [{"key": "columns", "label": "Value columns (matrix)", "roles": ["numeric", "log2fc", "pvalue"], "multi": True}],
     "optional": [{"key": "row_label", "label": "Row label", "roles": ["gene", "category", "text", "group"]}],
     "options": [{"key": "scale_rows", "label": "Z-score rows", "type": "bool", "default": False},
                 {"key": "palette", "label": "Palette", "type": "select", "choices": ["blue_red", "viridis", "magma", "inferno", "plasma", "cividis"], "default": "blue_red"},
                 {"key": "color_midpoint", "label": "Diverging midpoint (blue-red)", "type": "number", "default": None}]},
    {"type": "volcano", "label": "Volcano plot",
     "required": [{"key": "log2fc", "label": "log2 fold-change", "roles": ["log2fc", "numeric"]},
                  {"key": "pvalue", "label": "p-value / padj", "roles": ["pvalue", "numeric"]}],
     "optional": [{"key": "gene_label", "label": "Gene label", "roles": ["gene", "text", "category"]}],
     "options": [{"key": "fc_threshold", "label": "log2FC threshold", "type": "number", "default": 1.0},
                 {"key": "p_threshold", "label": "p threshold", "type": "number", "default": 0.05},
                 {"key": "label_top", "label": "Label top N", "type": "number", "default": 10}]},
    {"type": "pca", "label": "PCA plot",
     "required": [{"key": "columns", "label": "Feature columns", "roles": ["numeric", "log2fc"], "multi": True}],
     "optional": [{"key": "color", "label": "Color by group", "roles": ["group", "category", "status"]}],
     "options": []},
    {"type": "kaplan_meier", "label": "Kaplan-Meier plot",
     "required": [{"key": "time", "label": "Time", "roles": ["time", "numeric"]},
                  {"key": "status", "label": "Status/Event", "roles": ["status", "group", "numeric"]}],
     "optional": [{"key": "group", "label": "Group", "roles": ["group", "category", "status"]}],
     "options": []},
]

PLOT_TYPE_KEYS = {p["type"] for p in PLOT_TYPES}


# ================================================================
# Universal capabilities (review-2026-07): annotations, data labels,
# axis controls, per-series style overrides. Applied in the shared
# post-processing path after `p` exists, before the theme is appended.
# ================================================================

# Common ggplot plot types that receive the universal layers. Device- and
# no-theme types (network, 3D, ComplexHeatmap, ...) are intentionally excluded.
_UNIVERSAL_TYPES = {
    "scatter", "line", "bar", "grouped_bar", "error_bar",
    "box", "violin", "histogram", "area", "lollipop", "dot_plot",
}

# Which axes are genuinely continuous per template (so scale_*_continuous is
# safe). Axes that are discrete/categorical for a given type are omitted.
_AXIS_CONT = {
    "scatter": ("x", "y"),
    "line": ("y",),          # x may be time/category -> skip to avoid breakage
    "histogram": ("x", "y"),
    "area": ("x", "y"),
    "bar": ("y",),
    "grouped_bar": ("y",),
    "error_bar": ("y",),
    "box": ("y",),
    "violin": ("y",),
    "lollipop": ("y",),
    "dot_plot": ("x",),      # dot plot maps value -> x, category -> y
}

_ANNOTATION_TEXT_DEFAULT = "grey20"
_ANNOTATION_MARK_DEFAULT = "#DC2626"


def _hex_color_r(value, default: str) -> str:
    """R-quoted colour: the user's #RRGGBB when valid, else ``default``."""
    if isinstance(value, str) and _HEX_COLOR_RE.fullmatch(value.strip()):
        return rq(value.strip().upper())
    return rq(default)


def _relative_annotation(kind, a) -> list[str]:
    """``annotation_custom`` grob layer(s) for a PANEL-relative (npc) item.

    x/y (and x2/y2) are ``_finite_num`` clamped to [0, 1] npc; text via
    ``rq()``; colours via the hex validator (falling back to the defaults).
    Returns [] for invalid items. Grobs are ``grid::`` qualified so no extra
    ``library(grid)`` line is needed, and ``annotation_custom`` keeps ``p`` a
    normal ggplot layer (composes with the later theme and even ggplotly).
    """
    def _cust(grob):
        return f'annotation_custom({grob}, xmin = -Inf, xmax = Inf, ymin = -Inf, ymax = Inf)'

    if kind == "text":
        rx = _clamp01(a.get("x")); ry = _clamp01(a.get("y"))
        text = a.get("text")
        if rx is None or ry is None or not isinstance(text, str) or text == "":
            return []
        size = _finite_num(a.get("size"))
        size_mm = max(1.0, min(20.0, size)) if size is not None else _GEOM_TEXT_SIZE_7PT
        fontsize = size_mm * _GGPLOT_PT
        colour = _hex_color_r(a.get("color"), _ANNOTATION_TEXT_DEFAULT)
        grob = (f'grid::textGrob({rq(text)}, x = grid::unit({rx:g}, "npc"), '
                f'y = grid::unit({ry:g}, "npc"), '
                f'gp = grid::gpar(col = {colour}, fontsize = {fontsize:g}))')
        return [_cust(grob)]

    if kind == "arrow":
        rx = _clamp01(a.get("x")); ry = _clamp01(a.get("y"))
        rx2 = _clamp01(a.get("x2")); ry2 = _clamp01(a.get("y2"))
        if None in (rx, ry, rx2, ry2):
            return []
        colour = _hex_color_r(a.get("color"), _ANNOTATION_MARK_DEFAULT)
        grob = (f'grid::segmentsGrob(x0 = grid::unit({rx:g}, "npc"), y0 = grid::unit({ry:g}, "npc"), '
                f'x1 = grid::unit({rx2:g}, "npc"), y1 = grid::unit({ry2:g}, "npc"), '
                f'arrow = grid::arrow(length = grid::unit(0.02, "npc")), '
                f'gp = grid::gpar(col = {colour}, lwd = 1.2))')
        return [_cust(grob)]

    if kind == "rect":
        rx = _clamp01(a.get("x")); ry = _clamp01(a.get("y"))
        rx2 = _clamp01(a.get("x2")); ry2 = _clamp01(a.get("y2"))
        if None in (rx, ry, rx2, ry2):
            return []
        colour = _hex_color_r(a.get("color"), _ANNOTATION_MARK_DEFAULT)
        cx = (rx + rx2) / 2; cy = (ry + ry2) / 2
        w = abs(rx2 - rx); h = abs(ry2 - ry)
        grob = (f'grid::rectGrob(x = grid::unit({cx:g}, "npc"), y = grid::unit({cy:g}, "npc"), '
                f'width = grid::unit({w:g}, "npc"), height = grid::unit({h:g}, "npc"), '
                f'gp = grid::gpar(fill = {colour}, alpha = 0.12, col = NA))')
        return [_cust(grob)]

    if kind == "bracket":
        rx = _clamp01(a.get("x")); rx2 = _clamp01(a.get("x2")); ry = _clamp01(a.get("y"))
        if None in (rx, rx2, ry):
            return []
        colour = _hex_color_r(a.get("color"), _ANNOTATION_TEXT_DEFAULT)
        y_tick = max(0.0, ry - 0.02)      # small downward end ticks (npc)
        cx = (rx + rx2) / 2
        parts = [
            f'grid::segmentsGrob(x0 = grid::unit({rx:g}, "npc"), y0 = grid::unit({ry:g}, "npc"), '
            f'x1 = grid::unit({rx2:g}, "npc"), y1 = grid::unit({ry:g}, "npc"), '
            f'gp = grid::gpar(col = {colour}, lwd = 1))',
            f'grid::segmentsGrob(x0 = grid::unit({rx:g}, "npc"), y0 = grid::unit({ry:g}, "npc"), '
            f'x1 = grid::unit({rx:g}, "npc"), y1 = grid::unit({y_tick:g}, "npc"), '
            f'gp = grid::gpar(col = {colour}, lwd = 1))',
            f'grid::segmentsGrob(x0 = grid::unit({rx2:g}, "npc"), y0 = grid::unit({ry:g}, "npc"), '
            f'x1 = grid::unit({rx2:g}, "npc"), y1 = grid::unit({y_tick:g}, "npc"), '
            f'gp = grid::gpar(col = {colour}, lwd = 1))',
        ]
        label = a.get("label")
        if isinstance(label, str) and label != "":
            label_y = min(1.0, ry + 0.03)
            fontsize = _GEOM_TEXT_SIZE_7PT * _GGPLOT_PT
            parts.append(
                f'grid::textGrob({rq(label)}, x = grid::unit({cx:g}, "npc"), '
                f'y = grid::unit({label_y:g}, "npc"), '
                f'gp = grid::gpar(col = {colour}, fontsize = {fontsize:g}))')
        grob = "grid::grobTree(" + ", ".join(parts) + ")"
        return [_cust(grob)]

    return []


def _annotations_layer(o) -> str:
    """`+ annotate(...)` / `annotation_custom(...)` layers for annotations.

    Each item is a sanitized dict; unknown/invalid items are skipped. An
    optional ``coord`` field selects the coordinate space: ``"data"`` (default)
    uses ``annotate()`` in data coordinates; ``"relative"`` renders grid grobs
    in 0..1 PANEL-relative npc coordinates via ``annotation_custom``. Numbers
    go through ``_finite_num``, text through ``rq()``, colours through the hex
    validator. Returns "" when there are no valid annotations.
    """
    anns = o.get("annotations")
    if not isinstance(anns, list) or not anns:
        return ""
    layers: list[str] = []
    for a in anns:
        if not isinstance(a, dict):
            continue
        kind = a.get("kind")
        if a.get("coord") == "relative":
            layers.extend(_relative_annotation(kind, a))
            continue
        if kind == "text":
            x = _finite_num(a.get("x"))
            y = _finite_num(a.get("y"))
            text = a.get("text")
            if x is None or y is None or not isinstance(text, str) or text == "":
                continue
            size = _finite_num(a.get("size"))
            size_r = f"{max(1.0, min(20.0, size)):g}" if size is not None else f"{_GEOM_TEXT_SIZE_7PT}"
            colour = _hex_color_r(a.get("color"), _ANNOTATION_TEXT_DEFAULT)
            layers.append(
                f'annotate("text", x = {x:g}, y = {y:g}, label = {rq(text)}, '
                f'size = {size_r}, colour = {colour})'
            )
        elif kind == "arrow":
            x = _finite_num(a.get("x"))
            y = _finite_num(a.get("y"))
            x2 = _finite_num(a.get("x2"))
            y2 = _finite_num(a.get("y2"))
            if None in (x, y, x2, y2):
                continue
            colour = _hex_color_r(a.get("color"), _ANNOTATION_MARK_DEFAULT)
            layers.append(
                f'annotate("segment", x = {x:g}, y = {y:g}, xend = {x2:g}, yend = {y2:g}, '
                f'arrow = grid::arrow(length = grid::unit(0.02, "npc")), '
                f'colour = {colour}, linewidth = 0.4)'
            )
        elif kind == "rect":
            x = _finite_num(a.get("x"))
            y = _finite_num(a.get("y"))
            x2 = _finite_num(a.get("x2"))
            y2 = _finite_num(a.get("y2"))
            if None in (x, y, x2, y2):
                continue
            colour = _hex_color_r(a.get("color"), _ANNOTATION_MARK_DEFAULT)
            layers.append(
                f'annotate("rect", xmin = {min(x, x2):g}, xmax = {max(x, x2):g}, '
                f'ymin = {min(y, y2):g}, ymax = {max(y, y2):g}, alpha = 0.12, fill = {colour})'
            )
        elif kind == "bracket":
            x = _finite_num(a.get("x"))
            x2 = _finite_num(a.get("x2"))
            y = _finite_num(a.get("y"))
            if None in (x, x2, y):
                continue
            colour = _hex_color_r(a.get("color"), _ANNOTATION_TEXT_DEFAULT)
            tick = abs(y) * 0.03  # small downward ticks, scaled to the height
            y_tick = y - tick
            layers.append(
                f'annotate("segment", x = {x:g}, xend = {x2:g}, y = {y:g}, yend = {y:g}, '
                f'colour = {colour}, linewidth = 0.3)'
            )
            layers.append(
                f'annotate("segment", x = {x:g}, xend = {x:g}, y = {y:g}, yend = {y_tick:g}, '
                f'colour = {colour}, linewidth = 0.3)'
            )
            layers.append(
                f'annotate("segment", x = {x2:g}, xend = {x2:g}, y = {y:g}, yend = {y_tick:g}, '
                f'colour = {colour}, linewidth = 0.3)'
            )
            label = a.get("label")
            if isinstance(label, str) and label != "":
                layers.append(
                    f'annotate("text", x = {(x + x2) / 2:g}, y = {y:g}, label = {rq(label)}, '
                    f'vjust = -0.3, size = {_GEOM_TEXT_SIZE_7PT}, colour = {colour})'
                )
    if not layers:
        return ""
    return "\np <- p +\n  " + " +\n  ".join(layers) + "\n"


def _data_label_fmt_expr(o, val_expr: str) -> str:
    fmt = _choice(o.get("data_label_format"), ("number", "percent", "comma"), "number")
    if fmt == "percent":
        return f'sprintf("%.1f%%", ({val_expr}) * 100)'
    if fmt == "comma":
        return f'format(round({val_expr}), big.mark = ",", trim = TRUE, scientific = FALSE)'
    return f'sprintf("%.2f", {val_expr})'


def _data_labels_layer(plot_type: str, m, o) -> str:
    """geom_text value labels for ``show_data_labels`` (opt-in, default off).

    Applied on plots with a y aesthetic; skipped when it would collide with the
    existing n= / value layers (``show_n`` / ``show_values``).
    """
    if not o.get("show_data_labels"):
        return ""
    if o.get("show_n") or o.get("show_values"):
        return ""
    if plot_type == "bar":
        stat = o.get("stat", m.get("stat", "mean"))
        if stat == "count" or not m.get("y"):
            return ""  # count bars have no scalar value column to label
        val, kind = ".val", "col"
    elif plot_type == "grouped_bar":
        val, kind = ".value", "dodge"
    elif plot_type == "error_bar":
        val, kind = ".y", "point"
    elif plot_type == "lollipop":
        val, kind = ".val", "col"
    elif plot_type in ("scatter", "line"):
        y = m.get("y")
        if not y:
            return ""
        val, kind = _data(y), "point"
    else:
        return ""
    label_expr = _data_label_fmt_expr(o, val)
    if kind == "dodge":
        return (f'\np <- p + geom_text(aes(label = {label_expr}), '
                f'position = position_dodge(width = 0.76), vjust = -0.4, '
                f'size = {_GEOM_TEXT_SIZE_7PT}, colour = "grey25")\n')
    if kind == "col":
        return (f'\np <- p + geom_text(aes(label = {label_expr}), '
                f'vjust = -0.5, size = {_GEOM_TEXT_SIZE_7PT}, colour = "grey25")\n')
    return (f'\np <- p + geom_text(aes(label = {label_expr}), '
            f'vjust = -0.6, size = {_GEOM_TEXT_SIZE_7PT}, colour = "grey30", check_overlap = TRUE)\n')


def _axis_scale_layer(o, axis: str) -> str:
    """scale_{axis}_continuous for tick count / label format / reverse.

    Returns "" when no axis option is set for ``axis`` (byte-identical output).
    Only call for axes known to be continuous in the current template.
    """
    breaks = o.get(f"{axis}_breaks")
    n_breaks = None
    if breaks is not None and str(breaks) != "":
        try:
            n = int(float(breaks))
            if 2 <= n <= 30:
                n_breaks = n
        except (TypeError, ValueError):
            n_breaks = None
    fmt = o.get(f"{axis}_tick_format")
    if fmt not in ("number", "comma", "percent", "scientific"):
        fmt = None
    reverse = bool(o.get(f"reverse_{axis}"))
    if n_breaks is None and fmt in (None, "number") and not reverse:
        return ""
    args: list[str] = []
    if n_breaks is not None:
        args.append(f"n.breaks = {n_breaks}")
    if fmt == "comma":
        args.append("labels = scales::label_comma()")
    elif fmt == "percent":
        args.append("labels = scales::label_percent()")
    elif fmt == "scientific":
        args.append("labels = scales::label_scientific()")
    if reverse:
        args.append('trans = "reverse"')
    if not args:
        return ""
    return f'\np <- p + scale_{axis}_continuous({", ".join(args)})\n'


def _axis_break_layer(o) -> str:
    """Broken-axis gaps for ``options['axis_break_x'|'axis_break_y']``.

    Each is a 2-number ``[from, to]`` list (from < to, both finite) describing a
    gap to elide via ``ggbreak::scale_{x,y}_break``. Emitted inside a runtime
    ``requireNamespace("ggbreak")`` guard so it is a no-op where ggbreak is not
    yet installed and takes effect once the image ships it. Returns "" when no
    valid break is configured (byte-identical output).
    """
    out = ""
    for axis in ("x", "y"):
        br = o.get(f"axis_break_{axis}")
        if not isinstance(br, (list, tuple)) or len(br) != 2:
            continue
        frm = _finite_num(br[0])
        to = _finite_num(br[1])
        if frm is None or to is None or not (frm < to):
            continue
        out += (f'\nif (requireNamespace("ggbreak", quietly = TRUE)) {{ '
                f'p <- p + ggbreak::scale_{axis}_break(c({frm:g}, {to:g})) }}\n')
    return out


def _series_styles_layer(plot_type: str, m, o) -> str:
    """Per-series overrides for ``options['series_styles']``.

    Colours merge into the palette-derived manual scale (via ggplot_build, so
    partial overrides keep palette colours for the rest); linetype / shape emit
    manual scales that apply when those aesthetics are mapped. Series names not
    present in the data are ignored by ggplot at build time.
    """
    ss = o.get("series_styles")
    if not isinstance(ss, dict) or not ss:
        return ""
    colors: dict[str, str] = {}
    linetypes: dict[str, str] = {}
    shapes: dict[str, int] = {}
    for name, style in ss.items():
        if not isinstance(name, str) or not isinstance(style, dict):
            continue
        c = style.get("color")
        if isinstance(c, str) and _HEX_COLOR_RE.fullmatch(c.strip()):
            colors[name] = c.strip().upper()
        lt = style.get("linetype")
        if lt in _LINE_TYPES:
            linetypes[name] = lt
        sh = style.get("shape")
        if sh in _POINT_SHAPES and _POINT_SHAPES[sh] is not None:
            shapes[name] = _POINT_SHAPES[sh]
    parts: list[str] = []
    if colors:
        vec = ", ".join(f"{rq(k)} = {rq(v)}" for k, v in list(colors.items())[:80])
        parts.append(f"""
labplot_apply_series_styles <- function(plot) {{
  .override <- c({vec})
  .apply <- function(current_plot, aesthetic, scale_fun) {{
    built <- tryCatch(ggplot2::ggplot_build(current_plot), error = function(e) NULL)
    if (is.null(built)) return(current_plot)
    sc <- built$plot$scales$get_scales(aesthetic)
    if (is.null(sc)) return(current_plot)
    is_discrete <- tryCatch(isTRUE(sc$is_discrete()), error = function(e) FALSE)
    if (!is_discrete) return(current_plot)
    limits <- tryCatch(sc$get_limits(), error = function(e) character())
    limits <- as.character(limits[!is.na(limits)])
    if (!length(limits)) return(current_plot)
    hits <- intersect(names(.override), limits)
    if (!length(hits)) return(current_plot)
    values <- labplot_palette(length(limits))
    names(values) <- limits
    values[hits] <- .override[hits]
    suppressMessages(current_plot + scale_fun(values = values))
  }}
  plot <- .apply(plot, "fill", ggplot2::scale_fill_manual)
  plot <- .apply(plot, "colour", ggplot2::scale_colour_manual)
  plot
}}
p <- labplot_apply_series_styles(p)
""")
    if linetypes:
        vec = ", ".join(f"{rq(k)} = {rq(v)}" for k, v in list(linetypes.items())[:80])
        parts.append(f'p <- p + scale_linetype_manual(values = c({vec}), na.value = "solid")\n')
    if shapes:
        vec = ", ".join(f"{rq(k)} = {v}" for k, v in list(shapes.items())[:80])
        parts.append(f'p <- p + scale_shape_manual(values = c({vec}), na.value = 16)\n')
    return "".join(parts)


def _post_layers(plot_type: str, m, o) -> str:
    """Shared post-build layers appended after `p` exists, before the theme."""
    if plot_type not in _UNIVERSAL_TYPES:
        return ""
    has_y2 = isinstance(o.get("y2_column"), str) and bool(o.get("y2_column").strip())
    out = ""
    out += _data_labels_layer(plot_type, m, o)
    out += _annotations_layer(o)
    for axis in _AXIS_CONT.get(plot_type, ()):
        if axis == "x" and o.get("log_x"):
            continue
        if axis == "y" and o.get("log_y"):
            continue
        if axis == "x" and _x_is_temporal(plot_type, m, o):
            continue  # temporal x owns its own scale_x_date/datetime
        if axis == "y" and plot_type in ("scatter", "line") and has_y2:
            continue
        out += _axis_scale_layer(o, axis)
    out += _series_styles_layer(plot_type, m, o)
    out += _axis_break_layer(o)
    return out


def build_plot_r(plot_type: str, mapping: dict, options: dict) -> str:
    builder = _BUILDERS.get(plot_type)
    if builder is None:
        raise ValueError(f"Unknown plot type: {plot_type}")
    o = options or {}
    return builder(mapping, o) + _post_layers(plot_type, mapping, o)


# ================================================================
# Professional / domain-specific plot types
# ================================================================
def _col(c):  # base-R accessor for a literal column name
    return f"df[[{rq(c)}]]"


def _enrichment_dot(m, o):
    term, value = m["term"], m["value"]
    size, color = m.get("size"), m.get("color")
    size_aes = f", size = {_data(size)}" if size else ""
    color_aes = f", colour = {_data(color)}" if color else ""
    color_scale = '  scale_colour_gradient(low = "#B24745", high = "#4C6F91", name = "p.adjust") +\n' if color else ""
    return f"""
df <- as.data.frame(df)
.terms <- as.character({_col(term)})
.vals <- suppressWarnings(as.numeric({_col(value)}))
df$.term <- factor(.terms, levels = .terms[order(.vals)])
p <- ggplot(df, aes(x = {_data(value)}, y = .term{size_aes}{color_aes})) +
  geom_point(alpha = 0.9) +
  scale_size(range = c(2, 8), name = "Count") +
{color_scale}  {_labs(o, value, "")}
"""


def _enrichment_bar(m, o):
    term, value = m["term"], m["value"]
    return f"""
df <- as.data.frame(df)
.terms <- as.character({_col(term)})
.vals <- suppressWarnings(as.numeric({_col(value)}))
df$.term <- factor(.terms, levels = .terms[order(.vals)])
p <- ggplot(df, aes(x = {_data(value)}, y = .term, fill = {_data(value)})) +
  geom_col(alpha = 0.92, width = 0.7) +
  scale_fill_gradient(low = "#6C9EB3", high = "#B24745", guide = "none") +
  {_labs(o, value, "")}
"""


def _manhattan(m, o):
    chrom, pos, pval = m["chrom"], m["pos"], m["pvalue"]
    thr = _num(o.get("sig_threshold", 5e-8), 5e-8)
    return f"""
df <- as.data.frame(df)
df$.chr <- factor(as.character({_col(chrom)}), levels = unique(as.character({_col(chrom)})))
df$.bp <- suppressWarnings(as.numeric({_col(pos)}))
df$.p <- suppressWarnings(as.numeric({_col(pval)}))
df <- df[order(df$.chr, df$.bp), ]
.minp <- suppressWarnings(min(df$.p[df$.p > 0], na.rm = TRUE)); if (!is.finite(.minp)) .minp <- 1e-300
df$.p[is.na(df$.p) | df$.p <= 0] <- .minp
.chrlen <- tapply(df$.bp, df$.chr, max, na.rm = TRUE)
.off <- c(0, cumsum(as.numeric(.chrlen)))[seq_along(.chrlen)]; names(.off) <- names(.chrlen)
df$.cum <- df$.bp + .off[as.character(df$.chr)]
df$.band <- factor(as.integer(df$.chr) %% 2)
.centers <- tapply(df$.cum, df$.chr, function(x) (min(x) + max(x)) / 2)
p <- ggplot(df, aes(x = .cum, y = -log10(.p), colour = .band)) +
  geom_point(size = 0.9, alpha = 0.8) +
  scale_colour_manual(values = c("0" = "#4C6F91", "1" = "#6C9EB3"), guide = "none") +
  scale_x_continuous(breaks = as.numeric(.centers), labels = names(.centers), expand = c(0.01, 0)) +
  geom_hline(yintercept = -log10({thr}), linetype = "dashed", colour = "#B24745", linewidth = 0.25) +
  {_labs(o, "Chromosome", "-log10(p)")}
"""


def _chemical_space(m, o):
    x, y = m["x"], m["y"]
    color, size = m.get("color"), m.get("size")
    size_aes = f", size = {_data(size)}" if size else ""
    if color:
        aes = f"aes(x = {_data(x)}, y = {_data(y)}, colour = factor({_data(color)}){size_aes})"
        scale = "  scale_colour_manual(values = labplot_palette(), name = NULL) +\n"
    else:
        aes = f"aes(x = {_data(x)}, y = {_data(y)}{size_aes})"
        scale = ""
    size_scale = "  scale_size(range = c(1.5, 7)) +\n" if size else ""
    return f"""
p <- ggplot(df, {aes}) +
  geom_point(alpha = 0.78{'' if size else ', size = 2.4'}) +
{scale}{size_scale}  {_labs(o, x, y)}
"""


def _network(m, o):
    src, tgt = m["source"], m["target"]
    weight = m.get("weight")
    layout = _choice(o.get("layout"), _GRAPH_LAYOUTS, "fr")
    label = o.get("show_labels", True)
    label_block = f"  geom_node_text(aes(label = name), repel = TRUE, size = {_GEOM_TEXT_SIZE_7PT}, colour = \"grey20\") +\n" if label else ""
    edge_w = f"aes(width = {_data(weight)}), " if weight else ""
    edge_width_scale = "  ggraph::scale_edge_width(range = c(0.25, 1.1), guide = \"none\") +\n" if weight else ""
    return f"""
suppressMessages({{library(igraph); library(ggraph); library(tidygraph)}})
.edges <- data.frame(from = as.character({_col(src)}), to = as.character({_col(tgt)}), stringsAsFactors = FALSE)
{f'.edges$weight <- suppressWarnings(as.numeric({_col(weight)}))' if weight else ''}
.g <- igraph::graph_from_data_frame(.edges, directed = FALSE)
igraph::V(.g)$deg <- igraph::degree(.g)
p <- ggraph(.g, layout = {rq(layout)}) +
  geom_edge_link({edge_w}alpha = 0.25, colour = "grey55") +
{edge_width_scale}  geom_node_point(aes(size = deg), colour = "#B24745", alpha = 0.9) +
{label_block}  scale_size(range = c(2, 9), guide = "none") +
  labs(title = {rq(o.get('title')) if o.get('title') else 'NULL'}) +
  theme_void(base_size = 7) +
  theme(plot.title = element_text(face = "bold", hjust = 0.5, size = 7))
"""


def _annotated_heatmap(m, o):
    """DEVICE-rendered (ComplexHeatmap). Defines draw_plot()."""
    cols = m["columns"]
    if not isinstance(cols, list) or len(cols) < 2:
        raise ValueError("annotated heatmap needs >=2 numeric 'columns'")
    col_vec = "c(" + ", ".join(rq(c) for c in cols) + ")"
    anns = m.get("annotations") or []
    ann_vec = "c(" + ", ".join(rq(a) for a in anns) + ")" if anns else "character(0)"
    row_label = m.get("row_label")
    rowname = f"as.character({_col(row_label)})" if row_label else "as.character(seq_len(nrow(df)))"
    cluster_rows = "TRUE" if o.get("cluster_rows", True) else "FALSE"
    cluster_cols = "TRUE" if o.get("cluster_cols", True) else "FALSE"
    show_rn = "TRUE" if o.get("show_row_names", False) else "FALSE"
    title = rq(o.get("title")) if o.get("title") else "NULL"
    if o.get("color_mode") == "grayscale":
        colmap = 'circlize::colorRamp2(c(-2, 0, 2), c("grey90", "grey55", "grey10"))'
    else:
        colmap = 'circlize::colorRamp2(c(-2, 0, 2), c("#4C6F91", "white", "#B24745"))'
    return f"""
suppressMessages({{library(ComplexHeatmap); library(circlize)}})
df <- as.data.frame(df)
.cols <- {col_vec}
.mat <- as.matrix(df[, .cols, drop = FALSE]); storage.mode(.mat) <- "double"
rownames(.mat) <- {rowname}
.mat <- scale(.mat)                      # z-score each feature (column)
.mat[is.na(.mat)] <- 0
.annvars <- {ann_vec}
.ra <- NULL
if (length(.annvars) > 0) {{
  .anndf <- df[, .annvars, drop = FALSE]
  for (nm in names(.anndf)) .anndf[[nm]] <- as.factor(.anndf[[nm]])
  .ann_legend <- stats::setNames(
    lapply(names(.anndf), function(nm) list(title_gp = grid::gpar(fontsize = 7), labels_gp = grid::gpar(fontsize = 7))),
    names(.anndf)
  )
  .ra <- ComplexHeatmap::rowAnnotation(
    df = .anndf,
    annotation_name_gp = grid::gpar(fontsize = 7),
    annotation_legend_param = .ann_legend
  )
}}
draw_plot <- function() {{
  ht <- ComplexHeatmap::Heatmap(.mat, name = "z-score", col = {colmap},
    cluster_rows = {cluster_rows}, cluster_columns = {cluster_cols},
    show_row_names = {show_rn}, row_names_gp = grid::gpar(fontsize = 7),
    column_names_gp = grid::gpar(fontsize = 7), right_annotation = .ra,
    column_title = {title}, column_title_gp = grid::gpar(fontsize = 7),
    heatmap_legend_param = list(title_gp = grid::gpar(fontsize = 7), labels_gp = grid::gpar(fontsize = 7)))
  ComplexHeatmap::draw(ht, merge_legends = TRUE)
}}
"""


def _sankey(m, o):
    src, tgt = m["source"], m["target"]
    value = m.get("value") or m.get("weight")
    value_expr = f"suppressWarnings(as.numeric({_col(value)}))" if value else "1"
    return f"""
.flows <- data.frame(
  source = as.character({_col(src)}),
  target = as.character({_col(tgt)}),
  value = {value_expr},
  stringsAsFactors = FALSE
)
.flows$value[is.na(.flows$value) | .flows$value <= 0] <- 1
.flows <- .flows %>%
  dplyr::group_by(source, target) %>%
  dplyr::summarise(value = sum(value, na.rm = TRUE), .groups = "drop")
.sources <- .flows %>% dplyr::group_by(source) %>% dplyr::summarise(total = sum(value), .groups = "drop") %>% dplyr::arrange(desc(total), source)
.targets <- .flows %>% dplyr::group_by(target) %>% dplyr::summarise(total = sum(value), .groups = "drop") %>% dplyr::arrange(desc(total), target)
.sources$y <- seq_len(nrow(.sources))
.targets$y <- seq_len(nrow(.targets))
.flows <- .flows %>%
  dplyr::left_join(.sources[, c("source", "y")], by = "source") %>%
  dplyr::rename(y_source = y) %>%
  dplyr::left_join(.targets[, c("target", "y")], by = "target") %>%
  dplyr::rename(y_target = y)
.nodes <- rbind(
  data.frame(x = 0, y = .sources$y, label = .sources$source, total = .sources$total, side = "source"),
  data.frame(x = 1, y = .targets$y, label = .targets$target, total = .targets$total, side = "target")
)
p <- ggplot() +
  geom_curve(data = .flows, aes(x = 0.08, xend = 0.92, y = y_source, yend = y_target,
                                linewidth = value, colour = source),
             curvature = 0.45, alpha = 0.42, lineend = "round") +
  geom_point(data = .nodes, aes(x = x, y = y, size = total), shape = 21, fill = "white",
             colour = "grey20", stroke = 0.35) +
  geom_text(data = .nodes, aes(x = x, y = y, label = label, hjust = ifelse(x < 0.5, 1.05, -0.05)),
            size = {_GEOM_TEXT_SIZE_7PT}) +
  scale_colour_manual(values = labplot_palette(), guide = "none") +
  scale_linewidth(range = c(0.5, 5.2), guide = "none") +
  scale_size(range = c(2.5, 6), guide = "none") +
  scale_x_continuous(limits = c(-0.35, 1.35), breaks = c(0, 1), labels = c({rq(src)}, {rq(tgt)})) +
  {_labs(o, "", "Flow")} +
  theme(axis.text.y = element_blank(), axis.ticks.y = element_blank(), panel.grid = element_blank())
"""


def _upset(m, o):
    cols = m["sets"]
    if not isinstance(cols, list) or len(cols) < 2:
        raise ValueError("UpSet plot requires at least two set columns")
    col_vec = "c(" + ", ".join(rq(c) for c in cols) + ")"
    return f"""
suppressMessages(library(gridExtra))
.cols <- {col_vec}
.raw <- df[, .cols, drop = FALSE]
.bin <- as.data.frame(lapply(.raw, function(x) {{
  if (is.logical(x)) return(ifelse(is.na(x), FALSE, x))
  if (is.numeric(x)) return(ifelse(is.na(x), FALSE, x != 0))
  tolower(trimws(as.character(x))) %in% c("1", "true", "yes", "y", "present", "detected", "positive")
}}), check.names = FALSE)
.combo <- apply(.bin, 1, paste0, collapse = "")
.none <- paste(rep("0", length(.cols)), collapse = "")
.tab <- as.data.frame(table(.combo), stringsAsFactors = FALSE)
colnames(.tab) <- c("combo", "count")
.tab <- .tab[.tab$combo != .none & .tab$count > 0, , drop = FALSE]
if (nrow(.tab) == 0) stop("No non-empty intersections found")
.tab <- .tab[order(-.tab$count, .tab$combo), , drop = FALSE]
.tab <- .tab[seq_len(min(20, nrow(.tab))), , drop = FALSE]
.tab$ix <- seq_len(nrow(.tab))
.long <- do.call(rbind, lapply(seq_len(nrow(.tab)), function(i) {{
  data.frame(ix = .tab$ix[i], combo = .tab$combo[i], set = .cols,
             present = substring(.tab$combo[i], seq_along(.cols), seq_along(.cols)) == "1",
             count = .tab$count[i], stringsAsFactors = FALSE)
}}))
.long$set <- factor(.long$set, levels = rev(.cols))
.tab$ix_f <- factor(.tab$ix, levels = .tab$ix)
.long$ix_f <- factor(.long$ix, levels = .tab$ix)
.segments <- .long %>% dplyr::filter(present) %>% dplyr::group_by(ix_f) %>%
  dplyr::summarise(ymin = min(as.numeric(set)), ymax = max(as.numeric(set)), .groups = "drop")
.bar <- ggplot(.tab, aes(x = ix_f, y = count)) +
  geom_col(fill = "#4C6F91", width = 0.72) +
  labs(x = NULL, y = "Intersection size") +
  theme_minimal(base_size = 7) +
  theme(axis.text.x = element_blank(), panel.grid.major.x = element_blank())
.mat <- ggplot(.long, aes(x = ix_f, y = set)) +
  geom_segment(data = .segments, aes(x = ix_f, xend = ix_f, y = ymin, yend = ymax),
               inherit.aes = FALSE, linewidth = 0.35, colour = "grey35") +
  geom_point(aes(fill = present), shape = 21, size = 2.6, colour = "grey35", stroke = 0.25) +
  scale_fill_manual(values = c(`TRUE` = "#B24745", `FALSE` = "white"), guide = "none") +
  labs(x = "Intersection", y = NULL) +
  theme_minimal(base_size = 7) +
  theme(panel.grid = element_blank(), axis.text.x = element_blank(), axis.ticks.x = element_blank())
draw_plot <- function() {{
  gridExtra::grid.arrange(.bar, .mat, ncol = 1, heights = c(2, 1.25))
}}
"""


def _surface_3d(m, o):
    x, y, z = m["x"], m["y"], m["z"]
    return f"""
.plot <- data.frame(.x = suppressWarnings(as.numeric({_col(x)})),
                    .y = suppressWarnings(as.numeric({_col(y)})),
                    .z = suppressWarnings(as.numeric({_col(z)})))
.plot <- .plot[stats::complete.cases(.plot), ]
.xv <- sort(unique(.plot$.x)); .yv <- sort(unique(.plot$.y))
if (length(.xv) < 2 || length(.yv) < 2) stop("3D surface needs a grid with at least two x and y values")
.zmat <- matrix(NA_real_, nrow = length(.xv), ncol = length(.yv), dimnames = list(.xv, .yv))
for (i in seq_len(nrow(.plot))) .zmat[as.character(.plot$.x[i]), as.character(.plot$.y[i])] <- .plot$.z[i]
if (anyNA(.zmat)) stop("3D surface requires a complete x/y grid")
draw_plot <- function() {{
  .pal <- grDevices::colorRampPalette(c("#F7F8FA", "#B9C7D4", "#4C6F91"))(100)
  .zfacet <- (.zmat[-1, -1] + .zmat[-1, -ncol(.zmat)] + .zmat[-nrow(.zmat), -1] + .zmat[-nrow(.zmat), -ncol(.zmat)]) / 4
  .idx <- cut(.zfacet, breaks = 100, labels = FALSE, include.lowest = TRUE)
  graphics::persp(.xv, .yv, .zmat, theta = 38, phi = 28, expand = 0.62,
                  col = .pal[.idx], border = "grey45", lwd = 0.25,
                  xlab = {rq(o.get("x_label") or x)}, ylab = {rq(o.get("y_label") or y)}, zlab = {rq(z)},
                  ticktype = "detailed", shade = 0.35)
}}
"""


def _wireframe_3d(m, o):
    x, y, z = m["x"], m["y"], m["z"]
    return f"""
suppressMessages(library(lattice))
.plot <- data.frame(.x = suppressWarnings(as.numeric({_col(x)})),
                    .y = suppressWarnings(as.numeric({_col(y)})),
                    .z = suppressWarnings(as.numeric({_col(z)})))
.plot <- .plot[stats::complete.cases(.plot), ]
if (length(unique(.plot$.x)) < 2 || length(unique(.plot$.y)) < 2) stop("3D wireframe needs at least two x and y values")
.wf <- lattice::wireframe(.z ~ .x * .y, data = .plot, drape = FALSE,
                          screen = list(z = 35, x = -60), lwd = 0.45,
                          xlab = {rq(o.get("x_label") or x)}, ylab = {rq(o.get("y_label") or y)}, zlab = {rq(z)},
                          scales = list(arrows = FALSE, cex = 1.0))
draw_plot <- function() print(.wf)
"""


def _scatter_3d(m, o):
    x, y, z = m["x"], m["y"], m["z"]
    group = m.get("group")
    grp_line = f'.plot$.grp <- factor({_col(group)})' if group else '.plot$.grp <- factor("All")'
    return f"""
suppressMessages(library(lattice))
.plot <- data.frame(.x = suppressWarnings(as.numeric({_col(x)})),
                    .y = suppressWarnings(as.numeric({_col(y)})),
                    .z = suppressWarnings(as.numeric({_col(z)})))
{grp_line}
.plot <- .plot[stats::complete.cases(.plot[, c(".x", ".y", ".z")]), ]
.cloud <- lattice::cloud(.z ~ .x * .y, data = .plot, groups = .grp,
                         auto.key = list(columns = 2, cex = 1.0),
                         pch = 16, cex = 0.7, alpha = 0.75,
                         col = rep(c("#4C6F91", "#B24745", "#6A8A6B", "#8E6C8A", "#B79A43", "#5D8D8A", "#8C7A6B", "#7A7A7A", "#A06B5F"), length.out = length(levels(.plot$.grp))),
                         screen = list(z = 40, x = -65),
                         xlab = {rq(o.get("x_label") or x)}, ylab = {rq(o.get("y_label") or y)}, zlab = {rq(z)},
                         scales = list(arrows = FALSE, cex = 1.0))
draw_plot <- function() print(.cloud)
"""


def _contour_3d(m, o):
    x, y, z = m["x"], m["y"], m["z"]
    return f"""
.plot <- data.frame(.x = suppressWarnings(as.numeric({_col(x)})),
                    .y = suppressWarnings(as.numeric({_col(y)})),
                    .z = suppressWarnings(as.numeric({_col(z)})))
.plot <- .plot[stats::complete.cases(.plot), ]
.xv <- sort(unique(.plot$.x)); .yv <- sort(unique(.plot$.y))
if (length(.xv) < 2 || length(.yv) < 2) stop("3D contour needs a complete x/y grid")
.zmat <- matrix(NA_real_, nrow = length(.xv), ncol = length(.yv), dimnames = list(.xv, .yv))
for (i in seq_len(nrow(.plot))) .zmat[as.character(.plot$.x[i]), as.character(.plot$.y[i])] <- .plot$.z[i]
if (anyNA(.zmat)) stop("3D contour requires a complete x/y grid")
draw_plot <- function() {{
  .pal <- grDevices::colorRampPalette(c("#F7F8FA", "#B9C7D4", "#4C6F91"))(100)
  .zlim <- range(.zmat, finite = TRUE)
  .zfacet <- (.zmat[-1, -1] + .zmat[-1, -ncol(.zmat)] + .zmat[-nrow(.zmat), -1] + .zmat[-nrow(.zmat), -ncol(.zmat)]) / 4
  .idx <- cut(.zfacet, breaks = 100, labels = FALSE, include.lowest = TRUE)
  .pm <- graphics::persp(.xv, .yv, .zmat, theta = 38, phi = 28, expand = 0.62,
                         col = .pal[.idx], border = "grey60", lwd = 0.2,
                         xlab = {rq(o.get("x_label") or x)}, ylab = {rq(o.get("y_label") or y)}, zlab = {rq(z)},
                         zlim = .zlim, ticktype = "detailed", shade = 0.25)
  .levels <- pretty(.zlim, n = 8)
  .contours <- grDevices::contourLines(.xv, .yv, .zmat, levels = .levels)
  for (.cl in .contours) {{
    .xy <- grDevices::trans3d(.cl$x, .cl$y, .zlim[1], .pm)
    graphics::lines(.xy, col = "#1F1F1F", lwd = 0.9)
  }}
}}
"""


def _calibration_curve(m, o):
    predicted, observed = m["predicted"], m["observed"]
    group = m.get("group")
    if group:
        aes = f"aes(x = .pred, y = .obs, colour = factor({_col(group)}))"
        scale = "  scale_colour_manual(values = labplot_palette()) +\n"
        guide = f" + guides(colour = guide_legend(title = {rq(group)}))"
    else:
        aes = "aes(x = .pred, y = .obs)"
        scale = ""
        guide = ""
    return f"""
.plot <- df %>% dplyr::mutate(.pred = suppressWarnings(as.numeric({_col(predicted)})),
                              .obs = suppressWarnings(as.numeric({_col(observed)})))
.plot <- .plot[stats::complete.cases(.plot[, c(".pred", ".obs")]), ]
p <- ggplot(.plot, {aes}) +
  geom_abline(intercept = 0, slope = 1, linetype = "dashed", colour = "grey45", linewidth = 0.3) +
  geom_point(size = 2.0, alpha = 0.8) +
  geom_smooth(method = "lm", se = TRUE, linewidth = 0.35, alpha = 0.18) +
{scale}  {_labs(o, o.get("x_label") or "Predicted", o.get("y_label") or "Observed")}{guide}
"""


def _chord_diagram(m, o):
    src, tgt = m["source"], m["target"]
    value = m.get("value") or m.get("weight")
    value_expr = f"suppressWarnings(as.numeric({_col(value)}))" if value else "1"
    return f"""
suppressMessages({{library(circlize); library(grid)}})
.matdf <- data.frame(from = as.character({_col(src)}), to = as.character({_col(tgt)}),
                     value = {value_expr}, stringsAsFactors = FALSE)
.matdf$value[is.na(.matdf$value) | .matdf$value <= 0] <- 1
.matdf <- .matdf %>% dplyr::group_by(from, to) %>% dplyr::summarise(value = sum(value), .groups = "drop")
draw_plot <- function() {{
  circlize::circos.clear()
  grid::grid.newpage()
  .nodes <- unique(c(.matdf$from, .matdf$to))
  .cols <- setNames(rep(c("#4C6F91", "#B24745", "#6A8A6B", "#8E6C8A", "#B79A43", "#5D8D8A", "#8C7A6B", "#7A7A7A", "#A06B5F"), length.out = length(.nodes)), .nodes)
  circlize::chordDiagram(.matdf, directional = 1, direction.type = c("arrows", "diffHeight"),
                         grid.col = .cols, transparency = 0.35,
                         annotationTrack = c("grid"), preAllocateTracks = 1)
  circlize::circos.trackPlotRegion(track.index = 1, panel.fun = function(x, y) {{
    .sector <- circlize::get.cell.meta.data("sector.index")
    .xlim <- circlize::get.cell.meta.data("xlim")
    .ylim <- circlize::get.cell.meta.data("ylim")
    circlize::circos.text(mean(.xlim), .ylim[1] + 0.1, .sector, facing = "clockwise",
                          niceFacing = TRUE, adj = c(0, 0.5), cex = 1.0)
  }}, bg.border = NA)
  circlize::circos.clear()
}}
"""


def _parallel_coordinates(m, o):
    cols = m["columns"]
    if not isinstance(cols, list) or len(cols) < 2:
        raise ValueError("Parallel coordinates requires at least two numeric columns")
    col_vec = "c(" + ", ".join(rq(c) for c in cols) + ")"
    group = m.get("group")
    id_col = m.get("id")
    grp_expr = f"factor({_col(group)})" if group else 'factor("All")'
    id_expr = f"as.character({_col(id_col)})" if id_col else "as.character(seq_len(nrow(df)))"
    guide = f" + guides(colour = guide_legend(title = {rq(group)}))" if group else ' + guides(colour = "none")'
    return f"""
.cols <- {col_vec}
.wide <- df[, .cols, drop = FALSE]
.wide <- as.data.frame(lapply(.wide, function(x) suppressWarnings(as.numeric(x))), check.names = FALSE)
.scaled <- as.data.frame(lapply(.wide, function(x) {{
  .rng <- range(x, finite = TRUE)
  if (!all(is.finite(.rng)) || diff(.rng) == 0) return(rep(0.5, length(x)))
  (x - .rng[1]) / diff(.rng)
}}), check.names = FALSE)
.scaled$.id <- {id_expr}
.scaled$.grp <- {grp_expr}
.long <- tidyr::pivot_longer(.scaled, dplyr::all_of(.cols), names_to = "metric", values_to = "value")
.long$metric <- factor(.long$metric, levels = .cols)
p <- ggplot(.long, aes(x = metric, y = value, group = .id, colour = .grp)) +
  geom_line(alpha = 0.35, linewidth = 0.25) +
  geom_point(alpha = 0.55, size = 0.8) +
  scale_colour_manual(values = labplot_palette()) +
  {_labs(o, "", "Scaled value")}{guide} +
  theme(axis.text.x = element_text(angle = 35, hjust = 1), panel.grid.minor = element_blank())
"""


def _confusion_matrix(m, o):
    actual, predicted = m["actual"], m["predicted"]
    return f"""
.tab <- as.data.frame(table(Actual = as.character({_col(actual)}), Predicted = as.character({_col(predicted)})),
                      stringsAsFactors = FALSE)
.tab$Actual <- factor(.tab$Actual, levels = rev(sort(unique(.tab$Actual))))
.tab$Predicted <- factor(.tab$Predicted, levels = sort(unique(.tab$Predicted)))
p <- ggplot(.tab, aes(x = Predicted, y = Actual, fill = Freq)) +
  geom_tile(colour = "white", linewidth = 0.35) +
  geom_text(aes(label = Freq), size = {_GEOM_TEXT_SIZE_7PT}, colour = "grey10") +
  scale_fill_gradient(low = "grey95", high = "#4C6F91", name = "Count") +
  coord_equal() +
  {_labs(o, "Predicted", "Actual")} +
  theme(panel.grid = element_blank())
"""


def _tri_surface(m, o):
    x, y, z = m["x"], m["y"], m["z"]
    return f"""
.plot <- data.frame(.x = suppressWarnings(as.numeric({_col(x)})),
                    .y = suppressWarnings(as.numeric({_col(y)})),
                    .z = suppressWarnings(as.numeric({_col(z)})))
.plot <- .plot[stats::complete.cases(.plot), ]
.xv <- sort(unique(.plot$.x)); .yv <- sort(unique(.plot$.y))
if (length(.xv) < 2 || length(.yv) < 2) stop("Tri-surface needs a complete x/y grid")
.zmat <- matrix(NA_real_, nrow = length(.xv), ncol = length(.yv), dimnames = list(.xv, .yv))
for (i in seq_len(nrow(.plot))) .zmat[as.character(.plot$.x[i]), as.character(.plot$.y[i])] <- .plot$.z[i]
if (anyNA(.zmat)) stop("Tri-surface requires a complete x/y grid")
.triangles <- list()
for (i in seq_len(length(.xv) - 1)) for (j in seq_len(length(.yv) - 1)) {{
  .triangles[[length(.triangles) + 1]] <- data.frame(x = c(.xv[i], .xv[i + 1], .xv[i + 1]),
                                                     y = c(.yv[j], .yv[j], .yv[j + 1]),
                                                     z = c(.zmat[i, j], .zmat[i + 1, j], .zmat[i + 1, j + 1]))
  .triangles[[length(.triangles) + 1]] <- data.frame(x = c(.xv[i], .xv[i + 1], .xv[i]),
                                                     y = c(.yv[j], .yv[j + 1], .yv[j + 1]),
                                                     z = c(.zmat[i, j], .zmat[i + 1, j + 1], .zmat[i, j + 1]))
}}
draw_plot <- function() {{
  .pal <- grDevices::colorRampPalette(c("#F7F8FA", "#B9C7D4", "#4C6F91"))(100)
  .zlim <- range(.zmat, finite = TRUE)
  .pm <- graphics::persp(.xv, .yv, .zmat, theta = 38, phi = 28, expand = 0.62,
                         col = NA, border = NA,
                         xlab = {rq(o.get("x_label") or x)}, ylab = {rq(o.get("y_label") or y)}, zlab = {rq(z)},
                         zlim = .zlim, ticktype = "detailed")
  .ord <- order(vapply(.triangles, function(d) mean(d$z), numeric(1)))
  for (.idx in .ord) {{
    .tri <- .triangles[[.idx]]
    .xy <- grDevices::trans3d(.tri$x, .tri$y, .tri$z, .pm)
    .ci <- cut(mean(.tri$z), breaks = seq(.zlim[1], .zlim[2], length.out = 101), labels = FALSE, include.lowest = TRUE)
    graphics::polygon(.xy, col = .pal[.ci], border = "grey55", lwd = 0.25)
  }}
}}
"""


def _roc_pr_curve(m, o):
    score, label = m["score"], m["label"]
    group = m.get("group")
    grp_expr = f"as.character({_col(group)})" if group else 'rep("Model", nrow(df))'
    return f"""
.scores <- suppressWarnings(as.numeric({_col(score)}))
.lab_raw <- tolower(trimws(as.character({_col(label)})))
.label <- .lab_raw %in% c("1", "1.0", "true", "yes", "positive", "case", "disease", "event")
.grp <- {grp_expr}
.base <- data.frame(score = .scores, label = .label, group = .grp)
.base <- .base[stats::complete.cases(.base[, c("score", "group")]), ]
curve_one <- function(d) {{
  d <- d[order(-d$score), , drop = FALSE]
  P <- max(sum(d$label), 1); N <- max(sum(!d$label), 1)
  tp <- c(0, cumsum(d$label)); fp <- c(0, cumsum(!d$label))
  roc <- data.frame(metric = "ROC", x = fp / N, y = tp / P)
  recall <- tp / P
  precision <- ifelse(tp + fp == 0, 1, tp / pmax(tp + fp, 1))
  pr <- data.frame(metric = "PR", x = recall, y = precision)
  rbind(roc, pr)
}}
.curves <- do.call(rbind, lapply(split(.base, .base$group), function(d) {{
  out <- curve_one(d)
  out$group <- unique(d$group)[1]
  out
}}))
.curves$metric <- factor(.curves$metric, levels = c("ROC", "PR"))
p <- ggplot(.curves, aes(x = x, y = y, colour = factor(group))) +
  geom_abline(data = data.frame(metric = "ROC"), aes(intercept = 0, slope = 1),
              inherit.aes = FALSE, linetype = "dashed", colour = "grey70", linewidth = 0.25) +
  geom_line(linewidth = 0.45) +
  facet_wrap(~metric, nrow = 1) +
  coord_equal(xlim = c(0, 1), ylim = c(0, 1)) +
  scale_colour_manual(values = labplot_palette()) +
  {_labs(o, "False positive rate / recall", "True positive rate / precision")} +
  guides(colour = guide_legend(title = {rq(group) if group else 'NULL'}))
"""


def _ma_plot(m, o):
    mean_col, lfc = m["mean"], m["log2fc"]
    gene = m.get("gene_label")
    fc_t = _num(o.get("fc_threshold", 1.0), 1.0)
    label_top = int(o.get("label_top", 0) or 0)
    label_block = ""
    if gene and label_top > 0:
        label_block = f"""
.top <- .plot[order(-abs(.plot$.lfc)), , drop = FALSE]
.top <- .top[seq_len(min({label_top}, nrow(.top))), , drop = FALSE]
p <- p + geom_text(data = .top, aes(label = {_data(gene)}), size = {_GEOM_TEXT_SIZE_7PT}, vjust = -0.55, show.legend = FALSE)
"""
    return f"""
.plot <- df %>% dplyr::mutate(.mean = suppressWarnings(as.numeric({_col(mean_col)})),
                              .lfc = suppressWarnings(as.numeric({_col(lfc)})))
.plot <- .plot[stats::complete.cases(.plot[, c(".mean", ".lfc")]), ]
.plot$.sig <- ifelse(abs(.plot$.lfc) >= {fc_t}, ifelse(.plot$.lfc > 0, "Up", "Down"), "Stable")
.plot$.sig <- factor(.plot$.sig, levels = c("Down", "Stable", "Up"))
p <- ggplot(.plot, aes(x = .mean, y = .lfc, colour = .sig)) +
  geom_point(alpha = 0.72, size = 1.45) +
  geom_hline(yintercept = c(-{fc_t}, {fc_t}), linetype = "dashed", linewidth = 0.25, colour = "grey45") +
  scale_colour_manual(values = c(Down = "#6C9EB3", Stable = "grey70", Up = "#B24745"), name = NULL) +
  {_labs(o, o.get("x_label") or "Mean expression", o.get("y_label") or "log2 fold change")}
{label_block}"""


_BUILDERS.update({
    "enrichment_dot": _enrichment_dot,
    "enrichment_bar": _enrichment_bar,
    "manhattan": _manhattan,
    "chemical_space": _chemical_space,
    "network": _network,
    "annotated_heatmap": _annotated_heatmap,
    "sankey": _sankey,
    "upset": _upset,
    "surface_3d": _surface_3d,
    "scatter_3d": _scatter_3d,
    "contour_3d": _contour_3d,
    "calibration_curve": _calibration_curve,
    "chord_diagram": _chord_diagram,
    "parallel_coordinates": _parallel_coordinates,
    "confusion_matrix": _confusion_matrix,
    "tri_surface": _tri_surface,
    "wireframe_3d": _wireframe_3d,
    "roc_pr_curve": _roc_pr_curve,
    "ma_plot": _ma_plot,
})

# plot types that render via base-graphics devices (not ggsave) / skip ggplot theme
DEVICE_TYPES = {"annotated_heatmap", "upset", "surface_3d", "scatter_3d", "contour_3d", "chord_diagram", "tri_surface", "wireframe_3d"}
NO_THEME_TYPES = {"network", "annotated_heatmap", "upset", "surface_3d", "scatter_3d", "contour_3d", "chord_diagram", "tri_surface", "wireframe_3d"}

# plot types that render a continuous/gradient colour or fill scale (no discrete
# series scale for series_styles/category_colors to target). Combined with
# DEVICE_TYPES these are excluded from color editing (design §6, decision 10).
CONTINUOUS_FILL_TYPES = {
    "heatmap",
    "correlation_heatmap",
    "contour",
    "embedding",
    "calibration_curve",
    "roc_pr_curve",
    "confusion_matrix",
    "chemical_space",
    "parallel_coordinates",
    "radar",
    "sankey",
    "network",
}


def is_color_editable(plot_type: str) -> bool:
    """True iff the plot type exposes a discrete colour/fill scale that
    series_styles/category_colors can edit. DEVICE_TYPES (non-ggplot device
    path) and CONTINUOUS_FILL_TYPES (gradient fills) are not editable."""
    return plot_type not in DEVICE_TYPES and plot_type not in CONTINUOUS_FILL_TYPES

PLOT_TYPES += [
    {"type": "annotated_heatmap", "label": "Annotated heatmap (cohort)",
     "required": [{"key": "columns", "label": "Feature columns", "roles": ["numeric", "log2fc"], "multi": True}],
     "optional": [{"key": "annotations", "label": "Sample annotations (group/stage…)", "roles": ["group", "category", "status"], "multi": True},
                  {"key": "row_label", "label": "Row label", "roles": ["gene", "text", "category"]}],
     "options": [{"key": "cluster_rows", "label": "Cluster rows", "type": "bool", "default": True},
                 {"key": "cluster_cols", "label": "Cluster columns", "type": "bool", "default": True},
                 {"key": "show_row_names", "label": "Show row names", "type": "bool", "default": False}]},
    {"type": "network", "label": "Network",
     "required": [{"key": "source", "label": "Source node", "roles": ["gene", "category", "text"]},
                  {"key": "target", "label": "Target node", "roles": ["gene", "category", "text"]}],
     "optional": [{"key": "weight", "label": "Edge weight", "roles": ["numeric"]}],
     "options": [{"key": "layout", "label": "Layout", "type": "select", "choices": ["fr", "kk", "circle", "stress"], "default": "fr"},
                 {"key": "show_labels", "label": "Node labels", "type": "bool", "default": True}]},
    {"type": "enrichment_dot", "label": "Enrichment dot plot",
     "required": [{"key": "term", "label": "Term / pathway", "roles": ["text", "category", "gene"]},
                  {"key": "value", "label": "Gene ratio / score", "roles": ["numeric"]}],
     "optional": [{"key": "size", "label": "Count", "roles": ["numeric"]},
                  {"key": "color", "label": "p.adjust", "roles": ["pvalue", "numeric"]}],
     "options": []},
    {"type": "enrichment_bar", "label": "Enrichment bar plot",
     "required": [{"key": "term", "label": "Term / pathway", "roles": ["text", "category", "gene"]},
                  {"key": "value", "label": "Value (-log10 p / count)", "roles": ["numeric"]}],
     "optional": [], "options": []},
    {"type": "manhattan", "label": "Manhattan plot (GWAS)",
     "required": [{"key": "chrom", "label": "Chromosome", "roles": ["category", "group", "text", "numeric"]},
                  {"key": "pos", "label": "Position (bp)", "roles": ["numeric"]},
                  {"key": "pvalue", "label": "p-value", "roles": ["pvalue", "numeric"]}],
     "optional": [], "options": [{"key": "sig_threshold", "label": "Significance line (p)", "type": "number", "default": 5e-8}]},
    {"type": "chemical_space", "label": "Chemical space (descriptors)",
     "required": [{"key": "x", "label": "Descriptor X (e.g. MW)", "roles": ["numeric"]},
                  {"key": "y", "label": "Descriptor Y (e.g. LogP)", "roles": ["numeric"]}],
     "optional": [{"key": "color", "label": "Class / activity", "roles": ["group", "category", "status"]},
                  {"key": "size", "label": "Size by", "roles": ["numeric"]}],
     "options": []},
    {"type": "sankey", "label": "Sankey diagram",
     "required": [{"key": "source", "label": "Source", "roles": ["category", "group", "text", "gene"]},
                  {"key": "target", "label": "Target", "roles": ["category", "group", "text", "gene"]}],
     "optional": [{"key": "value", "label": "Flow value", "roles": ["numeric"]},
                  {"key": "weight", "label": "Flow weight", "roles": ["numeric"]}],
     "options": []},
    {"type": "upset", "label": "UpSet plot",
     "required": [{"key": "sets", "label": "Set membership columns", "roles": ["numeric", "status", "category"], "multi": True}],
     "optional": [],
     "options": []},
    {"type": "surface_3d", "label": "3D surface / plane plot",
     "required": [{"key": "x", "label": "X coordinate", "roles": ["numeric"]},
                  {"key": "y", "label": "Y coordinate", "roles": ["numeric"]},
                  {"key": "z", "label": "Response / Z", "roles": ["numeric"]}],
     "optional": [], "options": []},
    {"type": "scatter_3d", "label": "3D scatter plot",
     "required": [{"key": "x", "label": "X coordinate", "roles": ["numeric"]},
                  {"key": "y", "label": "Y coordinate", "roles": ["numeric"]},
                  {"key": "z", "label": "Z coordinate", "roles": ["numeric"]}],
     "optional": [{"key": "group", "label": "Group", "roles": ["group", "category", "status"]}], "options": []},
    {"type": "contour_3d", "label": "3D contour projection",
     "required": [{"key": "x", "label": "X coordinate", "roles": ["numeric"]},
                  {"key": "y", "label": "Y coordinate", "roles": ["numeric"]},
                  {"key": "z", "label": "Response / Z", "roles": ["numeric"]}],
     "optional": [], "options": []},
    {"type": "calibration_curve", "label": "Calibration curve",
     "required": [{"key": "predicted", "label": "Predicted / expected", "roles": ["numeric"]},
                  {"key": "observed", "label": "Observed / measured", "roles": ["numeric"]}],
     "optional": [{"key": "group", "label": "Group", "roles": ["group", "category", "status"]}], "options": []},
    {"type": "chord_diagram", "label": "Chord diagram",
     "required": [{"key": "source", "label": "Source", "roles": ["category", "group", "text", "gene"]},
                  {"key": "target", "label": "Target", "roles": ["category", "group", "text", "gene"]}],
     "optional": [{"key": "value", "label": "Value", "roles": ["numeric"]},
                  {"key": "weight", "label": "Weight", "roles": ["numeric"]}], "options": []},
    {"type": "parallel_coordinates", "label": "Parallel coordinates plot",
     "required": [{"key": "columns", "label": "Numeric dimensions", "roles": ["numeric"], "multi": True}],
     "optional": [{"key": "group", "label": "Group", "roles": ["group", "category", "status"]},
                  {"key": "id", "label": "Sample ID", "roles": ["text", "category", "gene"]}], "options": []},
    {"type": "confusion_matrix", "label": "Confusion matrix heatmap",
     "required": [{"key": "actual", "label": "Actual class", "roles": ["category", "status", "group", "text"]},
                  {"key": "predicted", "label": "Predicted class", "roles": ["category", "status", "group", "text"]}],
     "optional": [], "options": []},
    {"type": "tri_surface", "label": "Tri-surface plot",
     "required": [{"key": "x", "label": "X coordinate", "roles": ["numeric"]},
                  {"key": "y", "label": "Y coordinate", "roles": ["numeric"]},
                  {"key": "z", "label": "Response / Z", "roles": ["numeric"]}],
     "optional": [], "options": []},
    {"type": "wireframe_3d", "label": "3D wireframe plot",
     "required": [{"key": "x", "label": "X coordinate", "roles": ["numeric"]},
                  {"key": "y", "label": "Y coordinate", "roles": ["numeric"]},
                  {"key": "z", "label": "Response / Z", "roles": ["numeric"]}],
     "optional": [], "options": []},
    {"type": "roc_pr_curve", "label": "ROC / PR curve",
     "required": [{"key": "score", "label": "Prediction score", "roles": ["numeric"]},
                  {"key": "label", "label": "Binary label", "roles": ["status", "category", "group", "numeric"]}],
     "optional": [{"key": "group", "label": "Model / group", "roles": ["group", "category", "status"]}], "options": []},
    {"type": "ma_plot", "label": "MA plot",
     "required": [{"key": "mean", "label": "Mean expression", "roles": ["numeric"]},
                  {"key": "log2fc", "label": "log2 fold-change", "roles": ["log2fc", "numeric"]}],
     "optional": [{"key": "gene_label", "label": "Gene label", "roles": ["gene", "text", "category"]}],
     "options": [{"key": "fc_threshold", "label": "log2FC threshold", "type": "number", "default": 1.0},
                 {"key": "label_top", "label": "Label top N", "type": "number", "default": 0}]},
]


# ================================================================
# Additional scientific plot types (review-2026-07)
# ================================================================
def _sina(m, o):
    x, y = m["x"], m["y"]
    color = m.get("color") or x
    pt_a = _alpha_r(o, "point_alpha", "0.75")
    violin = (
        '  geom_violin(fill = "grey92", colour = "grey75", linewidth = 0.3, '
        'alpha = 0.6, scale = "width", trim = FALSE) +\n'
    ) if o.get("show_violin", False) else ""
    return f"""
suppressMessages(library(ggforce))
p <- ggplot(df, aes(x = factor({_data(x)}), y = {_data(y)})) +
{violin}  ggforce::geom_sina(aes(colour = factor({_data(color)})), size = 1.4, alpha = {pt_a}, maxwidth = 0.8) +
  scale_colour_manual(values = labplot_palette()) +
  {_labs(o, x, y)} + guides(colour = guide_legend(title = {rq(color)}))
"""


def _qq(m, o):
    value = m["value"]
    group = m.get("group")
    show_line = o.get("show_line", True)
    if group:
        aes = f"aes(sample = {_data(value)}, colour = factor({_data(group)}))"
        line = '  stat_qq_line(linewidth = 0.4, linetype = "dashed") +\n' if show_line else ""
        pts = "  stat_qq(size = 1.6, alpha = 0.8) +\n"
        scale = "  scale_colour_manual(values = labplot_palette()) +\n"
        guide = f" + guides(colour = guide_legend(title = {rq(group)}))"
    else:
        aes = f"aes(sample = {_data(value)})"
        line = '  stat_qq_line(linewidth = 0.4, linetype = "dashed", colour = "grey45") +\n' if show_line else ""
        pts = "  stat_qq(size = 1.6, alpha = 0.8, colour = labplot_accent()) +\n"
        scale = ""
        guide = ""
    return f"""
p <- ggplot(df, {aes}) +
{line}{pts}{scale}  {_labs(o, "Theoretical quantiles", "Sample quantiles")}{guide}
"""


def _ecdf(m, o):
    value = m["value"]
    group = m.get("group")
    if group:
        aes = f"aes(x = {_data(value)}, colour = factor({_data(group)}))"
        scale = "  scale_colour_manual(values = labplot_palette()) +\n"
        guide = f" + guides(colour = guide_legend(title = {rq(group)}))"
        col_arg = ""
    else:
        aes = f"aes(x = {_data(value)})"
        scale = ""
        guide = ""
        col_arg = ", colour = labplot_accent()"
    return f"""
p <- ggplot(df, {aes}) +
  stat_ecdf(geom = "step", linewidth = 0.5, pad = TRUE{col_arg}) +
{scale}  {_labs(o, value, "Cumulative probability")}{guide}
"""


def _forest(m, o):
    label, est = m["label"], m["estimate"]
    lo, hi = m["ci_low"], m["ci_high"]
    color = m.get("color")
    ref = _num(o.get("ref_line"), 1.0)
    if o.get("sort_by_estimate", False):
        order_expr = ".plot$.label <- factor(.plot$.label, levels = unique(.plot$.label[order(.plot$.est)]))"
    else:
        order_expr = ".plot$.label <- factor(.plot$.label, levels = rev(unique(as.character(.plot$.label))))"
    if color:
        col_line = f"\n.plot$.col <- factor({_col(color)})[.keep]"
        ebar = "  geom_errorbarh(aes(xmin = .lo, xmax = .hi, colour = .col), height = 0.18, linewidth = 0.4) +\n"
        point = "  geom_point(aes(colour = .col), size = 2.4) +\n"
        scale = "  scale_colour_manual(values = labplot_palette()) +\n"
        guide = f" + guides(colour = guide_legend(title = {rq(color)}))"
    else:
        col_line = ""
        ebar = '  geom_errorbarh(aes(xmin = .lo, xmax = .hi), height = 0.18, linewidth = 0.4, colour = "#4C6F91") +\n'
        point = '  geom_point(size = 2.4, colour = "#B24745") +\n'
        scale = ""
        guide = ""
    return f"""
.plot <- data.frame(
  .label = as.character({_col(label)}),
  .est = suppressWarnings(as.numeric({_col(est)})),
  .lo = suppressWarnings(as.numeric({_col(lo)})),
  .hi = suppressWarnings(as.numeric({_col(hi)})),
  stringsAsFactors = FALSE
)
.keep <- stats::complete.cases(.plot[, c(".est", ".lo", ".hi")]) & !is.na(.plot$.label)
.plot <- .plot[.keep, , drop = FALSE]{col_line}
if (nrow(.plot) < 1) stop("forest plot needs at least one complete row")
{order_expr}
p <- ggplot(.plot, aes(x = .est, y = .label)) +
  geom_vline(xintercept = {ref:g}, linetype = "dashed", colour = "grey50", linewidth = 0.3) +
{ebar}{point}{scale}  {_labs(o, "Estimate (95% CI)", "")}{guide}
"""


def _dot_plot(m, o):
    cat, val = m["category"], m["value"]
    lvl = ".plot$.cat[order(.plot$.val)]" if o.get("sort_desc", True) else "rev(unique(as.character(.plot$.cat)))"
    return f"""
.plot <- df %>%
  dplyr::transmute(.cat = as.character({_data(cat)}), .val = suppressWarnings(as.numeric({_data(val)}))) %>%
  dplyr::filter(!is.na(.cat), !is.na(.val)) %>%
  dplyr::group_by(.cat) %>%
  dplyr::summarise(.val = mean(.val, na.rm = TRUE), .groups = "drop")
if (nrow(.plot) < 1) stop("dot plot needs at least one category")
.plot$.cat <- factor(.plot$.cat, levels = {lvl})
p <- ggplot(.plot, aes(x = .val, y = .cat)) +
  geom_segment(aes(x = 0, xend = .val, yend = .cat), colour = "grey75", linewidth = 0.4) +
  geom_point(size = 2.8, colour = labplot_accent()) +
  {_labs(o, val, "")}
"""


def _lollipop(m, o):
    cat, val = m["category"], m["value"]
    lvl = ".plot$.cat[order(.plot$.val, decreasing = TRUE)]" if o.get("sort_desc", True) else "unique(as.character(.plot$.cat))"
    return f"""
.plot <- df %>%
  dplyr::transmute(.cat = as.character({_data(cat)}), .val = suppressWarnings(as.numeric({_data(val)}))) %>%
  dplyr::filter(!is.na(.cat), !is.na(.val)) %>%
  dplyr::group_by(.cat) %>%
  dplyr::summarise(.val = mean(.val, na.rm = TRUE), .groups = "drop")
if (nrow(.plot) < 1) stop("lollipop needs at least one category")
.plot$.cat <- factor(.plot$.cat, levels = {lvl})
p <- ggplot(.plot, aes(x = .cat, y = .val)) +
  geom_segment(aes(xend = .cat, y = 0, yend = .val), colour = "grey75", linewidth = 0.4) +
  geom_point(size = 2.8, colour = labplot_accent()) +
  {_labs(o, cat, val)}
"""


def _area(m, o):
    x, y, group = m["x"], m["y"], m["group"]
    stack_mode = _choice(o.get("stack_mode"), ("stack", "fill"), "stack")
    fill_a = _alpha_r(o, "fill_alpha", "0.85")
    ydefault = "Proportion" if stack_mode == "fill" else y
    xt = _x_axis_type(o)
    if xt in ("date", "datetime"):
        # Keep x as a real temporal aesthetic (never as.numeric) so the date
        # scale attaches; coercion is guarded so an all-NA parse falls back to
        # the raw column (rendered as-is) rather than crashing.
        if xt == "date":
            coerce = f'as.Date(as.character(df[[{rq(x)}]]))'
            scale_fn = "scale_x_date"
        else:
            coerce = f'as.POSIXct(as.character(df[[{rq(x)}]]))'
            scale_fn = "scale_x_datetime"
        fmt = o.get("date_format")
        if isinstance(fmt, str) and fmt.strip():
            labels_arg = f"date_labels = {rq(fmt.strip())}"
        else:
            labels_arg = "labels = scales::label_date_short()"
        return f"""
.xt_raw <- suppressWarnings({coerce})
.xt_ok <- !all(is.na(.xt_raw))
if (.xt_ok) {{ df[[{rq(x)}]] <- .xt_raw }}
.plot <- df %>%
  dplyr::transmute(.x = {_data(x)},
                   .y = suppressWarnings(as.numeric({_data(y)})),
                   .grp = factor({_data(group)})) %>%
  dplyr::filter(!is.na(.x), is.finite(.y), !is.na(.grp)) %>%
  dplyr::group_by(.x, .grp) %>%
  dplyr::summarise(.y = sum(.y, na.rm = TRUE), .groups = "drop") %>%
  dplyr::arrange(.x)
if (nrow(.plot) < 1) stop("area chart needs numeric x/y and a group")
p <- ggplot(.plot, aes(x = .x, y = .y, fill = .grp)) +
  geom_area(position = "{stack_mode}", alpha = {fill_a}, colour = "white", linewidth = 0.15) +
  scale_fill_manual(values = labplot_palette()) +
  {_labs(o, x, ydefault)} + guides(fill = guide_legend(title = {rq(group)}))
if (.xt_ok) {{ p <- p + {scale_fn}({labels_arg}) }}
"""
    return f"""
.plot <- df %>%
  dplyr::transmute(.x = suppressWarnings(as.numeric({_data(x)})),
                   .y = suppressWarnings(as.numeric({_data(y)})),
                   .grp = factor({_data(group)})) %>%
  dplyr::filter(is.finite(.x), is.finite(.y), !is.na(.grp)) %>%
  dplyr::group_by(.x, .grp) %>%
  dplyr::summarise(.y = sum(.y, na.rm = TRUE), .groups = "drop") %>%
  dplyr::arrange(.x)
if (nrow(.plot) < 1) stop("area chart needs numeric x/y and a group")
p <- ggplot(.plot, aes(x = .x, y = .y, fill = .grp)) +
  geom_area(position = "{stack_mode}", alpha = {fill_a}, colour = "white", linewidth = 0.15) +
  scale_fill_manual(values = labplot_palette()) +
  {_labs(o, x, ydefault)} + guides(fill = guide_legend(title = {rq(group)}))
"""


def _ridge(m, o):
    value, group = m["value"], m["group"]
    overlap = max(0.4, min(4.0, _num(o.get("overlap"), 1.4)))
    fill_a = _alpha_r(o, "fill_alpha", "0.85")
    return f"""
.d <- df %>%
  dplyr::transmute(.val = suppressWarnings(as.numeric({_data(value)})), .grp = as.character({_data(group)})) %>%
  dplyr::filter(is.finite(.val), !is.na(.grp))
if (nrow(.d) < 2) stop("ridge plot needs numeric values")
.levels <- sort(unique(.d$.grp))
.rng <- range(.d$.val, finite = TRUE)
.dens <- do.call(rbind, lapply(seq_along(.levels), function(.i) {{
  v <- .d$.val[.d$.grp == .levels[.i]]
  if (length(v) < 2 || !is.finite(stats::sd(v)) || stats::sd(v) == 0) return(NULL)
  de <- stats::density(v, n = 256, from = .rng[1], to = .rng[2])
  data.frame(.gi = .i, x = de$x, y = de$y)
}}))
if (is.null(.dens) || nrow(.dens) == 0) stop("ridge plot needs >= 2 values per group")
.scale <- {overlap:g} / max(.dens$y, na.rm = TRUE)
.dens$ymin <- .dens$.gi
.dens$ymax <- .dens$.gi + .dens$y * .scale
.dens$.grp <- factor(.levels[.dens$.gi], levels = rev(.levels))
p <- ggplot(.dens, aes(x = x, group = .grp, fill = .grp)) +
  geom_ribbon(aes(ymin = ymin, ymax = ymax), colour = "grey30", linewidth = 0.2, alpha = {fill_a}) +
  scale_fill_manual(values = labplot_palette()) +
  scale_y_continuous(breaks = seq_along(.levels), labels = .levels) +
  {_labs(o, value, group)} + guides(fill = "none")
"""


def _embedding(m, o):
    x, y = m["x"], m["y"]
    color = m.get("color")
    pt_a = _alpha_r(o, "point_alpha", "0.8")
    if color:
        aes = f"aes(x = {_data(x)}, y = {_data(y)}, colour = factor({_data(color)}))"
        scale = "  scale_colour_manual(values = labplot_palette()) +\n"
        guide = f" + guides(colour = guide_legend(title = {rq(color)}))"
    else:
        aes = f"aes(x = {_data(x)}, y = {_data(y)})"
        scale = ""
        guide = ""
    label_block = ""
    if color and o.get("show_cluster_labels", False):
        label_block = f"""
.cent <- df %>%
  dplyr::transmute(.cx = suppressWarnings(as.numeric({_data(x)})),
                   .cy = suppressWarnings(as.numeric({_data(y)})),
                   .g = factor({_data(color)})) %>%
  dplyr::filter(is.finite(.cx), is.finite(.cy), !is.na(.g)) %>%
  dplyr::group_by(.g) %>%
  dplyr::summarise(.mx = stats::median(.cx), .my = stats::median(.cy), .groups = "drop")
p <- p + geom_text(data = .cent, aes(x = .mx, y = .my, label = .g),
                   inherit.aes = FALSE, size = {_GEOM_TEXT_SIZE_7PT}, fontface = "bold", colour = "grey15")
"""
    return f"""
p <- ggplot(df, {aes}) +
  geom_point(size = 1.8, alpha = {pt_a}) +
{scale}  coord_equal() +
  {_labs(o, x, y)}{guide}
{label_block}"""


def _curve_fit(m, o):
    x, y = m["x"], m["y"]
    group = m.get("group")
    model = _choice(o.get("fit_model"), ("linear", "4pl", "mm", "exponential", "logistic"), "linear")
    show_points = o.get("show_points", True)
    fit_fun = f"""
.fit_one <- function(d) {{
  d <- d[stats::complete.cases(d), , drop = FALSE]
  d <- d[order(d$.x), , drop = FALSE]
  if (nrow(d) < 3 || length(unique(d$.x)) < 2) return(list(pred = NULL, lab = ""))
  gx <- seq(min(d$.x), max(d$.x), length.out = 200)
  .model <- {rq(model)}
  .ss_tot <- sum((d$.y - mean(d$.y))^2)
  .r2 <- function(fitted) if (!is.finite(.ss_tot) || .ss_tot <= 0) NA_real_ else 1 - sum((d$.y - fitted)^2) / .ss_tot
  if (.model == "linear") {{
    fit <- stats::lm(.y ~ .x, data = d)
    gy <- stats::predict(fit, newdata = data.frame(.x = gx))
    co <- stats::coef(fit)
    lab <- sprintf("y = %.3g x + %.3g\\nR\\u00b2 = %.3f", co[[2]], co[[1]], summary(fit)$r.squared)
    return(list(pred = data.frame(.x = gx, .y = as.numeric(gy)), lab = lab))
  }}
  fit <- tryCatch({{
    if (.model == "mm") {{
      stats::nls(.y ~ Vmax * .x / (Km + .x), data = d,
                 start = list(Vmax = max(d$.y, na.rm = TRUE), Km = stats::median(d$.x, na.rm = TRUE)),
                 control = stats::nls.control(warnOnly = TRUE, maxiter = 200))
    }} else if (.model == "exponential") {{
      .a0 <- d$.y[which.min(d$.x)]; if (!is.finite(.a0) || .a0 == 0) .a0 <- 1
      stats::nls(.y ~ a * exp(b * .x), data = d, start = list(a = .a0, b = 0.01),
                 control = stats::nls.control(warnOnly = TRUE, maxiter = 200))
    }} else if (.model == "logistic") {{
      stats::nls(.y ~ L / (1 + exp(-k * (.x - x0))), data = d,
                 start = list(L = max(d$.y, na.rm = TRUE), k = 1, x0 = stats::median(d$.x, na.rm = TRUE)),
                 control = stats::nls.control(warnOnly = TRUE, maxiter = 200))
    }} else if (.model == "4pl") {{
      stats::nls(.y ~ D + (A - D) / (1 + (.x / C)^B), data = d,
                 start = list(A = min(d$.y, na.rm = TRUE), B = 1,
                              C = stats::median(d$.x, na.rm = TRUE), D = max(d$.y, na.rm = TRUE)),
                 control = stats::nls.control(warnOnly = TRUE, maxiter = 200))
    }} else NULL
  }}, error = function(e) NULL)
  gy <- if (!is.null(fit)) tryCatch(stats::predict(fit, newdata = data.frame(.x = gx)), error = function(e) NULL) else NULL
  if (is.null(gy) || any(!is.finite(gy))) {{
    fit2 <- stats::lm(.y ~ .x, data = d)
    gy <- stats::predict(fit2, newdata = data.frame(.x = gx))
    co <- stats::coef(fit2)
    lab <- sprintf("linear fit (fallback)\\ny = %.3g x + %.3g\\nR\\u00b2 = %.3f", co[[2]], co[[1]], summary(fit2)$r.squared)
    return(list(pred = data.frame(.x = gx, .y = as.numeric(gy)), lab = lab))
  }}
  cf <- stats::coef(fit); r2v <- .r2(stats::predict(fit))
  lab <- if (.model == "mm") sprintf("Vmax = %.3g\\nKm = %.3g\\nR\\u00b2 = %.3f", cf[["Vmax"]], cf[["Km"]], r2v)
    else if (.model == "exponential") sprintf("y = %.3g e^(%.3g x)\\nR\\u00b2 = %.3f", cf[["a"]], cf[["b"]], r2v)
    else if (.model == "logistic") sprintf("L = %.3g, k = %.3g\\nx0 = %.3g\\nR\\u00b2 = %.3f", cf[["L"]], cf[["k"]], cf[["x0"]], r2v)
    else sprintf("EC50/IC50 = %.3g\\nHill = %.3g\\nR\\u00b2 = %.3f", cf[["C"]], cf[["B"]], r2v)
  list(pred = data.frame(.x = gx, .y = as.numeric(gy)), lab = lab)
}}
"""
    if group:
        base = f"""
.dat <- df %>%
  dplyr::transmute(.x = suppressWarnings(as.numeric({_data(x)})),
                   .y = suppressWarnings(as.numeric({_data(y)})),
                   .grp = factor({_data(group)})) %>%
  dplyr::filter(is.finite(.x), is.finite(.y), !is.na(.grp))
"""
        pts = "  geom_point(aes(colour = .grp), size = 1.9, alpha = 0.8) +\n" if show_points else ""
        curve = "  geom_line(data = .curve, aes(x = .x, y = .y, colour = .grp), linewidth = 0.5) +\n"
        scale = "  scale_colour_manual(values = labplot_palette()) +\n"
        guide = f" + guides(colour = guide_legend(title = {rq(group)}))"
        fit_loop = """
.groups <- unique(as.character(.dat$.grp))
.curve <- do.call(rbind, lapply(.groups, function(.g) {
  d <- .dat[as.character(.dat$.grp) == .g, c(".x", ".y"), drop = FALSE]
  r <- .fit_one(d)
  if (is.null(r$pred)) return(NULL)
  cc <- r$pred; cc$.grp <- .g; cc
}))
if (is.null(.curve) || nrow(.curve) == 0) stop("curve fit produced no fitted values")
.curve$.grp <- factor(.curve$.grp, levels = levels(.dat$.grp))
"""
        annotate = ""
    else:
        base = f"""
.dat <- df %>%
  dplyr::transmute(.x = suppressWarnings(as.numeric({_data(x)})),
                   .y = suppressWarnings(as.numeric({_data(y)}))) %>%
  dplyr::filter(is.finite(.x), is.finite(.y))
"""
        pts = '  geom_point(size = 1.9, alpha = 0.8, colour = "#4C6F91") +\n' if show_points else ""
        curve = '  geom_line(data = .curve, aes(x = .x, y = .y), linewidth = 0.5, colour = "#B24745") +\n'
        scale = ""
        guide = ""
        fit_loop = """
.res <- .fit_one(.dat[, c(".x", ".y"), drop = FALSE])
.curve <- .res$pred
if (is.null(.curve) || nrow(.curve) == 0) stop("curve fit produced no fitted values")
"""
        annotate = f"""
if (nzchar(.res$lab)) {{
  p <- p + annotate("text", x = min(.dat$.x, na.rm = TRUE), y = max(.dat$.y, na.rm = TRUE),
                    label = .res$lab, hjust = 0, vjust = 1, size = {_GEOM_TEXT_SIZE_7PT}, colour = "grey20")
}}
"""
    return f"""{base}
if (nrow(.dat) < 3) stop("curve fit needs at least 3 finite points")
{fit_fun}{fit_loop}
p <- ggplot(.dat, aes(x = .x, y = .y)) +
{pts}{curve}{scale}  {_labs(o, x, y)}{guide}
{annotate}"""


_BUILDERS.update({
    "sina": _sina,
    "qq": _qq,
    "ecdf": _ecdf,
    "forest": _forest,
    "dot_plot": _dot_plot,
    "lollipop": _lollipop,
    "area": _area,
    "ridge": _ridge,
    "embedding": _embedding,
    "curve_fit": _curve_fit,
})

PLOT_TYPES += [
    {"type": "sina", "label": "Sina / beeswarm plot",
     "required": [{"key": "x", "label": "Group (X)", "roles": ["group", "category", "status"]},
                  {"key": "y", "label": "Value (Y)", "roles": ["numeric", "log2fc", "pvalue"]}],
     "optional": [{"key": "color", "label": "Color by", "roles": ["group", "category", "status"]}],
     "options": [{"key": "show_violin", "label": "Violin outline", "type": "bool", "default": False}]},
    {"type": "qq", "label": "Q-Q (normal) plot",
     "required": [{"key": "value", "label": "Value (numeric)", "roles": ["numeric", "log2fc", "pvalue"]}],
     "optional": [{"key": "group", "label": "Color by", "roles": ["group", "category", "status"]}],
     "options": [{"key": "show_line", "label": "Reference line", "type": "bool", "default": True}]},
    {"type": "ecdf", "label": "Empirical CDF (ECDF)",
     "required": [{"key": "value", "label": "Value (numeric)", "roles": ["numeric", "log2fc", "pvalue"]}],
     "optional": [{"key": "group", "label": "Color by", "roles": ["group", "category", "status"]}],
     "options": []},
    {"type": "forest", "label": "Forest plot",
     "required": [{"key": "label", "label": "Study / variable", "roles": ["text", "category", "group", "gene"]},
                  {"key": "estimate", "label": "Estimate (OR/HR/effect)", "roles": ["numeric", "log2fc"]},
                  {"key": "ci_low", "label": "CI lower", "roles": ["numeric"]},
                  {"key": "ci_high", "label": "CI upper", "roles": ["numeric"]}],
     "optional": [{"key": "color", "label": "Color by", "roles": ["group", "category", "status"]}],
     "options": [{"key": "ref_line", "label": "Reference line (x)", "type": "number", "default": 1.0},
                 {"key": "sort_by_estimate", "label": "Sort by estimate", "type": "bool", "default": False}]},
    {"type": "dot_plot", "label": "Cleveland dot plot",
     "required": [{"key": "category", "label": "Category", "roles": ["group", "category", "status", "text", "gene"]},
                  {"key": "value", "label": "Value", "roles": ["numeric", "log2fc"]}],
     "optional": [],
     "options": [{"key": "sort_desc", "label": "Sort by value", "type": "bool", "default": True}]},
    {"type": "lollipop", "label": "Lollipop chart",
     "required": [{"key": "category", "label": "Category", "roles": ["group", "category", "status", "text", "gene"]},
                  {"key": "value", "label": "Value", "roles": ["numeric", "log2fc"]}],
     "optional": [],
     "options": [{"key": "sort_desc", "label": "Sort by value", "type": "bool", "default": True}]},
    {"type": "area", "label": "Stacked area chart",
     "required": [{"key": "x", "label": "X (time/order)", "roles": ["time", "numeric"]},
                  {"key": "y", "label": "Value (Y)", "roles": ["numeric"]},
                  {"key": "group", "label": "Series / group", "roles": ["group", "category", "status"]}],
     "optional": [],
     "options": [{"key": "stack_mode", "label": "Stacking", "type": "select", "choices": ["stack", "fill"], "default": "stack"}]},
    {"type": "ridge", "label": "Ridgeline / joyplot",
     "required": [{"key": "value", "label": "Value (numeric)", "roles": ["numeric", "log2fc", "pvalue"]},
                  {"key": "group", "label": "Group (rows)", "roles": ["group", "category", "status"]}],
     "optional": [],
     "options": [{"key": "overlap", "label": "Ridge overlap", "type": "number", "default": 1.4}]},
    {"type": "embedding", "label": "Embedding (UMAP / t-SNE)",
     "required": [{"key": "x", "label": "Dim 1 (X)", "roles": ["numeric"]},
                  {"key": "y", "label": "Dim 2 (Y)", "roles": ["numeric"]}],
     "optional": [{"key": "color", "label": "Color by cluster/label", "roles": ["group", "category", "status"]}],
     "options": [{"key": "show_cluster_labels", "label": "Label clusters", "type": "bool", "default": False}]},
    {"type": "curve_fit", "label": "Curve fit / dose-response",
     "required": [{"key": "x", "label": "X (dose/conc)", "roles": ["numeric", "time"]},
                  {"key": "y", "label": "Y (response)", "roles": ["numeric"]}],
     "optional": [{"key": "group", "label": "Series / group", "roles": ["group", "category", "status"]}],
     "options": [{"key": "fit_model", "label": "Fit model", "type": "select",
                  "choices": ["linear", "4pl", "mm", "exponential", "logistic"], "default": "linear"},
                 {"key": "show_points", "label": "Show data points", "type": "bool", "default": True}]},
]

PLOT_DOMAINS = {
    "box": "basic", "violin": "basic", "scatter": "basic", "bar": "basic", "grouped_bar": "basic", "overlap_bar": "basic", "line": "basic",
    "histogram": "basic", "density": "basic", "correlation_heatmap": "basic", "heatmap": "basic",
    "error_bar": "engineering", "ribbon": "engineering", "contour": "engineering", "radar": "engineering",
    "volcano": "omics", "pca": "omics",
    "kaplan_meier": "clinical", "annotated_heatmap": "clinical",
    "network": "systems_biology",
    "enrichment_dot": "enrichment", "enrichment_bar": "enrichment",
    "manhattan": "genomics",
    "chemical_space": "cheminformatics",
    "sankey": "advanced", "upset": "advanced", "surface_3d": "advanced",
    "scatter_3d": "advanced", "contour_3d": "advanced", "calibration_curve": "advanced",
    "chord_diagram": "advanced", "parallel_coordinates": "advanced",
    "confusion_matrix": "advanced", "tri_surface": "advanced", "wireframe_3d": "advanced",
    "roc_pr_curve": "advanced", "ma_plot": "advanced",
    "sina": "basic", "qq": "basic", "ecdf": "basic", "dot_plot": "basic",
    "lollipop": "basic", "area": "basic", "ridge": "basic",
    "forest": "clinical", "embedding": "omics", "curve_fit": "engineering",
}
DOMAIN_LABELS = {
    "basic": "Basic statistics", "omics": "Omics", "clinical": "Clinical / cohort",
    "systems_biology": "Systems biology", "enrichment": "Functional enrichment",
    "genomics": "Genomics", "cheminformatics": "Cheminformatics",
    "engineering": "Engineering / physical science",
    "advanced": "Advanced & specialized",
}
# ---- universal-capability option metadata (frontend enumeration) ----
_DATA_LABEL_OPTS = [
    {"key": "show_data_labels", "label": "Show data labels", "type": "bool", "default": False},
    {"key": "data_label_format", "label": "Data label format", "type": "select",
     "choices": ["number", "percent", "comma"], "default": "number"},
]
_X_AXIS_OPTS = [
    {"key": "x_breaks", "label": "X tick count", "type": "number", "default": None},
    {"key": "x_tick_format", "label": "X tick format", "type": "select",
     "choices": ["number", "comma", "percent", "scientific"], "default": "number"},
    {"key": "reverse_x", "label": "Reverse X axis", "type": "bool", "default": False},
]
_Y_AXIS_OPTS = [
    {"key": "y_breaks", "label": "Y tick count", "type": "number", "default": None},
    {"key": "y_tick_format", "label": "Y tick format", "type": "select",
     "choices": ["number", "comma", "percent", "scientific"], "default": "number"},
    {"key": "reverse_y", "label": "Reverse Y axis", "type": "bool", "default": False},
]
_ANNOTATION_OPT = {"key": "annotations", "label": "Annotations", "type": "annotations", "default": []}
_SERIES_STYLE_OPT = {"key": "series_styles", "label": "Per-series style", "type": "series_styles", "default": {}}
_TEMPORAL_OPTS = [
    {"key": "x_axis_type", "label": "X axis type", "type": "select",
     "choices": list(_X_AXIS_TYPES), "default": "auto"},
    {"key": "date_format", "label": "Date label format (strftime)", "type": "text", "default": ""},
]

_DATA_LABEL_TARGETS = {"bar", "grouped_bar", "error_bar", "lollipop", "scatter", "line"}
_X_AXIS_TARGETS = {"scatter", "line", "histogram", "area", "dot_plot"}
_Y_AXIS_TARGETS = {"scatter", "line", "histogram", "area", "bar", "grouped_bar",
                   "error_bar", "box", "violin", "lollipop"}
# annotations + series_styles are universal keys; advertise them on the common
# ggplot types so the frontend can surface them.
_ANNOTATION_TARGETS = set(_UNIVERSAL_TYPES)
_SERIES_STYLE_TARGETS = set(_UNIVERSAL_TYPES)
# date/time x axis surfaces only on the continuous-x templates.
_TEMPORAL_TARGETS = set(_TEMPORAL_X_TYPES)


def _extend_options(opts, existing, new_opts):
    for op in new_opts:
        if op["key"] not in existing:
            opts.append(dict(op))
            existing.add(op["key"])


for _p in PLOT_TYPES:
    _t = _p["type"]
    _opts = _p.setdefault("options", [])
    _existing = {op.get("key") for op in _opts}
    if _t in _DATA_LABEL_TARGETS:
        _extend_options(_opts, _existing, _DATA_LABEL_OPTS)
    if _t in _X_AXIS_TARGETS:
        _extend_options(_opts, _existing, _X_AXIS_OPTS)
    if _t in _Y_AXIS_TARGETS:
        _extend_options(_opts, _existing, _Y_AXIS_OPTS)
    if _t in _ANNOTATION_TARGETS:
        _extend_options(_opts, _existing, [_ANNOTATION_OPT])
    if _t in _SERIES_STYLE_TARGETS:
        _extend_options(_opts, _existing, [_SERIES_STYLE_OPT])
    if _t in _TEMPORAL_TARGETS:
        _extend_options(_opts, _existing, _TEMPORAL_OPTS)

for _p in PLOT_TYPES:
    _p["domain"] = PLOT_DOMAINS.get(_p["type"], "basic")

PLOT_TYPE_KEYS = {p["type"] for p in PLOT_TYPES}
