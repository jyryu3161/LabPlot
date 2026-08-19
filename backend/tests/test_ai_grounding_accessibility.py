import os
import re
import tempfile
import unittest
from unittest.mock import patch

import pandas as pd

from app.ai import client as ai_client
from app.ai import prompts
from app.ai.grounding import (
    AccessibilityChecksContract,
    accessibility_checks,
    build_dataset_grounding,
    ensure_grounded_facts,
    ground_generated_text,
)
from app.figures import service as figure_service


class GroundedFigureTextTests(unittest.TestCase):
    def setUp(self):
        self.frame = pd.DataFrame({
            "Time_h": [0, 24, 0, 24, 0, 24, 0, 24],
            "Genotype": ["Control", "Control", "Control", "Control", "KO", "KO", "KO", "KO"],
            "Expression": [1.0, 3.0, 2.0, 4.0, 8.0, 6.0, 7.0, 5.0],
        })
        self.profile = [
            {"name": "Time_h", "dtype": "numeric", "role": "time", "n_unique": 2,
             "n_missing": 0, "sample_values": [0, 24], "stats": {"min": 0, "max": 24, "mean": 12, "median": 12}},
            {"name": "Genotype", "dtype": "categorical", "role": "group", "n_unique": 2,
             "n_missing": 0, "sample_values": ["Control", "KO"], "stats": None},
            {"name": "Expression", "dtype": "numeric", "role": "numeric", "n_unique": 8,
             "n_missing": 0, "sample_values": [1, 3, 2, 4, 8, 6],
             "stats": {"min": 1, "max": 8, "mean": 4.5, "median": 4.5}},
        ]
        self.mapping = {"x": "Time_h", "y": "Expression", "group": "Genotype"}
        self.options = {
            "stat": "mean", "show_points": True, "error_bars": True,
            "error_type": "sd", "palette_name": "publication_muted_v2",
        }
        self.grounding = build_dataset_grounding(
            n_rows=8,
            column_profile=self.profile,
            mapping=self.mapping,
            options=self.options,
            plot_type="grouped_bar",
            dataframe=self.frame,
        )

    def test_grounding_exposes_exact_rows_levels_ranges_representation_and_trends(self):
        self.assertEqual(self.grounding["total_rows"], 8)
        self.assertEqual(self.grounding["series"]["column"], "Genotype")
        self.assertEqual(self.grounding["series"]["levels"], ["Control", "KO"])
        self.assertTrue(self.grounding["series"]["levels_complete"])
        self.assertEqual(self.grounding["mapped_columns"]["y"]["range"], {"min": 1.0, "max": 8.0})
        self.assertEqual(
            self.grounding["representation"],
            {"summary": "mean", "individual_observations": True, "error_bars": True, "error_type": "sd"},
        )
        trends = {item["series"]: item for item in self.grounding["descriptive_trends"]}
        self.assertEqual(trends["Control"]["direction"], "increased")
        self.assertEqual(trends["KO"]["direction"], "decreased")
        self.assertEqual(trends["Control"]["first_mean"], 1.5)
        self.assertEqual(trends["Control"]["last_mean"], 3.5)

    def test_numeric_time_used_as_series_has_exact_render_order(self):
        grounding = build_dataset_grounding(
            n_rows=8,
            column_profile=self.profile,
            mapping={"x": "Genotype", "y": "Expression", "group": "Time_h"},
            options={"stat": "mean"},
            plot_type="grouped_bar",
            dataframe=self.frame,
        )
        self.assertEqual(grounding["series"]["levels"], ["0", "24"])
        self.assertTrue(grounding["series"]["levels_complete"])

    def test_unsupported_numeric_sentence_is_removed_but_grounded_numbers_remain(self):
        generated = (
            "The source dataset contains 8 rows. "
            "There were 999 biological replicates. "
            "Expression ranges from 1 to 8."
        )
        cleaned = ground_generated_text(generated, self.grounding)
        self.assertIn("8 rows", cleaned)
        self.assertIn("1 to 8", cleaned)
        self.assertNotIn("999", cleaned)

    def test_row_count_is_never_relabelled_as_independent_sample_size(self):
        cleaned = ground_generated_text(
            "There were 8 biological samples. The source dataset contains 8 rows.",
            self.grounding,
        )
        self.assertNotIn("biological samples", cleaned)
        self.assertIn("8 rows", cleaned)

    def test_numeric_grounding_property_rejects_every_unlisted_value(self):
        for value in (-999, 9, 37, 123.456, 10000):
            with self.subTest(value=value):
                cleaned = ground_generated_text(
                    f"Expression ranges from 1 to 8. An unsupported result was {value}.",
                    self.grounding,
                )
                self.assertIn("1 to 8", cleaned)
                self.assertNotIn(str(value), cleaned)

    def test_supported_numbers_cannot_be_reassigned_to_wrong_facts(self):
        cleaned = ground_generated_text(
            "The source dataset contains 2 rows. There are 8 groups. "
            "Expression ranges from 8 to 1. The source dataset contains 8 rows. "
            "There are 2 groups. Expression ranges from 1 to 8.",
            self.grounding,
        )
        self.assertNotIn("contains 2 rows", cleaned)
        self.assertNotIn("8 groups", cleaned)
        self.assertNotIn("8 to 1", cleaned)
        self.assertIn("contains 8 rows", cleaned)
        self.assertIn("2 groups", cleaned)
        self.assertIn("1 to 8", cleaned)

    def test_deterministic_facts_add_quantitative_context_without_calling_rows_samples(self):
        result = ensure_grounded_facts("Line chart of Expression by Time_h.", self.grounding, kind="alt_text")
        self.assertIn("8 source-data rows", result)
        self.assertIn("Control and KO", result)
        self.assertIn("1 to 8", result)
        self.assertIn("Control increased", result)
        self.assertNotIn("8 samples", result)

    def test_legend_and_alt_text_prompts_are_versioned_and_post_grounded(self):
        for version, system in (
            (prompts.LEGEND_PROMPT_VERSION, prompts.LEGEND_SYSTEM),
            (prompts.ALT_TEXT_PROMPT_VERSION, prompts.ALT_TEXT_SYSTEM),
            (prompts.REVIEW_PROMPT_VERSION, prompts.REVIEW_SYSTEM),
        ):
            self.assertRegex(version, r"^\d{4}-\d{2}-\d{2}\.\d+$")
            self.assertIn(f"PROMPT VERSION: {version}", system)

        with patch.object(ai_client, "_run_logged", return_value={
            "legend": "There were 999 samples. Line chart of Expression by Time_h."
        }):
            legend = ai_client.generate_legend(
                object(), "grouped_bar", self.mapping, self.options, self.grounding, None,
            )
        self.assertNotIn("999", legend)
        self.assertIn("8 source-data rows", legend)
        self.assertIn("Control and KO", legend)

        with patch.object(ai_client, "_run_logged", return_value={
            "alt_text": "Line chart with 999 subjects."
        }):
            alt_text = ai_client.generate_alt_text(
                object(), "grouped_bar", self.mapping, self.options, self.grounding, None,
            )
        self.assertNotIn("999", alt_text)
        self.assertIn("8 source-data rows", alt_text)
        self.assertIn("Control increased", alt_text)

    def test_methods_include_only_supplied_runtime_package_versions(self):
        text = figure_service._assemble_methods_text(
            "line", self.mapping, self.options, "nature",
            "library(ggplot2)\nlibrary(dplyr)\np <- ggplot(df) + geom_line()",
            package_versions={"R": "4.5.3", "ggplot2": "4.0.3", "dplyr": "1.1.4"},
        )
        self.assertIn("R 4.5.3", text)
        self.assertIn("ggplot2 4.0.3", text)
        self.assertIn("dplyr 1.1.4", text)
        self.assertNotIn("tidyr", text)


class ColorAccessibilityContractTests(unittest.TestCase):
    def _summary(self, levels=None):
        return {
            "series": {
                "column": "Genotype",
                "levels": levels or [],
                "levels_complete": levels is not None,
            }
        }

    def test_checks_use_only_actual_resolved_series_colors(self):
        checks = accessibility_checks(
            plot_type="line",
            mapping={"x": "Time_h", "y": "Expression", "group": "Genotype"},
            options={"palette_name": "publication_muted_v2"},
            dataset_grounding=self._summary(["Control", "KO"]),
            style_preset="nature",
        )
        self.assertEqual(checks["schema_version"], "1.0")
        self.assertEqual(checks["palette"]["status"], "evaluated")
        self.assertEqual(checks["palette"]["colors"], ["#2F8998", "#B94A3F"])
        self.assertEqual(checks["palette"]["series_count"], 2)
        self.assertEqual(
            [item["mode"] for item in checks["cvd"]["simulations"]],
            ["protanopia", "deuteranopia", "tritanopia"],
        )
        self.assertIn(checks["cvd"]["status"], {"pass", "needs_review"})
        self.assertIsInstance(checks["grayscale"]["min_delta_l"], float)
        self.assertGreaterEqual(checks["minimum_contrast"]["ratio"], 1.0)
        self.assertEqual(checks["minimum_contrast"]["background"], "#FFFFFF")

    def test_accessibility_json_schema_is_strict_and_versioned(self):
        schema = AccessibilityChecksContract.model_json_schema()
        self.assertEqual(
            set(schema["required"]),
            {"schema_version", "palette", "cvd", "grayscale", "minimum_contrast"},
        )
        self.assertEqual(schema["properties"]["schema_version"]["const"], "1.0")
        self.assertFalse(schema["additionalProperties"])

    def test_category_and_series_overrides_are_the_resolved_colors(self):
        checks = accessibility_checks(
            plot_type="line",
            mapping={"x": "Time_h", "y": "Expression", "group": "Genotype"},
            options={
                "palette_name": "publication_muted_v2",
                "category_colors": {"Control": "#112233"},
                "series_styles": {"KO": {"color": "#ABCDEF"}},
            },
            dataset_grounding=self._summary(["Control", "KO"]),
            style_preset="nature",
        )
        self.assertEqual(checks["palette"]["colors"], ["#112233", "#ABCDEF"])

    def test_single_element_override_is_included_in_actual_color_set(self):
        checks = accessibility_checks(
            plot_type="grouped_bar",
            mapping={"x": "Time_h", "y": "Expression", "group": "Genotype"},
            options={
                "palette_name": "publication_muted_v2",
                "element_overrides": {"bar:Control:24": {"fill": "#7E22CE"}},
            },
            dataset_grounding=self._summary(["Control", "KO"]),
            style_preset="nature",
        )
        self.assertEqual(
            checks["palette"]["colors"],
            ["#62B9C5", "#E4776B", "#7E22CE"],
        )
        self.assertIn("element_overrides", checks["palette"]["source"])

    def test_explicit_single_line_still_gets_background_contrast(self):
        checks = accessibility_checks(
            plot_type="line",
            mapping={"x": "x", "y": "y"},
            options={"line_color": "#112233"},
            dataset_grounding={"series": None},
            style_preset="nature",
        )
        self.assertEqual(checks["palette"]["colors"], ["#112233"])
        self.assertEqual(checks["minimum_contrast"]["status"], "pass")
        self.assertEqual(checks["cvd"]["status"], "not_evaluable")

    def test_pairwise_checks_are_not_evaluable_without_exact_levels(self):
        checks = accessibility_checks(
            plot_type="line",
            mapping={"x": "Time_h", "y": "Expression", "group": "Genotype"},
            options={"palette_name": "publication_muted_v2"},
            dataset_grounding=self._summary(None),
            style_preset="nature",
        )
        self.assertEqual(checks["palette"]["status"], "not_evaluable")
        self.assertEqual(checks["cvd"]["status"], "not_evaluable")
        self.assertEqual(checks["grayscale"]["status"], "not_evaluable")
        self.assertEqual(checks["minimum_contrast"]["status"], "not_evaluable")
        self.assertIsNotNone(checks["palette"]["reason"])

    def test_accessibility_contract_properties_hold_for_two_to_eight_series(self):
        valid_statuses = {"pass", "needs_review", "not_evaluable"}
        for count in range(2, 9):
            with self.subTest(series_count=count):
                checks = accessibility_checks(
                    plot_type="line",
                    mapping={"x": "x", "y": "y", "group": "group"},
                    options={"palette_name": "publication_muted_v2"},
                    dataset_grounding=self._summary([f"G{i}" for i in range(count)]),
                    style_preset="nature",
                )
                self.assertEqual(len(checks["palette"]["colors"]), count)
                self.assertTrue(all(
                    re.fullmatch(r"#[0-9A-F]{6}", color)
                    for color in checks["palette"]["colors"]
                ))
                self.assertIn(checks["cvd"]["status"], valid_statuses)
                self.assertIn(checks["grayscale"]["status"], valid_statuses)
                self.assertIn(checks["minimum_contrast"]["status"], valid_statuses)
                self.assertGreaterEqual(checks["minimum_contrast"]["ratio"], 1.0)

    def test_server_overwrites_provider_accessibility_claims(self):
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as handle:
            handle.write(b"not-a-real-png-but-the-client-only-base64-encodes-it")
            path = handle.name
        provider = {
            "publication_score": 90,
            "summary": "Readable figure.",
            "visual_quality": {"score": 90, "comments": []},
            "statistical": {"score": 90, "comments": []},
            "suitability": {"score": 90, "comments": []},
            "strengths": [],
            "issues": [],
            "accessibility_checks": {"cvd": {"status": "pass", "simulations": []}},
        }
        try:
            with patch.object(ai_client, "_run_logged", return_value=provider):
                result = ai_client.review_figure(
                    object(), path, "line",
                    {"x": "Time_h", "y": "Expression", "group": "Genotype"},
                    {"palette_name": "publication_muted_v2"},
                    dataset_grounding=self._summary(["Control", "KO"]),
                )
        finally:
            os.unlink(path)
        self.assertEqual(result["accessibility_checks"]["schema_version"], "1.0")
        self.assertEqual(len(result["accessibility_checks"]["cvd"]["simulations"]), 3)
        self.assertEqual(result["review_prompt_version"], prompts.REVIEW_PROMPT_VERSION)


if __name__ == "__main__":
    unittest.main()
