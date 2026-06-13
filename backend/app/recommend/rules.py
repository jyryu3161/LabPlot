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
            "log2 fold-change와 p-value 컬럼이 감지되어 차등발현(DEG) 시각화에 적합합니다.",
            {"log2fc": log2fc[0], "pvalue": pvalue[0], "gene_label": (gene[0] if gene else None)},
            {"log2fc": log2fc[:3], "pvalue": pvalue[:3]})

    if time and status:
        add("kaplan_meier", "Kaplan-Meier plot", 0.95,
            "time과 status(event) 컬럼이 있어 생존 곡선 분석에 적합합니다.",
            {"time": time[0], "status": status[0], "group": (group[0] if group else None)},
            {"time": time[:3], "status": status[:3]})

    if group and numeric:
        add("box", "Box plot", 0.9,
            f"범주형 '{group[0]}'에 따른 수치형 '{numeric[0]}' 분포 비교에 적합합니다.",
            {"x": group[0], "y": numeric[0], "color": group[0]},
            {"x": group[:3], "y": numeric[:5]})
        add("violin", "Violin plot", 0.84,
            "그룹별 분포의 형태(밀도)까지 보고 싶을 때 적합합니다.",
            {"x": group[0], "y": numeric[0], "color": group[0]},
            {"x": group[:3], "y": numeric[:5]})
        add("bar", "Bar plot", 0.7,
            "그룹별 요약값(평균/합)을 강조해 표시합니다.",
            {"x": group[0], "y": numeric[0], "stat": "mean"},
            {"x": group[:3], "y": numeric[:5]})

    if len(numeric) >= 2:
        add("scatter", "Scatter plot", 0.88,
            f"두 수치형 변수 '{numeric[0]}'와 '{numeric[1]}'의 관계를 봅니다.",
            {"x": numeric[0], "y": numeric[1], "color": (group[0] if group else None)},
            {"x": numeric[:5], "y": numeric[:5]})

    if time and numeric:
        add("line", "Line plot", 0.8,
            f"'{time[0]}'에 따른 '{numeric[0]}' 변화(time-course)를 봅니다.",
            {"x": time[0], "y": numeric[0], "group": (group[0] if group else None)},
            {"x": time[:3], "y": numeric[:5]})

    if len(matrix_cols) >= 2:
        add("heatmap", "Heatmap", 0.72,
            f"{len(matrix_cols)}개 수치형 컬럼을 행렬로 보고 패턴을 색으로 표시합니다.",
            {"columns": matrix_cols[:50], "row_label": (gene[0] if gene else None)},
            {"columns": matrix_cols[:50]})

    if len(numeric) >= 3:
        add("pca", "PCA plot", 0.68,
            f"{len(numeric)}개 수치형 변수로 주성분 분석(PCA)을 수행해 샘플 군집을 봅니다.",
            {"columns": numeric[:50], "color": (group[0] if group else None)},
            {"columns": numeric[:50]})

    if group and not numeric:
        add("bar", "Bar plot (count)", 0.6,
            "범주형 변수의 빈도(count)를 막대로 표시합니다.",
            {"x": group[0], "stat": "count"},
            {"x": group[:3]})

    out.sort(key=lambda s: s["score"], reverse=True)
    return out
