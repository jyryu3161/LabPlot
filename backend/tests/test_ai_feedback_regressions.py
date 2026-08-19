import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.ai import client as ai_client
from app.common.exceptions import BadRequestError
from app.figures.schemas import ImprovementRequest
from app.figures import service as figure_service
from app.r_engine.templates import build_plot_r
from app.recommend import rules as recommendation_rules


class RecommendationFeedbackRegressionTests(unittest.TestCase):
    """Regression coverage for the recommendation feedback reported in Aug 2026."""

    def test_required_series_is_repaired_from_semantic_required_vars(self):
        suggestions = [{
            "plot_type": "grouped_bar",
            "title": "Expression by Genotype and Time",
            "score": 0.95,
            "required_vars": {
                "x": "Genotype",
                "y": "Expression",
                "series": "Time",
            },
            "suggested_mapping": {
                "x": "Genotype",
                "y": "Expression",
            },
        }]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Genotype", "Time", "Expression"},
            "Genotype별로 0시간과 24시간의 Expression 변화를 표시하고 개별 replicate도 표시",
        )

        self.assertEqual(prepared[0]["suggested_mapping"]["group"], "Time")
        self.assertTrue(prepared[0]["mapping_complete"])
        self.assertEqual(prepared[0]["missing_required_mappings"], [])

    def test_individual_replicate_intent_drives_component_scores_and_overall_rank(self):
        """REQ-REC-1/2: preserve statistics while renderer support drives intent rank."""
        suggestions = [
            {
                "plot_type": "bar",
                "title": "High model-score summary bars",
                "score": 0.98,
                "scores": {
                    "data_structure_fit": 0.98,
                    "user_intent_match": 0.95,
                    "statistical_suitability": 0.8,
                    "overall": 0.95,
                },
                "suggested_mapping": {"x": "Genotype", "y": "Expression"},
            },
            {
                "plot_type": "grouped_bar",
                "title": "Replicates by genotype and time",
                "score": 0.82,
                "scores": {
                    "data_structure_fit": 0.82,
                    "user_intent_match": 0.7,
                    "statistical_suitability": 0.1,
                    "overall": 0.8,
                },
                "suggested_mapping": {
                    "x": "Genotype",
                    "y": "Expression",
                    "group": "Time_h",
                },
            },
        ]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Genotype", "Time_h", "Expression", "Replicate"},
            "Show the individual replicates for each genotype at 0 and 24 hours.",
        )

        self.assertEqual(prepared[0]["plot_type"], "grouped_bar")
        self.assertEqual(prepared[0]["rank"], 1)
        self.assertEqual(
            set(prepared[0]["scores"]),
            {"data_structure_fit", "user_intent_match", "statistical_suitability", "overall"},
        )
        self.assertEqual(prepared[0]["score"], prepared[0]["scores"]["overall"])
        self.assertGreaterEqual(prepared[0]["scores"]["user_intent_match"], 0.9)
        self.assertEqual(prepared[0]["scores"]["statistical_suitability"], 0.1)
        self.assertEqual(
            prepared[0]["intent"]["individual_observation_support"],
            {"status": "satisfied", "mode": "individual_points_with_summary"},
        )
        bar = next(item for item in prepared if item["plot_type"] == "bar")
        self.assertLessEqual(bar["scores"]["user_intent_match"], 0.35)
        self.assertEqual(bar["scores"]["statistical_suitability"], 0.8)
        self.assertGreater(prepared[0]["scores"]["overall"], bar["scores"]["overall"])

    def test_line_recommendation_declares_replicate_and_duplicate_time_connection_policy(self):
        """REQ-REC-3: metadata and R agree raw trajectories are unsupported."""
        prepared = figure_service._prepare_recommendations(
            [{
                "plot_type": "line",
                "title": "Expression trajectories",
                "score": 0.94,
                "required_vars": {
                    "time": "Time_h",
                    "value": "Expression",
                    "group": "Genotype",
                    "subject_id": "Subject_ID",
                },
                "suggested_mapping": {
                    "x": "Time_h",
                    "y": "Expression",
                    "group": "Genotype",
                },
            }],
            {"Time_h", "Expression", "Genotype", "Subject_ID"},
            "Show individual subject trajectories and raw replicate points over time.",
        )

        policy = prepared[0]["intent"]["line_policy"]
        self.assertEqual(policy["replicate_id_column"], "Subject_ID")
        self.assertEqual(policy["raw_trajectory_grouping"], "not_supported_by_renderer")
        self.assertEqual(policy["same_time_replicates"], "do_not_connect_without_aggregation")
        self.assertEqual(policy["summary_mode"], "selection_required")
        self.assertEqual(policy["error_summary"], "none")
        self.assertEqual(policy["support_status"], "selection_required")
        self.assertEqual(policy["blocking_reason"], "renderer_cannot_group_by_replicate")
        self.assertTrue(policy["requires_confirmation"])
        self.assertEqual(
            prepared[0]["intent"]["individual_observation_support"]["status"],
            "selection_required",
        )

        script = build_plot_r(
            "line",
            prepared[0]["suggested_mapping"],
            prepared[0]["suggested_options"],
        )
        self.assertIn('group = factor(.data[["Genotype"]])', script)
        self.assertNotIn("Subject_ID", script)

    def test_line_without_replicate_id_is_below_supported_points_summary(self):
        """REQ-REC-2/3: an ID-less line ranks below fulfilled points+summary."""
        prepared = figure_service._prepare_recommendations(
            [
                {
                    "plot_type": "line",
                    "title": "High provider-score line",
                    "scores": {
                        "data_structure_fit": 0.99,
                        "user_intent_match": 0.99,
                        "statistical_suitability": 0.9,
                        "overall": 0.99,
                    },
                    "suggested_mapping": {
                        "x": "Time_h", "y": "Expression", "group": "Genotype",
                    },
                },
                {
                    "plot_type": "grouped_bar",
                    "title": "Individual points with summary",
                    "scores": {
                        "data_structure_fit": 0.75,
                        "user_intent_match": 0.6,
                        "statistical_suitability": 0.6,
                        "overall": 0.65,
                    },
                    "suggested_mapping": {
                        "x": "Genotype", "y": "Expression", "group": "Time_h",
                    },
                },
            ],
            {"Time_h", "Expression", "Genotype"},
            "Show every individual replicate over time.",
        )

        self.assertEqual(prepared[0]["plot_type"], "grouped_bar")
        line = next(item for item in prepared if item["plot_type"] == "line")
        line_policy = line["intent"]["line_policy"]
        self.assertEqual(line_policy["blocking_reason"], "replicate_id_required")
        self.assertEqual(line_policy["support_status"], "selection_required")
        self.assertLess(
            line["scores"]["user_intent_match"],
            prepared[0]["scores"]["user_intent_match"],
        )

    def test_provider_candidate_pool_survives_until_intent_aware_reranking(self):
        """REQ-REC-4: candidate six can enter the validated final top five."""
        provider_recommendations = []
        for index in range(5):
            score = 0.99 - index * 0.01
            provider_recommendations.append({
                "plot_type": "bar",
                "title": f"Summary bar {index}",
                "score": score,
                "scores": {
                    "data_structure_fit": score,
                    "user_intent_match": score,
                    "statistical_suitability": 0.8,
                    "overall": score,
                },
                "suggested_mapping": {"x": "Genotype", "y": "Expression"},
            })
        provider_recommendations.append({
            "plot_type": "grouped_bar",
            "title": "Sixth provider candidate with raw points",
            "score": 0.7,
            "scores": {
                "data_structure_fit": 0.7,
                "user_intent_match": 0.6,
                "statistical_suitability": 0.1,
                "overall": 0.7,
            },
            "suggested_mapping": {
                "x": "Genotype", "y": "Expression", "group": "Time_h",
            },
        })
        profile = [
            {"name": "Genotype", "dtype": "string", "role": "group", "n_unique": 2},
            {"name": "Time_h", "dtype": "numeric", "role": "time", "n_unique": 2},
            {"name": "Expression", "dtype": "numeric", "role": "numeric", "n_unique": 12},
        ]

        with (
            patch.object(ai_client, "_run_logged", return_value={"recommendations": provider_recommendations}),
            patch.object(ai_client, "active_provider_label", return_value="test-provider"),
        ):
            candidates = ai_client.recommend_charts(object(), profile)

        self.assertEqual(len(candidates), 6)
        prepared = figure_service._prepare_recommendations(
            candidates,
            {"Genotype", "Time_h", "Expression"},
            "Show individual replicates for each genotype and time.",
        )
        self.assertEqual(len(prepared), 5)
        self.assertEqual(prepared[0]["plot_type"], "grouped_bar")
        self.assertEqual(prepared[0]["scores"]["statistical_suitability"], 0.1)
        self.assertEqual(
            prepared[0]["suggested_options"],
            {"stat": "mean", "show_points": True, "error_bars": True, "error_type": "sd"},
        )
        script = build_plot_r(
            prepared[0]["plot_type"],
            prepared[0]["suggested_mapping"],
            prepared[0]["suggested_options"],
        )
        self.assertIn("position_jitterdodge", script)
        self.assertIn("geom_errorbar", script)

    def test_rule_recommendations_expose_the_same_component_score_contract(self):
        suggestions = recommendation_rules.suggest_charts([
            {"name": "Genotype", "role": "group", "dtype": "string", "n_unique": 2},
            {"name": "Expression", "role": "numeric", "dtype": "float", "n_unique": 12},
        ])

        self.assertTrue(suggestions)
        for suggestion in suggestions:
            self.assertEqual(
                set(suggestion["scores"]),
                {"data_structure_fit", "user_intent_match", "statistical_suitability", "overall"},
            )
            self.assertEqual(suggestion["score"], suggestion["scores"]["overall"])

    def test_unrecoverable_required_mapping_is_explicitly_reported(self):
        suggestions = [{
            "plot_type": "grouped_bar",
            "title": "Expression by Genotype and Time",
            "score": 0.95,
            "suggested_mapping": {"x": "Genotype", "y": "Expression"},
        }]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Genotype", "BatchA", "BatchB", "Expression"},
            "Genotype별로 0시간과 24시간의 Expression 변화를 표시",
        )

        self.assertFalse(prepared[0]["mapping_complete"])
        self.assertEqual(
            prepared[0]["missing_required_mappings"],
            [{"key": "group", "label": "Series / method"}],
        )

    def test_required_series_is_repaired_from_an_unambiguous_time_column_name(self):
        suggestions = [{
            "plot_type": "grouped_bar",
            "title": "Expression by Genotype and Time",
            "score": 0.95,
            "suggested_mapping": {"x": "Genotype", "y": "Expression"},
        }]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Genotype", "Time_h", "Expression"},
            "Genotype별로 0시간과 24시간의 Expression 변화를 표시",
        )

        self.assertEqual(prepared[0]["suggested_mapping"]["group"], "Time_h")
        self.assertTrue(prepared[0]["mapping_complete"])

    def test_exact_cached_y2_payload_is_repaired_to_grouped_bar_series(self):
        suggestions = [{
            "plot_type": "grouped_bar",
            "title": "Expression by Genotype and Time",
            "score": 0.95,
            "required_vars": {
                "x": "Genotype",
                "y": "Expression",
                "y2": "Time_h",
            },
            "suggested_mapping": {
                "x": "Genotype",
                "y": "Expression",
                "y2": "Time_h",
            },
        }]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Genotype", "Time_h", "Expression"},
        )

        self.assertEqual(
            prepared[0]["suggested_mapping"],
            {"x": "Genotype", "y": "Expression", "group": "Time_h"},
        )
        self.assertTrue(prepared[0]["mapping_complete"])

    def test_line_y2_categorical_payload_is_repaired_to_optional_group(self):
        suggestions = [{
            "plot_type": "line",
            "title": "Expression over Time by Genotype",
            "score": 0.9,
            "suggested_mapping": {
                "x": "Time_h",
                "y": "Expression",
                "y2": "Genotype",
            },
        }]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Genotype", "Time_h", "Expression"},
        )

        self.assertEqual(
            prepared[0]["suggested_mapping"],
            {"x": "Time_h", "y": "Expression", "group": "Genotype"},
        )
        self.assertTrue(prepared[0]["mapping_complete"])

    def test_line_group_intent_is_repaired_from_one_profile_group_column(self):
        """REQ-REC-GROUP-1: one real group role makes the line render-ready."""
        suggestions = [{
            "plot_type": "line",
            "title": "Response over time by genotype",
            "score": 0.91,
            "suggested_mapping": {"x": "Time_h", "y": "Response"},
        }]
        profile = [
            {"name": "Time_h", "role": "time", "dtype": "numeric"},
            {"name": "Response", "role": "numeric", "dtype": "numeric"},
            {"name": "Genotype", "role": "group", "dtype": "string"},
        ]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Time_h", "Response", "Genotype"},
            "Plot response over time for each genotype.",
            column_profile=profile,
        )

        self.assertEqual(
            prepared[0]["suggested_mapping"],
            {"x": "Time_h", "y": "Response", "group": "Genotype"},
        )
        self.assertTrue(prepared[0]["mapping_complete"])
        self.assertEqual(prepared[0]["missing_required_mappings"], [])

    def test_line_group_intent_with_two_profile_candidates_is_blocked(self):
        """REQ-REC-GROUP-2: ambiguity is visible; no first-column guessing."""
        suggestions = [{
            "plot_type": "line",
            "title": "Response over time by group",
            "score": 0.91,
            "suggested_mapping": {"x": "Time_h", "y": "Response"},
        }]
        profile = [
            {"name": "Time_h", "role": "time", "dtype": "numeric"},
            {"name": "Response", "role": "numeric", "dtype": "numeric"},
            {"name": "Genotype", "role": "group", "dtype": "string"},
            {"name": "Treatment", "role": "group", "dtype": "string"},
        ]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Time_h", "Response", "Genotype", "Treatment"},
            "Show a separate line for each group.",
            column_profile=profile,
        )

        self.assertNotIn("group", prepared[0]["suggested_mapping"])
        self.assertFalse(prepared[0]["mapping_complete"])
        self.assertEqual(
            prepared[0]["missing_required_mappings"],
            [{"key": "group", "label": "Group/Color"}],
        )
        self.assertEqual(
            prepared[0]["intent"]["group_mapping_candidates"],
            ["Genotype", "Treatment"],
        )

        # The saved/cached contract must remain blocked even though the
        # original free-text objective is not available on a later GET.
        cached = figure_service._prepare_recommendations(
            prepared,
            {"Time_h", "Response", "Genotype", "Treatment"},
            column_profile=profile,
        )
        self.assertFalse(cached[0]["mapping_complete"])
        self.assertEqual(cached[0]["missing_required_mappings"][0]["key"], "group")

    def test_line_explicit_group_semantics_win_over_other_profile_candidates(self):
        """REQ-REC-GROUP-3: provider semantics resolve profile ambiguity."""
        suggestions = [{
            "plot_type": "line",
            "title": "Treatment response over time",
            "score": 0.91,
            "required_vars": {"series": "Treatment"},
            "suggested_mapping": {"x": "Time_h", "y": "Response"},
        }]
        profile = [
            {"name": "Time_h", "role": "time", "dtype": "numeric"},
            {"name": "Response", "role": "numeric", "dtype": "numeric"},
            {"name": "Genotype", "role": "group", "dtype": "string"},
            {"name": "Treatment", "role": "group", "dtype": "string"},
        ]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Time_h", "Response", "Genotype", "Treatment"},
            column_profile=profile,
        )

        self.assertEqual(prepared[0]["suggested_mapping"]["group"], "Treatment")
        self.assertTrue(prepared[0]["mapping_complete"])

    def test_line_numeric_y2_payload_becomes_secondary_axis_not_group(self):
        suggestions = [{
            "plot_type": "line",
            "title": "Two responses over time",
            "score": 0.9,
            "suggested_mapping": {
                "x": "Time",
                "y": "Response",
                "y2": "Response2",
            },
        }]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Time", "Response", "Response2"},
        )

        self.assertEqual(
            prepared[0]["suggested_mapping"],
            {"x": "Time", "y": "Response"},
        )
        self.assertEqual(prepared[0]["suggested_options"]["y2_column"], "Response2")

    def test_line_keeps_group_and_numeric_secondary_y_together(self):
        suggestions = [{
            "plot_type": "line",
            "title": "Responses over time by genotype",
            "score": 0.9,
            "suggested_mapping": {
                "x": "Time",
                "y": "Response",
                "group": "Genotype",
                "y2": "Response2",
            },
        }]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Time", "Response", "Response2", "Genotype"},
        )

        self.assertEqual(prepared[0]["suggested_mapping"]["group"], "Genotype")
        self.assertEqual(prepared[0]["suggested_options"]["y2_column"], "Response2")

    def test_explicit_time_semantic_outranks_a_genotype_name_for_line_x(self):
        suggestions = [{
            "plot_type": "line",
            "title": "Expression over Time",
            "score": 0.9,
            "required_vars": {"time": "Time", "y": "Expression"},
            "suggested_mapping": {"y": "Expression"},
        }]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Genotype", "Time", "Expression"},
        )

        self.assertEqual(prepared[0]["suggested_mapping"]["x"], "Time")
        self.assertTrue(prepared[0]["mapping_complete"])

    def test_auto_repair_does_not_reuse_time_for_both_x_and_group(self):
        suggestions = [{
            "plot_type": "grouped_bar",
            "title": "Expression by Genotype and Time",
            "score": 0.95,
            "required_vars": {"time": "Time", "y": "Expression"},
            "suggested_mapping": {"y": "Expression"},
        }]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Genotype", "Time", "Expression"},
        )

        self.assertEqual(
            prepared[0]["suggested_mapping"],
            {"x": "Genotype", "y": "Expression", "group": "Time"},
        )
        self.assertTrue(prepared[0]["mapping_complete"])

    def test_grouped_bar_semantics_keep_genotype_on_x_and_time_as_series(self):
        suggestions = [{
            "plot_type": "grouped_bar",
            "title": "Expression by Genotype and Time",
            "score": 0.95,
            "required_vars": {
                "genotype": "Genotype",
                "time": "Time",
                "y": "Expression",
            },
            "suggested_mapping": {"y": "Expression"},
        }]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Genotype", "Time", "Expression"},
        )

        self.assertEqual(
            prepared[0]["suggested_mapping"],
            {"x": "Genotype", "y": "Expression", "group": "Time"},
        )
        self.assertTrue(prepared[0]["mapping_complete"])

    def test_grouped_bar_auto_repair_never_duplicates_an_explicit_group(self):
        suggestions = [{
            "plot_type": "grouped_bar",
            "title": "Expression by Time and Genotype",
            "score": 0.9,
            "required_vars": {
                "genotype": "Genotype",
                "time": "Time",
                "y": "Expression",
            },
            "suggested_mapping": {"y": "Expression", "group": "Genotype"},
        }]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Genotype", "Time", "Expression"},
        )

        self.assertEqual(
            prepared[0]["suggested_mapping"],
            {"x": "Time", "y": "Expression", "group": "Genotype"},
        )
        self.assertTrue(prepared[0]["mapping_complete"])

    def test_grouped_bar_rejects_an_option_not_offered_by_its_registry(self):
        suggestions = [{
            "plot_type": "grouped_bar",
            "title": "Expression by Genotype and Time",
            "score": 0.95,
            "suggested_mapping": {
                "x": "Genotype",
                "y": "Expression",
                "group": "Time",
            },
            "suggested_options": {"stat": "count"},
        }]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Genotype", "Time", "Expression"},
        )

        self.assertNotIn("stat", prepared[0]["suggested_options"])

    def test_individual_replicate_intent_produces_supported_grouped_bar_options(self):
        suggestions = [{
            "plot_type": "grouped_bar",
            "title": "Expression by Genotype and Time",
            "score": 0.95,
            "suggested_mapping": {
                "x": "Genotype",
                "y": "Expression",
                "group": "Time",
            },
        }]

        prepared = figure_service._prepare_recommendations(
            suggestions,
            {"Genotype", "Time", "Expression"},
            "Show the 0 h and 24 h change by genotype with individual replicates displayed.",
        )

        self.assertEqual(
            prepared[0]["intent"],
            {
                "show_individual_observations": True,
                "individual_observation_support": {
                    "status": "satisfied",
                    "mode": "individual_points_with_summary",
                },
            },
        )
        self.assertEqual(
            prepared[0]["suggested_options"],
            {
                "stat": "mean",
                "show_points": True,
                "error_bars": True,
                "error_type": "sd",
            },
        )

        script = build_plot_r(
            "grouped_bar",
            prepared[0]["suggested_mapping"],
            prepared[0]["suggested_options"],
        )
        self.assertIn("position_jitterdodge", script)
        self.assertIn("seed = 1", script)
        self.assertIn("geom_errorbar", script)


class ReviewFeedbackRegressionTests(unittest.TestCase):
    def _payload(self):
        return {
            "publication_score": 70,
            "summary": "Mostly clear.",
            "visual_quality": {"score": 80, "comments": ["Blue lines have good contrast."]},
            "statistical": {
                "score": 55,
                "comments": [
                    "Add significance markers and p-values between groups.",
                    "The error-bar definition should be stated in the caption.",
                ],
            },
            "suitability": {"score": 75, "comments": []},
            "strengths": ["Readable axes."],
            "issues": [
                "No statistical significance is displayed.",
                "Increase the legend spacing.",
            ],
        }

    def test_review_evidence_exposes_inputs_without_dataset_rows(self):
        version = SimpleNamespace(
            id='11111111-1111-4111-8111-111111111111',
            version_number=6,
            png_path=None,
            mapping={"x": "Genotype", "y": "Expression", "group": "Time_h"},
            options={"title": "Expression", "category_colors": {"KO": "#2563EB"}},
            style_preset="nature",
            edit_context={"original_request": "Knockout을 파란색으로 변경"},
        )
        dataset = SimpleNamespace(
            name="Expression dataset",
            column_profile=[
                {"name": "Genotype", "role": "group", "dtype": "categorical", "sample_values": ["WT", "KO"]},
                {"name": "Expression", "role": "numeric", "dtype": "numeric", "sample_values": [1.2, 3.4]},
            ],
        )
        figure = SimpleNamespace(plot_type="grouped_bar", dataset=dataset)

        evidence = figure_service._review_evidence(figure, version)

        self.assertEqual(evidence["render"]["version_number"], 6)
        self.assertEqual(evidence["last_ai_request"], "Knockout을 파란색으로 변경")
        self.assertEqual(evidence["mapping"]["group"], "Time_h")
        self.assertEqual(evidence["dataset"]["column_count"], 2)
        self.assertNotIn("sample_values", evidence["dataset"]["columns"][0])

    def test_review_removes_unsupported_significance_recommendations(self):
        cleaned = ai_client._ground_review_payload(
            self._payload(),
            statistical_evidence=False,
        )

        joined = " ".join(cleaned["statistical"]["comments"] + cleaned["issues"]).lower()
        self.assertNotIn("significance", joined)
        self.assertNotIn("p-value", joined)
        self.assertIn("error-bar definition", joined)
        self.assertIn("legend spacing", joined)

    def test_review_keeps_significance_comment_when_test_evidence_exists(self):
        cleaned = ai_client._ground_review_payload(
            self._payload(),
            statistical_evidence=True,
        )
        joined = " ".join(cleaned["statistical"]["comments"] + cleaned["issues"]).lower()
        self.assertIn("significance", joined)

    def test_review_merges_missing_error_bar_and_legend_feedback_with_actual_options(self):
        payload = self._payload()
        payload["statistical"]["comments"] = [
            "Error bars are mandatory for grouped mean bars.",
            "The legend does not define whether uncertainty is SD or SE.",
            "Individual observations are absent and should be shown.",
        ]
        payload["issues"] = [
            "Add error bars.",
            "Define the error bars in the legend.",
        ]

        cleaned = ai_client._ground_review_payload(
            payload,
            statistical_evidence=False,
            plot_type="grouped_bar",
            mapping={"x": "Genotype", "y": "Expression", "group": "Time_h"},
            options={
                "stat": "mean",
                "show_points": True,
                "error_bars": False,
                "error_type": "se",
            },
        )

        joined = " ".join(cleaned["statistical"]["comments"] + cleaned["issues"]).lower()
        self.assertNotIn("mandatory", joined)
        self.assertNotIn("individual observations are absent", joined)
        self.assertIn("individual observations are shown", joined)
        self.assertIn("error_type=se", joined)
        self.assertIn("error_bars=false", joined)
        self.assertIn("recommended", joined)
        self.assertEqual(joined.count("error_bars=false"), 1)

    def test_review_matches_omitted_bar_error_option_to_renderer_default(self):
        payload = self._payload()
        payload["statistical"]["comments"] = [
            "Error bars are missing and should be added.",
            "The legend does not define whether the uncertainty is SD or SE.",
        ]
        payload["issues"] = []

        # The ordinary summary-bar renderer treats an omitted error_bars option
        # as True. The deterministic review guard must use that same effective
        # value rather than claiming that no error bars were rendered.
        script = build_plot_r(
            "bar",
            {"x": "Genotype", "y": "Expression"},
            {"stat": "mean"},
        )
        self.assertIn("geom_errorbar", script)

        cleaned = ai_client._ground_review_payload(
            payload,
            statistical_evidence=False,
            plot_type="bar",
            mapping={"x": "Genotype", "y": "Expression"},
            options={"stat": "mean"},
        )

        joined = " ".join(cleaned["statistical"]["comments"] + cleaned["issues"]).lower()
        self.assertIn("error_bars=true", joined)
        self.assertNotIn("error_bars=false", joined)
        self.assertNotIn("missing", joined)
        self.assertNotIn("mandatory", joined)

    def test_review_preserves_positive_error_bar_and_individual_point_observations(self):
        payload = self._payload()
        payload["statistical"]["comments"] = [
            "Error bars show variability clearly.",
            "Individual observations show the distribution clearly.",
        ]
        payload["issues"] = []

        cleaned = ai_client._ground_review_payload(
            payload,
            statistical_evidence=False,
            plot_type="grouped_bar",
            mapping={"x": "Genotype", "y": "Expression", "group": "Time_h"},
            options={"stat": "mean", "show_points": True, "error_bars": True},
        )

        self.assertEqual(
            cleaned["statistical"]["comments"],
            payload["statistical"]["comments"],
        )

    def test_review_drops_legend_definition_requirement_when_no_error_bars_are_rendered(self):
        payload = self._payload()
        payload["statistical"]["comments"] = [
            "The legend should define whether the error bars are SD or SE.",
        ]
        payload["issues"] = []

        cleaned = ai_client._ground_review_payload(
            payload,
            statistical_evidence=False,
            plot_type="grouped_bar",
            mapping={"x": "Genotype", "y": "Expression", "group": "Time_h"},
            options={"stat": "mean", "show_points": False, "error_bars": False},
        )

        joined = " ".join(cleaned["statistical"]["comments"] + cleaned["issues"]).lower()
        self.assertNotIn("legend", joined)
        self.assertNotIn("caption", joined)

    def test_review_keeps_legend_definition_requirement_when_error_bars_are_rendered(self):
        payload = self._payload()
        payload["statistical"]["comments"] = [
            "The legend should define whether the error bars are SD or SE.",
        ]
        payload["issues"] = []

        cleaned = ai_client._ground_review_payload(
            payload,
            statistical_evidence=False,
            plot_type="bar",
            mapping={"x": "Genotype", "y": "Expression"},
            # Omitted error_bars uses the renderer's True default for bar.
            options={"stat": "mean"},
        )

        self.assertEqual(
            cleaned["statistical"]["comments"],
            payload["statistical"]["comments"],
        )

    def test_review_missing_uncertainty_feedback_considers_individual_points_without_mandating_bars(self):
        payload = self._payload()
        payload["statistical"]["comments"] = [
            "Error bars are mandatory for every grouped mean bar.",
            "The caption does not state whether uncertainty is SD or SE.",
        ]
        payload["issues"] = []

        cleaned = ai_client._ground_review_payload(
            payload,
            statistical_evidence=False,
            plot_type="grouped_bar",
            mapping={"x": "Genotype", "y": "Expression", "group": "Time_h"},
            options={"stat": "mean", "show_points": False, "error_bars": False, "error_type": "se"},
        )

        joined = " ".join(cleaned["statistical"]["comments"] + cleaned["issues"]).lower()
        self.assertNotIn("mandatory", joined)
        self.assertIn("consider showing individual observations", joined)
        self.assertIn("if error bars are enabled", joined)
        self.assertEqual(joined.count("error_bars=false"), 1)

    def test_review_drops_mandatory_error_bar_claim_for_non_mean_bars(self):
        payload = self._payload()
        payload["statistical"]["comments"] = ["Every bar chart must include error bars."]
        payload["issues"] = ["Error bars are missing."]

        cleaned = ai_client._ground_review_payload(
            payload,
            statistical_evidence=False,
            plot_type="bar",
            mapping={"x": "Category"},
            options={"stat": "count", "error_bars": False},
        )

        joined = " ".join(cleaned["statistical"]["comments"] + cleaned["issues"]).lower()
        self.assertNotIn("error bar", joined)

    def test_review_neutralizes_a_score_based_only_on_missing_significance(self):
        payload = self._payload()
        payload["publication_score"] = 60
        payload["visual_quality"]["score"] = 80
        payload["statistical"] = {
            "score": 40,
            "comments": ["Add significance markers and p-values between groups."],
        }
        payload["suitability"]["score"] = 80
        payload["issues"] = []

        cleaned = ai_client._ground_review_payload(
            payload,
            statistical_evidence=False,
        )

        self.assertEqual(cleaned["statistical"]["score"], 80)
        self.assertEqual(cleaned["publication_score"], 80)
        self.assertIn("not scored", cleaned["statistical"]["comments"][0].lower())

    def test_review_keeps_grounded_no_test_caveats_and_positive_pvalue_feedback(self):
        payload = self._payload()
        payload["statistical"]["comments"] = [
            "Significance cannot be evaluated because no statistical test is available.",
            "No issue: p-values are clearly legible.",
        ]
        payload["issues"] = []

        cleaned = ai_client._ground_review_payload(
            payload,
            statistical_evidence=False,
        )

        self.assertEqual(cleaned["statistical"]["comments"], payload["statistical"]["comments"])

    def test_safe_prefix_does_not_hide_a_later_unsupported_significance_request(self):
        payload = self._payload()
        payload["statistical"]["comments"] = [
            "No issue with the axes, but p-values are missing and should be added.",
            "Significance cannot be evaluated because no statistical test is available; add significance markers anyway.",
        ]
        payload["issues"] = []

        cleaned = ai_client._ground_review_payload(
            payload,
            statistical_evidence=False,
        )

        self.assertNotIn("p-values are missing", " ".join(cleaned["statistical"]["comments"]))
        self.assertNotIn("add significance", " ".join(cleaned["statistical"]["comments"]).lower())

    def test_review_drops_a_color_request_claim_that_contradicts_edit_history(self):
        payload = self._payload()
        payload["visual_quality"]["comments"].append(
            "The user requested a red line, but the current line is blue."
        )

        cleaned = ai_client._ground_review_payload(
            payload,
            statistical_evidence=False,
            edit_context={
                "original_request": "빨간 선을 파란색으로 바꿔줘",
                "applied_changes": [
                    {"key": "options.line_color", "from": "#DC2626", "to": "#2563EB"},
                ],
            },
        )

        joined = " ".join(cleaned["visual_quality"]["comments"]).lower()
        self.assertNotIn("requested a red line", joined)
        self.assertIn("blue lines have good contrast", joined)

    def test_review_uses_only_changed_series_color_as_edit_history_evidence(self):
        payload = self._payload()
        payload["visual_quality"]["comments"].append(
            "The user requested the Knockout series to be red, but it is blue."
        )
        edit_context = {
            "original_request": "Change the Knockout series from red to blue.",
            "applied_changes": [{
                "key": "options.series_styles",
                "from": {
                    "Wildtype": {"color": "#DC2626"},
                    "Knockout": {"color": "#DC2626"},
                },
                "to": {
                    # This unchanged sibling color must not become evidence
                    # that the user requested red for Knockout.
                    "Wildtype": {"color": "#DC2626"},
                    "Knockout": {"color": "#2563EB"},
                },
            }],
        }

        self.assertEqual(ai_client._edit_context_colors(edit_context), {"#2563EB"})
        cleaned = ai_client._ground_review_payload(
            payload,
            statistical_evidence=False,
            edit_context=edit_context,
        )

        joined = " ".join(cleaned["visual_quality"]["comments"]).lower()
        self.assertNotIn("requested the knockout series to be red", joined)
        self.assertIn("blue lines have good contrast", joined)

    def test_review_drops_an_unverifiable_user_request_claim_without_edit_history(self):
        payload = self._payload()
        payload["visual_quality"]["comments"].append(
            "The user requested a red line, but the current line is blue."
        )

        cleaned = ai_client._ground_review_payload(
            payload,
            statistical_evidence=False,
            edit_context=None,
        )

        joined = " ".join(cleaned["visual_quality"]["comments"]).lower()
        self.assertNotIn("requested a red line", joined)
        self.assertIn("blue lines have good contrast", joined)

    def test_review_keeps_supported_non_color_edit_history(self):
        payload = self._payload()
        payload["visual_quality"]["comments"].append(
            "The user requested larger text, and the labels are now readable."
        )

        cleaned = ai_client._ground_review_payload(
            payload,
            statistical_evidence=False,
            edit_context={
                "original_request": "Increase the font size.",
                "applied_changes": [
                    {"key": "options.font_scale", "from": 1.0, "to": 1.2},
                ],
            },
        )

        joined = " ".join(cleaned["visual_quality"]["comments"]).lower()
        self.assertIn("requested larger text", joined)

    def test_review_receives_exact_last_edit_request_and_applied_changes(self):
        captured = {}

        def fake_run_logged(db, user_id, feature, system, content, schema, usage_feature, max_tokens, **kwargs):
            captured["content"] = content
            return self._payload()

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as png:
            png.write(b"not-a-real-png-but-review-only-base64-encodes-it")
            png_path = png.name
        try:
            with patch.object(ai_client, "_run_logged", side_effect=fake_run_logged):
                ai_client.review_figure(
                    object(),
                    png_path,
                    "line",
                    {"x": "Time", "y": "Expression"},
                    {"line_color": "#2563EB"},
                    edit_context={
                        "source": "ai_edit",
                        "original_request": "선을 파란색으로 바꿔줘",
                        "applied_changes": [
                            {"key": "options.line_color", "from": "#DC2626", "to": "#2563EB"},
                        ],
                    },
                )
        finally:
            os.unlink(png_path)

        text = "\n".join(part.get("text", "") for part in captured["content"] if part.get("kind") == "text")
        self.assertIn("선을 파란색으로 바꿔줘", text)
        self.assertIn("#2563EB", text)
        self.assertNotIn("requested red", text.lower())

    def test_applied_edit_persists_exact_request_and_actual_changes_for_review(self):
        db = Mock()
        base = SimpleNamespace(
            mapping={"x": "Time", "y": "Expression"},
            options={"line_color": "#DC2626"},
            style_preset="nature",
        )
        new_version = SimpleNamespace(
            mapping={"x": "Time", "y": "Expression"},
            options={"line_color": "#2563EB"},
            style_preset="nature",
            edit_context=None,
        )

        result = figure_service._finalize_apply_response(
            db,
            SimpleNamespace(),
            SimpleNamespace(),
            base,
            new_version,
            {"options": {"line_color": "#2563EB"}},
            {"id": "new-version"},
            verify=False,
            original_request="선을 파란색으로 바꿔줘",
        )

        expected_change = {
            "key": "options.line_color",
            "from": "#DC2626",
            "to": "#2563EB",
        }
        self.assertEqual(result["applied_changes"], [expected_change])
        self.assertEqual(
            new_version.edit_context,
            {
                "source": "ai_edit",
                "original_request": "선을 파란색으로 바꿔줘",
                "applied_changes": [expected_change],
            },
        )
        db.commit.assert_called_once_with()

    def test_applied_edit_durable_context_keeps_more_than_provider_prompt_limit(self):
        db = Mock()
        long_request = "x" * 5000
        base = SimpleNamespace(mapping={}, options={"title": "Old"}, style_preset="nature")
        new_version = SimpleNamespace(
            mapping={}, options={"title": "New"}, style_preset="nature", edit_context=None,
        )

        figure_service._finalize_apply_response(
            db, SimpleNamespace(), SimpleNamespace(), base, new_version,
            {"options": {"title": "New"}}, {"id": "new-version"},
            verify=False, original_request=long_request,
        )

        self.assertEqual(new_version.edit_context["original_request"], long_request)

    def test_reviewed_plan_rejects_a_stale_figure_or_mismatched_plan_base(self):
        current_id = '11111111-1111-4111-8111-111111111111'
        stale_id = '22222222-2222-4222-8222-222222222222'
        figure = SimpleNamespace(current_version_id=current_id)

        with self.assertRaises(figure_service.AppError) as stale_figure:
            figure_service._guard_reviewed_improvement_base(figure, stale_id, stale_id)
        self.assertEqual(stale_figure.exception.status_code, 409)
        self.assertEqual(stale_figure.exception.error_code, 'VERSION_CONFLICT')

        with self.assertRaises(figure_service.AppError) as mismatched_plan:
            figure_service._guard_reviewed_improvement_base(figure, stale_id, current_id)
        self.assertEqual(mismatched_plan.exception.status_code, 409)

        # Backward-compatible callers that omit the guard retain the existing
        # explicit historical-version behavior.
        figure_service._guard_reviewed_improvement_base(figure, stale_id, None)

    def test_verification_uses_original_request_not_ai_generated_subset(self):
        db = Mock()
        base = SimpleNamespace(
            mapping={"x": "Time", "y": "Expression"},
            options={"title": "Old"},
            style_preset="nature",
        )
        new_version = SimpleNamespace(
            id='33333333-3333-4333-8333-333333333333',
            mapping={"x": "Time", "y": "Expression"},
            options={"title": "New"},
            style_preset="nature",
            edit_context=None,
        )
        verification = {
            "version": new_version,
            "applied_changes": [{"key": "options.title", "from": "Old", "to": "New"}],
            "dropped_keys": [],
            "verification": {"attempts": 1, "satisfied": True, "feedback": "ok"},
        }

        with patch.object(figure_service, '_run_verification', return_value=verification) as run:
            result = figure_service._finalize_apply_response(
                db,
                SimpleNamespace(),
                SimpleNamespace(),
                base,
                new_version,
                {"options": {"title": "New"}},
                {"id": new_version.id},
                verify=True,
                original_request="Change title and color to blue",
                verification_request="Change title to New",
                allow_retry=False,
            )

        self.assertEqual(new_version.edit_context["original_request"], "Change title and color to blue")
        self.assertEqual(new_version.edit_context["verification_request"], "Change title to New")
        self.assertEqual(run.call_args.args[6], "Change title and color to blue")
        self.assertTrue(result["verification"]["satisfied"])

    def test_ai_generated_verification_text_is_not_labeled_as_a_user_request(self):
        db = Mock()
        base = SimpleNamespace(mapping={}, options={"title": "Old"}, style_preset="nature")
        new_version = SimpleNamespace(
            id='44444444-4444-4444-8444-444444444444',
            version_number=2,
            png_path=None,
            mapping={},
            options={"title": "New"},
            style_preset="nature",
            edit_context=None,
        )
        verification = {
            "version": new_version,
            "applied_changes": [{"key": "options.title", "from": "Old", "to": "New"}],
            "dropped_keys": [],
            "verification": {"attempts": 1, "satisfied": True, "feedback": "ok"},
        }

        with patch.object(figure_service, '_run_verification', return_value=verification):
            figure_service._finalize_apply_response(
                db,
                SimpleNamespace(),
                SimpleNamespace(),
                base,
                new_version,
                {"options": {"title": "New"}},
                {"id": new_version.id},
                verify=True,
                original_request=None,
                verification_request="AI suggestion: change title",
                allow_retry=False,
            )

        self.assertNotIn("original_request", new_version.edit_context)
        self.assertEqual(
            new_version.edit_context["verification_request"],
            "AI suggestion: change title",
        )
        evidence = figure_service._review_evidence(
            SimpleNamespace(plot_type="line", dataset=SimpleNamespace(name="D", column_profile=[])),
            new_version,
        )
        self.assertIsNone(evidence["last_ai_request"])


class MarkedEditSafetyRegressionTests(unittest.TestCase):
    """Deterministic contracts for localized AI edits and their verifier."""

    @staticmethod
    def _improve_fixture(plot_type: str):
        figure = SimpleNamespace(
            id="11111111-1111-4111-8111-111111111111",
            plot_type=plot_type,
            style_preset="nature",
            dataset_id="22222222-2222-4222-8222-222222222222",
            project_id=None,
        )
        mapping = (
            {"x": "Time", "y": "Expression"}
            if plot_type == "line"
            else {"x": "Genotype", "y": "Expression", "group": "Time"}
        )
        version = SimpleNamespace(
            id="33333333-3333-4333-8333-333333333333",
            mapping=mapping,
            options={},
            style_preset="nature",
            png_path=None,
            r_code="",
            layout=None,
        )
        dataset = SimpleNamespace(column_profile=[
            {"name": "Time", "role": "time", "dtype": "numeric"},
            {"name": "Expression", "role": "numeric", "dtype": "numeric"},
            {"name": "Genotype", "role": "group", "dtype": "string"},
        ])
        db = Mock()
        db.query.return_value.filter.return_value.order_by.return_value.first.return_value = None
        return db, figure, version, dataset

    @staticmethod
    def _scene_layout():
        return {
            "img_px": {"w": 1000, "h": 800},
            "scene_elements": [
                {
                    "id": "element:title", "kind": "text", "role": "title",
                    "bbox_px": {"x0": 100, "x1": 900, "y0": 20, "y1": 80},
                    "editable": True, "setting_path": "options.title",
                },
                {
                    "id": "element:axis:x:label", "kind": "text", "role": "x_label",
                    "bbox_px": {"x0": 350, "x1": 650, "y0": 730, "y1": 780},
                    "editable": True, "setting_path": "options.x_label",
                },
                {
                    "id": "element:axis:y:label", "kind": "text", "role": "y_label",
                    "bbox_px": {"x0": 20, "x1": 80, "y0": 250, "y1": 600},
                    "editable": True, "setting_path": "options.y_label",
                },
                {
                    "id": "mark:grouped_bar:Control:24h", "kind": "mark", "role": "bar",
                    "category": "Control", "series": "24h",
                    "bbox_px": {"x0": 300, "x1": 380, "y0": 300, "y1": 650},
                    "editable": False, "setting_path": None,
                    "unsupported_reason": "Per-bar styling is not supported yet.",
                },
            ],
        }

    def test_mark_patch_keeps_stable_mark_id_and_drops_unrequested_defaults(self):
        db, figure, version, dataset = self._improve_fixture("line")
        prompt = "\n".join([
            "Apply the localized edits marked on the figure preview.",
            "",
            "Localized image editing annotations for R-code regeneration:",
            "Mark #3 [region]. Bounds: left 10%, top 10%, width 20%, height 20%. User memo: 선을 점선으로 바꿔줘",
        ])
        suggestions = [{
            "mark_id": "3",
            "resolved_target": "line stroke",
            "confidence": 0.82,
            "suggestion_type": "Line style",
            "recommended": "Use a dashed line.",
            "priority": "high",
            "param_patch": {"options": {
                "line_type": "dashed",
                "palette_name": "journal_muted",
                "size": "wide",
                "dpi": 300,
            }},
        }]

        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=version),
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ai_client, "improve_figure", return_value=(suggestions, [])),
        ):
            rows = figure_service.improve_version(
                db, figure.id, version.id, "44444444-4444-4444-8444-444444444444", prompt=prompt
            )

        applicable = [row for row in rows if row.param_patch]
        self.assertEqual(len(applicable), 1)
        self.assertEqual(applicable[0].param_patch, {"options": {"line_type": "dashed"}})
        self.assertEqual(applicable[0].edit_scope["scope_id"], "mark:3")
        self.assertEqual(applicable[0].edit_scope["mark_id"], "3")
        self.assertEqual(applicable[0].edit_scope["status"], "supported")
        self.assertEqual(applicable[0].edit_scope["allowed_patch_keys"], ["options.line_type"])
        self.assertEqual(applicable[0].edit_scope["confidence"], 0.82)

    def test_provider_normalization_preserves_structured_mark_id_and_confidence(self):
        normalized = ai_client._normalize_improvement_suggestions([{
            "mark_id": "title-region-a",
            "confidence": 0.73,
            "suggestion_type": "Title",
            "recommended": "Remove it.",
            "param_patch": {"options": {"title": ""}},
        }])

        self.assertEqual(normalized[0]["mark_id"], "title-region-a")
        self.assertEqual(normalized[0]["confidence"], 0.73)

    def test_client_declared_target_cannot_expand_the_request_allowlist(self):
        db, figure, version, dataset = self._improve_fixture("line")
        version.layout = self._scene_layout()
        marks = [{
            "id": "forged-title-target",
            "label": "Mark A",
            "display_number": 1,
            "type": "region",
            "memo": "remove this",
            "bbox_normalized": {"x": 0.3, "y": 0.375, "width": 0.08, "height": 0.4375},
            "resolved_target": {
                "type": "title",
                "label": "Title",
                "setting_path": "options.title",
                "editable": True,
            },
        }]
        suggestions = [{
            "mark_id": "forged-title-target",
            "suggestion_type": "Title",
            "recommended": "Remove the title.",
            "priority": "high",
            "param_patch": {"options": {"title": ""}},
        }]

        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=version),
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ai_client, "improve_figure", return_value=(suggestions, [])),
        ):
            rows = figure_service.improve_version(
                db, figure.id, version.id, "44444444-4444-4444-8444-444444444444",
                prompt="Apply the localized edits marked on the figure preview.",
                marks=marks,
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].param_patch, {})
        self.assertEqual(rows[0].edit_scope["status"], "unsupported")
        self.assertEqual(rows[0].edit_scope["resolved_target"]["role"], "bar")

    def test_server_hit_test_authorizes_title_and_axis_label_text_edits(self):
        cases = [
            (
                "title-a", {"x": 0.1, "y": 0.025, "width": 0.8, "height": 0.075},
                "이 텍스트만 ZXQ-17로", "title", "ZXQ-17",
            ),
            (
                "x-label-a", {"x": 0.35, "y": 0.9125, "width": 0.3, "height": 0.0625},
                "이 텍스트만 Timepoint로", "x_label", "Timepoint",
            ),
            (
                "y-label-a", {"x": 0.02, "y": 0.3125, "width": 0.06, "height": 0.4375},
                "이 텍스트만 Response로", "y_label", "Response",
            ),
            (
                "title-remove-a", {"x": 0.1, "y": 0.025, "width": 0.8, "height": 0.075},
                "remove this", "title", "",
            ),
        ]
        for mark_id, bbox, memo, option_key, value in cases:
            with self.subTest(option_key=option_key):
                db, figure, version, dataset = self._improve_fixture("line")
                version.layout = self._scene_layout()
                suggestions = [{
                    "mark_id": mark_id,
                    "suggestion_type": "Localized text",
                    "recommended": "Replace the selected text.",
                    "priority": "high",
                    "param_patch": {"options": {option_key: value}},
                }]
                marks = [{
                    "id": mark_id, "label": "Mark A", "display_number": 1,
                    "type": "region", "memo": memo, "bbox_normalized": bbox,
                }]
                with (
                    patch.object(figure_service, "get_figure", return_value=figure),
                    patch.object(figure_service, "get_version", return_value=version),
                    patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
                    patch.object(figure_service.ai_client, "improve_figure", return_value=(suggestions, [])),
                ):
                    rows = figure_service.improve_version(
                        db, figure.id, version.id, "44444444-4444-4444-8444-444444444444",
                        prompt="Apply the localized edits marked on the figure preview.",
                        marks=marks,
                    )

                applicable = [row for row in rows if row.param_patch]
                self.assertEqual(len(applicable), 1)
                self.assertEqual(applicable[0].param_patch, {"options": {option_key: value}})
                self.assertEqual(
                    applicable[0].edit_scope["resolved_target"]["setting_path"],
                    f"options.{option_key}",
                )

    def test_wide_axis_regions_prefer_the_single_semantic_label_over_the_axis_band(self):
        layout = self._scene_layout()
        layout["scene_elements"].extend([
            {
                "id": "element:axis:x", "kind": "axis", "role": "x_axis",
                "bbox_px": {"x0": 100, "x1": 900, "y0": 640, "y1": 795},
                "editable": True, "setting_path": "options",
            },
            {
                "id": "element:axis:y", "kind": "axis", "role": "y_axis",
                "bbox_px": {"x0": 0, "x1": 180, "y0": 120, "y1": 700},
                "editable": True, "setting_path": "options",
            },
        ])

        cases = [
            (
                {"x": 0.20, "y": 0.84, "width": 0.60, "height": 0.15},
                "x_label", "options.x_label",
            ),
            (
                {"x": 0.005, "y": 0.20, "width": 0.16, "height": 0.65},
                "y_label", "options.y_label",
            ),
        ]
        for bbox, role, setting_path in cases:
            with self.subTest(role=role):
                target = figure_service._server_resolve_mark_target(
                    {"type": "region", "bbox_normalized": bbox}, layout,
                )
                self.assertIsNotNone(target)
                self.assertEqual(target["role"], role)
                self.assertEqual(target["setting_path"], setting_path)

    def test_axis_label_hit_tolerance_beats_an_intersecting_axis_band(self):
        layout = self._scene_layout()
        layout["scene_elements"].append({
            "id": "element:axis:x", "kind": "axis", "role": "x_axis",
            "bbox_px": {"x0": 100, "x1": 900, "y0": 640, "y1": 795},
            "editable": True, "setting_path": "options",
        })

        target = figure_service._server_resolve_mark_target({
            "type": "region",
            # Stops one pixel above the x-label box (y=730) but is inside the
            # label tolerance and already intersects the much larger axis band.
            "bbox_normalized": {"x": 0.34, "y": 0.89, "width": 0.32, "height": 0.02125},
        }, layout)

        self.assertIsNotNone(target)
        self.assertEqual(target["role"], "x_label")

    def test_target_override_accepts_only_nearby_server_known_editable_text(self):
        layout = self._scene_layout()
        base_mark = {
            "id": "axis-label-correction", "label": "Mark B", "display_number": 2,
            "type": "region", "memo": "이 텍스트만 Genotype region으로 변경",
            # This deliberately spans title + both labels. Automatic scoring
            # chooses the title, while the explicit correction chooses x_label.
            "bbox_normalized": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
        }
        parsed = ImprovementRequest.model_validate({
            "marks": [{
                **base_mark,
                "target_override": {
                    "type": "x_label", "role": "x_label", "label": "X-axis label",
                    "setting_path": "options.x_label", "element_id": "element:axis:x:label",
                },
            }],
        })
        self.assertEqual(parsed.marks[0].target_override.element_id, "element:axis:x:label")
        valid = figure_service._structured_edit_request_scopes([{
            **base_mark,
            "target_override": {
                "type": "x_label", "role": "x_label", "label": "X-axis label",
                "setting_path": "options.x_label", "element_id": "element:axis:x:label",
            },
        }], layout=layout)[0]
        self.assertEqual(valid["server_resolved_target"]["role"], "x_label")
        self.assertEqual(valid["accepted_target_override"]["setting_path"], "options.x_label")
        self.assertEqual(valid["requested_target_override"]["setting_path"], "options.x_label")
        self.assertEqual(valid["inferred_server_target"]["role"], "title")

        forged = figure_service._structured_edit_request_scopes([{
            **base_mark,
            "target_override": {
                # Known element id with forged authority-bearing metadata.
                "type": "x_label", "role": "x_label", "label": "X-axis label",
                "setting_path": "options.error_bars", "element_id": "element:axis:x:label",
                "editable": True,
            },
        }], layout=layout)[0]
        self.assertIsNone(forged["accepted_target_override"])
        self.assertEqual(forged["requested_target_override"]["setting_path"], "options.error_bars")
        self.assertIsNone(forged["server_resolved_target"])
        self.assertIn("could not be matched", forged["target_override_rejection_reason"])

        far = figure_service._structured_edit_request_scopes([{
            **base_mark,
            "bbox_normalized": {"x": 0.80, "y": 0.30, "width": 0.10, "height": 0.10},
            "target_override": {
                "type": "x_label", "role": "x_label", "label": "X-axis label",
                "setting_path": "options.x_label", "element_id": "element:axis:x:label",
            },
        }], layout=layout)[0]
        self.assertIsNone(far["server_resolved_target"])
        self.assertIsNone(far["accepted_target_override"])

        styling = figure_service._structured_edit_request_scopes([{
            **base_mark,
            "memo": "이 라벨을 파란색으로 변경",
            "target_override": {
                "type": "x_label", "role": "x_label", "label": "X-axis label",
                "setting_path": "options.x_label", "element_id": "element:axis:x:label",
            },
        }], layout=layout)[0]
        self.assertIsNone(styling["accepted_target_override"])

        conflicting_subject = figure_service._structured_edit_request_scopes([{
            **base_mark,
            "memo": "제목을 ABC로 변경",
            "target_override": {
                "type": "x_label", "role": "x_label", "label": "X-axis label",
                "setting_path": "options.x_label", "element_id": "element:axis:x:label",
            },
        }], layout=layout)[0]
        self.assertIsNone(conflicting_subject["accepted_target_override"])

    def test_explicit_axis_label_subject_does_not_authorize_a_conflicting_title_hit(self):
        db, figure, version, dataset = self._improve_fixture("line")
        version.layout = self._scene_layout()
        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=version),
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ai_client, "improve_figure", return_value=([{
                "mark_id": "conflicting-title-hit", "suggestion_type": "Localized text",
                "recommended": "Rename text", "priority": "high",
                "param_patch": {"options": {
                    "title": "UNREQUESTED TITLE", "x_label": "Time",
                }},
            }], [])),
        ):
            rows = figure_service.improve_version(
                db, figure.id, version.id, "44444444-4444-4444-8444-444444444444",
                prompt="Apply the localized edits marked on the figure preview.",
                marks=[{
                    "id": "conflicting-title-hit", "label": "Mark A", "display_number": 1,
                    "type": "region", "memo": "Rename the x-axis label to Time",
                    "bbox_normalized": {"x": 0.1, "y": 0.025, "width": 0.8, "height": 0.075},
                }],
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].param_patch, {"options": {"x_label": "Time"}})
        self.assertEqual(rows[0].edit_scope["allowed_patch_keys"], ["options.x_label"])
        self.assertEqual(rows[0].edit_scope["resolved_target"]["role"], "title")

    def test_rejected_target_override_cannot_authorize_a_provider_patch(self):
        db, figure, version, dataset = self._improve_fixture("line")
        version.layout = self._scene_layout()
        marks = [{
            "id": "forged-override", "label": "Mark A", "display_number": 1,
            "type": "region", "memo": "이 텍스트만 Genotype region으로 변경",
            "bbox_normalized": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
            "target_override": {
                "type": "x_label", "role": "x_label", "setting_path": "options.error_bars",
                "element_id": "element:axis:x:label", "editable": True,
            },
        }]
        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=version),
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ai_client, "improve_figure", return_value=([{
                "mark_id": "forged-override", "suggestion_type": "Localized text",
                "recommended": "Change the x label", "priority": "high",
                "param_patch": {"options": {"x_label": "Genotype region"}},
            }], [])),
        ):
            rows = figure_service.improve_version(
                db, figure.id, version.id, "44444444-4444-4444-8444-444444444444",
                prompt="Apply the localized edits marked on the figure preview.", marks=marks,
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].param_patch, {})
        self.assertEqual(rows[0].edit_scope["target_override_status"], "rejected")
        self.assertIn("could not be matched", rows[0].edit_scope["reason"])

    def test_server_text_target_does_not_authorize_a_color_styling_request(self):
        db, figure, version, dataset = self._improve_fixture("line")
        version.layout = self._scene_layout()
        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=version),
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ai_client, "improve_figure", return_value=([{
                "mark_id": "title-color", "suggestion_type": "Title", "recommended": "Blue",
                "priority": "high", "param_patch": {"options": {"title": "blue"}},
            }], [])),
        ):
            rows = figure_service.improve_version(
                db, figure.id, version.id, "44444444-4444-4444-8444-444444444444",
                prompt="Apply the localized edits marked on the figure preview.",
                marks=[{
                    "id": "title-color", "label": "A", "display_number": 1, "type": "region",
                    "memo": "이것을 파랗게", "bbox_normalized": {
                        "x": 0.1, "y": 0.025, "width": 0.8, "height": 0.075,
                    },
                }],
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].param_patch, {})

    def test_grouped_bar_only_allows_named_series_wide_recolor_and_preserves_siblings(self):
        db, figure, version, dataset = self._improve_fixture("grouped_bar")
        version.layout = self._scene_layout()
        version.options = {"category_colors": {"0h": "#DC2626"}}
        suggestions = [{
            "mark_id": "series-24h", "suggestion_type": "Series color", "recommended": "Blue",
            "priority": "high", "param_patch": {"options": {"category_colors": {
                "24h": "#2563EB", "Control": "#16A34A",
            }}},
        }]
        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=version),
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ai_client, "improve_figure", return_value=(suggestions, [])),
        ):
            rows = figure_service.improve_version(
                db, figure.id, version.id, "44444444-4444-4444-8444-444444444444",
                prompt="Apply the localized edits marked on the figure preview.",
                marks=[{
                    "id": "series-24h", "label": "A", "display_number": 1, "type": "region",
                    "memo": "24 h 계열 전체를 파란색으로 바꿔줘",
                    "bbox_normalized": {"x": 0.3, "y": 0.375, "width": 0.08, "height": 0.4375},
                }],
            )

        applicable = [row for row in rows if row.param_patch]
        self.assertEqual(len(applicable), 1)
        improvement = applicable[0]
        self.assertEqual(improvement.param_patch, {
            "options": {"category_colors": {"24h": "#2563EB"}},
        })
        self.assertEqual(
            improvement.edit_scope["allowed_patch_keys"],
            ["options.category_colors.24h"],
        )
        merged = figure_service._merge_apply_options(version.options, improvement.param_patch["options"])
        self.assertEqual(merged["category_colors"], {"0h": "#DC2626", "24h": "#2563EB"})
        r_override = figure_service.renderer._category_color_override_r(merged)
        self.assertIn('"0h" = "#DC2626"', r_override)
        self.assertIn('"24h" = "#2563EB"', r_override)

        safe, rejected = figure_service._enforce_edit_scope_patch({"options": {"category_colors": {
            "24h": "#2563EB", "Control": "#16A34A",
        }}}, improvement.edit_scope)
        self.assertEqual(safe, improvement.param_patch)
        self.assertEqual(rejected, ["options.category_colors.Control"])
        changed_value, rejected_value = figure_service._enforce_edit_scope_patch({
            "options": {"category_colors": {"24h": "#16A34A"}},
        }, improvement.edit_scope)
        self.assertEqual(changed_value, {})
        self.assertEqual(rejected_value, ["options.category_colors.24h"])

        base = SimpleNamespace(options=version.options, mapping=version.mapping, style_preset="nature")
        after = SimpleNamespace(options=merged, mapping=version.mapping, style_preset="nature")
        self.assertEqual(
            [item["key"] for item in figure_service._full_version_diff(base, after)],
            ["options.category_colors.24h"],
        )

    def test_element_overrides_are_bounded_and_accept_only_safe_stable_ids_and_hex(self):
        valid_prefix = "mark:grouped_bar:category=Control&series="
        raw = {
            f"{valid_prefix}{index}": {
                "fill": "#7e22ce",
                "stroke": "#3b0764",
                "width": 999,
            }
            for index in range(100)
        }
        raw.update({
            "mark:grouped_bar:category=A.B&series=24%20h": {"fill": "#62b9c5"},
            "mark:grouped_bar:category=X[options.palette_name]&series=24h": {"fill": "#FFFFFF"},
            "mark:grouped_bar:category=Control&series=bad%ZZ": {"fill": "#FFFFFF"},
            "mark:grouped_bar:category=Control&series=evil": {
                "fill": "red",
                "stroke": "#12345G",
            },
        })

        clean = figure_service.sanitize_options(
            "grouped_bar", {"element_overrides": raw},
        )["element_overrides"]

        self.assertEqual(len(clean), 80)
        self.assertEqual(clean[f"{valid_prefix}0"], {
            "fill": "#7E22CE", "stroke": "#3B0764",
        })
        self.assertTrue(all(set(style) <= {"fill", "stroke"} for style in clean.values()))
        self.assertNotIn("mark:grouped_bar:category=X[options.palette_name]&series=24h", clean)
        self.assertNotIn("mark:grouped_bar:category=Control&series=bad%ZZ", clean)
        self.assertNotIn("mark:grouped_bar:category=Control&series=evil", clean)

        rejected_only = figure_service.sanitize_options("grouped_bar", {
            "element_overrides": {
                "mark:grouped_bar:category=X[options.palette_name]&series=24h": {"fill": "#FFFFFF"},
                "mark:grouped_bar:category=Control&series=bad%ZZ": {"fill": "#FFFFFF"},
                "mark:grouped_bar:category=Control&series=evil": {"fill": "red"},
                "mark:grouped_bar:category=" + ("X" * 600) + "&series=24h": {"fill": "#FFFFFF"},
            },
        })
        self.assertNotIn("element_overrides", rejected_only)
        element_schema = ai_client._OPTIONS_PATCH_SCHEMA["properties"]["element_overrides"]
        self.assertEqual(
            set(element_schema["additionalProperties"]["properties"]),
            {"fill", "stroke"},
        )
        self.assertEqual(
            figure_service._element_override_fields_from_request(
                "Set only this bar border blue",
            ),
            {"stroke": "#2563EB"},
        )

        dotted = figure_service.sanitize_options("grouped_bar", {
            "element_overrides": {
                "mark:grouped_bar:category=A.B&series=24%20h": {"fill": "#62b9c5"},
            },
        })
        self.assertEqual(dotted["element_overrides"], {
            "mark:grouped_bar:category=A.B&series=24%20h": {"fill": "#62B9C5"},
        })

        dotted_id = "mark:grouped_bar:category=A.B&series=24%20h"
        sibling_id = "mark:grouped_bar:category=A&series=B.24%20h"
        approved_patch = {
            "options": {"element_overrides": {dotted_id: {"fill": "#62B9C5"}}},
        }
        scoped, rejected = figure_service._enforce_edit_scope_patch({
            "options": {"element_overrides": {
                dotted_id: {"fill": "#62B9C5", "stroke": "#111111"},
                sibling_id: {"fill": "#DC2626"},
            }},
        }, {
            "status": "supported",
            "allowed_patch_keys": [
                f"options.element_overrides.{dotted_id}.fill",
            ],
            "approved_patch": approved_patch,
        })
        self.assertEqual(scoped, approved_patch)
        self.assertEqual(rejected, sorted({
            f"options.element_overrides.{dotted_id}.stroke",
            f"options.element_overrides.{sibling_id}.fill",
        }))

    def test_point_and_cell_overrides_accept_only_plot_compatible_renderer_ids(self):
        cases = [
            (
                "scatter",
                "mark:scatter:row=sample%202",
                [
                    "mark:heatmap:row=sample%202&col=GeneA",
                    "mark:scatter:row=bad%ZZ",
                    "mark:scatter:row=x[options.title]",
                ],
            ),
            (
                "heatmap",
                "mark:heatmap:row=Sample%20A&col=Gene%2F1",
                [
                    "mark:scatter:row=Sample%20A",
                    "mark:heatmap:row=&col=GeneA",
                    "mark:heatmap:row=SampleA&col=bad%ZZ",
                ],
            ),
            (
                "correlation_heatmap",
                "mark:correlation_heatmap:x=Gene%20A&y=Gene%2F1",
                [
                    "mark:heatmap:row=Gene%20A&col=Gene%2F1",
                    "mark:correlation_heatmap:x=GeneA&y=bad%ZZ",
                    "mark:correlation_heatmap:x=GeneA&y=x[options.title]",
                ],
            ),
        ]
        for plot_type, valid_id, invalid_ids in cases:
            with self.subTest(plot_type=plot_type):
                raw = {valid_id: {"fill": "#7e22ce", "stroke": "#3b0764"}}
                raw.update({item: {"fill": "#FFFFFF"} for item in invalid_ids})
                clean = figure_service.sanitize_options(
                    plot_type, {"element_overrides": raw},
                )["element_overrides"]
                self.assertEqual(clean, {
                    valid_id: {"fill": "#7E22CE", "stroke": "#3B0764"},
                })

    def test_point_and_cell_scope_keeps_dot_plus_ids_as_one_exact_path_segment(self):
        cases = [
            ("point", "mark:scatter:row=sample.1+rep"),
            ("cell", "mark:heatmap:row=Sample.1+rep&col=Gene+A"),
            ("cell", "mark:correlation_heatmap:x=Gene.A+y&y=Gene+B"),
        ]
        for role, element_id in cases:
            with self.subTest(element_id=element_id):
                leaf = f"options.element_overrides.{element_id}.fill"
                approved = {
                    "options": {"element_overrides": {element_id: {"fill": "#7E22CE"}}},
                }
                sibling_id = f"{element_id}+sibling"
                scoped, rejected = figure_service._enforce_edit_scope_patch({
                    "options": {"element_overrides": {
                        element_id: {"fill": "#7E22CE", "stroke": "#111111"},
                        sibling_id: {"fill": "#DC2626"},
                    }},
                }, {
                    "status": "supported",
                    "allowed_patch_keys": [leaf],
                    "approved_patch": approved,
                })
                self.assertEqual(scoped, approved)
                self.assertEqual(rejected, sorted({
                    f"options.element_overrides.{element_id}.stroke",
                    f"options.element_overrides.{sibling_id}.fill",
                }))
                target = {
                    "role": role,
                    "element_id": element_id,
                    "editable": True,
                    "setting_path": f"options.element_overrides.{element_id}",
                }
                self.assertEqual(
                    figure_service._supported_element_override_target(target),
                    (element_id, f"options.element_overrides.{element_id}"),
                )

    def test_marked_point_and_cells_generate_only_the_exact_requested_color_leaf(self):
        cases = [
            (
                "scatter", {"x": "Time", "y": "Expression"}, "point",
                "mark:scatter:row=sample.1+rep",
            ),
            (
                "heatmap", {"columns": ["Time", "Expression"]}, "cell",
                "mark:heatmap:row=Sample.1+rep&col=Expression",
            ),
            (
                "correlation_heatmap", {"columns": ["Time", "Expression"]}, "cell",
                "mark:correlation_heatmap:x=Time&y=Expression.1+rep",
            ),
        ]
        for plot_type, mapping, role, element_id in cases:
            with self.subTest(plot_type=plot_type):
                db, figure, version, dataset = self._improve_fixture(plot_type)
                version.mapping = mapping
                version.layout = {
                    "img_px": {"w": 1000, "h": 800},
                    "scene_elements": [{
                        "id": element_id,
                        "kind": "mark",
                        "role": role,
                        "bbox_px": {"x0": 300, "x1": 380, "y0": 300, "y1": 650},
                        "editable": True,
                        "setting_path": f"options.element_overrides.{element_id}",
                    }],
                }
                marks = [{
                    "id": "localized-element", "label": "A", "display_number": 1,
                    "type": "region", "memo": "이 요소 하나만 #7E22CE로 바꾸세요",
                    "bbox_normalized": {"x": 0.30, "y": 0.375, "width": 0.08, "height": 0.4375},
                }]
                suggestions = [{
                    "mark_id": "localized-element",
                    "suggestion_type": "Localized styling",
                    "recommended": "Change it and also add error bars.",
                    "priority": "high",
                    "param_patch": {"options": {"error_bars": True}},
                }]
                with (
                    patch.object(figure_service, "get_figure", return_value=figure),
                    patch.object(figure_service, "get_version", return_value=version),
                    patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
                    patch.object(figure_service.ai_client, "improve_figure", return_value=(suggestions, [])),
                ):
                    rows = figure_service.improve_version(
                        db, figure.id, version.id, "44444444-4444-4444-8444-444444444444",
                        prompt="Apply the localized edits marked on the figure preview.",
                        marks=marks,
                    )

                applicable = [row for row in rows if row.param_patch]
                self.assertEqual(len(applicable), 1)
                expected = {
                    "options": {"element_overrides": {element_id: {"fill": "#7E22CE"}}},
                }
                self.assertEqual(applicable[0].param_patch, expected)
                self.assertEqual(
                    applicable[0].edit_scope["allowed_patch_keys"],
                    [f"options.element_overrides.{element_id}.fill"],
                )

    def test_point_and_cell_target_corrections_reject_forged_or_mismatched_paths(self):
        cases = [
            ("point", "mark:scatter:row=sample.1+rep"),
            ("cell", "mark:heatmap:row=Sample.1+rep&col=Gene+A"),
            ("cell", "mark:correlation_heatmap:x=Gene.A+y&y=Gene+B"),
        ]
        mark = {
            "type": "region",
            "bbox_normalized": {"x": 0.30, "y": 0.375, "width": 0.08, "height": 0.4375},
        }
        for role, element_id in cases:
            with self.subTest(element_id=element_id):
                expected_path = f"options.element_overrides.{element_id}"
                layout = {
                    "img_px": {"w": 1000, "h": 800},
                    "scene_elements": [{
                        "id": element_id, "role": role, "kind": "mark",
                        "bbox_px": {"x0": 300, "x1": 380, "y0": 300, "y1": 650},
                        "editable": True, "setting_path": expected_path,
                    }],
                }
                requested = {
                    "type": role, "role": role, "element_id": element_id,
                    "setting_path": expected_path, "editable": True,
                }
                accepted = figure_service._server_validate_target_override(
                    mark, layout, requested, "이 요소 하나만 파란색으로",
                )
                self.assertIsNotNone(accepted)
                self.assertEqual(accepted["element_id"], element_id)

                forged = {**requested, "setting_path": "options.palette_name"}
                self.assertIsNone(figure_service._server_validate_target_override(
                    mark, layout, forged, "이 요소 하나만 파란색으로",
                ))
                mismatched_role = {**requested, "role": "bar", "type": "bar"}
                self.assertIsNone(figure_service._server_validate_target_override(
                    mark, layout, mismatched_role, "이 요소 하나만 파란색으로",
                ))

    def test_duplicate_scene_ids_are_collapsed_for_target_discovery(self):
        element_id = "mark:scatter:row=int%3A101"
        layout = {
            "img_px": {"w": 1000, "h": 800},
            "scene_elements": [
                {
                    "id": element_id, "role": "point", "kind": "mark",
                    "bbox_px": {"x0": 300, "x1": 314, "y0": 300, "y1": 314},
                    "editable": False, "setting_path": None,
                },
                {
                    "id": element_id, "role": "point", "kind": "mark",
                    "bbox_px": {"x0": 300, "x1": 314, "y0": 300, "y1": 314},
                    "editable": False, "setting_path": None,
                },
            ],
        }
        _width, _height, candidates = figure_service._server_mark_target_candidates(layout)
        matching = [target for target, _box in candidates if target.get("element_id") == element_id]
        self.assertEqual(len(matching), 1)

    def test_target_dropdown_can_select_only_a_nearby_server_known_bar(self):
        layout = self._scene_layout()
        mark_id = "mark:grouped_bar:category=Control&series=24h"
        layout["scene_elements"][-1].update({
            "id": mark_id,
            "editable": True,
            "setting_path": f"options.element_overrides.{mark_id}",
            "unsupported_reason": None,
        })
        mark = {
            "type": "region",
            "bbox_normalized": {"x": 0.30, "y": 0.375, "width": 0.08, "height": 0.4375},
        }
        requested = {
            "type": "bar", "role": "bar", "element_id": mark_id,
            "setting_path": f"options.element_overrides.{mark_id}",
            "editable": True,
        }

        accepted = figure_service._server_validate_target_override(
            mark, layout, requested, "이 막대 하나만 파란색으로",
        )
        self.assertIsNotNone(accepted)
        self.assertEqual(accepted["element_id"], mark_id)
        self.assertEqual(accepted["category"], "Control")

        forged = dict(requested)
        forged["setting_path"] = "options.palette_name"
        self.assertIsNone(figure_service._server_validate_target_override(
            mark, layout, forged, "이 막대 하나만 파란색으로",
        ))
        far_mark = {
            "type": "region",
            "bbox_normalized": {"x": 0.80, "y": 0.05, "width": 0.05, "height": 0.05},
        }
        self.assertIsNone(figure_service._server_validate_target_override(
            far_mark, layout, requested, "이 막대 하나만 파란색으로",
        ))

    def test_specific_grouped_bar_mark_produces_one_server_scoped_override(self):
        db, figure, version, dataset = self._improve_fixture("grouped_bar")
        version.layout = self._scene_layout()
        mark_id = "mark:grouped_bar:category=Control&series=24h"
        version.layout["scene_elements"][-1].update({
            "id": mark_id,
            "editable": True,
            "setting_path": f"options.element_overrides.{mark_id}",
            "unsupported_reason": None,
        })
        sibling_id = "mark:grouped_bar:category=Knockout&series=0h"
        version.options = {
            "element_overrides": {sibling_id: {"fill": "#61A574"}},
        }
        # The provider tries to add an unrelated setting. The deterministic
        # server target + explicit memo must still yield only the selected bar.
        suggestions = [{
            "mark_id": "bar-control-24h",
            "suggestion_type": "Bar styling",
            "recommended": "Change the marked bar and add error bars.",
            "priority": "high",
            "param_patch": {"options": {"error_bars": True}},
        }]
        marks = [{
            "id": "bar-control-24h", "label": "A", "display_number": 1,
            "type": "region",
            "memo": "이 막대 하나만 #7E22CE로 바꾸고 다른 것은 바꾸지 마세요",
            "bbox_normalized": {"x": 0.30, "y": 0.375, "width": 0.08, "height": 0.4375},
        }]

        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=version),
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ai_client, "improve_figure", return_value=(suggestions, [])),
        ):
            rows = figure_service.improve_version(
                db, figure.id, version.id, "44444444-4444-4444-8444-444444444444",
                prompt="Apply the localized edits marked on the figure preview.",
                marks=marks,
            )

        applicable = [row for row in rows if row.param_patch]
        self.assertEqual(len(applicable), 1)
        improvement = applicable[0]
        self.assertEqual(improvement.param_patch, {
            "options": {"element_overrides": {mark_id: {"fill": "#7E22CE"}}},
        })
        leaf_path = f"options.element_overrides.{mark_id}.fill"
        self.assertEqual(improvement.edit_scope["allowed_patch_keys"], [leaf_path])
        self.assertEqual(improvement.edit_scope["resolved_target"]["element_id"], mark_id)

        merged = figure_service._merge_apply_options(
            version.options, improvement.param_patch["options"],
        )
        self.assertEqual(merged["element_overrides"][sibling_id], {"fill": "#61A574"})
        self.assertEqual(merged["element_overrides"][mark_id], {"fill": "#7E22CE"})

        tampered, rejected = figure_service._enforce_edit_scope_patch({
            "options": {"element_overrides": {
                mark_id: {"fill": "#7E22CE", "stroke": "#111111"},
                sibling_id: {"fill": "#DC2626"},
            }},
        }, improvement.edit_scope)
        self.assertEqual(tampered, improvement.param_patch)
        self.assertEqual(rejected, sorted({
            f"options.element_overrides.{mark_id}.stroke",
            f"options.element_overrides.{sibling_id}.fill",
        }))

        base = SimpleNamespace(
            options=version.options, mapping=version.mapping, style_preset="nature",
        )
        after = SimpleNamespace(
            options=merged, mapping=version.mapping, style_preset="nature",
        )
        self.assertEqual(
            [item["key"] for item in figure_service._full_version_diff(base, after)],
            [leaf_path],
        )
        checklist = figure_service._ai_edit_checklist(
            [SimpleNamespace(
                param_patch=improvement.param_patch,
                suggestion_type="Bar styling",
            )],
            SimpleNamespace(
                mapping=version.mapping,
                options=merged,
                style_preset="nature",
                r_code=build_plot_r("grouped_bar", version.mapping, merged),
            ),
        )
        self.assertEqual(len(checklist), 1)
        self.assertEqual(checklist[0]["path"], leaf_path)
        self.assertEqual(checklist[0]["status"], "applied")

    def test_grouped_bar_x_category_recolor_remains_explicitly_unsupported(self):
        db, figure, version, dataset = self._improve_fixture("grouped_bar")
        version.layout = self._scene_layout()
        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=version),
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ai_client, "improve_figure", return_value=([{
                "mark_id": "category-control", "suggestion_type": "Category color", "recommended": "Blue",
                "priority": "high", "param_patch": {"options": {"category_colors": {"Control": "#2563EB"}}},
            }], [])),
        ):
            rows = figure_service.improve_version(
                db, figure.id, version.id, "44444444-4444-4444-8444-444444444444",
                prompt="Apply the localized edits marked on the figure preview.",
                marks=[{
                    "id": "category-control", "label": "A", "display_number": 1, "type": "region",
                    "memo": "Control 범주 전체를 파란색으로",
                    "bbox_normalized": {"x": 0.3, "y": 0.375, "width": 0.08, "height": 0.4375},
                }],
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].param_patch, {})
        self.assertEqual(rows[0].edit_scope["status"], "unsupported")

    def test_apply_uses_server_stored_original_request_and_rejects_explicit_mismatch(self):
        scope = {
            "original_request": "Change only the title to ZXQ-17",
            "original_request_source": "explicit",
        }
        self.assertEqual(
            figure_service._resolve_apply_original_request([scope], None),
            "Change only the title to ZXQ-17",
        )
        with self.assertRaises(BadRequestError) as mismatch:
            figure_service._resolve_apply_original_request([scope], "Also change the palette")
        self.assertEqual(mismatch.exception.error_code, "REQUEST_PROVENANCE_MISMATCH")
        with self.assertRaises(BadRequestError) as mixed:
            figure_service._resolve_apply_original_request([
                scope,
                {"original_request": "Change the axis", "original_request_source": "explicit"},
            ], None)
        self.assertEqual(mixed.exception.error_code, "MIXED_REQUEST_SCOPES")

    def test_whitelist_does_not_widen_legend_title_removal_or_axis_minimum(self):
        pdef = figure_service._plot_def("line")
        legend = figure_service._request_allowed_patch_paths(
            "line", "remove legend title", pdef
        )
        self.assertIn("options.legend_title", legend)
        self.assertNotIn("options.hide_legend", legend)
        x_min = figure_service._request_allowed_patch_paths(
            "line", "set x-axis minimum to 0", pdef
        )
        self.assertIn("options.x_min", x_min)
        self.assertNotIn("options.x_max", x_min)
        self.assertNotIn("options.log_x", x_min)

    def test_unknown_or_missing_provider_mark_id_never_falls_into_another_scope(self):
        scopes = [
            {"scope_id": "request", "mark_id": None, "request": "General request"},
            {"scope_id": "mark:a", "mark_id": "a", "mark_label": "A", "display_number": 1},
            {"scope_id": "mark:b", "mark_id": "b", "mark_label": "B", "display_number": 2},
        ]
        self.assertIsNone(figure_service._resolve_suggestion_scope({"mark_id": "unknown"}, scopes))
        self.assertIsNone(figure_service._resolve_suggestion_scope({}, scopes))

    def test_unknown_unsupported_mark_reason_is_not_copied_to_submitted_marks(self):
        db, figure, version, dataset = self._improve_fixture("line")
        prompt = "Mark #1: change line type\nMark #2: change point shape"
        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=version),
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ai_client, "improve_figure", return_value=([], [{
                "mark_id": "99", "request": "wrong mark", "reason": "WRONG_MARK_REASON",
            }])),
        ):
            rows = figure_service.improve_version(
                db, figure.id, version.id, "44444444-4444-4444-8444-444444444444", prompt=prompt
            )

        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row.edit_scope["status"] == "unsupported" for row in rows))
        self.assertTrue(all("WRONG_MARK_REASON" not in row.recommended for row in rows))

    def test_duplicate_provider_results_for_one_mark_merge_to_one_durable_result(self):
        db, figure, version, dataset = self._improve_fixture("line")
        prompt = "Mark #3: 선을 점선으로 바꾸고 점을 네모로 바꿔줘"
        suggestions = [
            {
                "mark_id": "3", "suggestion_type": "Line type", "recommended": "Dashed",
                "priority": "high", "param_patch": {"options": {"line_type": "dashed"}},
            },
            {
                "mark_id": "3", "suggestion_type": "Point shape", "recommended": "Square",
                "priority": "high", "param_patch": {"options": {"point_shape": "square"}},
            },
        ]
        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=version),
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ai_client, "improve_figure", return_value=(suggestions, [])),
        ):
            rows = figure_service.improve_version(
                db, figure.id, version.id, "44444444-4444-4444-8444-444444444444", prompt=prompt
            )

        applicable = [row for row in rows if row.param_patch]
        self.assertEqual(len(applicable), 1)
        self.assertEqual(applicable[0].param_patch, {
            "options": {"line_type": "dashed", "point_shape": "square"},
        })

    def test_blank_mark_memo_consumes_general_prompt_without_duplicate_global_scope(self):
        scopes = figure_service._structured_edit_request_scopes([{
            "id": "region-a", "label": "A", "display_number": 1,
            "type": "region", "memo": "",
        }], "Change the marked item to blue")

        self.assertEqual(len(scopes), 1)
        self.assertEqual(scopes[0]["mark_id"], "region-a")
        self.assertEqual(scopes[0]["request"], "Change the marked item to blue")

    def test_structured_mark_allows_blank_memo_and_null_target_is_explicitly_unsupported(self):
        request = ImprovementRequest.model_validate({
            "prompt": "Remove the marked title",
            "marks": [{
                "id": "title-region-a",
                "label": "Mark 1",
                "display_number": 1,
                "type": "region",
                "memo": "",
                "bbox_normalized": {"x": 0.1, "y": 0.05, "width": 0.4, "height": 0.1},
                "resolved_target": {
                    "type": "data_element",
                    "label": "one rendered bar",
                    "setting_path": None,
                    "element_id": "bar-17",
                    "role": "bar",
                    "category": "Knockout",
                    "series": "24h",
                    "editable": False,
                    "unsupported_reason": "Individual rendered bars are not independently editable.",
                },
            }],
        })
        db, figure, version, dataset = self._improve_fixture("grouped_bar")

        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=version),
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ai_client, "improve_figure", return_value=([{
                "mark_id": "title-region-a",
                "confidence": 0.91,
                "suggestion_type": "Bar styling",
                "recommended": "Change a single bar.",
                "priority": "high",
                "param_patch": {"options": {"palette_name": "journal_muted"}},
            }], [])),
        ):
            rows = figure_service.improve_version(
                db,
                figure.id,
                version.id,
                "44444444-4444-4444-8444-444444444444",
                prompt=request.prompt,
                marks=[mark.model_dump(exclude_none=False) for mark in request.marks],
            )

        marked = next(row for row in rows if row.edit_scope.get("mark_id") == "title-region-a")
        self.assertEqual(marked.param_patch, {})
        self.assertEqual(marked.edit_scope["status"], "unsupported")
        self.assertEqual(marked.edit_scope["confidence"], 0.91)
        self.assertIn("not independently editable", marked.edit_scope["reason"])

    def test_specific_bar_mark_is_explicitly_unsupported_not_generic_fallback(self):
        db, figure, version, dataset = self._improve_fixture("grouped_bar")
        prompt = "\n".join([
            "Apply the localized edits marked on the figure preview.",
            "",
            "Localized image editing annotations for R-code regeneration:",
            "Mark #7 [region]. Bounds: left 20%, top 20%, width 10%, height 30%. User memo: 이 막대 하나만 파란색으로 바꿔줘",
        ])
        suggestions = [{
            "mark_id": "7",
            "resolved_target": "one bar/data element",
            "suggestion_type": "Bar styling",
            "recommended": "Use publication defaults.",
            "priority": "high",
            "param_patch": {"options": {
                "error_bars": True,
                "error_type": "sd",
                "palette_name": "journal_muted",
                "size": "wide",
                "dpi": 300,
            }},
        }]

        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=version),
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ai_client, "improve_figure", return_value=(suggestions, [])),
        ):
            rows = figure_service.improve_version(
                db, figure.id, version.id, "44444444-4444-4444-8444-444444444444", prompt=prompt
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].param_patch, {})
        self.assertEqual(rows[0].suggestion_type, "Unsupported request")
        self.assertEqual(rows[0].edit_scope["scope_id"], "mark:7")
        self.assertEqual(rows[0].edit_scope["status"], "unsupported")
        self.assertIn("individual bar", rows[0].edit_scope["reason"].lower())

    def test_category_value_relabel_has_specific_reason_even_when_provider_is_incomplete(self):
        db, figure, version, dataset = self._improve_fixture("grouped_bar")
        version.layout = self._scene_layout()
        version.layout["scene_elements"][-1]["id"] = "mark:grouped_bar:KO:24h"
        version.layout["scene_elements"][-1]["category"] = "KO"
        marks = [{
            "id": "category-ko", "label": "Mark B", "display_number": 2,
            "type": "region", "memo": "KO → Knockout",
            # Inside the persisted KO bar bbox (300..380, 300..650).
            "bbox_normalized": {"x": 0.31, "y": 0.40, "width": 0.06, "height": 0.35},
        }]
        provider_reason = "The AI could not return a complete, request-scoped edit plan."

        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=version),
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ai_client, "improve_figure", return_value=([], [{
                "mark_id": "category-ko", "request": marks[0]["memo"], "reason": provider_reason,
            }])),
        ):
            rows = figure_service.improve_version(
                db, figure.id, version.id, "44444444-4444-4444-8444-444444444444",
                prompt="Apply the localized edits marked on the figure preview.", marks=marks,
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].edit_scope["status"], "unsupported")
        reason = rows[0].edit_scope["reason"]
        self.assertIn("Category value relabeling", reason)
        self.assertIn("source dataset value", reason)
        self.assertIn("display-label column", reason)
        self.assertNotIn("category label override", reason)
        self.assertNotIn("incomplete", reason.lower())
        self.assertEqual(rows[0].edit_scope["resolved_target"]["role"], "bar")
        self.assertEqual(rows[0].edit_scope["resolved_target"]["category"], "KO")

    def test_global_category_value_relabel_gets_specific_supported_guidance(self):
        db, figure, version, dataset = self._improve_fixture("grouped_bar")
        request = "Rename category value KO to Knockout"
        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=version),
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ai_client, "improve_figure", return_value=([], [{
                "request": request,
                "reason": "The AI could not return a complete, request-scoped edit plan.",
            }])),
        ):
            rows = figure_service.improve_version(
                db, figure.id, version.id, "44444444-4444-4444-8444-444444444444",
                prompt=request,
            )

        self.assertEqual(len(rows), 1)
        reason = rows[0].edit_scope["reason"]
        self.assertIn("Category value relabeling", reason)
        self.assertIn("display-label column", reason)
        self.assertNotIn("incomplete", reason.lower())

    def test_category_order_and_axis_label_rename_are_not_misclassified_as_value_relabel(self):
        authoritative_bar = {
            "role": "bar", "type": "bar", "category": "KO", "series": "24h",
            "editable": False,
        }
        cases = [
            "Change category order to Control, KO",
            "Rename the x-axis label to Genotype",
            "Rename the y-axis category label to Expression",
        ]
        for request in cases:
            with self.subTest(request=request):
                reason = figure_service._specific_element_unsupported_reason({
                    "scope_id": "mark:test", "mark_id": "test", "request": request,
                    "server_resolved_target": authoritative_bar,
                })
                self.assertFalse(reason and reason.startswith("Category value relabeling"))
        self.assertIsNone(figure_service._category_value_relabel_unsupported_reason({
            "scope_id": "request", "mark_id": None, "request": "KO → Knockout",
        }))

    def test_incomplete_marked_payload_never_invents_export_or_palette_fallback(self):
        with patch.object(
            ai_client,
            "_run_logged",
            side_effect=BadRequestError("incomplete payload", error_code="AI_BAD_RESPONSE"),
        ):
            suggestions, unsupported = ai_client.improve_figure(
                object(),
                "grouped_bar",
                {"x": "Genotype", "y": "Expression", "group": "Time"},
                {},
                "nature",
                None,
                [],
                user_request="Mark #7: change only this bar to blue",
            )

        self.assertEqual(suggestions, [])
        self.assertTrue(unsupported)
        self.assertNotIn("size", str(unsupported).lower())
        self.assertNotIn("palette", str(unsupported).lower())

    def test_marks_only_incomplete_payload_is_scoped_failure_not_publication_fallback(self):
        with patch.object(
            ai_client,
            "_run_logged",
            side_effect=BadRequestError("incomplete payload", error_code="AI_BAD_RESPONSE"),
        ):
            suggestions, unsupported = ai_client.improve_figure(
                object(), "line", {"x": "Time", "y": "Expression"}, {}, "nature",
                None, [], user_request=None,
                request_scopes=[{"scope_id": "mark:a", "mark_id": "a", "request": ""}],
            )

        self.assertEqual(suggestions, [])
        self.assertTrue(unsupported)
        self.assertNotIn("publication", str(unsupported).lower())

    def test_apply_reenforces_persisted_scope_against_a_tampered_patch(self):
        patch_value, rejected = figure_service._enforce_edit_scope_patch(
            {
                "options": {
                    "line_type": "dashed",
                    "palette_name": "journal_muted",
                    "dpi": 300,
                },
            },
            {
                "status": "supported",
                "request": "Change the line to dashed",
                "allowed_patch_keys": ["options.line_type"],
            },
        )

        self.assertEqual(patch_value, {"options": {"line_type": "dashed"}})
        self.assertEqual(rejected, ["options.dpi", "options.palette_name"])

    def test_single_apply_path_reenforces_leaf_scope_and_deep_merges_base_options(self):
        base = SimpleNamespace(
            id="base-version", version_number=1, mapping={"x": "Genotype", "y": "Expression"},
            options={"category_colors": {"0h": "#DC2626"}}, style_preset="nature",
        )
        figure = SimpleNamespace(
            id="figure", versions=[base], current_version_id="base-version", style_preset="nature",
        )
        scope = {
            "status": "supported",
            "allowed_patch_keys": ["options.category_colors.24h"],
            "approved_patch": {"options": {"category_colors": {"24h": "#2563EB"}}},
            "original_request": "24 h 계열 전체를 파란색으로 바꿔줘",
            "original_request_source": "explicit",
        }
        improvement = SimpleNamespace(
            id="improvement", figure_version_id="base-version", suggestion_type="Series color",
            param_patch={"options": {"category_colors": {
                "24h": "#2563EB", "Control": "#16A34A",
            }}},
            edit_scope=scope, applied=False,
        )
        new_version = SimpleNamespace(
            id="new-version", mapping=base.mapping, options=None, style_preset="nature", edit_context=None,
        )
        db = Mock()

        def query(model):
            result = Mock()
            result.filter.return_value.first.return_value = (
                improvement if model is figure_service.Improvement else new_version
            )
            return result

        db.query.side_effect = query
        captured = {}

        def rerender(_db, _figure_id, _owner_id, request):
            captured["options"] = request.options
            new_version.options = request.options
            return {"id": "new-version"}

        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=base),
            patch.object(figure_service, "rerender", side_effect=rerender),
            patch.object(figure_service, "_ai_edit_checklist", return_value=[]),
            patch.object(figure_service, "_append_internal_ai_edit_checklist"),
            patch.object(figure_service, "_applied_skipped_from_checklist", return_value=([], [])),
        ):
            result = figure_service.apply_improvement(
                db, "figure", "improvement", "owner", original_request=None,
            )

        self.assertEqual(captured["options"]["category_colors"], {
            "0h": "#DC2626", "24h": "#2563EB",
        })
        self.assertEqual(result["dropped_keys"], ["options.category_colors.Control"])
        self.assertEqual(
            new_version.edit_context["original_request"],
            "24 h 계열 전체를 파란색으로 바꿔줘",
        )

    def test_specific_category_series_element_and_category_rename_are_unsupported(self):
        for request in (
            "Control의 24 h 막대만 보라색으로 바꿔줘",
            "KO 범주만 Knockout으로 이름을 바꿔줘",
            "make only the selected point purple",
        ):
            with self.subTest(request=request):
                reason = figure_service._specific_element_unsupported_reason({
                    "mark_id": "region-a",
                    "request": request,
                })
                self.assertIsNotNone(reason)

    def test_named_category_wide_recolor_remains_supported(self):
        scope = {"mark_id": "region-b", "request": "Knockout 계열 전체를 파랑으로 바꿔줘"}
        self.assertIsNone(figure_service._specific_element_unsupported_reason(scope))
        filtered = figure_service._filter_patch_to_request_scope(
            {"options": {"category_colors": {
                "Knockout": "#2563EB",
                "Wildtype": "#DC2626",
            }}},
            set(),
            scope["request"],
        )
        self.assertEqual(filtered, {"options": {"category_colors": {"Knockout": "#2563EB"}}})

    def test_named_series_style_keeps_only_requested_series_and_leaf(self):
        filtered = figure_service._filter_patch_to_request_scope(
            {"options": {"series_styles": {
                "Knockout": {"color": "#2563EB", "shape": "square"},
                "Wildtype": {"color": "#DC2626"},
            }}},
            set(),
            "Knockout 계열 전체를 파란색으로 바꿔줘",
        )
        self.assertEqual(filtered, {
            "options": {"series_styles": {"Knockout": {"color": "#2563EB"}}},
        })
        self.assertEqual(
            figure_service._authorization_patch_key_paths(filtered),
            ["options.series_styles.Knockout.color"],
        )

    def test_short_category_label_requires_explicit_category_context(self):
        patch_value = {"options": {"category_colors": {"A": "#2563EB"}}}
        self.assertEqual(
            figure_service._filter_patch_to_request_scope(
                patch_value, set(), "Make a colorblind chart with clear labels"
            ),
            {},
        )
        self.assertEqual(
            figure_service._filter_patch_to_request_scope(
                patch_value, set(), "A를 파란색으로 바꿔줘"
            ),
            patch_value,
        )

    def test_verification_fails_when_render_contains_an_unrequested_diff(self):
        base = SimpleNamespace(
            png_path="before.png",
            mapping={"x": "Time", "y": "Expression"},
            options={"title": "Old", "palette_name": "preset"},
            style_preset="nature",
        )
        after = SimpleNamespace(
            png_path="after.png",
            mapping={"x": "Time", "y": "Expression"},
            options={"title": "New", "palette_name": "journal_muted"},
            style_preset="nature",
            render_log="",
        )
        db = Mock()

        with (
            patch.object(figure_service.storage, "exists", return_value=True),
            patch.object(figure_service.storage, "materialize", side_effect=lambda value, suffix: value),
            patch.object(
                figure_service.ai_client,
                "verify_edit",
                return_value={"satisfied": True, "feedback": "The title changed."},
            ) as verify,
        ):
            outcome = figure_service._run_verification(
                db,
                SimpleNamespace(),
                "44444444-4444-4444-8444-444444444444",
                base,
                after,
                {"options": {"title": "New"}},
                "Change the title to New",
                allow_retry=False,
            )

        self.assertFalse(outcome["verification"]["satisfied"])
        self.assertIn("options.palette_name", outcome["verification"]["feedback"])
        self.assertEqual(verify.call_args.args[3], "Change the title to New")
        self.assertEqual(verify.call_args.kwargs["allowed_patch_keys"], ["options.title"])
        self.assertEqual(
            [item["key"] for item in verify.call_args.kwargs["unrequested_changes"]],
            ["options.palette_name"],
        )


if __name__ == "__main__":
    unittest.main()
