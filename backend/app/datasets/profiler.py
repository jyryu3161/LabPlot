"""Lightweight column profiling with biology-aware role detection.

Roles are *suggestions* only; the user can override mappings in the builder.
"""
from __future__ import annotations

import math
import re

import numpy as np
import pandas as pd

_LOG2FC_RE = re.compile(r"(log2?\s*fold|log2fc|logfc|fold[_\s]*change|l2fc|\blfc\b)", re.I)
_PVAL_RE = re.compile(r"(p[\._\s-]*val|p[\._\s-]*adj|adj[\._\s-]*p|padj|\bpval\b|\bfdr\b|q[\._\s-]*val|\bqvalue\b|\bp\b)", re.I)
_GENE_RE = re.compile(r"(gene|symbol|^id$|ensembl|transcript|probe|feature)", re.I)
_TIME_RE = re.compile(r"(time|day|days|month|week|hour|hr|os[_\.]?time|surv|duration|followup|follow[_\s]*up|date|timepoint)", re.I)
_STATUS_RE = re.compile(r"(status|event|vital|death|dead|os[_\.]?event|censor|deceased|relapse|recur)", re.I)
_GROUP_RE = re.compile(r"(group|treatment|condition|cohort|arm|genotype|cell[_\s]*line|sample[_\s]*type|class|label|category|type|sex|gender|stage|grade)", re.I)


def _clean(value):
    if value is None:
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return None if (math.isnan(value) or math.isinf(value)) else float(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    return value


def _is_status_like(series: pd.Series) -> bool:
    vals = series.dropna().unique()
    if len(vals) == 0 or len(vals) > 4:
        return False
    sset = {str(v).strip().lower() for v in vals}
    binary_words = {"0", "1", "0.0", "1.0", "alive", "dead", "event", "censored", "censor",
                    "yes", "no", "true", "false", "deceased", "living", "relapse", "norelapse"}
    return sset.issubset(binary_words)


def _numeric_like_series(series: pd.Series) -> pd.Series | None:
    if series.dtype.kind in ("i", "u", "f"):
        return series
    if series.dtype.kind != "O":
        return None
    present = series.notna() & series.astype(str).str.strip().ne("")
    if not bool(present.any()):
        return None
    converted = pd.to_numeric(series, errors="coerce")
    if bool(converted[present].notna().all()):
        return converted
    return None


def _detect_role(name: str, series: pd.Series, dtype_kind: str, n_unique: int, n_rows: int) -> str:
    lname = name.strip().lower()
    is_numeric = dtype_kind in ("i", "f", "u")

    if is_numeric and _LOG2FC_RE.search(lname):
        return "log2fc"
    if _PVAL_RE.search(lname) and is_numeric:
        non_null = series.dropna()
        if len(non_null) == 0 or ((non_null >= 0).all() and (non_null <= 1.0001).all()):
            return "pvalue"
    if _STATUS_RE.search(lname) and _is_status_like(series):
        return "status"
    if _STATUS_RE.search(lname) and is_numeric and n_unique <= 3:
        return "status"
    if _TIME_RE.search(lname):
        return "time"
    if _GENE_RE.search(lname) and n_unique > max(10, 0.5 * n_rows):
        return "gene"
    if not is_numeric and _GROUP_RE.search(lname):
        return "group"

    if is_numeric:
        # numeric with very few distinct values acts like a grouping factor
        if n_unique <= max(2, min(6, int(0.05 * n_rows) + 1)) and n_unique < 10:
            return "group"
        return "numeric"
    # non-numeric
    if dtype_kind == "M":
        return "time"
    if n_unique <= max(2, min(20, int(0.5 * n_rows))):
        return "group" if n_unique <= 12 else "category"
    return "text"


def profile_dataframe(df: pd.DataFrame, preview_rows: int = 20) -> dict:
    n_rows = int(len(df))
    columns = []
    for col in df.columns:
        series = df[col]
        numeric_series = _numeric_like_series(series)
        profile_series = numeric_series if numeric_series is not None else series
        dtype_kind = profile_series.dtype.kind  # i,u,f,O,b,M
        is_numeric = dtype_kind in ("i", "u", "f")
        n_unique = int(profile_series.nunique(dropna=True))
        n_missing = int(series.isna().sum())
        role = _detect_role(str(col), profile_series, dtype_kind, n_unique, n_rows)

        if is_numeric:
            dtype = "numeric"
        elif dtype_kind == "M":
            dtype = "datetime"
        elif n_unique <= max(2, min(20, int(0.5 * n_rows))):
            dtype = "categorical"
        else:
            dtype = "text"

        stats = None
        if is_numeric and n_rows - n_missing > 0:
            non_null = profile_series.dropna()
            stats = {
                "min": _clean(non_null.min()),
                "max": _clean(non_null.max()),
                "mean": _clean(float(non_null.mean())),
                "median": _clean(float(non_null.median())),
            }

        sample = [_clean(v) for v in series.dropna().unique()[:6].tolist()]

        columns.append({
            "name": str(col),
            "dtype": dtype,
            "role": role,
            "n_unique": n_unique,
            "n_missing": n_missing,
            "sample_values": sample,
            "stats": stats,
        })

    preview_df = df.head(preview_rows)
    preview = []
    for _, row in preview_df.iterrows():
        preview.append({str(k): _clean(v) for k, v in row.items()})

    return {"n_rows": n_rows, "n_cols": int(df.shape[1]), "columns": columns, "preview": preview}
