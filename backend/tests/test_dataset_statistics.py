import sys
import types
import unittest
from unittest.mock import patch

import pandas as pd

from app.datasets.profiler import profile_dataframe
from app.datasets.stats import comparison_value_columns, compute_statistics


def _experiment_frame() -> pd.DataFrame:
    rows = []
    for genotype_index, genotype in enumerate(("WT", "KO", "OE")):
        for time_h in (0, 24):
            for replicate in (1, 2, 3):
                rows.append({
                    "Genotype": genotype,
                    "Time_h": time_h,
                    "Replicate": replicate,
                    "Subject_ID": f"{genotype}-{replicate}",
                    "Expression": 10 + genotype_index * 20 + time_h / 8 + replicate / 10,
                })
    return pd.DataFrame(rows)


class _FakeScipyStats:
    @staticmethod
    def f_oneway(*_arrays):
        return 42.0, 0.0

    @staticmethod
    def kruskal(*_arrays):
        return 40.0, 0.0

    @staticmethod
    def shapiro(_array):
        return 0.99, 0.5

    @staticmethod
    def levene(*_arrays):
        return 1.0, 0.5


class _BoundaryPScipyStats:
    @staticmethod
    def ttest_ind(*_arrays, **_kwargs):
        return 2.0, 0.04996

    @staticmethod
    def mannwhitneyu(*_arrays, **_kwargs):
        return 3.0, 0.04996

    @staticmethod
    def shapiro(_array):
        return 0.99, 0.5

    @staticmethod
    def levene(*_arrays):
        return 1.0, 0.5


class _SequentialPScipyStats:
    def __init__(self):
        self._parametric_p_values = iter((0.02496, 0.05004))

    def ttest_ind(self, *_arrays, **_kwargs):
        return 2.0, next(self._parametric_p_values)

    @staticmethod
    def mannwhitneyu(*_arrays, **_kwargs):
        return 3.0, 0.5

    @staticmethod
    def shapiro(_array):
        return 0.99, 0.5

    @staticmethod
    def levene(*_arrays):
        return 1.0, 0.5


class _TinyPScipyStats(_BoundaryPScipyStats):
    @staticmethod
    def ttest_ind(*_arrays, **_kwargs):
        return 12.0, 1e-8

    @staticmethod
    def mannwhitneyu(*_arrays, **_kwargs):
        return 9.0, 2e-8


class DatasetStatisticsTests(unittest.TestCase):
    def test_profiler_marks_time_ids_and_replicates_as_structural_roles(self):
        profile = profile_dataframe(_experiment_frame())["columns"]
        roles = {column["name"]: column["role"] for column in profile}

        self.assertEqual(roles["Genotype"], "group")
        self.assertEqual(roles["Time_h"], "time")
        self.assertEqual(roles["Replicate"], "replicate")
        self.assertEqual(roles["Subject_ID"], "id")
        self.assertEqual(roles["Expression"], "numeric")

    def test_comparison_values_exclude_structural_roles_and_legacy_names(self):
        profile = [
            {"name": "Genotype", "dtype": "categorical", "role": "group"},
            {"name": "Time_h", "dtype": "numeric", "role": "numeric"},
            {"name": "Replicate", "dtype": "numeric", "role": "numeric"},
            {"name": "Subject_ID", "dtype": "numeric", "role": "numeric"},
            {"name": "Expression", "dtype": "numeric", "role": "numeric"},
            {"name": "recovery_time", "dtype": "numeric", "role": "numeric"},
            {"name": "Time_h", "dtype": "numeric", "role": "numeric", "role_source": "user"},
        ]

        self.assertEqual(
            comparison_value_columns(profile),
            ["Expression", "recovery_time", "Time_h"],
        )

    def test_group_time_repeated_design_suppresses_pooled_one_way_comparison(self):
        frame = _experiment_frame()
        profile = profile_dataframe(frame)["columns"]
        scipy_module = types.ModuleType("scipy")
        scipy_module.stats = _FakeScipyStats

        with patch.dict(sys.modules, {"scipy": scipy_module}):
            result = compute_statistics(frame, profile)

        self.assertEqual(result["comparisons"], [])
        self.assertEqual(result["comparison_policy"], "suppress-group-time-one-factor-comparisons-v4")
        self.assertTrue(result["one_factor_comparisons_suppressed"])

    def test_group_time_design_without_repeated_unit_also_suppresses_pooled_comparison(self):
        frame = pd.DataFrame({
            "Treatment": ["A", "A", "A", "A", "B", "B", "B", "B"],
            "Time_h": [0, 0, 24, 24, 0, 0, 24, 24],
            "Expression": [1.0, 1.1, 1.8, 1.9, 2.0, 2.1, 2.8, 2.9],
        })
        profile = [
            {"name": "Treatment", "dtype": "categorical", "role": "group", "n_unique": 2},
            {"name": "Time_h", "dtype": "numeric", "role": "time", "n_unique": 2},
            {"name": "Expression", "dtype": "numeric", "role": "numeric", "n_unique": 8},
        ]
        scipy_module = types.ModuleType("scipy")
        scipy_module.stats = _BoundaryPScipyStats

        with patch.dict(sys.modules, {"scipy": scipy_module}):
            result = compute_statistics(frame, profile)

        self.assertEqual(result["comparisons"], [])

    def test_legacy_day_name_uses_the_same_group_time_suppression_contract(self):
        frame = pd.DataFrame({
            "Treatment": ["A", "A", "B", "B"],
            "Study_Days": [0, 7, 0, 7],
            "Expression": [1.0, 1.8, 2.0, 2.9],
        })
        profile = [
            {"name": "Treatment", "dtype": "categorical", "role": "group", "n_unique": 2},
            {"name": "Study_Days", "dtype": "numeric", "role": "numeric", "n_unique": 2},
            {"name": "Expression", "dtype": "numeric", "role": "numeric", "n_unique": 4},
        ]
        result = compute_statistics(frame, profile)

        self.assertTrue(result["one_factor_comparisons_suppressed"])
        self.assertEqual(result["comparisons"], [])

    def test_one_way_anova_remains_available_when_no_time_design_is_present(self):
        frame = pd.DataFrame({
            "Genotype": ["WT", "WT", "KO", "KO", "OE", "OE"],
            "Expression": [1.0, 1.1, 2.0, 2.1, 3.0, 3.1],
        })
        profile = [
            {"name": "Genotype", "dtype": "categorical", "role": "group", "n_unique": 3},
            {"name": "Expression", "dtype": "numeric", "role": "numeric", "n_unique": 6},
        ]
        scipy_module = types.ModuleType("scipy")
        scipy_module.stats = _FakeScipyStats

        with patch.dict(sys.modules, {"scipy": scipy_module}):
            result = compute_statistics(frame, profile)

        self.assertEqual(
            [(item["group_column"], item["value_column"], item["test"]) for item in result["comparisons"]],
            [("Genotype", "Expression", "One-way ANOVA")],
        )

    def test_explicit_numeric_override_does_not_reinterpret_time_name_as_design_factor(self):
        frame = _experiment_frame()
        profile = profile_dataframe(frame)["columns"]
        for column in profile:
            if column["name"] == "Time_h":
                column["role"] = "numeric"
                column["role_source"] = "user"
        scipy_module = types.ModuleType("scipy")
        scipy_module.stats = _FakeScipyStats

        with patch.dict(sys.modules, {"scipy": scipy_module}):
            result = compute_statistics(frame, profile)

        self.assertEqual(
            [item["value_column"] for item in result["comparisons"]],
            ["Time_h", "Expression"],
        )

    def test_raw_p_values_drive_significance_before_api_rounding(self):
        frame = pd.DataFrame({
            "Treatment": ["A", "A", "A", "B", "B", "B"],
            "Expression": [1.0, 1.2, 1.4, 2.0, 2.2, 2.4],
        })
        profile = [
            {"name": "Treatment", "dtype": "categorical", "role": "group", "n_unique": 2},
            {"name": "Expression", "dtype": "numeric", "role": "numeric", "n_unique": 6},
        ]
        scipy_module = types.ModuleType("scipy")
        scipy_module.stats = _BoundaryPScipyStats

        with patch.dict(sys.modules, {"scipy": scipy_module}):
            result = compute_statistics(frame, profile)

        comparison = result["comparisons"][0]
        self.assertEqual(comparison["p_value"], 0.04996)
        self.assertTrue(comparison["significant"])
        self.assertEqual(comparison["nonparametric"]["p_value"], 0.04996)
        self.assertTrue(comparison["nonparametric"]["significant"])

    def test_tiny_p_values_are_preserved_for_api_formatting(self):
        frame = pd.DataFrame({
            "Treatment": ["A", "A", "A", "B", "B", "B"],
            "Expression": [1.0, 1.2, 1.4, 2.0, 2.2, 2.4],
        })
        profile = [
            {"name": "Treatment", "dtype": "categorical", "role": "group", "n_unique": 2},
            {"name": "Expression", "dtype": "numeric", "role": "numeric", "n_unique": 6},
        ]
        scipy_module = types.ModuleType("scipy")
        scipy_module.stats = _TinyPScipyStats

        with patch.dict(sys.modules, {"scipy": scipy_module}):
            comparison = compute_statistics(frame, profile)["comparisons"][0]

        self.assertEqual(comparison["p_value"], 1e-8)
        self.assertEqual(comparison["nonparametric"]["p_value"], 2e-8)
        self.assertTrue(comparison["significant"])

    def test_bh_adjustment_uses_raw_p_values_before_api_rounding(self):
        frame = pd.DataFrame({
            "Treatment": ["A", "A", "A", "B", "B", "B"],
            "Cohort": ["X", "X", "Y", "Y", "X", "Y"],
            "Expression": [1.0, 1.2, 1.4, 2.0, 2.2, 2.4],
        })
        profile = [
            {"name": "Treatment", "dtype": "categorical", "role": "group", "n_unique": 2},
            {"name": "Cohort", "dtype": "categorical", "role": "category", "n_unique": 2},
            {"name": "Expression", "dtype": "numeric", "role": "numeric", "n_unique": 6},
        ]
        scipy_module = types.ModuleType("scipy")
        scipy_module.stats = _SequentialPScipyStats()

        with patch.dict(sys.modules, {"scipy": scipy_module}):
            result = compute_statistics(frame, profile)

        self.assertEqual(
            [comparison["p_value"] for comparison in result["comparisons"]],
            [0.02496, 0.05004],
        )
        self.assertAlmostEqual(result["comparisons"][0]["p_value_adjusted"], 0.04992)
        self.assertAlmostEqual(result["comparisons"][1]["p_value_adjusted"], 0.05004)
        self.assertEqual(
            [comparison["significant_fdr"] for comparison in result["comparisons"]],
            [True, False],
        )

    def test_role_override_records_user_intent_for_statistics(self):
        from app.datasets.service import _apply_column_role_overrides, normalized_column_profile

        updated = _apply_column_role_overrides(
            [{
                "name": "recovery_time",
                "dtype": "numeric",
                "role": "time",
                "sample_values": [1, 2, 3],
            }],
            {"recovery_time": "numeric"},
        )

        self.assertEqual(updated[0]["role"], "numeric")
        self.assertEqual(updated[0]["role_source"], "user")
        self.assertEqual(comparison_value_columns(updated), ["recovery_time"])

        text_override = _apply_column_role_overrides(
            [{
                "name": "Replicate",
                "dtype": "numeric",
                "role": "replicate",
                "sample_values": [1, 2, 3],
            }],
            {"Replicate": "text"},
        )
        self.assertEqual(normalized_column_profile(text_override), text_override)
        self.assertEqual(text_override[0]["dtype"], "text")
        self.assertEqual(text_override[0]["role"], "text")


if __name__ == "__main__":
    unittest.main()
