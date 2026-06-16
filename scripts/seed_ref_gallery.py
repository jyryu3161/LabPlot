#!/usr/bin/env python3
"""Seed curated public gallery figures from ref_data/graph_gallery.

The reference gallery contains example CSV files, R code, and images. This
script renders curated single-panel examples through LabPlot's own templates so
the public gallery stays reproducible and its "use as template" flow remains
compatible with uploaded user data.
"""
from __future__ import annotations

import argparse
import math
import random
import sys
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from statistics import NormalDist
from types import SimpleNamespace
from typing import Callable

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
REF_ROOT = ROOT / "ref_data" / "graph_gallery"
sys.path.insert(0, str(BACKEND))

import app.main  # noqa: E402,F401 - register all SQLAlchemy models
from app.auth.models import User  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.datasets.models import Dataset  # noqa: E402
from app.datasets import service as dataset_service  # noqa: E402
from app.figures.models import Figure  # noqa: E402
from app.figures import service as figure_service  # noqa: E402


@dataclass(frozen=True)
class GallerySeed:
    key: str
    figure_name: str
    dataset_name: str
    plot_type: str
    mapping: dict
    options: dict
    rel_csv: str | None = None
    dataframe_factory: Callable[[], pd.DataFrame] | None = None
    transform: Callable[[pd.DataFrame], pd.DataFrame] | None = None
    column_roles: dict[str, str] | None = None
    style_preset: str = "nature"


def _read_ref(rel_csv: str) -> pd.DataFrame:
    path = REF_ROOT / rel_csv
    if not path.exists():
        raise FileNotFoundError(path)
    return pd.read_csv(path)


def _csv_bytes(df: pd.DataFrame) -> bytes:
    out = BytesIO()
    df.to_csv(out, index=False)
    return out.getvalue()


def _mean_sem(df: pd.DataFrame, groups: list[str], value: str, mean_col: str, sem_col: str) -> pd.DataFrame:
    summary = df.groupby(groups, dropna=False)[value].agg(["mean", "std", "count"]).reset_index()
    summary[mean_col] = summary["mean"]
    summary[sem_col] = summary["std"].fillna(0) / summary["count"].clip(lower=1).map(math.sqrt)
    return summary[groups + [mean_col, sem_col]]


def _long(df: pd.DataFrame, x: str, value_cols: list[str], series_col: str, value_col: str) -> pd.DataFrame:
    return df.melt(id_vars=[x], value_vars=value_cols, var_name=series_col, value_name=value_col)


def _clean_labels(series: pd.Series) -> pd.Series:
    return series.astype(str).str.replace(r"\s+", " ", regex=True).str.strip().str.replace("_", " ", regex=False)


def _bar_error(df: pd.DataFrame) -> pd.DataFrame:
    return _mean_sem(df, ["Group"], "Cell_Viability_Pct", "Mean_Cell_Viability", "SEM")


def _grouped_error(df: pd.DataFrame) -> pd.DataFrame:
    return _mean_sem(df, ["Group", "Marker"], "Value", "Mean_Value", "SEM")


def _ecdf(df: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict] = []
    for group, sub in df.groupby("Group", dropna=False):
        values = pd.to_numeric(sub["Value"], errors="coerce").dropna().sort_values().reset_index(drop=True)
        n = len(values)
        for idx, value in enumerate(values, start=1):
            rows.append({"Group": group, "Value": float(value), "Cumulative_Probability": idx / n})
    return pd.DataFrame(rows)


def _cell_viability(df: pd.DataFrame) -> pd.DataFrame:
    return _mean_sem(df, ["Concentration_uM", "Drug"], "Viability_Percent", "Mean_Viability", "SEM")


def _dose_response(df: pd.DataFrame) -> pd.DataFrame:
    return _mean_sem(df, ["Concentration_uM", "Compound"], "Response_Percent", "Mean_Response", "SEM")


def _cell_growth(df: pd.DataFrame) -> pd.DataFrame:
    work = df.copy()
    work["Cell_Count_1000"] = work["Cell_Count"] / 1000
    return _mean_sem(work, ["Time_h", "Cell_Line"], "Cell_Count_1000", "Mean_Cell_Count_1000", "SEM")


def _western_blot(df: pd.DataFrame) -> pd.DataFrame:
    return _mean_sem(df, ["Protein", "Sample"], "Relative_Expression", "Mean_Relative_Expression", "SEM")


def _flow_histogram(df: pd.DataFrame) -> pd.DataFrame:
    out = _long(df, "Bin_Center", ["Control", "Treatment_1", "Treatment_2", "Positive_Control"], "Sample", "Events")
    out["Sample"] = _clean_labels(out["Sample"])
    return out


def _pca_columns() -> list[str]:
    return [f"Gene_{idx}" for idx in range(1, 101)]


def _gene_heatmap(df: pd.DataFrame) -> pd.DataFrame:
    work = df.rename(columns={df.columns[0]: "Gene"}).copy()
    return work


def _roc(df: pd.DataFrame) -> pd.DataFrame:
    status = pd.to_numeric(df["Disease_Status"], errors="coerce").fillna(0).astype(int)
    positives = max(int((status == 1).sum()), 1)
    negatives = max(int((status == 0).sum()), 1)
    rows: list[dict] = []
    for biomarker in ["Biomarker_A", "Biomarker_B", "Biomarker_C", "Combined_Score"]:
        scores = pd.to_numeric(df[biomarker], errors="coerce")
        valid = pd.DataFrame({"score": scores, "status": status}).dropna().sort_values("score", ascending=False)
        label = biomarker.replace("_", " ")
        rows.append({"Biomarker": label, "FPR": 0.0, "TPR": 0.0})
        for _, row in valid.iterrows():
            selected = valid.loc[valid["score"] >= row["score"], "status"]
            rows.append({
                "Biomarker": label,
                "FPR": float((selected == 0).sum()) / negatives,
                "TPR": float((selected == 1).sum()) / positives,
            })
        rows.append({"Biomarker": label, "FPR": 1.0, "TPR": 1.0})
    return pd.DataFrame(rows)


def _tumor_growth(df: pd.DataFrame) -> pd.DataFrame:
    return _mean_sem(df, ["Day", "Group"], "Tumor_Volume_mm3", "Mean_Tumor_Volume_mm3", "SEM")


def _phase_diagram(df: pd.DataFrame) -> pd.DataFrame:
    return df.sort_values(["Phase", "Phenol_wt_percent"]).copy()


def _fermentation(df: pd.DataFrame) -> pd.DataFrame:
    out = _long(df, "Time_h", ["Biomass_g_L", "Glucose_g_L", "Product_g_L"], "Metric", "Value")
    out["Metric"] = out["Metric"].str.replace("_g_L", "", regex=False).str.replace("_", " ", regex=False)
    return out


def _qpcr(df: pd.DataFrame) -> pd.DataFrame:
    return _mean_sem(df, ["Gene", "Condition"], "Expression_fold", "Mean_Expression_fold", "SEM")


def _sds_page(df: pd.DataFrame) -> pd.DataFrame:
    return _mean_sem(df, ["Lane", "MW_kDa"], "Intensity", "Mean_Intensity", "SEM")


def _plasmid_yield(df: pd.DataFrame) -> pd.DataFrame:
    return _mean_sem(df, ["Strain", "Media"], "Plasmid_Yield_ug_mL", "Mean_Plasmid_Yield", "SEM")


def _antibody_standard(df: pd.DataFrame) -> pd.DataFrame:
    work = df[df["Type"].astype(str).str.lower() == "standard"].copy()
    work["Concentration_ng_mL"] = (
        work["Sample"].astype(str).str.extract(r"Std_([0-9.]+)ng_mL", expand=False).astype(float)
    )
    return _mean_sem(work, ["Concentration_ng_mL"], "OD450", "Mean_OD450", "SEM")


def _cell_culture_density(df: pd.DataFrame) -> pd.DataFrame:
    out = _long(df, "Day", ["VCD_10e6_mL", "TCD_10e6_mL"], "Metric", "Cells_10e6_mL")
    out["Metric"] = out["Metric"].str.replace("_10e6_mL", "", regex=False)
    return out


def _enzyme_activity(df: pd.DataFrame) -> pd.DataFrame:
    return _mean_sem(df, ["Substrate_mM", "Condition"], "Velocity_umol_min_mg", "Mean_Velocity", "SEM")


def _metabolic_flux(df: pd.DataFrame) -> pd.DataFrame:
    work = df.copy()
    work["Condition"] = _clean_labels(work["Condition"])
    return (
        work.groupby(["Condition", "Metabolite"], dropna=False)["Flux_mmol_gDCW_h"]
        .mean()
        .reset_index(name="Mean_Flux")
    )


def _stress_strain(df: pd.DataFrame) -> pd.DataFrame:
    out = _long(df, "Strain", ["Steel_MPa", "Aluminum_MPa", "Polymer_MPa"], "Material", "Stress_MPa")
    out["Material"] = out["Material"].str.replace("_MPa", "", regex=False)
    return out


def _solar_iv(df: pd.DataFrame) -> pd.DataFrame:
    out = _long(df, "Voltage_V", ["Current_25C_mA", "Current_45C_mA", "Current_65C_mA"], "Temperature", "Current_mA")
    out["Temperature"] = out["Temperature"].str.replace("Current_", "", regex=False).str.replace("_mA", "", regex=False)
    return out


def _fatigue(df: pd.DataFrame) -> pd.DataFrame:
    out = _long(df, "Cycles", ["Steel_MPa", "Aluminum_MPa", "Titanium_MPa"], "Material", "Stress_MPa")
    out["Material"] = out["Material"].str.replace("_MPa", "", regex=False)
    return out


def _particle_size(df: pd.DataFrame) -> pd.DataFrame:
    out = _long(df, "Particle_Size_um", ["Sample_A", "Sample_B", "Sample_C"], "Sample", "Density")
    out["Sample"] = _clean_labels(out["Sample"])
    return out


def _creep(df: pd.DataFrame) -> pd.DataFrame:
    out = _long(df, "Time_min", ["Strain_10MPa", "Strain_15MPa"], "Stress", "Strain")
    out["Stress"] = out["Stress"].str.replace("Strain_", "", regex=False)
    return out


def _dsc(df: pd.DataFrame) -> pd.DataFrame:
    out = _long(df, "Temperature_C", ["HeatFlow_1st_mW", "HeatFlow_2nd_mW"], "Run", "HeatFlow_mW")
    out["Run"] = out["Run"].str.replace("HeatFlow_", "", regex=False).str.replace("_mW", "", regex=False)
    return out


def _tga(df: pd.DataFrame) -> pd.DataFrame:
    out = _long(df, "Temperature_C", ["Mass_5Cmin_pct", "Mass_10Cmin_pct"], "Heating_Rate", "Mass_pct")
    out["Heating_Rate"] = out["Heating_Rate"].str.replace("Mass_", "", regex=False).str.replace("_pct", "", regex=False)
    return out


def _water_radar(df: pd.DataFrame) -> pd.DataFrame:
    out = df.melt(
        id_vars=["Process"],
        value_vars=["TSS_Removal_pct", "COD_Removal_pct", "Turbidity_Removal_pct", "HeavyMetal_Removal_pct"],
        var_name="Contaminant",
        value_name="Removal_pct",
    )
    out["Contaminant"] = (
        out["Contaminant"].str.replace("_Removal_pct", "", regex=False).str.replace("HeavyMetal", "Heavy metal", regex=False)
    )
    return out


def _qq(df: pd.DataFrame) -> pd.DataFrame:
    normal = NormalDist()
    rows: list[dict] = []
    for col in df.columns:
        values = pd.to_numeric(df[col], errors="coerce").dropna().sort_values().reset_index(drop=True)
        if len(values) < 3:
            continue
        mean = values.mean()
        sd = values.std(ddof=1) or 1.0
        for idx, value in enumerate(values, start=1):
            p = (idx - 0.5) / len(values)
            rows.append({
                "Distribution": col.replace("_", " ").title(),
                "Theoretical_Quantile": normal.inv_cdf(p),
                "Sample_Quantile": float((value - mean) / sd),
            })
    return pd.DataFrame(rows)


def _composition_trend(df: pd.DataFrame) -> pd.DataFrame:
    out = _long(df, "Year", ["Group_A", "Group_B", "Group_C", "Group_D"], "Group", "Count")
    out["Group"] = _clean_labels(out["Group"])
    return out


def _advanced_sankey() -> pd.DataFrame:
    return pd.DataFrame([
        ("Raw reads", "QC passed", 920),
        ("Raw reads", "Filtered", 80),
        ("QC passed", "Aligned", 780),
        ("QC passed", "Unmapped", 140),
        ("Aligned", "Exonic", 430),
        ("Aligned", "Intronic", 210),
        ("Aligned", "Intergenic", 140),
        ("Exonic", "Differential genes", 95),
        ("Intronic", "Differential genes", 32),
        ("Differential genes", "Pathway hits", 54),
        ("Differential genes", "Novel candidates", 73),
    ], columns=["Source", "Target", "Reads"])


def _advanced_upset() -> pd.DataFrame:
    rng = random.Random(4101)
    rows: list[dict] = []
    for idx in range(96):
        base = rng.random()
        rows.append({
            "Sample": f"S{idx + 1:03d}",
            "RNAseq": int(base < 0.68 or rng.random() < 0.18),
            "Proteomics": int(base < 0.52 or rng.random() < 0.14),
            "Metabolomics": int(0.25 < base < 0.82 or rng.random() < 0.10),
            "CRISPR": int(base > 0.48 or rng.random() < 0.08),
            "Imaging": int(base < 0.33 or base > 0.76 or rng.random() < 0.10),
        })
    return pd.DataFrame(rows)


def _advanced_surface_grid() -> pd.DataFrame:
    rows: list[dict] = []
    for xi in range(-8, 9):
        for yi in range(-8, 9):
            x = xi / 2.0
            y = yi / 2.0
            response = (
                1.8 * math.exp(-((x - 0.8) ** 2 + (y + 0.5) ** 2) / 5.0)
                + 0.55 * math.sin(x * 1.2)
                + 0.35 * math.cos(y * 1.4)
                + 0.08 * x
                - 0.04 * y
            )
            rows.append({"X": round(x, 3), "Y": round(y, 3), "Response": round(response, 5)})
    return pd.DataFrame(rows)


def _advanced_scatter_3d() -> pd.DataFrame:
    rng = random.Random(4102)
    centers = [(-1.9, -0.9, 0.2, "Cluster A"), (1.6, -0.4, 1.3, "Cluster B"), (0.1, 1.7, -0.8, "Cluster C")]
    rows: list[dict] = []
    for cx, cy, cz, label in centers:
        for idx in range(34):
            rows.append({
                "PC1": round(cx + rng.gauss(0, 0.45), 4),
                "PC2": round(cy + rng.gauss(0, 0.42), 4),
                "PC3": round(cz + rng.gauss(0, 0.38), 4),
                "Cluster": label,
            })
    return pd.DataFrame(rows)


def _advanced_calibration_curve() -> pd.DataFrame:
    rng = random.Random(4103)
    rows: list[dict] = []
    for instrument, offset, slope in [("Instrument A", 0.015, 0.97), ("Instrument B", 0.035, 0.91)]:
        for idx in range(28):
            predicted = idx / 27
            observed = offset + slope * predicted + rng.gauss(0, 0.035)
            rows.append({
                "Predicted": round(predicted, 4),
                "Observed": round(max(0, min(1, observed)), 4),
                "Instrument": instrument,
            })
    return pd.DataFrame(rows)


def _advanced_chord() -> pd.DataFrame:
    return pd.DataFrame([
        ("T cells", "B cells", 26),
        ("T cells", "Dendritic", 18),
        ("T cells", "Macrophages", 12),
        ("B cells", "Stromal", 11),
        ("B cells", "Dendritic", 9),
        ("Macrophages", "Endothelial", 17),
        ("Macrophages", "Stromal", 22),
        ("Dendritic", "T cells", 16),
        ("Stromal", "Endothelial", 14),
        ("Endothelial", "T cells", 7),
        ("Endothelial", "B cells", 5),
    ], columns=["Source", "Target", "Interaction_Strength"])


def _advanced_parallel_coordinates() -> pd.DataFrame:
    rng = random.Random(4104)
    rows: list[dict] = []
    for cohort, shift in [("Responder", 0.55), ("Non-responder", -0.35), ("Intermediate", 0.05)]:
        for idx in range(18):
            immune = rng.gauss(1.5 + shift, 0.28)
            metabolic = rng.gauss(0.8 - shift * 0.35, 0.22)
            rows.append({
                "Sample": f"{cohort[:3]}-{idx + 1:02d}",
                "Cohort": cohort,
                "Immune_Score": round(immune, 4),
                "Metabolic_Score": round(metabolic, 4),
                "Proliferation": round(rng.gauss(1.0 + shift * 0.25, 0.2), 4),
                "Hypoxia": round(rng.gauss(0.7 - shift * 0.18, 0.18), 4),
                "Stromal_Score": round(rng.gauss(0.9 + shift * 0.1, 0.2), 4),
            })
    return pd.DataFrame(rows)


def _advanced_confusion_matrix() -> pd.DataFrame:
    rng = random.Random(4105)
    classes = ["Control", "Disease A", "Disease B", "Disease C"]
    rows: list[dict] = []
    for actual in classes:
        for _ in range(42):
            if rng.random() < 0.78:
                predicted = actual
            else:
                predicted = rng.choice([c for c in classes if c != actual])
            rows.append({"Actual": actual, "Predicted": predicted})
    return pd.DataFrame(rows)


def _advanced_roc_pr() -> pd.DataFrame:
    rng = random.Random(4106)
    rows: list[dict] = []
    for idx in range(160):
        positive = rng.random() < 0.38
        signal = rng.gauss(0.72 if positive else 0.34, 0.16)
        score_a = max(0, min(1, signal))
        score_b = max(0, min(1, rng.gauss(0.64 if positive else 0.40, 0.18)))
        rows.append({"Patient": f"P{idx + 1:03d}", "Model": "Model A", "Score": round(score_a, 4), "Label": "positive" if positive else "negative"})
        rows.append({"Patient": f"P{idx + 1:03d}", "Model": "Model B", "Score": round(score_b, 4), "Label": "positive" if positive else "negative"})
    return pd.DataFrame(rows)


def _advanced_ma_plot() -> pd.DataFrame:
    rng = random.Random(4107)
    rows: list[dict] = []
    for idx in range(420):
        mean_expr = 2 ** rng.uniform(1.2, 11.5)
        lfc = rng.gauss(0, 0.42)
        if idx % 41 == 0:
            lfc += rng.choice([-1.8, 1.9])
        rows.append({
            "Gene": f"GENE{idx + 1:04d}",
            "Mean_Expression": round(mean_expr, 4),
            "Log2FC": round(lfc, 4),
        })
    return pd.DataFrame(rows)


COMMON_OPTIONS = {
    "title": "",
    "size": "wide",
    "palette_name": "okabe_ito",
    "font_scale": 0.95,
}


SEEDS = [
    GallerySeed(
        key="scatter_plot",
        figure_name="Scatter plot",
        dataset_name="Gallery seed - scatter plot",
        rel_csv="01_basic_stats/data/01_scatter_plot.csv",
        plot_type="scatter",
        mapping={"x": "Variable_X", "y": "Variable_Y"},
        options={**COMMON_OPTIONS, "x_label": "Variable X", "y_label": "Variable Y"},
    ),
    GallerySeed(
        key="scatter_regression",
        figure_name="Scatter plot with regression",
        dataset_name="Gallery seed - scatter with regression",
        rel_csv="01_basic_stats/data/02_scatter_with_regression.csv",
        plot_type="scatter",
        mapping={"x": "Concentration_ug_mL", "y": "Absorbance"},
        options={**COMMON_OPTIONS, "x_label": "Concentration (ug/mL)", "y_label": "Absorbance", "add_smooth": True},
    ),
    GallerySeed(
        key="scatter_confidence",
        figure_name="Scatter plot with confidence interval",
        dataset_name="Gallery seed - scatter with confidence interval",
        rel_csv="01_basic_stats/data/03_scatter_with_confidence.csv",
        plot_type="scatter",
        mapping={"x": "Dose_mg_kg", "y": "Response_Pct"},
        options={**COMMON_OPTIONS, "x_label": "Dose (mg/kg)", "y_label": "Response (%)", "add_smooth": True},
    ),
    GallerySeed(
        key="box_plot",
        figure_name="Box plot",
        dataset_name="Gallery seed - box plot",
        rel_csv="01_basic_stats/data/04_box_plot.csv",
        plot_type="box",
        mapping={"x": "Group", "y": "Measurement"},
        options={**COMMON_OPTIONS, "x_label": "Group", "y_label": "Measurement", "show_points": False},
    ),
    GallerySeed(
        key="box_jitter",
        figure_name="Box plot with jitter",
        dataset_name="Gallery seed - box plot with jitter",
        rel_csv="01_basic_stats/data/05_box_plot_with_jitter.csv",
        plot_type="box",
        mapping={"x": "Genotype", "y": "Expression_Level"},
        options={**COMMON_OPTIONS, "x_label": "Genotype", "y_label": "Expression level", "show_points": True},
    ),
    GallerySeed(
        key="violin_plot",
        figure_name="Violin plot",
        dataset_name="Gallery seed - violin plot",
        rel_csv="01_basic_stats/data/06_violin_plot.csv",
        plot_type="violin",
        mapping={"x": "Time_Point", "y": "Biomarker_Ng_mL"},
        options={**COMMON_OPTIONS, "x_label": "Time point", "y_label": "Biomarker (ng/mL)", "show_box": True},
    ),
    GallerySeed(
        key="bar_error",
        figure_name="Bar chart with error bars",
        dataset_name="Gallery seed - bar chart with error bars",
        rel_csv="01_basic_stats/data/07_bar_chart_with_error.csv",
        transform=_bar_error,
        plot_type="error_bar",
        mapping={"x": "Group", "y": "Mean_Cell_Viability", "error": "SEM"},
        options={**COMMON_OPTIONS, "x_label": "Group", "y_label": "Cell viability (%)", "connect_points": False},
    ),
    GallerySeed(
        key="grouped_error",
        figure_name="Grouped error bar chart",
        dataset_name="Gallery seed - grouped error bar chart",
        rel_csv="01_basic_stats/data/08_grouped_bar_chart.csv",
        transform=_grouped_error,
        plot_type="error_bar",
        mapping={"x": "Group", "y": "Mean_Value", "group": "Marker", "error": "SEM"},
        options={**COMMON_OPTIONS, "x_label": "Group", "y_label": "Marker value", "connect_points": False},
    ),
    GallerySeed(
        key="histogram_density",
        figure_name="Histogram with density",
        dataset_name="Gallery seed - histogram with density",
        rel_csv="01_basic_stats/data/09_histogram_with_density.csv",
        plot_type="histogram",
        mapping={"value": "Value"},
        options={**COMMON_OPTIONS, "x_label": "Value", "bins": 30, "show_density": True},
    ),
    GallerySeed(
        key="cumulative_distribution",
        figure_name="Cumulative distribution curve",
        dataset_name="Gallery seed - cumulative distribution curve",
        rel_csv="01_basic_stats/data/10_cumulative_distribution.csv",
        transform=_ecdf,
        plot_type="line",
        mapping={"x": "Value", "y": "Cumulative_Probability", "group": "Group"},
        options={**COMMON_OPTIONS, "x_label": "Value", "y_label": "Cumulative probability"},
    ),
    GallerySeed(
        key="cell_viability",
        figure_name="Cell viability assay",
        dataset_name="Gallery seed - cell viability assay",
        rel_csv="02_biology_medicine/data/01_cell_viability_assay.csv",
        transform=_cell_viability,
        plot_type="error_bar",
        mapping={"x": "Concentration_uM", "y": "Mean_Viability", "group": "Drug", "error": "SEM"},
        options={**COMMON_OPTIONS, "x_label": "Concentration (uM)", "y_label": "Viability (%)", "connect_points": True},
    ),
    GallerySeed(
        key="dose_response",
        figure_name="Dose response curve",
        dataset_name="Gallery seed - dose response curve",
        rel_csv="02_biology_medicine/data/02_dose_response_curve.csv",
        transform=_dose_response,
        plot_type="error_bar",
        mapping={"x": "Concentration_uM", "y": "Mean_Response", "group": "Compound", "error": "SEM"},
        options={**COMMON_OPTIONS, "x_label": "Concentration (uM)", "y_label": "Response (%)", "connect_points": True},
    ),
    GallerySeed(
        key="cell_growth",
        figure_name="Cell growth curve",
        dataset_name="Gallery seed - cell growth curve",
        rel_csv="02_biology_medicine/data/03_growth_curve.csv",
        transform=_cell_growth,
        plot_type="error_bar",
        mapping={"x": "Time_h", "y": "Mean_Cell_Count_1000", "group": "Cell_Line", "error": "SEM"},
        options={**COMMON_OPTIONS, "x_label": "Time (h)", "y_label": "Cell count (x1000)", "connect_points": True},
    ),
    GallerySeed(
        key="elisa_standard",
        figure_name="ELISA standard curve",
        dataset_name="Gallery seed - ELISA standard curve",
        rel_csv="02_biology_medicine/data/04_elisa_standard_curve.csv",
        plot_type="scatter",
        mapping={"x": "Concentration_pg_mL", "y": "OD450"},
        options={**COMMON_OPTIONS, "x_label": "Concentration (pg/mL)", "y_label": "OD450", "add_smooth": True},
    ),
    GallerySeed(
        key="western_blot",
        figure_name="Western blot quantification",
        dataset_name="Gallery seed - western blot quantification",
        rel_csv="02_biology_medicine/data/05_western_blot_quantification.csv",
        transform=_western_blot,
        plot_type="error_bar",
        mapping={"x": "Protein", "y": "Mean_Relative_Expression", "group": "Sample", "error": "SEM"},
        options={**COMMON_OPTIONS, "x_label": "Protein", "y_label": "Relative expression", "connect_points": False},
    ),
    GallerySeed(
        key="flow_histogram",
        figure_name="Flow cytometry histogram",
        dataset_name="Gallery seed - flow cytometry histogram",
        rel_csv="02_biology_medicine/data/06_flow_cytometry_histogram.csv",
        transform=_flow_histogram,
        plot_type="line",
        mapping={"x": "Bin_Center", "y": "Events", "group": "Sample"},
        options={**COMMON_OPTIONS, "x_label": "Fluorescence intensity", "y_label": "Events"},
    ),
    GallerySeed(
        key="kaplan_meier",
        figure_name="Kaplan-Meier survival curve",
        dataset_name="Gallery seed - Kaplan-Meier survival curve",
        rel_csv="02_biology_medicine/data/07_survival_curve_kaplan_meier.csv",
        plot_type="kaplan_meier",
        mapping={"time": "Time_months", "status": "Event", "group": "Group"},
        options={**COMMON_OPTIONS, "x_label": "Time (months)", "y_label": "Survival probability"},
    ),
    GallerySeed(
        key="pca_sample",
        figure_name="PCA sample plot",
        dataset_name="Gallery seed - PCA sample plot",
        rel_csv="02_biology_medicine/data/08_pca_plot.csv",
        plot_type="pca",
        mapping={"columns": _pca_columns(), "color": "Group"},
        options={**COMMON_OPTIONS},
    ),
    GallerySeed(
        key="gene_heatmap",
        figure_name="Gene expression heatmap",
        dataset_name="Gallery seed - gene expression heatmap",
        rel_csv="02_biology_medicine/data/09_heatmap_gene_expression.csv",
        transform=_gene_heatmap,
        plot_type="heatmap",
        mapping={"columns": [f"Control_{i}" for i in range(1, 5)] + [f"Treated_{i}" for i in range(1, 5)], "row_label": "Gene"},
        options={**COMMON_OPTIONS, "scale_rows": True, "palette": "viridis"},
    ),
    GallerySeed(
        key="volcano",
        figure_name="Volcano plot",
        dataset_name="Gallery seed - volcano plot",
        rel_csv="02_biology_medicine/data/10_volcano_plot.csv",
        plot_type="volcano",
        mapping={"log2fc": "log2FoldChange", "pvalue": "p_value", "gene_label": "Gene"},
        options={**COMMON_OPTIONS, "fc_threshold": 1.0, "p_threshold": 0.05, "label_top": 8},
    ),
    GallerySeed(
        key="diagnostic_roc",
        figure_name="Diagnostic ROC curves",
        dataset_name="Gallery seed - diagnostic ROC curves",
        rel_csv="02_biology_medicine/data/11_roc_curve.csv",
        transform=_roc,
        plot_type="line",
        mapping={"x": "FPR", "y": "TPR", "group": "Biomarker"},
        options={**COMMON_OPTIONS, "x_label": "False positive rate", "y_label": "True positive rate"},
    ),
    GallerySeed(
        key="tumor_growth",
        figure_name="Tumor growth curve",
        dataset_name="Gallery seed - tumor growth curve",
        rel_csv="02_biology_medicine/data/12_tumor_growth_curve.csv",
        transform=_tumor_growth,
        plot_type="error_bar",
        mapping={"x": "Day", "y": "Mean_Tumor_Volume_mm3", "group": "Group", "error": "SEM"},
        options={**COMMON_OPTIONS, "x_label": "Day", "y_label": "Tumor volume (mm3)", "connect_points": True},
    ),
    GallerySeed(
        key="titration_curve",
        figure_name="Acid-base titration curve",
        dataset_name="Gallery seed - titration curve",
        rel_csv="03_chemistry/data/01_titration_curve.csv",
        plot_type="line",
        mapping={"x": "Volume_NaOH_mL", "y": "pH"},
        options={**COMMON_OPTIONS, "x_label": "NaOH volume (mL)", "y_label": "pH", "hide_legend": True},
    ),
    GallerySeed(
        key="calibration_curve",
        figure_name="Analytical calibration curve",
        dataset_name="Gallery seed - calibration curve",
        rel_csv="03_chemistry/data/02_calibration_curve.csv",
        plot_type="scatter",
        mapping={"x": "Concentration_ppm", "y": "Absorbance"},
        options={**COMMON_OPTIONS, "x_label": "Concentration (ppm)", "y_label": "Absorbance", "add_smooth": True},
    ),
    GallerySeed(
        key="michaelis_menten",
        figure_name="Michaelis-Menten kinetics",
        dataset_name="Gallery seed - Michaelis-Menten kinetics",
        rel_csv="03_chemistry/data/03_kinetics_michaelis_menten.csv",
        plot_type="scatter",
        mapping={"x": "Substrate_mM", "y": "Velocity_umol_min"},
        options={**COMMON_OPTIONS, "x_label": "Substrate (mM)", "y_label": "Velocity (umol/min)", "add_smooth": True},
    ),
    GallerySeed(
        key="lineweaver_burk",
        figure_name="Lineweaver-Burk plot",
        dataset_name="Gallery seed - Lineweaver-Burk plot",
        rel_csv="03_chemistry/data/04_kinetics_lineweaver_burk.csv",
        plot_type="scatter",
        mapping={"x": "1_Substrate_1_mM", "y": "1_Velocity_1_umol_min"},
        options={**COMMON_OPTIONS, "x_label": "1 / substrate (1/mM)", "y_label": "1 / velocity", "add_smooth": True},
    ),
    GallerySeed(
        key="arrhenius",
        figure_name="Arrhenius plot",
        dataset_name="Gallery seed - Arrhenius plot",
        rel_csv="03_chemistry/data/05_arrhenius_plot.csv",
        plot_type="scatter",
        mapping={"x": "Inv_Temperature_1_K", "y": "ln_k"},
        options={**COMMON_OPTIONS, "x_label": "1 / temperature (1/K)", "y_label": "ln(k)", "add_smooth": True},
    ),
    GallerySeed(
        key="hplc_chromatogram",
        figure_name="HPLC chromatogram",
        dataset_name="Gallery seed - HPLC chromatogram",
        rel_csv="03_chemistry/data/06_chromatogram.csv",
        plot_type="line",
        mapping={"x": "Time_min", "y": "Signal_AU"},
        options={**COMMON_OPTIONS, "x_label": "Retention time (min)", "y_label": "Detector response (AU)", "hide_legend": True},
    ),
    GallerySeed(
        key="uv_vis_spectrum",
        figure_name="UV-Vis absorption spectrum",
        dataset_name="Gallery seed - UV-Vis absorption spectrum",
        rel_csv="03_chemistry/data/07_spectra_uv_vis.csv",
        plot_type="line",
        mapping={"x": "Wavelength_nm", "y": "Absorbance"},
        options={**COMMON_OPTIONS, "x_label": "Wavelength (nm)", "y_label": "Absorbance", "hide_legend": True},
    ),
    GallerySeed(
        key="ftir_spectrum",
        figure_name="FTIR spectrum",
        dataset_name="Gallery seed - FTIR spectrum",
        rel_csv="03_chemistry/data/08_spectra_ir.csv",
        plot_type="line",
        mapping={"x": "Wavenumber_cm-1", "y": "Transmittance_percent"},
        options={**COMMON_OPTIONS, "x_label": "Wavenumber (cm-1)", "y_label": "Transmittance (%)", "hide_legend": True},
    ),
    GallerySeed(
        key="van_hoff",
        figure_name="Van't Hoff plot",
        dataset_name="Gallery seed - Van't Hoff plot",
        rel_csv="03_chemistry/data/09_van_hoff_plot.csv",
        plot_type="scatter",
        mapping={"x": "1000_T_1_K", "y": "ln_K"},
        options={**COMMON_OPTIONS, "x_label": "1000 / T (1/K)", "y_label": "ln(K)", "add_smooth": True},
    ),
    GallerySeed(
        key="phase_diagram",
        figure_name="Phase diagram",
        dataset_name="Gallery seed - phase diagram",
        rel_csv="03_chemistry/data/10_phase_diagram.csv",
        transform=_phase_diagram,
        plot_type="line",
        mapping={"x": "Phenol_wt_percent", "y": "Temperature_C", "group": "Phase"},
        options={**COMMON_OPTIONS, "x_label": "Phenol (wt%)", "y_label": "Temperature (degC)"},
    ),
    GallerySeed(
        key="fermentation_time_course",
        figure_name="Fermentation time course",
        dataset_name="Gallery seed - fermentation time course",
        rel_csv="04_biotechnology/data/01_fermentation_time_course.csv",
        transform=_fermentation,
        plot_type="line",
        mapping={"x": "Time_h", "y": "Value", "group": "Metric"},
        options={**COMMON_OPTIONS, "x_label": "Time (h)", "y_label": "Concentration (g/L)"},
    ),
    GallerySeed(
        key="bioreactor_oxygen",
        figure_name="Bioreactor oxygen profile",
        dataset_name="Gallery seed - bioreactor oxygen profile",
        rel_csv="04_biotechnology/data/02_bioreactor_oxygen_profile.csv",
        plot_type="line",
        mapping={"x": "Time_h", "y": "DO_percent"},
        options={**COMMON_OPTIONS, "x_label": "Time (h)", "y_label": "Dissolved oxygen (%)", "hide_legend": True},
    ),
    GallerySeed(
        key="qpcr_expression",
        figure_name="qPCR expression fold change",
        dataset_name="Gallery seed - qPCR expression fold change",
        rel_csv="04_biotechnology/data/03_qpcr_expression.csv",
        transform=_qpcr,
        plot_type="error_bar",
        mapping={"x": "Gene", "y": "Mean_Expression_fold", "group": "Condition", "error": "SEM"},
        options={**COMMON_OPTIONS, "x_label": "Gene", "y_label": "Relative expression", "connect_points": False},
    ),
    GallerySeed(
        key="sds_page",
        figure_name="SDS-PAGE densitometry",
        dataset_name="Gallery seed - SDS-PAGE densitometry",
        rel_csv="04_biotechnology/data/04_sds_page_densitometry.csv",
        transform=_sds_page,
        plot_type="error_bar",
        mapping={"x": "MW_kDa", "y": "Mean_Intensity", "group": "Lane", "error": "SEM"},
        options={**COMMON_OPTIONS, "x_label": "Molecular weight (kDa)", "y_label": "Band intensity", "connect_points": True},
    ),
    GallerySeed(
        key="plasmid_yield",
        figure_name="Plasmid yield optimization",
        dataset_name="Gallery seed - plasmid yield optimization",
        rel_csv="04_biotechnology/data/05_plasmid_yield_optimization.csv",
        transform=_plasmid_yield,
        plot_type="error_bar",
        mapping={"x": "Strain", "y": "Mean_Plasmid_Yield", "group": "Media", "error": "SEM"},
        options={**COMMON_OPTIONS, "x_label": "Strain", "y_label": "Plasmid yield (ug/mL)", "connect_points": False},
    ),
    GallerySeed(
        key="antibody_titer",
        figure_name="Antibody titer standard curve",
        dataset_name="Gallery seed - antibody titer standard curve",
        rel_csv="04_biotechnology/data/06_antibody_titer_elisa.csv",
        transform=_antibody_standard,
        plot_type="error_bar",
        mapping={"x": "Concentration_ng_mL", "y": "Mean_OD450", "error": "SEM"},
        options={**COMMON_OPTIONS, "x_label": "Concentration (ng/mL)", "y_label": "OD450", "connect_points": True},
    ),
    GallerySeed(
        key="protein_purification",
        figure_name="Protein purification chromatogram",
        dataset_name="Gallery seed - protein purification chromatogram",
        rel_csv="04_biotechnology/data/07_protein_purification_chromatogram.csv",
        plot_type="line",
        mapping={"x": "Volume_mL", "y": "UV280_mAU"},
        options={**COMMON_OPTIONS, "x_label": "Elution volume (mL)", "y_label": "UV280 (mAU)", "hide_legend": True},
    ),
    GallerySeed(
        key="cell_culture_density",
        figure_name="Cell culture density curve",
        dataset_name="Gallery seed - cell culture density curve",
        rel_csv="04_biotechnology/data/08_cell_culture_density.csv",
        transform=_cell_culture_density,
        plot_type="line",
        mapping={"x": "Day", "y": "Cells_10e6_mL", "group": "Metric"},
        options={**COMMON_OPTIONS, "x_label": "Day", "y_label": "Cells (10e6/mL)"},
    ),
    GallerySeed(
        key="enzyme_activity",
        figure_name="Enzyme activity assay",
        dataset_name="Gallery seed - enzyme activity assay",
        rel_csv="04_biotechnology/data/09_enzyme_activity_assay.csv",
        transform=_enzyme_activity,
        plot_type="error_bar",
        mapping={"x": "Substrate_mM", "y": "Mean_Velocity", "group": "Condition", "error": "SEM"},
        options={**COMMON_OPTIONS, "x_label": "Substrate (mM)", "y_label": "Initial velocity", "connect_points": True},
    ),
    GallerySeed(
        key="metabolic_flux",
        figure_name="Metabolic flux radar",
        dataset_name="Gallery seed - metabolic flux radar",
        rel_csv="04_biotechnology/data/10_metabolic_flux_sankey.csv",
        transform=_metabolic_flux,
        plot_type="radar",
        mapping={"axis": "Metabolite", "value": "Mean_Flux", "group": "Condition"},
        options={**COMMON_OPTIONS, "x_label": "", "y_label": "Flux"},
        style_preset="colorblind",
    ),
    GallerySeed(
        key="stress_strain",
        figure_name="Stress-strain curve",
        dataset_name="Gallery seed - stress-strain curve",
        rel_csv="05_engineering/data/01_stress_strain_curve.csv",
        transform=_stress_strain,
        plot_type="line",
        mapping={"x": "Strain", "y": "Stress_MPa", "group": "Material"},
        options={**COMMON_OPTIONS, "x_label": "Strain", "y_label": "Stress (MPa)"},
    ),
    GallerySeed(
        key="nyquist",
        figure_name="Nyquist impedance plot",
        dataset_name="Gallery seed - Nyquist impedance plot",
        rel_csv="05_engineering/data/02_nyquist_plot.csv",
        plot_type="scatter",
        mapping={"x": "Z_real_Ohm", "y": "Z_imag_Ohm"},
        options={**COMMON_OPTIONS, "x_label": "Z real (Ohm)", "y_label": "Z imaginary (Ohm)", "add_smooth": False},
    ),
    GallerySeed(
        key="bode_magnitude",
        figure_name="Bode magnitude plot",
        dataset_name="Gallery seed - Bode magnitude plot",
        rel_csv="05_engineering/data/03_bode_plot.csv",
        plot_type="line",
        mapping={"x": "Frequency_Hz", "y": "Magnitude_Ohm"},
        options={**COMMON_OPTIONS, "x_label": "Frequency (Hz)", "y_label": "Magnitude (Ohm)", "log_x": True, "hide_legend": True},
    ),
    GallerySeed(
        key="solar_iv",
        figure_name="Solar cell I-V curve",
        dataset_name="Gallery seed - solar cell I-V curve",
        rel_csv="05_engineering/data/04_iv_curve_solar.csv",
        transform=_solar_iv,
        plot_type="line",
        mapping={"x": "Voltage_V", "y": "Current_mA", "group": "Temperature"},
        options={**COMMON_OPTIONS, "x_label": "Voltage (V)", "y_label": "Current (mA)"},
    ),
    GallerySeed(
        key="fatigue_sn",
        figure_name="Fatigue S-N curve",
        dataset_name="Gallery seed - fatigue S-N curve",
        rel_csv="05_engineering/data/05_fatigue_s_n_curve.csv",
        transform=_fatigue,
        plot_type="line",
        mapping={"x": "Cycles", "y": "Stress_MPa", "group": "Material"},
        options={**COMMON_OPTIONS, "x_label": "Cycles", "y_label": "Stress amplitude (MPa)", "log_x": True},
    ),
    GallerySeed(
        key="particle_size",
        figure_name="Particle size distribution",
        dataset_name="Gallery seed - particle size distribution",
        rel_csv="05_engineering/data/06_particle_size_distribution.csv",
        transform=_particle_size,
        plot_type="line",
        mapping={"x": "Particle_Size_um", "y": "Density", "group": "Sample"},
        options={**COMMON_OPTIONS, "x_label": "Particle size (um)", "y_label": "Density", "log_x": True},
    ),
    GallerySeed(
        key="creep_recovery",
        figure_name="Creep recovery curve",
        dataset_name="Gallery seed - creep recovery curve",
        rel_csv="05_engineering/data/07_creep_recovery.csv",
        transform=_creep,
        plot_type="line",
        mapping={"x": "Time_min", "y": "Strain", "group": "Stress"},
        options={**COMMON_OPTIONS, "x_label": "Time (min)", "y_label": "Strain"},
    ),
    GallerySeed(
        key="dsc",
        figure_name="DSC thermal analysis",
        dataset_name="Gallery seed - DSC thermal analysis",
        rel_csv="05_engineering/data/08_thermal_analysis_dsc.csv",
        transform=_dsc,
        plot_type="line",
        mapping={"x": "Temperature_C", "y": "HeatFlow_mW", "group": "Run"},
        options={**COMMON_OPTIONS, "x_label": "Temperature (degC)", "y_label": "Heat flow (mW)"},
    ),
    GallerySeed(
        key="tga",
        figure_name="TGA mass loss curve",
        dataset_name="Gallery seed - TGA mass loss curve",
        rel_csv="05_engineering/data/09_tga_thermogravimetric.csv",
        transform=_tga,
        plot_type="line",
        mapping={"x": "Temperature_C", "y": "Mass_pct", "group": "Heating_Rate"},
        options={**COMMON_OPTIONS, "x_label": "Temperature (degC)", "y_label": "Mass (%)"},
    ),
    GallerySeed(
        key="water_treatment_radar",
        figure_name="Water treatment performance radar",
        dataset_name="Gallery seed - water treatment performance radar",
        rel_csv="05_engineering/data/10_water_treatment_efficiency.csv",
        transform=_water_radar,
        plot_type="radar",
        mapping={"axis": "Contaminant", "value": "Removal_pct", "group": "Process"},
        options={**COMMON_OPTIONS, "x_label": "", "y_label": "Removal (%)"},
        style_preset="colorblind",
    ),
    GallerySeed(
        key="correlation_heatmap",
        figure_name="Feature correlation heatmap",
        dataset_name="Gallery seed - feature correlation heatmap",
        rel_csv="06_advanced_complex/data/02_correlation_heatmap.csv",
        plot_type="correlation_heatmap",
        mapping={"columns": ["Age", "BMI", "SBP", "DBP", "Glucose", "Cholesterol", "HDL", "LDL", "TG", "HbA1c"]},
        options={**COMMON_OPTIONS, "corr_method": "pearson", "show_values": False},
    ),
    GallerySeed(
        key="qq_plot",
        figure_name="Q-Q plot",
        dataset_name="Gallery seed - Q-Q plot",
        rel_csv="06_advanced_complex/data/03_qq_plot.csv",
        transform=_qq,
        plot_type="scatter",
        mapping={"x": "Theoretical_Quantile", "y": "Sample_Quantile", "color": "Distribution"},
        options={**COMMON_OPTIONS, "x_label": "Theoretical quantile", "y_label": "Sample quantile (z-score)", "add_smooth": True},
    ),
    GallerySeed(
        key="residuals",
        figure_name="Residuals vs fitted plot",
        dataset_name="Gallery seed - residuals vs fitted plot",
        rel_csv="06_advanced_complex/data/04_residuals_plot.csv",
        plot_type="scatter",
        mapping={"x": "y_fitted", "y": "residuals"},
        options={**COMMON_OPTIONS, "x_label": "Fitted value", "y_label": "Residual", "add_smooth": True},
    ),
    GallerySeed(
        key="forest",
        figure_name="Forest plot",
        dataset_name="Gallery seed - forest plot",
        rel_csv="06_advanced_complex/data/05_forest_plot_meta_analysis.csv",
        plot_type="error_bar",
        mapping={"x": "Study", "y": "Effect_Size", "ymin": "CI_Lower", "ymax": "CI_Upper"},
        options={**COMMON_OPTIONS, "x_label": "Study", "y_label": "Effect size", "connect_points": False, "flip_coords": True},
    ),
    GallerySeed(
        key="bubble",
        figure_name="Bubble chart",
        dataset_name="Gallery seed - bubble chart",
        rel_csv="06_advanced_complex/data/06_bubble_chart.csv",
        plot_type="chemical_space",
        mapping={"x": "Fold_Change", "y": "Neg_Log10_PValue", "color": "Category", "size": "Gene_Size"},
        options={**COMMON_OPTIONS, "x_label": "Fold change", "y_label": "-log10(p-value)"},
    ),
    GallerySeed(
        key="clustered_heatmap",
        figure_name="Clustered sample heatmap",
        dataset_name="Gallery seed - clustered sample heatmap",
        rel_csv="06_advanced_complex/data/07_dendrogram_clustering.csv",
        plot_type="annotated_heatmap",
        mapping={"columns": ["Feature_A", "Feature_B", "Feature_C", "Feature_D", "Feature_E"], "row_label": "Sample"},
        options={**COMMON_OPTIONS, "cluster_rows": True, "cluster_cols": True, "show_row_names": True},
    ),
    GallerySeed(
        key="lollipop",
        figure_name="Lollipop chart",
        dataset_name="Gallery seed - lollipop chart",
        rel_csv="06_advanced_complex/data/08_lollipop_chart.csv",
        plot_type="enrichment_bar",
        mapping={"term": "Pathway", "value": "Enrichment_Score"},
        options={**COMMON_OPTIONS, "x_label": "Enrichment score", "y_label": ""},
    ),
    GallerySeed(
        key="composition_trend",
        figure_name="Composition trend chart",
        dataset_name="Gallery seed - composition trend chart",
        rel_csv="06_advanced_complex/data/09_area_chart_stacked.csv",
        transform=_composition_trend,
        plot_type="line",
        mapping={"x": "Year", "y": "Count", "group": "Group"},
        options={**COMMON_OPTIONS, "x_label": "Year", "y_label": "Count"},
    ),
    GallerySeed(
        key="grouped_density",
        figure_name="Grouped density plot",
        dataset_name="Gallery seed - grouped density plot",
        rel_csv="06_advanced_complex/data/10_ridge_plot_joy.csv",
        plot_type="density",
        mapping={"value": "Value", "group": "Group"},
        options={**COMMON_OPTIONS, "x_label": "Value", "show_rug": False},
    ),
    GallerySeed(
        key="sankey",
        figure_name="Sankey diagram",
        dataset_name="Gallery seed - Sankey diagram",
        dataframe_factory=_advanced_sankey,
        plot_type="sankey",
        mapping={"source": "Source", "target": "Target", "value": "Reads"},
        options={**COMMON_OPTIONS, "x_label": "", "y_label": "Workflow"},
    ),
    GallerySeed(
        key="upset",
        figure_name="UpSet plot",
        dataset_name="Gallery seed - UpSet plot",
        dataframe_factory=_advanced_upset,
        plot_type="upset",
        mapping={"sets": ["RNAseq", "Proteomics", "Metabolomics", "CRISPR", "Imaging"]},
        options={**COMMON_OPTIONS, "size": "wide"},
    ),
    GallerySeed(
        key="surface_3d",
        figure_name="3D surface plot",
        dataset_name="Gallery seed - 3D surface plot",
        dataframe_factory=_advanced_surface_grid,
        plot_type="surface_3d",
        mapping={"x": "X", "y": "Y", "z": "Response"},
        options={**COMMON_OPTIONS, "x_label": "Factor X", "y_label": "Factor Y", "size": "square"},
    ),
    GallerySeed(
        key="scatter_3d",
        figure_name="3D scatter plot",
        dataset_name="Gallery seed - 3D scatter plot",
        dataframe_factory=_advanced_scatter_3d,
        plot_type="scatter_3d",
        mapping={"x": "PC1", "y": "PC2", "z": "PC3", "group": "Cluster"},
        options={**COMMON_OPTIONS, "size": "square"},
    ),
    GallerySeed(
        key="contour_3d",
        figure_name="3D contour projection",
        dataset_name="Gallery seed - 3D contour projection",
        dataframe_factory=_advanced_surface_grid,
        plot_type="contour_3d",
        mapping={"x": "X", "y": "Y", "z": "Response"},
        options={**COMMON_OPTIONS, "x_label": "Factor X", "y_label": "Factor Y", "size": "square"},
    ),
    GallerySeed(
        key="calibration_curve_advanced",
        figure_name="Calibration curve",
        dataset_name="Gallery seed - calibration curve",
        dataframe_factory=_advanced_calibration_curve,
        plot_type="calibration_curve",
        mapping={"predicted": "Predicted", "observed": "Observed", "group": "Instrument"},
        options={**COMMON_OPTIONS, "x_label": "Predicted probability", "y_label": "Observed frequency"},
    ),
    GallerySeed(
        key="chord_diagram",
        figure_name="Chord diagram",
        dataset_name="Gallery seed - chord diagram",
        dataframe_factory=_advanced_chord,
        plot_type="chord_diagram",
        mapping={"source": "Source", "target": "Target", "value": "Interaction_Strength"},
        options={**COMMON_OPTIONS, "size": "square"},
    ),
    GallerySeed(
        key="parallel_coordinates",
        figure_name="Parallel coordinates plot",
        dataset_name="Gallery seed - parallel coordinates plot",
        dataframe_factory=_advanced_parallel_coordinates,
        plot_type="parallel_coordinates",
        mapping={
            "columns": ["Immune_Score", "Metabolic_Score", "Proliferation", "Hypoxia", "Stromal_Score"],
            "group": "Cohort",
            "id": "Sample",
        },
        options={**COMMON_OPTIONS, "x_label": "", "y_label": "Scaled score"},
    ),
    GallerySeed(
        key="confusion_matrix",
        figure_name="Confusion matrix heatmap",
        dataset_name="Gallery seed - confusion matrix heatmap",
        dataframe_factory=_advanced_confusion_matrix,
        plot_type="confusion_matrix",
        mapping={"actual": "Actual", "predicted": "Predicted"},
        options={**COMMON_OPTIONS, "size": "square"},
    ),
    GallerySeed(
        key="tri_surface",
        figure_name="Tri-surface plot",
        dataset_name="Gallery seed - tri-surface plot",
        dataframe_factory=_advanced_surface_grid,
        plot_type="tri_surface",
        mapping={"x": "X", "y": "Y", "z": "Response"},
        options={**COMMON_OPTIONS, "x_label": "Factor X", "y_label": "Factor Y", "size": "square"},
    ),
    GallerySeed(
        key="wireframe_3d",
        figure_name="3D wireframe plot",
        dataset_name="Gallery seed - 3D wireframe plot",
        dataframe_factory=_advanced_surface_grid,
        plot_type="wireframe_3d",
        mapping={"x": "X", "y": "Y", "z": "Response"},
        options={**COMMON_OPTIONS, "x_label": "Factor X", "y_label": "Factor Y", "size": "square"},
    ),
    GallerySeed(
        key="roc_pr",
        figure_name="ROC and PR curves",
        dataset_name="Gallery seed - ROC and PR curves",
        dataframe_factory=_advanced_roc_pr,
        plot_type="roc_pr_curve",
        mapping={"score": "Score", "label": "Label", "group": "Model"},
        options={**COMMON_OPTIONS, "x_label": "False positive rate / recall", "y_label": "True positive rate / precision"},
    ),
    GallerySeed(
        key="ma_plot",
        figure_name="MA plot",
        dataset_name="Gallery seed - MA plot",
        dataframe_factory=_advanced_ma_plot,
        plot_type="ma_plot",
        mapping={"mean": "Mean_Expression", "log2fc": "Log2FC", "gene_label": "Gene"},
        options={**COMMON_OPTIONS, "x_label": "Mean expression", "y_label": "log2 fold change", "log_x": True, "fc_threshold": 1.0, "label_top": 8},
    ),
]


def _ensure_root(db) -> User:
    root = db.query(User).filter(User.email == settings.ROOT_EMAIL).first()
    if not root:
        raise RuntimeError(f"Root user {settings.ROOT_EMAIL} not found")
    return root


def _delete_existing(db, root: User, figure_name: str) -> None:
    rows = db.query(Figure).filter(Figure.owner_id == root.id, Figure.name == figure_name).all()
    for figure in rows:
        if figure.dataset_id:
            dataset = db.query(Dataset).filter(Dataset.id == figure.dataset_id).first()
            if dataset and dataset.owner_id == root.id:
                dataset_service.delete_dataset(db, dataset.id, root.id)
                continue
        db.delete(figure)
    db.commit()


def seed_one(db, root: User, seed: GallerySeed, replace: bool) -> str:
    exists = db.query(Figure.id).filter(Figure.owner_id == root.id, Figure.name == seed.figure_name).first()
    if exists and not replace:
        return "skipped"
    if exists and replace:
        _delete_existing(db, root, seed.figure_name)

    if seed.dataframe_factory:
        df = seed.dataframe_factory()
    elif seed.rel_csv:
        df = _read_ref(seed.rel_csv)
    else:
        raise RuntimeError(f"Seed {seed.key} has no rel_csv or dataframe_factory")
    if seed.transform:
        df = seed.transform(df)
    content = _csv_bytes(df)
    dataset = dataset_service.create_dataset(
        db,
        owner_id=root.id,
        filename=f"{seed.key}.csv",
        content=content,
        name=seed.dataset_name,
        description="Curated public gallery seed derived from ref_data.",
        column_roles=seed.column_roles,
    )
    figure_service.create_figure(
        db,
        root.id,
        SimpleNamespace(
            dataset_id=dataset.id,
            name=seed.figure_name,
            plot_type=seed.plot_type,
            mapping=seed.mapping,
            options=seed.options,
            style_preset=seed.style_preset,
        ),
    )
    db.commit()
    return "created"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--replace", action="store_true", help="replace existing seeded figures with matching names")
    parser.add_argument("--list", action="store_true", help="list selected seeds without writing")
    parser.add_argument("--only", nargs="*", help="optional seed keys or figure names to run")
    args = parser.parse_args()

    seeds = SEEDS
    if args.only:
        wanted = {item.lower() for item in args.only}
        seeds = [
            seed for seed in seeds
            if seed.key.lower() in wanted or seed.figure_name.lower() in wanted
        ]

    if args.list:
        for seed in seeds:
            source = seed.rel_csv or "<generated>"
            print(f"{seed.key}\t{seed.plot_type}\t{seed.figure_name}\t{source}")
        print(f"{len(seeds)} selected")
        return 0

    with SessionLocal() as db:
        root = _ensure_root(db)
        counts = {"created": 0, "skipped": 0, "failed": 0}
        for seed in seeds:
            try:
                status = seed_one(db, root, seed, replace=args.replace)
                counts[status] += 1
                print(f"{status}: {seed.figure_name}")
            except Exception as exc:
                counts["failed"] += 1
                db.rollback()
                print(f"failed: {seed.figure_name}: {exc}", file=sys.stderr)
        print(counts)
        return 1 if counts["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
