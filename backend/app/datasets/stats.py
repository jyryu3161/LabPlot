"""Descriptive statistics + simple group comparisons computed at upload time.

Group comparison: Welch's t-test (2 groups) or one-way ANOVA (>2 groups) per
(group column x numeric column), using scipy. Results are advisory summaries —
not a substitute for a full statistical analysis.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd


def _f(x):
    try:
        v = float(x)
        return None if (math.isnan(v) or math.isinf(v)) else round(v, 4)
    except (TypeError, ValueError):
        return None


def _describe(series: pd.Series) -> dict:
    s = pd.to_numeric(series, errors="coerce").dropna()
    if len(s) == 0:
        return {"n": 0}
    return {
        "n": int(len(s)),
        "mean": _f(s.mean()), "sd": _f(s.std(ddof=1)) if len(s) > 1 else 0.0,
        "median": _f(s.median()), "min": _f(s.min()), "max": _f(s.max()),
        "q1": _f(s.quantile(0.25)), "q3": _f(s.quantile(0.75)),
    }


def compute_statistics(df: pd.DataFrame, column_profile: list[dict]) -> dict:
    # descriptive: every numeric-dtype column (includes time, log2fc, pvalue, numeric status)
    numerics = [c["name"] for c in column_profile if c["dtype"] == "numeric"]
    groups = [c["name"] for c in column_profile if c["role"] in ("group", "category", "status")
              and 2 <= c["n_unique"] <= 8]

    descriptive = [{"column": n, **_describe(df[n])} for n in numerics]

    comparisons = []
    try:
        from scipy import stats as sp
    except ImportError:
        sp = None

    if sp is not None:
        for gcol in groups[:2]:
            levels = [lv for lv in df[gcol].dropna().unique()]
            if not (2 <= len(levels) <= 8):
                continue
            for ncol in numerics[:6]:
                if ncol == gcol:
                    continue
                arrays, per_group = [], []
                for lv in levels:
                    vals = pd.to_numeric(df.loc[df[gcol] == lv, ncol], errors="coerce").dropna().values
                    if len(vals) >= 2:
                        arrays.append(vals)
                        per_group.append({"level": str(lv), "n": int(len(vals)),
                                          "mean": _f(np.mean(vals)), "sd": _f(np.std(vals, ddof=1))})
                if len(arrays) < 2:
                    continue
                try:
                    if len(arrays) == 2:
                        st, p = sp.ttest_ind(arrays[0], arrays[1], equal_var=False)
                        test = "Welch t-test"
                    else:
                        st, p = sp.f_oneway(*arrays)
                        test = "One-way ANOVA"
                except Exception:
                    continue
                pv = _f(p)
                comparisons.append({
                    "group_column": gcol, "value_column": ncol, "test": test,
                    "statistic": _f(st), "p_value": pv,
                    "significant": bool(pv is not None and pv < 0.05),
                    "groups": per_group,
                })

    return {"descriptive": descriptive, "comparisons": comparisons}
