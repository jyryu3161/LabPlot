"""A1.4 coverage: honest sanitize/apply/verify diagnostics.

Covers the new _sanitize_param_patch_report / _apply_diagnostics registry
pass / _r_code_check_for_patch registry fallback / scoped verify-retry /
verification exception-path additions layered on top of A1.3's
app.r_engine.option_support registry. Mocking style follows
MarkedEditSafetyRegressionTests / test_verification_fails_when_render_contains_an_unrequested_diff
in tests/test_ai_feedback_regressions.py.
"""
from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, mock_open, patch

from app.figures import service as figure_service


class SanitizeParamPatchReportTests(unittest.TestCase):
    def test_drops_x_breaks_on_heatmap_with_registry_reason(self):
        clean, dropped = figure_service._sanitize_param_patch_report(
            {"options": {"x_breaks": 5, "title": "Kept"}},
            "heatmap",
            {"columns": ["a", "b"]},
            {},
        )
        self.assertEqual(clean, {"options": {"title": "Kept"}})
        paths = {item["path"]: item["reason"] for item in dropped}
        self.assertIn("options.x_breaks", paths)
        # heatmap isn't in templates._UNIVERSAL_TYPES, so x_breaks never rides
        # the universal scale_x_continuous() post-layer - option_support's
        # own reason text, not a generic "invalid value"/"not an option" one.
        self.assertNotEqual(paths["options.x_breaks"], "invalid value")
        self.assertNotIn(f"not an option for heatmap", paths["options.x_breaks"])

    def test_unrecognized_key_reports_not_an_option(self):
        clean, dropped = figure_service._sanitize_param_patch_report(
            {"options": {"totally_made_up_key": 1}}, "scatter", {"x": "a", "y": "b"}, {},
        )
        self.assertEqual(clean, {})
        self.assertEqual(dropped, [{"path": "options.totally_made_up_key", "reason": "not an option for scatter"}])

    def test_invalid_value_is_dropped_with_invalid_value_reason(self):
        clean, dropped = figure_service._sanitize_param_patch_report(
            {"options": {"level_order": "not-a-list"}}, "bar", {"x": "a", "y": "b"}, {},
        )
        self.assertEqual(clean, {})
        self.assertEqual(dropped, [{"path": "options.level_order", "reason": "invalid value"}])

    def test_companion_keys_accepted_together_survive(self):
        # error_type needs error_bars on; both proposed in the SAME patch for
        # bar (with a y mapping, stat defaults to "mean") must survive together.
        clean, dropped = figure_service._sanitize_param_patch_report(
            {"options": {"error_bars": True, "error_type": "ci95"}},
            "bar",
            {"x": "cat", "y": "val"},
            {},
        )
        self.assertEqual(clean, {"options": {"error_bars": True, "error_type": "ci95"}})
        self.assertEqual(dropped, [])


class ApplyDiagnosticsRegistryPassTests(unittest.TestCase):
    def test_stored_but_unconsumed_key_is_dropped_with_reason_regardless_of_value_diff(self):
        new_version = SimpleNamespace(
            mapping={"columns": ["a", "b"]},
            options={"x_breaks": 5},
            figure=SimpleNamespace(plot_type="heatmap"),
        )
        applied, dropped, reasons = figure_service._apply_diagnostics(
            {"options": {"x_breaks": 5}},
            {"columns": ["a", "b"]},
            {},
            "nature",
            new_version,
        )
        # The stored value visibly changed (None -> 5), so the OLD value-diff
        # alone would have called this "applied" - the registry pass must
        # still move it to dropped_keys with a reason.
        self.assertEqual(applied, [])
        self.assertIn("options.x_breaks", dropped)
        self.assertIn("options.x_breaks", reasons)
        self.assertTrue(reasons["options.x_breaks"])

    def test_consumed_touched_key_still_applies_normally(self):
        new_version = SimpleNamespace(
            mapping={"x": "Time", "y": "Expression"},
            options={"title": "New"},
            figure=SimpleNamespace(plot_type="scatter"),
        )
        applied, dropped, reasons = figure_service._apply_diagnostics(
            {"options": {"title": "New"}},
            {"x": "Time", "y": "Expression"},
            {"title": "Old"},
            "nature",
            new_version,
        )
        self.assertEqual(dropped, [])
        self.assertEqual(reasons, {})
        self.assertEqual([item["key"] for item in applied], ["options.title"])


class RCodeCheckRegistryFallbackTests(unittest.TestCase):
    def test_returns_false_when_r_code_unchanged_for_a_consumed_key(self):
        base = SimpleNamespace(r_code="p <- p + labplot_theme()\n")
        version = SimpleNamespace(
            r_code="p <- p + labplot_theme()\n",  # byte-identical to base
            mapping={"x": "Time", "y": "Expression"},
            options={"hide_legend": True},
            figure=SimpleNamespace(plot_type="scatter"),
        )
        match, note = figure_service._r_code_check_for_patch(
            "options", "hide_legend", True, version, base=base,
        )
        self.assertFalse(match)
        self.assertEqual(note, "R code unchanged")

    def test_returns_none_when_r_code_differs(self):
        base = SimpleNamespace(r_code="p <- p + labplot_theme()\n")
        version = SimpleNamespace(
            r_code="p <- p + labplot_theme() + theme(legend.position='none')\n",
            mapping={"x": "Time", "y": "Expression"},
            options={"hide_legend": True},
            figure=SimpleNamespace(plot_type="scatter"),
        )
        match, note = figure_service._r_code_check_for_patch(
            "options", "hide_legend", True, version, base=base,
        )
        self.assertIsNone(match)

    def test_returns_false_with_registry_reason_when_r_code_unchanged_for_an_unconsumed_key(self):
        # error_type has no dedicated R-code string check and is genuinely
        # UNCONSUMED here (grouped_bar with error_bars unset) - this must NOT
        # fall through to the generic neutral "no specific check defined"
        # None (which the checklist then reports as "applied"); it must
        # report a concrete failure carrying the registry's own reason, same
        # as the already-consumed-but-unchanged case above.
        base = SimpleNamespace(r_code="p <- p + labplot_theme()\n")
        version = SimpleNamespace(
            r_code="p <- p + labplot_theme()\n",  # byte-identical to base
            mapping={"x": "cat", "y": "val", "group": "g"},
            options={"error_type": "ci95"},
            figure=SimpleNamespace(plot_type="grouped_bar"),
        )
        match, note = figure_service._r_code_check_for_patch(
            "options", "error_type", "ci95", version, base=base,
        )
        self.assertFalse(match)
        self.assertIn("error_bars", note)

    def test_legend_ncol_has_a_dedicated_string_check(self):
        version_without = type("V", (), {"r_code": "p <- p + labplot_theme()\n"})()
        version_with = type("V", (), {"r_code": "p <- p + guide_legend(ncol = 2)\n"})()
        match_without, _ = figure_service._r_code_check_for_patch("options", "legend_ncol", 2, version_without)
        match_with, _ = figure_service._r_code_check_for_patch("options", "legend_ncol", 2, version_with)
        self.assertFalse(match_without)
        self.assertTrue(match_with)


class ScopedSuggestionLosesAllKeysReasonTests(unittest.TestCase):
    """When a marked-edit scope's ONLY proposed patch key is dropped by
    sanitize/option_support, the "Unsupported request" carrier row must
    surface THAT reason, not the generic fallback."""

    @staticmethod
    def _fixture():
        figure = SimpleNamespace(
            id="11111111-1111-4111-8111-111111111111",
            plot_type="heatmap",
            style_preset="nature",
            dataset_id="22222222-2222-4222-8222-222222222222",
            project_id=None,
        )
        version = SimpleNamespace(
            id="33333333-3333-4333-8333-333333333333",
            mapping={"columns": ["a", "b"]},
            options={},
            style_preset="nature",
            png_path=None,
            r_code="",
            layout=None,
        )
        dataset = SimpleNamespace(column_profile=[
            {"name": "a", "role": "numeric", "dtype": "numeric"},
            {"name": "b", "role": "numeric", "dtype": "numeric"},
        ])
        db = Mock()
        db.query.return_value.filter.return_value.order_by.return_value.first.return_value = None
        return db, figure, version, dataset

    def test_carrier_row_reason_is_the_registry_reason_not_the_generic_fallback(self):
        db, figure, version, dataset = self._fixture()
        prompt = "\n".join([
            "Apply the localized edits marked on the figure preview.",
            "",
            "Localized image editing annotations for R-code regeneration:",
            "Mark #1 [region]. Bounds: left 10%, top 10%, width 20%, height 20%. "
            "User memo: change the x axis tick format to comma",
        ])
        # x_tick_format is a registry-unsupported key for heatmap (x isn't in
        # templates._AXIS_CONT for heatmap): the ENTIRE param_patch is dropped
        # by _sanitize_param_patch_report, so this scope produces zero rows.
        suggestions = [{
            "mark_id": "1",
            "resolved_target": "x axis",
            "confidence": 0.7,
            "suggestion_type": "Axis tick format",
            "recommended": "Use comma-formatted x ticks.",
            "priority": "medium",
            "param_patch": {"options": {"x_tick_format": "comma"}},
        }]

        with (
            patch.object(figure_service, "get_figure", return_value=figure),
            patch.object(figure_service, "get_version", return_value=version),
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ai_client, "improve_figure", return_value=(suggestions, [])),
        ):
            rows = figure_service.improve_version(
                db, figure.id, version.id, "44444444-4444-4444-8444-444444444444", prompt=prompt,
            )

        carriers = [row for row in rows if row.suggestion_type == "Unsupported request"]
        self.assertEqual(len(carriers), 1)
        reason = carriers[0].edit_scope["reason"]
        self.assertNotEqual(reason, "No request-authorized parameter change could be derived for this edit scope.")
        self.assertNotIn("was recognized as the", reason)


class ScopedVerifyRetryTests(unittest.TestCase):
    """(T5) A scoped edit (non-empty allowed_patch_keys) is allowed to retry -
    allow_retry is no longer forced off just because edit_scopes was passed."""

    def test_retry_runs_and_succeeds_for_a_scoped_edit(self):
        base = SimpleNamespace(
            png_path="before.png",
            mapping={"x": "Time", "y": "Expression"},
            options={"title": "Old"},
            style_preset="nature",
        )
        applied_version = SimpleNamespace(
            id="v-after",
            version_number=2,
            png_path="after.png",
            mapping={"x": "Time", "y": "Expression"},
            options={"title": "New"},
            style_preset="nature",
            render_log="",
            r_code="",
            figure=SimpleNamespace(plot_type="scatter"),
        )
        retry_version = SimpleNamespace(
            id="v-retry",
            png_path="after2.png",
            mapping={"x": "Time", "y": "Expression"},
            options={"title": "New", "subtitle": "n=24"},
            style_preset="nature",
            render_log="",
            r_code="",
            figure=SimpleNamespace(plot_type="scatter"),
        )
        fig = SimpleNamespace(
            id="fig-1", plot_type="scatter", dataset_id="ds-1", project_id=None, style_preset="nature",
        )
        db = Mock()
        db.query.return_value.filter.return_value.first.return_value = retry_version

        with (
            patch.object(figure_service.storage, "exists", return_value=True),
            patch.object(figure_service.storage, "materialize", side_effect=lambda value, suffix: value),
            patch("builtins.open", mock_open(read_data=b"fake-png-bytes")),
            patch.object(figure_service.ds_service, "get_dataset", return_value=SimpleNamespace(column_profile=[])),
            patch.object(
                figure_service.ai_client, "verify_edit",
                side_effect=[
                    {"satisfied": False, "feedback": "Title changed but the subtitle is still missing."},
                    {"satisfied": True, "feedback": "Now matches the request."},
                ],
            ) as verify,
            patch.object(
                figure_service.ai_client, "improve_figure",
                return_value=([{
                    "priority": "high",
                    "param_patch": {"options": {"subtitle": "n=24"}},
                }], []),
            ) as improve,
            patch.object(figure_service, "rerender", return_value={"id": "v-retry"}) as rerender_mock,
        ):
            outcome = figure_service._run_verification(
                db, fig, "owner-1", base, applied_version,
                {"options": {"title": "New"}},
                "Change the title to New and add the subtitle n=24",
                allow_retry=True,
                allowed_patch_keys=["options.title", "options.subtitle"],
            )

        self.assertEqual(verify.call_count, 2)
        improve.assert_called_once()
        rerender_mock.assert_called_once()
        self.assertTrue(outcome["verification"]["satisfied"])
        self.assertEqual(outcome["verification"]["attempts"], 2)

    def test_retry_is_skipped_when_the_scoped_allowed_set_is_empty(self):
        base = SimpleNamespace(
            png_path="before.png", mapping={"x": "Time", "y": "Expression"},
            options={"title": "Old"}, style_preset="nature",
        )
        applied_version = SimpleNamespace(
            id="v-after", png_path="after.png",
            mapping={"x": "Time", "y": "Expression"}, options={"title": "New"},
            style_preset="nature", render_log="", figure=SimpleNamespace(plot_type="scatter"),
        )
        fig = SimpleNamespace(id="fig-1", plot_type="scatter", dataset_id="ds-1", project_id=None)
        db = Mock()

        with (
            patch.object(figure_service.storage, "exists", return_value=True),
            patch.object(figure_service.storage, "materialize", side_effect=lambda value, suffix: value),
            patch.object(
                figure_service.ai_client, "verify_edit",
                return_value={"satisfied": False, "feedback": "Not quite."},
            ) as verify,
            patch.object(figure_service.ai_client, "improve_figure") as improve,
        ):
            figure_service._run_verification(
                db, fig, "owner-1", base, applied_version,
                {"options": {"title": "New"}},
                "Change the title to New",
                allow_retry=True,
                allowed_patch_keys=[],
            )

        self.assertEqual(verify.call_count, 1)
        improve.assert_not_called()

    def test_retry_widening_uses_only_the_applied_scopes_own_request_text(self):
        # A1.4-fix regression: `original_request` can be the WHOLE plan text
        # (head clause + every numbered mark's memo), but a global-only apply
        # (request_scopes has no mark_id) must only widen retry_allowed from
        # the APPLIED scope's own request field - never from an un-applied
        # mark's memo baked into original_request. Plan: head "Put the legend
        # at the bottom" + mark memo "hide the points" (not applied here).
        base = SimpleNamespace(
            png_path="before.png", mapping={"x": "Time", "y": "Expression"},
            options={"legend_position": "right"}, style_preset="nature",
        )
        applied_version = SimpleNamespace(
            id="v-after", version_number=2, png_path="after.png",
            mapping={"x": "Time", "y": "Expression"},
            options={"legend_position": "bottom"}, style_preset="nature",
            render_log="", r_code="", figure=SimpleNamespace(plot_type="scatter"),
        )
        retry_version = SimpleNamespace(
            id="v-retry", png_path="after2.png",
            mapping={"x": "Time", "y": "Expression"},
            options={"legend_position": "bottom", "show_points": False},
            style_preset="nature", render_log="", r_code="",
            figure=SimpleNamespace(plot_type="scatter"),
        )
        fig = SimpleNamespace(
            id="fig-1", plot_type="scatter", dataset_id="ds-1", project_id=None, style_preset="nature",
        )
        db = Mock()
        db.query.return_value.filter.return_value.first.return_value = retry_version
        full_plan_text = "Put the legend at the bottom\nMark A: hide the points"

        with (
            patch.object(figure_service.storage, "exists", return_value=True),
            patch.object(figure_service.storage, "materialize", side_effect=lambda value, suffix: value),
            patch("builtins.open", mock_open(read_data=b"fake-png-bytes")),
            patch.object(figure_service.ds_service, "get_dataset", return_value=SimpleNamespace(column_profile=[])),
            patch.object(
                figure_service.ai_client, "verify_edit",
                side_effect=[
                    {"satisfied": False, "feedback": "Legend moved but points are still shown."},
                    {"satisfied": True, "feedback": "Now matches the request."},
                ],
            ),
            patch.object(
                figure_service.ai_client, "improve_figure",
                # The model proposes the un-applied mark's edit (points),
                # which must NOT be authorized for this global-only apply.
                return_value=([{
                    "priority": "high",
                    "param_patch": {"options": {"show_points": False}},
                }], []),
            ) as improve,
            patch.object(figure_service, "rerender", return_value={"id": "v-retry"}) as rerender_mock,
        ):
            outcome = figure_service._run_verification(
                db, fig, "owner-1", base, applied_version,
                {"options": {"legend_position": "bottom"}},
                full_plan_text,
                allow_retry=True,
                allowed_patch_keys=["options.legend_position", "options.legend_direction"],
                request_scopes=[{
                    "scope_id": "request", "mark_id": None,
                    "request": "Put the legend at the bottom",
                    "original_request": full_plan_text,
                }],
            )

        improve.assert_called_once()
        # options.show_points was never authorized for this apply, so
        # _best_sanitized_patch/_filter_patch_to_request_scope must reject it
        # entirely - no retry rerender happens, and the un-applied mark's edit
        # never lands in a version or in the reported allowed_patch_keys.
        rerender_mock.assert_not_called()
        self.assertNotIn("options.show_points", outcome["verification"]["allowed_patch_keys"])

    def test_retry_widening_uses_applied_scope_text_for_a_legitimately_authorized_path(self):
        # Same shape as above, but the APPLIED scope's own text (not an
        # un-applied mark's memo) authorizes the retry fix - this must still
        # work exactly as before.
        base = SimpleNamespace(
            png_path="before.png", mapping={"x": "Time", "y": "Expression"},
            options={}, style_preset="nature",
        )
        applied_version = SimpleNamespace(
            id="v-after", version_number=2, png_path="after.png",
            mapping={"x": "Time", "y": "Expression"},
            options={"title": "New"}, style_preset="nature",
            render_log="", r_code="", figure=SimpleNamespace(plot_type="scatter"),
        )
        retry_version = SimpleNamespace(
            id="v-retry", png_path="after2.png",
            mapping={"x": "Time", "y": "Expression"},
            options={"title": "New", "log_y": True}, style_preset="nature",
            render_log="", r_code="", figure=SimpleNamespace(plot_type="scatter"),
        )
        fig = SimpleNamespace(
            id="fig-1", plot_type="scatter", dataset_id="ds-1", project_id=None, style_preset="nature",
        )
        db = Mock()
        db.query.return_value.filter.return_value.first.return_value = retry_version

        with (
            patch.object(figure_service.storage, "exists", return_value=True),
            patch.object(figure_service.storage, "materialize", side_effect=lambda value, suffix: value),
            patch("builtins.open", mock_open(read_data=b"fake-png-bytes")),
            patch.object(figure_service.ds_service, "get_dataset", return_value=SimpleNamespace(column_profile=[])),
            patch.object(
                figure_service.ai_client, "verify_edit",
                side_effect=[
                    {"satisfied": False, "feedback": "Title changed but the axis is not log scale."},
                    {"satisfied": True, "feedback": "Now matches the request."},
                ],
            ),
            patch.object(
                figure_service.ai_client, "improve_figure",
                return_value=([{
                    "priority": "high",
                    "param_patch": {"options": {"log_y": True}},
                }], []),
            ) as improve,
            patch.object(figure_service, "rerender", return_value={"id": "v-retry"}) as rerender_mock,
        ):
            outcome = figure_service._run_verification(
                db, fig, "owner-1", base, applied_version,
                {"options": {"title": "New"}},
                "Change the title to New and use a log scale on the y axis",
                allow_retry=True,
                allowed_patch_keys=["options.title"],
                request_scopes=[{
                    "scope_id": "request", "mark_id": None,
                    "request": "Change the title to New and use a log scale on the y axis",
                }],
            )

        improve.assert_called_once()
        rerender_mock.assert_called_once()
        self.assertTrue(outcome["verification"]["satisfied"])
        self.assertIn("options.log_y", outcome["verification"]["allowed_patch_keys"])


class VerificationExceptionPathTests(unittest.TestCase):
    def test_exception_before_any_verdict_sets_verification_error(self):
        base = SimpleNamespace(png_path="before.png", mapping={}, options={}, style_preset="nature")
        applied_version = SimpleNamespace(
            png_path="after.png", mapping={}, options={}, style_preset="nature", render_log="",
        )
        db = Mock()

        with (
            patch.object(figure_service.storage, "exists", return_value=True),
            patch.object(figure_service.storage, "materialize", side_effect=lambda value, suffix: value),
            patch.object(figure_service.ai_client, "verify_edit", side_effect=RuntimeError("boom")),
        ):
            outcome = figure_service._run_verification(
                db, SimpleNamespace(), "owner-1", base, applied_version,
                {"options": {"title": "New"}}, "Change the title to New",
                allow_retry=False,
            )

        self.assertIn("skipped", outcome["verification"])
        self.assertIn("error", outcome["verification"])
        self.assertIn("RuntimeError", outcome["verification"]["error"])
        self.assertIn("boom", outcome["verification"]["error"])


if __name__ == "__main__":
    unittest.main()


class DeterministicLogScaleParserTests(unittest.TestCase):
    def test_korean_y_axis_log(self):
        patch = figure_service._explicit_visual_patch_from_request("box", "control 그룹을 주황색으로 바꾸고, y축을 로그 스케일로 해줘")
        self.assertTrue(patch["options"].get("log_y"))
        self.assertNotIn("log_x", patch["options"])

    def test_english_x_axis_log(self):
        patch = figure_service._explicit_visual_patch_from_request("scatter", "use a log scale on the x axis")
        self.assertTrue(patch["options"].get("log_x"))

    def test_remove_log_is_not_parsed(self):
        patch = figure_service._explicit_visual_patch_from_request("scatter", "remove the log scale from the y axis")
        self.assertNotIn("log_y", patch.get("options", {}))

    def test_no_axis_named_no_log(self):
        patch = figure_service._explicit_visual_patch_from_request("scatter", "log transform the data")
        self.assertNotIn("log_x", patch.get("options", {}))
        self.assertNotIn("log_y", patch.get("options", {}))

    # --- Regression: axis-LABEL rename requests that merely mention 'log'
    # (very common biology phrasing) must not be parsed as a log-scale
    # request, and must not authorize options.log_x/log_y either. ---

    def test_rename_y_label_containing_log_is_not_parsed_as_log_scale(self):
        patch = figure_service._explicit_visual_patch_from_request(
            "bar", "Rename the y axis label to 'log fold change'",
        )
        self.assertNotIn("log_y", patch.get("options", {}))

    def test_rename_y_title_containing_log_parenthetical_is_not_parsed_as_log_scale(self):
        patch = figure_service._explicit_visual_patch_from_request(
            "scatter", "Rename the y axis title to Expression (log-transformed)",
        )
        self.assertNotIn("log_y", patch.get("options", {}))

    def test_set_y_label_containing_log_scale_text_is_not_parsed_as_log_scale(self):
        patch = figure_service._explicit_visual_patch_from_request(
            "line", "Set the y axis label to 'Counts (log scale)'",
        )
        self.assertNotIn("log_y", patch.get("options", {}))

    def test_korean_y_label_rename_containing_log_is_not_parsed_as_log_scale(self):
        patch = figure_service._explicit_visual_patch_from_request(
            "bar", "y축 라벨을 로그 발현량으로 바꿔줘",
        )
        self.assertNotIn("log_y", patch.get("options", {}))

    def test_explicit_log_scale_verb_still_authorized_after_gate(self):
        patch = figure_service._explicit_visual_patch_from_request(
            "scatter", "use a log scale on the y axis",
        )
        self.assertTrue(patch["options"].get("log_y"))

    def test_rename_authorization_excludes_log_y_but_keeps_y_label(self):
        from app.r_engine.templates import PLOT_TYPES
        pdef = next(p for p in PLOT_TYPES if p["type"] == "bar")
        allowed = figure_service._request_allowed_patch_paths(
            "bar", "Rename the y axis label to 'log fold change'", pdef,
        )
        self.assertIn("options.y_label", allowed)
        self.assertNotIn("options.log_y", allowed)

    def test_korean_rename_authorization_excludes_log_y_but_keeps_y_label(self):
        from app.r_engine.templates import PLOT_TYPES
        pdef = next(p for p in PLOT_TYPES if p["type"] == "bar")
        allowed = figure_service._request_allowed_patch_paths(
            "bar", "y축 라벨을 로그 발현량으로 바꿔줘", pdef,
        )
        self.assertIn("options.y_label", allowed)
        self.assertNotIn("options.log_y", allowed)

    def test_explicit_log_scale_request_still_authorizes_log_y(self):
        from app.r_engine.templates import PLOT_TYPES
        pdef = next(p for p in PLOT_TYPES if p["type"] == "scatter")
        allowed = figure_service._request_allowed_patch_paths(
            "scatter", "use a log scale on the y axis", pdef,
        )
        self.assertIn("options.log_y", allowed)
