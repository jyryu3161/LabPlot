"""Generate self-contained R (ggplot2) code per plot type.

Each builder returns an R snippet that constructs a ggplot object `p` from a
data frame `df`, using literal column names via tidy-eval `.data[["col"]]`.
Only packages available in the r-viz env are used: ggplot2, dplyr, tidyr,
readr, scales, viridisLite (+ base stats/grDevices).
"""
from __future__ import annotations

from typing import Any


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


# ---------------------------------------------------------------- builders
def _box(m, o):
    x, y = m["x"], m["y"]
    color = m.get("color") or x
    points = "  geom_jitter(width = 0.15, size = 1.1, alpha = 0.45) +\n" if o.get("show_points", True) else ""
    return f"""
p <- ggplot(df, aes(x = factor({_data(x)}), y = {_data(y)}, fill = factor({_data(color)}))) +
  geom_boxplot(outlier.size = 0.8, alpha = 0.9, width = 0.65) +
{points}  scale_fill_manual(values = labplot_palette()) +
  {_labs(o, x, y)} + guides(fill = guide_legend(title = {rq(color)}))
"""


def _violin(m, o):
    x, y = m["x"], m["y"]
    color = m.get("color") or x
    inner = "  geom_boxplot(width = 0.12, fill = \"white\", alpha = 0.7, outlier.shape = NA) +\n" if o.get("show_box", True) else ""
    points = "  geom_jitter(width = 0.12, size = 1.0, alpha = 0.4) +\n" if o.get("show_points", False) else ""
    return f"""
p <- ggplot(df, aes(x = factor({_data(x)}), y = {_data(y)}, fill = factor({_data(color)}))) +
  geom_violin(trim = FALSE, alpha = 0.85, scale = "width") +
{inner}{points}  scale_fill_manual(values = labplot_palette()) +
  {_labs(o, x, y)} + guides(fill = guide_legend(title = {rq(color)}))
"""


def _scatter(m, o):
    x, y = m["x"], m["y"]
    color = m.get("color")
    smooth = '  geom_smooth(method = "lm", se = TRUE, colour = "#3C5488", fill = "grey80", alpha = 0.4) +\n' if o.get("add_smooth", False) else ""
    if color:
        aes = f"aes(x = {_data(x)}, y = {_data(y)}, colour = factor({_data(color)}))"
        scale = "  scale_colour_manual(values = labplot_palette()) +\n"
        guide = f" + guides(colour = guide_legend(title = {rq(color)}))"
    else:
        aes = f"aes(x = {_data(x)}, y = {_data(y)})"
        scale = ""
        guide = ""
    return f"""
p <- ggplot(df, {aes}) +
{smooth}  geom_point(size = 2.0, alpha = 0.8) +
{scale}  {_labs(o, x, y)}{guide}
"""


def _bar(m, o):
    x = m["x"]
    stat = o.get("stat", m.get("stat", "mean"))
    if stat == "count" or not m.get("y"):
        return f"""
p <- ggplot(df, aes(x = factor({_data(x)}), fill = factor({_data(x)}))) +
  geom_bar() +
  scale_fill_manual(values = labplot_palette()) +
  {_labs(o, x, "count")} + guides(fill = "none")
"""
    y = m["y"]
    fun = "mean" if stat == "mean" else "sum"
    err = ""
    if stat == "mean" and o.get("error_bars", True):
        err = """  geom_errorbar(aes(ymin = .val - .sd, ymax = .val + .sd), width = 0.2, linewidth = 0.4) +
"""
    return f"""
.summ <- df %>% dplyr::group_by(.grp = factor({_data(x)})) %>%
  dplyr::summarise(.val = {fun}({_data(y)}, na.rm = TRUE),
                   .sd = stats::sd({_data(y)}, na.rm = TRUE), .groups = "drop")
.summ$.sd[is.na(.summ$.sd)] <- 0
p <- ggplot(.summ, aes(x = .grp, y = .val, fill = .grp)) +
  geom_col(width = 0.7, alpha = 0.92) +
{err}  scale_fill_manual(values = labplot_palette()) +
  {_labs(o, x, f"{fun}({y})")} + guides(fill = "none")
"""


def _line(m, o):
    x, y = m["x"], m["y"]
    group = m.get("group")
    if group:
        aes = f"aes(x = {_data(x)}, y = {_data(y)}, colour = factor({_data(group)}), group = factor({_data(group)}))"
        scale = "  scale_colour_manual(values = labplot_palette()) +\n"
        guide = f" + guides(colour = guide_legend(title = {rq(group)}))"
    else:
        aes = f"aes(x = {_data(x)}, y = {_data(y)}, group = 1)"
        scale = ""
        guide = ""
    return f"""
p <- ggplot(df, {aes}) +
  geom_line(linewidth = 0.9) +
  geom_point(size = 1.8) +
{scale}  {_labs(o, x, y)}{guide}
"""


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
        f"  geom_density(aes(y = after_stat(count)), linewidth = 0.7, colour = \"grey20\", fill = NA) +\n"
        if density and not group else ""
    )
    return f"""
p <- ggplot(df, {aes}) +
  geom_histogram(bins = {bins}, colour = "white", linewidth = 0.2, alpha = 0.85{position}) +
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
    rug_layer = "  geom_rug(alpha = 0.25, linewidth = 0.2) +\n" if rug else ""
    return f"""
p <- ggplot(df, {aes}) +
  geom_density(alpha = 0.28, linewidth = 0.9) +
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
.cor <- stats::cor(.mat, use = "pairwise.complete.obs", method = "{method}")
.long <- as.data.frame(as.table(.cor))
colnames(.long) <- c("x", "y", "value")
.long$x <- factor(.long$x, levels = .cols)
.long$y <- factor(.long$y, levels = rev(.cols))
p <- ggplot(.long, aes(x = x, y = y, fill = value)) +
  geom_tile(colour = "white", linewidth = 0.4) +
  scale_fill_gradient2(low = "#3C5488", mid = "white", high = "#E64B35", midpoint = 0,
                       limits = c(-1, 1), name = "r") +
  {_labs(o, "", "")} +
  coord_equal() +
  theme(axis.text.x = element_text(angle = 45, hjust = 1),
        panel.grid = element_blank())
if ({show_values}) {{
  p <- p + geom_text(aes(label = sprintf("%.2f", value)), size = 2.6, colour = "grey20")
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
    scale_rows = ""
    if o.get("scale_rows", False):
        scale_rows = ".mat <- t(scale(t(.mat)));\n"
    if o.get("color_mode") == "grayscale":
        fill_scale = 'scale_fill_gradient(low = "grey92", high = "grey15", na.value = "grey85")'
    else:
        fill_scale = f'scale_fill_viridis_c(option = "{o.get("palette", "viridis")}", na.value = "grey85")'
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
p <- p + geom_text(data = .top, aes(label = {_data(gene)}), size = 2.8, vjust = -0.6, show.legend = FALSE)
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
  {'scale_colour_manual(values = c(Down = "grey60", NS = "grey85", Up = "black"))' if o.get("color_mode") == "grayscale" else 'scale_colour_manual(values = c(Down = "#4DBBD5", NS = "grey70", Up = "#E64B35"))'} +
  geom_vline(xintercept = c(-{fc_t}, {fc_t}), linetype = "dashed", colour = "grey50", linewidth = 0.3) +
  geom_hline(yintercept = -log10({p_t}), linetype = "dashed", colour = "grey50", linewidth = 0.3) +
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
  geom_point(size = 2.4, alpha = 0.85, colour = "#3C5488") +
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
  geom_step(linewidth = 0.9) +
  scale_colour_manual(values = labplot_palette()) +
  coord_cartesian(ylim = c(0, 1)) +
  {_labs(o, "Time", "Survival probability")} +
  guides(colour = guide_legend(title = {rq(group) if group else 'NULL'})) +
  theme(legend.position = "{legend}")
"""


_BUILDERS = {
    "box": _box,
    "violin": _violin,
    "scatter": _scatter,
    "bar": _bar,
    "line": _line,
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
     "options": [{"key": "show_points", "label": "Show points", "type": "bool", "default": True}]},
    {"type": "violin", "label": "Violin plot",
     "required": [{"key": "x", "label": "Group (X)", "roles": ["group", "category", "status"]},
                  {"key": "y", "label": "Value (Y)", "roles": ["numeric", "log2fc", "pvalue"]}],
     "optional": [{"key": "color", "label": "Color by", "roles": ["group", "category", "status"]}],
     "options": [{"key": "show_box", "label": "Inner boxplot", "type": "bool", "default": True},
                 {"key": "show_points", "label": "Show points", "type": "bool", "default": False}]},
    {"type": "scatter", "label": "Scatter plot",
     "required": [{"key": "x", "label": "X (numeric)", "roles": ["numeric", "log2fc", "pvalue", "time"]},
                  {"key": "y", "label": "Y (numeric)", "roles": ["numeric", "log2fc", "pvalue"]}],
     "optional": [{"key": "color", "label": "Color by", "roles": ["group", "category", "status"]}],
     "options": [{"key": "add_smooth", "label": "Regression line", "type": "bool", "default": False}]},
    {"type": "bar", "label": "Bar plot",
     "required": [{"key": "x", "label": "Category (X)", "roles": ["group", "category", "status"]}],
     "optional": [{"key": "y", "label": "Value (Y)", "roles": ["numeric", "log2fc"]}],
     "options": [{"key": "stat", "label": "Statistic", "type": "select", "choices": ["mean", "sum", "count"], "default": "mean"},
                 {"key": "error_bars", "label": "Error bars (SD)", "type": "bool", "default": True}]},
    {"type": "line", "label": "Line plot",
     "required": [{"key": "x", "label": "X (time/order)", "roles": ["time", "numeric", "category"]},
                  {"key": "y", "label": "Y (numeric)", "roles": ["numeric"]}],
     "optional": [{"key": "group", "label": "Group/Color", "roles": ["group", "category", "status"]}],
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
                 {"key": "palette", "label": "Palette", "type": "select", "choices": ["viridis", "magma", "inferno", "plasma", "cividis"], "default": "viridis"}]},
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


def build_plot_r(plot_type: str, mapping: dict, options: dict) -> str:
    builder = _BUILDERS.get(plot_type)
    if builder is None:
        raise ValueError(f"Unknown plot type: {plot_type}")
    return builder(mapping, options or {})


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
    color_scale = '  scale_colour_gradient(low = "#E64B35", high = "#3C5488", name = "p.adjust") +\n' if color else ""
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
  scale_fill_gradient(low = "#4DBBD5", high = "#E64B35", guide = "none") +
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
  scale_colour_manual(values = c("0" = "#3C5488", "1" = "#4DBBD5"), guide = "none") +
  scale_x_continuous(breaks = as.numeric(.centers), labels = names(.centers), expand = c(0.01, 0)) +
  geom_hline(yintercept = -log10({thr}), linetype = "dashed", colour = "#E64B35", linewidth = 0.4) +
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
    layout = o.get("layout", "fr")
    label = o.get("show_labels", True)
    label_block = "  geom_node_text(aes(label = name), repel = TRUE, size = 2.6, colour = \"grey20\") +\n" if label else ""
    edge_w = f"aes(width = {_data(weight)}), " if weight else ""
    edge_width_scale = "  ggraph::scale_edge_width(range = c(0.3, 2), guide = \"none\") +\n" if weight else ""
    return f"""
suppressMessages({{library(igraph); library(ggraph); library(tidygraph)}})
.edges <- data.frame(from = as.character({_col(src)}), to = as.character({_col(tgt)}), stringsAsFactors = FALSE)
{f'.edges$weight <- suppressWarnings(as.numeric({_col(weight)}))' if weight else ''}
.g <- igraph::graph_from_data_frame(.edges, directed = FALSE)
igraph::V(.g)$deg <- igraph::degree(.g)
p <- ggraph(.g, layout = "{layout}") +
  geom_edge_link({edge_w}alpha = 0.25, colour = "grey55") +
{edge_width_scale}  geom_node_point(aes(size = deg), colour = "#E64B35", alpha = 0.9) +
{label_block}  scale_size(range = c(2, 9), guide = "none") +
  labs(title = {rq(o.get('title')) if o.get('title') else 'NULL'}) +
  theme_void(base_size = 12) +
  theme(plot.title = element_text(face = "bold", hjust = 0.5))
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
        colmap = 'circlize::colorRamp2(c(-2, 0, 2), c("#3C5488", "white", "#E64B35"))'
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
  .ra <- ComplexHeatmap::rowAnnotation(df = .anndf)
}}
draw_plot <- function() {{
  ht <- ComplexHeatmap::Heatmap(.mat, name = "z-score", col = {colmap},
    cluster_rows = {cluster_rows}, cluster_columns = {cluster_cols},
    show_row_names = {show_rn}, row_names_gp = grid::gpar(fontsize = 7),
    column_names_gp = grid::gpar(fontsize = 9), right_annotation = .ra,
    column_title = {title})
  ComplexHeatmap::draw(ht, merge_legends = TRUE)
}}
"""


_BUILDERS.update({
    "enrichment_dot": _enrichment_dot,
    "enrichment_bar": _enrichment_bar,
    "manhattan": _manhattan,
    "chemical_space": _chemical_space,
    "network": _network,
    "annotated_heatmap": _annotated_heatmap,
})

# plot types that render via base-graphics devices (not ggsave) / skip ggplot theme
DEVICE_TYPES = {"annotated_heatmap"}
NO_THEME_TYPES = {"network", "annotated_heatmap"}

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
]

PLOT_DOMAINS = {
    "box": "basic", "violin": "basic", "scatter": "basic", "bar": "basic", "line": "basic",
    "histogram": "basic", "density": "basic", "correlation_heatmap": "basic", "heatmap": "basic",
    "volcano": "omics", "pca": "omics",
    "kaplan_meier": "clinical", "annotated_heatmap": "clinical",
    "network": "systems_biology",
    "enrichment_dot": "enrichment", "enrichment_bar": "enrichment",
    "manhattan": "genomics",
    "chemical_space": "cheminformatics",
}
DOMAIN_LABELS = {
    "basic": "Basic statistics", "omics": "Omics", "clinical": "Clinical / cohort",
    "systems_biology": "Systems biology", "enrichment": "Functional enrichment",
    "genomics": "Genomics", "cheminformatics": "Cheminformatics",
}
for _p in PLOT_TYPES:
    _p["domain"] = PLOT_DOMAINS.get(_p["type"], "basic")

PLOT_TYPE_KEYS = {p["type"] for p in PLOT_TYPES}
