"""Descriptive statistics + simple group comparisons computed at upload time.

Group comparison: Welch's t-test (2 groups) or one-way ANOVA (>2 groups) per
(group column x numeric column), using scipy. Alongside each parametric test we
also add a nonparametric equivalent (Mann-Whitney U / Kruskal-Wallis), effect
sizes with an approximate 95% CI (2-group), lightweight assumption checks
(normality / equal variance), and Benjamini-Hochberg (FDR) adjusted p-values
across all comparisons. Results are advisory summaries — not a substitute for a
full statistical analysis.
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


def _cohens_d(m1, s1, n1, m2, s2, n2) -> dict | None:
    """Cohen's d + Hedges' g with an approximate 95% CI, from group summaries."""
    try:
        if None in (m1, s1, n1, m2, s2, n2) or n1 < 2 or n2 < 2:
            return None
        dfree = n1 + n2 - 2
        pooled_var = ((n1 - 1) * s1 ** 2 + (n2 - 1) * s2 ** 2) / dfree
        if pooled_var <= 0:
            return None
        sd_pooled = math.sqrt(pooled_var)
        d = (m1 - m2) / sd_pooled
        # Hedges' small-sample correction
        j = 1.0 - (3.0 / (4.0 * dfree - 1.0))
        g = d * j
        # approximate SE of d (Hedges & Olkin)
        se = math.sqrt((n1 + n2) / (n1 * n2) + d ** 2 / (2.0 * (n1 + n2)))
        return {
            "metric": "Cohen's d",
            "cohens_d": _f(d),
            "hedges_g": _f(g),
            "ci_low": _f(d - 1.96 * se),
            "ci_high": _f(d + 1.96 * se),
        }
    except Exception:
        return None


def _bh_adjust(pvals: list) -> list:
    """Benjamini-Hochberg FDR adjustment; preserves order, keeps None entries."""
    try:
        idx = [i for i, p in enumerate(pvals) if p is not None]
        if not idx:
            return list(pvals)
        vals = [float(pvals[i]) for i in idx]
        adj = None
        try:
            from scipy import stats as _sp
            if hasattr(_sp, "false_discovery_control"):
                adj = [float(v) for v in _sp.false_discovery_control(vals, method="bh")]
        except Exception:
            adj = None
        if adj is None:
            m = len(vals)
            order = sorted(range(m), key=lambda k: vals[k])
            adj = [None] * m
            prev = 1.0
            for rank in range(m, 0, -1):
                k = order[rank - 1]
                prev = min(prev, vals[k] * m / rank)
                adj[k] = min(prev, 1.0)
        out = list(pvals)
        for pos, i in enumerate(idx):
            out[i] = _f(adj[pos])
        return out
    except Exception:
        return list(pvals)


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
                comp = {
                    "group_column": gcol, "value_column": ncol, "test": test,
                    "statistic": _f(st), "p_value": pv,
                    "significant": bool(pv is not None and pv < 0.05),
                    "groups": per_group,
                }

                # nonparametric equivalent (Mann-Whitney U / Kruskal-Wallis)
                try:
                    if len(arrays) == 2:
                        nst, np_p = sp.mannwhitneyu(arrays[0], arrays[1], alternative="two-sided")
                        ntest = "Mann-Whitney U"
                    else:
                        nst, np_p = sp.kruskal(*arrays)
                        ntest = "Kruskal-Wallis"
                    npv = _f(np_p)
                    comp["nonparametric"] = {
                        "test": ntest, "statistic": _f(nst), "p_value": npv,
                        "significant": bool(npv is not None and npv < 0.05),
                    }
                except Exception:
                    pass

                # effect size w/ approximate 95% CI (2-group only)
                if len(arrays) == 2:
                    try:
                        g0, g1 = per_group[0], per_group[1]
                        es = _cohens_d(g0["mean"], g0["sd"], g0["n"],
                                       g1["mean"], g1["sd"], g1["n"])
                        if es is not None:
                            comp["effect_size"] = es
                    except Exception:
                        pass

                # assumption checks: normality (Shapiro-Wilk) + equal variance (Levene)
                try:
                    assumptions = {}
                    shapiro_ps = []
                    for a in arrays:
                        if 3 <= len(a) <= 5000:
                            try:
                                _, sh_p = sp.shapiro(a)
                                shp = float(sh_p)
                                if not math.isnan(shp):
                                    shapiro_ps.append(shp)
                            except Exception:
                                pass
                    if shapiro_ps:
                        min_p = min(shapiro_ps)  # most conservative across groups
                        assumptions["shapiro_p"] = _f(min_p)
                        assumptions["normal"] = bool(min_p > 0.05)
                    try:
                        _, lev_p = sp.levene(*arrays)
                        lp = _f(lev_p)
                        if lp is not None:
                            assumptions["levene_p"] = lp
                            assumptions["equal_variance"] = bool(lp > 0.05)
                    except Exception:
                        pass
                    if assumptions:
                        comp["assumptions"] = assumptions
                except Exception:
                    pass

                comparisons.append(comp)

    # multiple-testing correction (Benjamini-Hochberg FDR) across all comparisons
    fdr_applied = False
    try:
        if len(comparisons) > 1:
            adj_ps = _bh_adjust([c.get("p_value") for c in comparisons])
            for c, ap in zip(comparisons, adj_ps):
                c["p_value_adjusted"] = ap
                c["significant_fdr"] = bool(ap is not None and ap < 0.05)
            np_ps = [c.get("nonparametric", {}).get("p_value") for c in comparisons]
            if any(p is not None for p in np_ps):
                for c, ap in zip(comparisons, _bh_adjust(np_ps)):
                    if isinstance(c.get("nonparametric"), dict) and ap is not None:
                        c["nonparametric"]["p_value_adjusted"] = ap
            fdr_applied = True
    except Exception:
        fdr_applied = False

    result = {"descriptive": descriptive, "comparisons": comparisons}
    if fdr_applied:
        result["fdr_method"] = "benjamini-hochberg"
    return result
