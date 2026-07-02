"""Deterministic, instant chart suggestions from a dataset column profile.

Returned shape matches the AI recommendation shape so the UI can render both
identically (source field distinguishes them).
"""
from __future__ import annotations

import re
from typing import Any

MAX_RULE_SUGGESTIONS = 5


def _by_role(columns: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    buckets: dict[str, list[dict[str, Any]]] = {}
    for c in columns:
        buckets.setdefault(c.get("role", "text"), []).append(c)
    return buckets


def _names(cols: list[dict[str, Any]]) -> list[str]:
    return [c["name"] for c in cols]


def _first(cols: list[dict[str, Any]]) -> str | None:
    return cols[0]["name"] if cols else None


def _match(cols: list[dict[str, Any]], pattern: str) -> str | None:
    rx = re.compile(pattern, re.I)
    for col in cols:
        if rx.search(str(col.get("name", ""))):
            return col["name"]
    return None


def _is_chromosome_name(col: dict[str, Any]) -> bool:
    return bool(re.search(r"\b(chr|chrom|chromosome)\b", str(col.get("name", "")), re.I))


def _best_group(cols: list[dict[str, Any]]) -> str | None:
    if not cols:
        return None
    ranked = sorted(
        cols,
        key=lambda c: (
            0 if c.get("role") == "group" else 1 if c.get("role") == "status" else 2,
            int(c.get("n_unique") or 999),
            c["name"].lower(),
        ),
    )
    return ranked[0]["name"]


def _mapping(data: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in data.items() if v not in (None, "", [])}


def suggest_charts(columns: list[dict[str, Any]], limit: int = MAX_RULE_SUGGESTIONS) -> list[dict[str, Any]]:
    b = _by_role(columns)
    numeric_cols = b.get("numeric", [])
    log2fc_cols = b.get("log2fc", [])
    pvalue_cols = b.get("pvalue", [])
    group_cols = b.get("group", []) + b.get("category", []) + b.get("status", [])
    time_cols = [c for c in b.get("time", []) if not _is_chromosome_name(c)]
    status_cols = b.get("status", [])
    gene_cols = b.get("gene", [])
    text_cols = b.get("text", []) + b.get("category", []) + b.get("group", []) + gene_cols

    numeric = _names(numeric_cols)
    log2fc = _names(log2fc_cols)
    pvalue = _names(pvalue_cols)
    group = _names(group_cols)
    time = _names(time_cols)
    status = _names(status_cols)
    gene = _names(gene_cols)
    matrix_cols = numeric + log2fc
    primary_group = _best_group(group_cols)
    all_cols = columns

    suggestions: list[dict[str, Any]] = []

    def add(plot_type: str, title: str, score: float, rationale: str,
            mapping: dict[str, Any], required: dict[str, Any], fit: str) -> None:
        suggestions.append({
            "plot_type": plot_type,
            "title": title,
            "score": score,
            "rationale": rationale,
            "suggested_mapping": _mapping(mapping),
            "required_vars": required,
            "fit": fit,
            "source": "rule",
        })

    x_coord = _match(numeric_cols, r"^(x|x[_\s-]*coord|temperature|temp|dose|pressure|speed|load)$")
    y_coord = _match(numeric_cols, r"^(y|y[_\s-]*coord|pressure|humidity|ph|time|speed|load)$")
    z_coord = _match(numeric_cols, r"\b(z|response|yield|intensity|height|surface|signal|strength|stress|efficiency)\b")
    if x_coord and y_coord and z_coord and len({x_coord, y_coord, z_coord}) == 3:
        add("contour", "Contour / response surface", 0.94,
            "Detected x/y coordinate-style columns plus a response column, which fits a contour or response-surface visualization.",
            {"x": x_coord, "y": y_coord, "z": z_coord},
            {"x": [x_coord], "y": [y_coord], "z": [z_coord]},
            "exact")

    lower = _match(numeric_cols, r"\b(ymin|lower|low|lcl|ci[_\s-]*low|min)\b")
    upper = _match(numeric_cols, r"\b(ymax|upper|high|ucl|ci[_\s-]*high|max)\b")
    error = _match(numeric_cols, r"\b(sd|se|sem|stderr|std[_\s-]*err|error|err)\b")
    mean_value = _match(numeric_cols, r"\b(mean|avg|average|value|response|signal|strength|stress)\b") or _first(numeric_cols)
    x_interval = time[0] if time else primary_group
    if x_interval and mean_value and (error or (lower and upper)):
        add("error_bar", "Error bar plot", 0.96,
            "Detected a measured value with uncertainty columns, which fits an error-bar plot.",
            {"x": x_interval, "y": mean_value, "group": primary_group if x_interval != primary_group else None,
             "error": error, "ymin": lower, "ymax": upper},
            {"x": [x_interval], "y": [mean_value], "error": [error] if error else [], "ymin": [lower] if lower else [], "ymax": [upper] if upper else []},
            "strong")
        if time and lower and upper:
            add("ribbon", "Ribbon / interval plot", 0.97,
                "Detected ordered/time data with lower and upper bounds, which fits an interval ribbon plot.",
                {"x": time[0], "y": mean_value, "group": primary_group, "ymin": lower, "ymax": upper},
                {"x": time[:3], "y": [mean_value], "ymin": [lower], "ymax": [upper]},
                "strong")

    metric = _match(text_cols, r"\b(metric|axis|parameter|property|dimension|variable)\b")
    if metric and mean_value:
        series = next((c["name"] for c in group_cols if c["name"] != metric), None)
        add("radar", "Radar / polar plot", 0.94,
            "Detected metric/property labels with numeric values, suitable for comparing profiles across axes.",
            {"axis": metric, "value": mean_value, "group": series},
            {"axis": [metric], "value": [mean_value]},
            "good")

    chrom = _match(all_cols, r"\b(chr|chrom|chromosome)\b")
    pos = _match(numeric_cols, r"\b(pos|position|bp|base[_\s-]*pair)\b")
    if chrom and pos and pvalue:
        add("manhattan", "Manhattan plot", 0.98,
            "Detected chromosome, genomic position, and p-value columns required for a GWAS-style Manhattan plot.",
            {"chrom": chrom, "pos": pos, "pvalue": pvalue[0]},
            {"chrom": [chrom], "pos": [pos], "pvalue": pvalue[:3]},
            "exact")

    if log2fc and pvalue:
        add("volcano", "Volcano plot", 0.97,
            "Detected effect-size and p-value columns, which are the required structure for differential analysis visualization.",
            {"log2fc": log2fc[0], "pvalue": pvalue[0], "gene_label": _first(gene_cols)},
            {"log2fc": log2fc[:3], "pvalue": pvalue[:3]},
            "exact")

    if time and status:
        add("kaplan_meier", "Kaplan-Meier plot", 0.95,
            "Detected time-to-event and event/status columns, which are required for a survival curve.",
            {"time": time[0], "status": status[0], "group": primary_group},
            {"time": time[:3], "status": status[:3]},
            "exact")

    source = _match(text_cols, r"\b(source|from|protein[_\s-]*1|gene[_\s-]*a|interactor[_\s-]*a)\b")
    target = _match(text_cols, r"\b(target|to|protein[_\s-]*2|gene[_\s-]*b|interactor[_\s-]*b)\b")
    if source and target and source != target:
        add("network", "Network", 0.93,
            "Detected source and target node columns, which fit a network edge-list structure.",
            {"source": source, "target": target, "weight": _first(numeric_cols)},
            {"source": [source], "target": [target]},
            "exact")

    term = _match(text_cols, r"\b(term|pathway|go|description|process|category)\b")
    if term and (numeric or pvalue):
        value = numeric[0] if numeric else pvalue[0]
        add("enrichment_dot", "Enrichment dot plot", 0.9,
            "Detected a term/pathway column and numeric score/count columns suitable for enrichment-style ranking.",
            {"term": term, "value": value, "color": (pvalue[0] if pvalue else None)},
            {"term": [term], "value": (numeric[:5] or pvalue[:3])},
            "strong")

    if time and numeric:
        add("line", "Line plot", 0.89,
            f"Use a line plot to show how '{numeric[0]}' changes over ordered/time column '{time[0]}'.",
            {"x": time[0], "y": numeric[0], "group": primary_group},
            {"x": time[:3], "y": numeric[:5]},
            "strong")

    if primary_group and numeric:
        if len(group_cols) >= 2:
            x_group = _match(group_cols, r"\b(benchmark|dataset|task|metric|scenario|category|endpoint)\b") or primary_group
            series_group = (
                _match([c for c in group_cols if c["name"] != x_group], r"\b(model|method|algorithm|series|condition|group|treatment)\b")
                or next((c["name"] for c in group_cols if c["name"] != x_group), None)
            )
            if series_group:
                add("grouped_bar", "Grouped bar chart", 0.95,
                    f"Compare '{numeric[0]}' across '{x_group}' with side-by-side bars for '{series_group}'.",
                    {"x": x_group, "y": numeric[0], "group": series_group},
                    {"x": group[:4], "y": numeric[:5], "group": group[:4]},
                    "strong")
        add("box", "Box plot", 0.92,
            f"Compare the distribution of '{numeric[0]}' across categorical groups in '{primary_group}'.",
            {"x": primary_group, "y": numeric[0], "color": primary_group},
            {"x": group[:3], "y": numeric[:5]},
            "strong")
        add("violin", "Violin plot", 0.84,
            f"Compare distribution shape and density of '{numeric[0]}' across '{primary_group}'.",
            {"x": primary_group, "y": numeric[0], "color": primary_group},
            {"x": group[:3], "y": numeric[:5]},
            "good")
        add("bar", "Bar plot", 0.76,
            f"Summarize '{numeric[0]}' by '{primary_group}' using a mean or sum.",
            {"x": primary_group, "y": numeric[0], "stat": "mean"},
            {"x": group[:3], "y": numeric[:5]},
            "good")
        add("density", "Density plot", 0.74,
            f"Show the distribution shape of '{numeric[0]}' with optional grouping by '{primary_group}'.",
            {"value": numeric[0], "group": primary_group},
            {"value": numeric[:5], "group": group[:3]},
            "good")

    if len(numeric) >= 2:
        add("scatter", "Scatter plot", 0.88,
            f"Inspect the relationship between numeric variables '{numeric[0]}' and '{numeric[1]}'.",
            {"x": numeric[0], "y": numeric[1], "color": primary_group},
            {"x": numeric[:5], "y": numeric[:5]},
            "strong")

    if numeric:
        add("histogram", "Histogram", 0.72,
            f"Show the univariate distribution of numeric column '{numeric[0]}'.",
            {"value": numeric[0], "group": primary_group},
            {"value": numeric[:5]},
            "good")

    if len(numeric) >= 3:
        add("correlation_heatmap", "Correlation heatmap", 0.76,
            f"Summarize pairwise correlations across {len(numeric)} numeric variables.",
            {"columns": numeric[:20]},
            {"columns": numeric[:50]},
            "good")

    if len(matrix_cols) >= 4:
        heatmap_score = 0.9 if gene else 0.8 if primary_group else 0.76
        pca_score = 0.94 if primary_group and not gene else 0.78 if not gene else 0.7
        add("heatmap", "Heatmap", heatmap_score,
            f"Display {len(matrix_cols)} numeric feature columns as a matrix and encode patterns with color.",
            {"columns": matrix_cols[:50], "row_label": _first(gene_cols)},
            {"columns": matrix_cols[:50]},
            "good")
        add("pca", "PCA plot", pca_score,
            f"Run PCA across {len(matrix_cols)} numeric feature columns to inspect sample clustering.",
            {"columns": matrix_cols[:50], "color": primary_group},
            {"columns": matrix_cols[:50]},
            "good")
        if primary_group:
            add("annotated_heatmap", "Annotated heatmap", 0.86 if not gene else 0.78,
                "Numeric feature columns plus grouping annotations fit an annotated cohort heatmap.",
                {"columns": matrix_cols[:50], "annotations": [primary_group], "row_label": _first(gene_cols)},
                {"columns": matrix_cols[:50], "annotations": group[:5]},
                "good")

    if primary_group and not numeric:
        add("bar", "Bar plot (count)", 0.82,
            f"Show category frequencies for '{primary_group}' as bars.",
            {"x": primary_group, "stat": "count"},
            {"x": group[:3]},
            "strong")

    # --- forest plot: effect estimate + lower/upper CI + a label column ---
    estimate = _match(
        numeric_cols + log2fc_cols,
        r"\b(estimate|effect|coef|coefficient|beta|odds[_\s-]*ratio|or|hazard[_\s-]*ratio|hr|rr|log2fc|logfc|mean[_\s-]*diff)\b",
    )
    ci_low = _match(numeric_cols, r"\b(ci[_\s-]*low|ci[_\s-]*lower|lower|lcl|l95|conf[_\s-]*low)\b")
    ci_high = _match(numeric_cols, r"\b(ci[_\s-]*high|ci[_\s-]*upper|upper|ucl|u95|conf[_\s-]*high)\b")
    forest_label = _match(text_cols, r"\b(study|trial|variable|term|subgroup|cohort|comparison|outcome|label|name)\b") or _first(text_cols)
    if estimate and ci_low and ci_high and forest_label and ci_low != ci_high:
        add("forest", "Forest plot", 0.95,
            "Detected an effect estimate with lower/upper confidence bounds and a label column, the structure of a forest plot.",
            {"label": forest_label, "estimate": estimate, "ci_low": ci_low, "ci_high": ci_high},
            {"label": [forest_label], "estimate": [estimate], "ci_low": [ci_low], "ci_high": [ci_high]},
            "exact")

    # --- dose-response / curve fit: dose-like x with response-like y ---
    dose_x = _match(numeric_cols, r"\b(dose|conc|concentration|log[_\s-]*dose|log[_\s-]*conc)\b")
    resp_y = _match(numeric_cols, r"\b(response|inhibition|viability|activity|signal|absorbance|od|effect|survival|growth)\b")
    if dose_x and resp_y and dose_x != resp_y:
        add("curve_fit", "Curve fit / dose-response", 0.9,
            "Detected dose/concentration and response columns suitable for a fitted dose-response (4PL) curve.",
            {"x": dose_x, "y": resp_y, "group": primary_group, "fit_model": "4pl"},
            {"x": [dose_x], "y": [resp_y]},
            "strong")

    # --- embedding scatter: precomputed 2-D coordinates (UMAP / t-SNE) ---
    emb_x = _match(numeric_cols, r"\b(umap[_\s-]*1|tsne[_\s-]*1|t[_\s-]*sne[_\s-]*1|dim[_\s-]*1|component[_\s-]*1|embedding[_\s-]*1)\b")
    emb_y = _match(numeric_cols, r"\b(umap[_\s-]*2|tsne[_\s-]*2|t[_\s-]*sne[_\s-]*2|dim[_\s-]*2|component[_\s-]*2|embedding[_\s-]*2)\b")
    if emb_x and emb_y and emb_x != emb_y:
        add("embedding", "Embedding (UMAP / t-SNE)", 0.92,
            "Detected two precomputed embedding coordinate columns, ideal for a UMAP/t-SNE style labeled scatter.",
            {"x": emb_x, "y": emb_y, "color": primary_group},
            {"x": [emb_x], "y": [emb_y]},
            "exact")

    # --- stacked area: composition over an ordered/time axis by group ---
    if time and numeric and primary_group:
        add("area", "Stacked area chart", 0.78,
            f"Show how the composition of '{numeric[0]}' across '{primary_group}' evolves over '{time[0]}'.",
            {"x": time[0], "y": numeric[0], "group": primary_group},
            {"x": time[:3], "y": numeric[:5], "group": group[:3]},
            "good")

    # --- sina / beeswarm and single-column distribution diagnostics ---
    if primary_group and numeric:
        add("sina", "Sina / beeswarm plot", 0.7,
            f"Show every observation of '{numeric[0]}' across '{primary_group}' with a beeswarm/sina layout.",
            {"x": primary_group, "y": numeric[0], "color": primary_group},
            {"x": group[:3], "y": numeric[:5]},
            "good")
    if numeric:
        add("ecdf", "Empirical CDF (ECDF)", 0.6,
            f"Show the empirical cumulative distribution of '{numeric[0]}'.",
            {"value": numeric[0], "group": primary_group},
            {"value": numeric[:5]},
            "good")
        add("qq", "Q-Q (normal) plot", 0.58,
            f"Assess the normality of '{numeric[0]}' with a quantile-quantile plot.",
            {"value": numeric[0], "group": primary_group},
            {"value": numeric[:5]},
            "good")

    best_by_type: dict[str, dict[str, Any]] = {}
    for suggestion in suggestions:
        current = best_by_type.get(suggestion["plot_type"])
        if current is None or suggestion["score"] > current["score"]:
            best_by_type[suggestion["plot_type"]] = suggestion

    out = sorted(best_by_type.values(), key=lambda s: s["score"], reverse=True)[:limit]
    for rank, suggestion in enumerate(out, start=1):
        suggestion["rank"] = rank
    return out
