"""Deterministic, instant chart suggestions from a dataset column profile.

Returned shape matches the AI recommendation shape so the UI can render both
identically (source field distinguishes them).
"""
from __future__ import annotations


def _by_role(columns: list[dict]):
    buckets: dict[str, list[str]] = {}
    for c in columns:
        buckets.setdefault(c["role"], []).append(c["name"])
    return buckets


def suggest_charts(columns: list[dict]) -> list[dict]:
    b = _by_role(columns)
    numeric = b.get("numeric", [])
    group = b.get("group", []) + b.get("category", [])
    time = b.get("time", [])
    status = b.get("status", [])
    log2fc = b.get("log2fc", [])
    pvalue = b.get("pvalue", [])
    gene = b.get("gene", [])
    # numeric-ish columns usable as a heatmap/PCA matrix
    matrix_cols = numeric + log2fc

    out: list[dict] = []

    def add(plot_type, title, score, rationale, mapping, required):
        out.append({
            "plot_type": plot_type,
            "title": title,
            "score": score,
            "rationale": rationale,
            "suggested_mapping": mapping,
            "required_vars": required,
            "source": "rule",
        })

    if log2fc and pvalue:
        add("volcano", "Volcano plot", 0.97,
            "Detected log2 fold-change and p-value columns, which are suitable for differential expression visualization.",
            {"log2fc": log2fc[0], "pvalue": pvalue[0], "gene_label": (gene[0] if gene else None)},
            {"log2fc": log2fc[:3], "pvalue": pvalue[:3]})

    if time and status:
        add("kaplan_meier", "Kaplan-Meier plot", 0.95,
            "Detected time and status/event columns, which are suitable for survival curve analysis.",
            {"time": time[0], "status": status[0], "group": (group[0] if group else None)},
            {"time": time[:3], "status": status[:3]})

    if group and numeric:
        add("density", "Density plot", 0.86,
            f"Compare the distribution shape of '{numeric[0]}' across groups in '{group[0]}'.",
            {"value": numeric[0], "group": group[0]},
            {"value": numeric[:5], "group": group[:3]})
        add("box", "Box plot", 0.9,
            f"Compare the distribution of numeric column '{numeric[0]}' across categorical groups in '{group[0]}'.",
            {"x": group[0], "y": numeric[0], "color": group[0]},
            {"x": group[:3], "y": numeric[:5]})
        add("violin", "Violin plot", 0.84,
            "Use this when the distribution shape and density by group are important.",
            {"x": group[0], "y": numeric[0], "color": group[0]},
            {"x": group[:3], "y": numeric[:5]})
        add("bar", "Bar plot", 0.7,
            "Highlight grouped summary values such as mean or sum.",
            {"x": group[0], "y": numeric[0], "stat": "mean"},
            {"x": group[:3], "y": numeric[:5]})

    if numeric:
        add("histogram", "Histogram", 0.82,
            f"Show the univariate distribution of numeric column '{numeric[0]}'.",
            {"value": numeric[0], "group": (group[0] if group else None)},
            {"value": numeric[:5]})

    if len(numeric) >= 2:
        add("scatter", "Scatter plot", 0.88,
            f"Inspect the relationship between numeric variables '{numeric[0]}' and '{numeric[1]}'.",
            {"x": numeric[0], "y": numeric[1], "color": (group[0] if group else None)},
            {"x": numeric[:5], "y": numeric[:5]})
        add("correlation_heatmap", "Correlation heatmap", 0.78,
            f"Summarize pairwise correlations across {len(numeric)} numeric variables.",
            {"columns": numeric[:20]},
            {"columns": numeric[:50]})

    if time and numeric:
        add("line", "Line plot", 0.8,
            f"Show how '{numeric[0]}' changes over '{time[0]}' in a time-course view.",
            {"x": time[0], "y": numeric[0], "group": (group[0] if group else None)},
            {"x": time[:3], "y": numeric[:5]})

    if len(matrix_cols) >= 2:
        add("heatmap", "Heatmap", 0.72,
            f"Display {len(matrix_cols)} numeric columns as a matrix and encode patterns with color.",
            {"columns": matrix_cols[:50], "row_label": (gene[0] if gene else None)},
            {"columns": matrix_cols[:50]})

    if len(numeric) >= 3:
        add("pca", "PCA plot", 0.68,
            f"Run PCA across {len(numeric)} numeric variables to inspect sample clustering.",
            {"columns": numeric[:50], "color": (group[0] if group else None)},
            {"columns": numeric[:50]})

    if group and not numeric:
        add("bar", "Bar plot (count)", 0.6,
            "Show category frequencies as bars.",
            {"x": group[0], "stat": "count"},
            {"x": group[:3]})

    out.sort(key=lambda s: s["score"], reverse=True)
    return out
