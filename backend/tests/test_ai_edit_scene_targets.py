"""Regressions for the 2026-08 AI-edit feedback round:

A) a box drawn around crowded x tick labels must resolve to the tick-label
   strip (options.x_text_angle), never to the invisible x-axis-label band,
   and the rotation wording alone must authorize x_text_angle;
B) a continuous colorbar must be a first-class semantic target whose
   move/direction requests authorize legend_position / legend_direction;
plus the renderer-order fix: template tick rotation must survive the
complete labplot_theme() (it used to be silently reset).
"""
import json
import os
import tempfile
import unittest

import pandas as pd

from app.figures import service
from app.figures.service import (
    _plot_def,
    _request_allowed_patch_paths,
    _scene_role_paths_for_request,
    _scope_generic_unsupported_reason,
    _server_resolve_mark_target,
    _server_validate_target_override,
    sanitize_options,
)
from app.ai.options_schema import build_options_patch_schema
from app.r_engine import renderer


IMG_W, IMG_H = 2100.0, 1500.0


def _box(x0, y0, x1, y1):
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1}


def _heatmap_like_layout() -> dict:
    """Synthetic sidecar mirroring a rendered heatmap with a bottom-adjacent
    empty x-label band, a real tick strip, and a right-side colorbar."""
    return {
        "img_px": {"w": IMG_W, "h": IMG_H},
        "panel_px": _box(250, 120, 1850, 1320),
        "xlab_px": _box(300, 1450, 1800, 1450),      # zero height: labs(x = NULL)
        "ylab_px": _box(40, 300, 40, 1100),          # zero width
        "x_axis_px": _box(250, 1330, 1850, 1420),
        "y_axis_px": _box(150, 120, 240, 1320),
        "scene_elements": [
            {"id": "element:title", "kind": "text", "role": "title",
             "bbox_px": _box(250, 40, 1850, 40), "editable": True,
             "setting_path": "options.title", "placeholder": True},
            {"id": "element:axis:x:label", "kind": "text", "role": "x_label",
             "bbox_px": _box(300, 1450, 1800, 1450), "editable": True,
             "setting_path": "options.x_label", "placeholder": True},
            {"id": "element:axis:y:label", "kind": "text", "role": "y_label",
             "bbox_px": _box(40, 300, 40, 1100), "editable": True,
             "setting_path": "options.y_label", "placeholder": True},
            {"id": "element:axis:x:tick_labels", "kind": "text", "role": "x_tick_labels",
             "bbox_px": _box(250, 1330, 1850, 1420), "editable": True,
             "setting_path": "options.x_text_angle", "placeholder": False},
            {"id": "element:axis:y:tick_labels", "kind": "text", "role": "y_tick_labels",
             "bbox_px": _box(150, 120, 240, 1320), "editable": True,
             "setting_path": "options.y_tick_format", "placeholder": False},
            {"id": "element:legend:colorbar", "kind": "guide", "role": "colorbar",
             "bbox_px": _box(1900, 400, 2050, 1100), "editable": True,
             "setting_path": "options.legend_position", "placeholder": False},
        ],
    }


def _region_mark(x0, y0, x1, y1, mark_id="1"):
    return {
        "id": mark_id, "type": "region",
        "bbox_normalized": {
            "x": x0 / IMG_W, "y": y0 / IMG_H,
            "width": (x1 - x0) / IMG_W, "height": (y1 - y0) / IMG_H,
        },
    }


class RequestAuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.pdef = _plot_def("heatmap")

    def test_rotation_wording_without_axis_mention_authorizes_x_text_angle(self):
        for request in (
            "겹치는 글자를 45도로 회전",
            "rotate the overlapping labels 45 degrees",
        ):
            paths = _request_allowed_patch_paths("heatmap", request, self.pdef)
            self.assertIn("options.x_text_angle", paths, request)

    def test_colorbar_move_wording_authorizes_legend_layout(self):
        for request in (
            "colorbar를 heatmap 오른쪽으로 이동",
            "move the color bar to the right of the heatmap",
            "컬러바를 오른쪽으로 옮겨줘",
        ):
            paths = _request_allowed_patch_paths("heatmap", request, self.pdef)
            self.assertIn("options.legend_position", paths, request)
            self.assertIn("options.legend_direction", paths, request)

    def test_color_change_wording_never_authorizes_legend_layout(self):
        for request in (
            "컬러 바꿔줘",
            "색상 바꿔줘",
            "빨간색 막대를 파란색으로 바꿔",
        ):
            paths = _request_allowed_patch_paths("heatmap", request, self.pdef)
            self.assertNotIn("options.legend_position", paths, request)
            self.assertNotIn("options.legend_direction", paths, request)
            self.assertNotIn("options.hide_legend", paths, request)

    def test_scene_role_rules_gate_on_operation_wording(self):
        self.assertEqual(
            _scene_role_paths_for_request("x_tick_labels", "겹치는 글자를 45도로 회전"),
            {"x_text_angle"},
        )
        self.assertEqual(
            _scene_role_paths_for_request("colorbar", "colorbar를 heatmap 오른쪽으로 이동"),
            {"legend_position", "legend_direction"},
        )
        self.assertEqual(_scene_role_paths_for_request("colorbar", "make it prettier"), set())
        self.assertEqual(_scene_role_paths_for_request("x_tick_labels", "make it blue"), set())


class MarkResolutionTests(unittest.TestCase):
    def test_region_on_tick_labels_resolves_tick_strip_not_axis_label(self):
        layout = _heatmap_like_layout()
        mark = _region_mark(500, 1320, 1200, 1430)
        target = _server_resolve_mark_target(mark, layout)
        self.assertIsNotNone(target)
        self.assertEqual(target.get("role"), "x_tick_labels")
        self.assertEqual(target.get("setting_path"), "options.x_text_angle")

    def test_placeholder_label_band_never_wins_inference(self):
        layout = _heatmap_like_layout()
        # Box hugging the empty x-label band below the ticks: with the old
        # logic this resolved to x_label via tolerance-only matching.
        mark = _region_mark(500, 1340, 1200, 1445)
        target = _server_resolve_mark_target(mark, layout)
        self.assertEqual(target.get("role"), "x_tick_labels")

    def test_arrow_head_on_colorbar_resolves_colorbar(self):
        layout = _heatmap_like_layout()
        mark = {"id": "2", "type": "arrow",
                "point_normalized": {"x": 1975 / IMG_W, "y": 700 / IMG_H}}
        target = _server_resolve_mark_target(mark, layout)
        self.assertEqual(target.get("role"), "colorbar")
        self.assertEqual(target.get("setting_path"), "options.legend_position")
        # Display-name contract for the correction dropdown / plan rows: a
        # generic "Scene element" label made candidates indistinguishable.
        self.assertEqual(target.get("label"), "Continuous colorbar")

    def test_tick_label_candidates_carry_specific_display_labels(self):
        layout = _heatmap_like_layout()
        mark = _region_mark(500, 1320, 1200, 1430)
        target = _server_resolve_mark_target(mark, layout)
        self.assertEqual(target.get("label"), "X-axis tick labels")

    def test_legacy_layout_without_scene_elements_still_offers_tick_strip(self):
        layout = _heatmap_like_layout()
        layout.pop("scene_elements")
        mark = _region_mark(500, 1320, 1200, 1430)
        target = _server_resolve_mark_target(mark, layout)
        self.assertEqual(target.get("role"), "x_tick_labels")

    def test_validate_override_accepts_tick_labels_with_rotation_memo(self):
        layout = _heatmap_like_layout()
        mark = _region_mark(500, 1320, 1200, 1430)
        requested = {"role": "x_tick_labels", "setting_path": "options.x_text_angle",
                     "label": "X-axis tick labels", "editable": True}
        accepted = _server_validate_target_override(mark, layout, requested, "45도로 회전해줘")
        self.assertIsNotNone(accepted)
        self.assertEqual(accepted.get("role"), "x_tick_labels")
        rejected = _server_validate_target_override(mark, layout, requested, "make it blue")
        self.assertIsNone(rejected)

    def test_validate_override_accepts_colorbar_with_move_memo(self):
        layout = _heatmap_like_layout()
        mark = _region_mark(1890, 380, 2060, 1120)
        requested = {"role": "colorbar", "setting_path": "options.legend_position",
                     "label": "Colorbar", "editable": True}
        accepted = _server_validate_target_override(mark, layout, requested, "오른쪽으로 이동")
        self.assertIsNotNone(accepted)
        self.assertEqual(accepted.get("role"), "colorbar")

    def test_generic_unsupported_reason_names_recognized_target(self):
        scope = {"server_resolved_target": {
            "role": "colorbar", "label": "Colorbar", "editable": True,
            "setting_path": "options.legend_position",
        }}
        reason = _scope_generic_unsupported_reason(scope)
        self.assertIn("Colorbar", reason)
        self.assertIn("moving it", reason)
        self.assertEqual(
            _scope_generic_unsupported_reason({}),
            "No request-authorized parameter change could be derived for this edit scope.",
        )


class DeterministicParserTests(unittest.TestCase):
    """A provider outage must never block a fully explicit rotation/legend
    request: the deterministic parser feeds the same authorization filter."""

    def test_explicit_rotation_angle_parses_without_ai(self):
        patch = service._explicit_visual_patch_from_request("heatmap", "겹치는 글자를 60도로 회전")
        self.assertEqual(patch["options"]["x_text_angle"], 60)
        patch = service._explicit_visual_patch_from_request("heatmap", "rotate the labels 45 degrees")
        self.assertEqual(patch["options"]["x_text_angle"], 45)

    def test_guide_relocation_parses_without_ai(self):
        patch = service._explicit_visual_patch_from_request("heatmap", "colorbar를 heatmap 오른쪽으로 이동")
        self.assertEqual(patch["options"]["legend_position"], "right")
        self.assertEqual(patch["options"]["legend_direction"], "vertical")
        patch = service._explicit_visual_patch_from_request("heatmap", "move the legend to the bottom")
        self.assertEqual(patch["options"]["legend_position"], "bottom")
        self.assertEqual(patch["options"]["legend_direction"], "horizontal")

    def test_parser_ignores_non_rotation_numbers_and_color_requests(self):
        options = service._explicit_visual_patch_from_request("heatmap", "컬러 바꿔줘").get("options", {})
        self.assertNotIn("legend_position", options)
        options = service._explicit_visual_patch_from_request("heatmap", "y축 구간 1~10").get("options", {})
        self.assertNotIn("x_text_angle", options)


class AppliedDiffDefaultTests(unittest.TestCase):
    def test_fill_default_before_values_flags_effective_defaults(self):
        changes = [
            {"key": "options.x_text_angle", "from": None, "to": 60},
            {"key": "options.legend_direction", "from": None, "to": "vertical"},
            {"key": "options.legend_position", "from": "bottom", "to": "right"},
            {"key": "mapping.x", "from": None, "to": "dose"},
        ]
        filled = service._fill_default_before_values(
            changes, "heatmap", {"legend_position": "bottom"})
        self.assertEqual(filled[0]["from"], 45)
        self.assertTrue(filled[0]["from_is_default"])
        self.assertEqual(filled[1]["from"], "horizontal")
        self.assertTrue(filled[1]["from_is_default"])
        self.assertEqual(filled[2]["from"], "bottom")
        self.assertNotIn("from_is_default", filled[2])
        self.assertIsNone(filled[3]["from"], "mapping keys have no renderer default")

    def test_hidden_legend_reports_none_position_default(self):
        changes = [{"key": "options.legend_position", "from": None, "to": "right"}]
        filled = service._fill_default_before_values(changes, "scatter", {"hide_legend": True})
        self.assertEqual(filled[0]["from"], "none")
        self.assertTrue(filled[0]["from_is_default"])


class AutoQualityGuardTests(unittest.TestCase):
    """2026-08-19 request: heatmap-family color keys live on the right. The
    UNREQUESTED auto-quality pass must never relocate a continuous colorbar;
    explicit user edit requests go through a different path and still can."""

    def test_auto_quality_never_moves_a_continuous_colorbar(self):
        patch = service._combined_quality_patch(
            [{"param_patch": {"options": {
                "legend_position": "bottom", "legend_direction": "horizontal",
                "x_text_angle": 60,
            }}}],
            _plot_def("heatmap"), {}, {}, "nature", set())
        options = patch.get("options", {})
        self.assertNotIn("legend_position", options)
        self.assertNotIn("legend_direction", options)
        self.assertEqual(options.get("x_text_angle"), 60,
                         "unrelated auto-quality keys must survive the guard")

    def test_auto_quality_may_still_move_a_discrete_legend(self):
        patch = service._combined_quality_patch(
            [{"param_patch": {"options": {"legend_position": "bottom"}}}],
            _plot_def("scatter"), {}, {}, "nature", set())
        self.assertEqual(patch.get("options", {}).get("legend_position"), "bottom")


class ResolvedTargetSchemaTests(unittest.TestCase):
    """A mark resolving to a bar/point/cell carries an element_overrides
    setting path with ':', '=', '&' and %-escapes. The request schema used to
    reject it, turning the whole /improve call into a 422 - which dropped the
    AI-busy state and let leftover drafts render stray 'Live preview'
    versions (2026-08-19 P0)."""

    def test_element_override_setting_path_is_accepted(self):
        from app.figures.schemas import ImprovementResolvedTarget
        target = ImprovementResolvedTarget(
            type="cell",
            label="Cell",
            role="cell",
            editable=True,
            element_id="mark:heatmap:row=Long%20sample%20name%205%20xx&col=GeneB",
            setting_path="options.element_overrides.mark:heatmap:row=Long%20sample%20name%205%20xx&col=GeneB",
        )
        self.assertEqual(target.type, "cell")
        for path in ("options.x_text_angle", "options", "mapping.x", "style_preset"):
            ImprovementResolvedTarget(type="x_tick_labels", setting_path=path)

    def test_garbage_setting_paths_are_still_rejected(self):
        import pydantic
        from app.figures.schemas import ImprovementResolvedTarget
        for bad in ("options.element_overrides.has space", "styles.injection", "options.a.b"):
            with self.assertRaises(pydantic.ValidationError, msg=bad):
                ImprovementResolvedTarget(type="cell", setting_path=bad)


class OptionModelTests(unittest.TestCase):
    def test_legend_direction_is_a_sanctioned_choice_option(self):
        schema = build_options_patch_schema()
        self.assertEqual(
            sorted(schema["properties"]["legend_direction"]["enum"]),
            ["horizontal", "vertical"],
        )
        clean = sanitize_options("heatmap", {
            "legend_direction": "vertical",
            "legend_position": "top",
            "x_text_angle": 45,
        })
        self.assertEqual(clean.get("legend_direction"), "vertical")
        self.assertEqual(clean.get("legend_position"), "top")
        self.assertEqual(clean.get("x_text_angle"), 45)
        self.assertIsNone(
            sanitize_options("heatmap", {"legend_direction": "diagonal"}).get("legend_direction"))


def _render(plot_type, mapping, options, data):
    out_dir = tempfile.mkdtemp(prefix=f"labplot_{plot_type}_scene_target_")
    result = renderer.render(plot_type, mapping, options, "nature", data, out_dir)
    layout = None
    if result.success and "layout" in result.outputs:
        with open(result.outputs["layout"], encoding="utf-8") as handle:
            layout = json.load(handle)
    svg = ""
    if result.success and "svg" in result.outputs:
        with open(result.outputs["svg"], encoding="utf-8") as handle:
            svg = handle.read()
    return result, layout, svg


def _scene_by_role(layout, role):
    return [e for e in (layout or {}).get("scene_elements", []) if e.get("role") == role]


@unittest.skipUnless(
    os.path.exists("/app/.pixi/envs/r-viz/bin/Rscript") or os.environ.get("LABPLOT_RUN_R_TESTS"),
    "R renderer not available on this host",
)
class RendererSceneTargetTests(unittest.TestCase):
    HEATMAP_DF = pd.DataFrame({
        "sample_name": ["Response group", "Secondary cohort", "Baseline control", "Long label D"],
        "GeneA": [1.2, 2.4, 0.4, 1.9],
        "GeneB": [0.3, 1.1, 2.2, 0.8],
        "GeneC": [2.0, 0.2, 1.4, 1.1],
    })
    HEATMAP_MAPPING = {"columns": ["GeneA", "GeneB", "GeneC"], "row_label": "sample_name"}

    def test_heatmap_tick_rotation_survives_theme_and_scene_targets_exist(self):
        result, layout, svg = _render("heatmap", self.HEATMAP_MAPPING, {}, self.HEATMAP_DF)
        self.assertTrue(result.success, result.log)
        # Render-order fix: the 45deg default must be emitted AFTER the
        # complete labplot_theme() so it is actually rendered.
        theme_at = result.r_code.index("labplot_theme()")
        angle_at = result.r_code.index("axis.text.x = element_text(angle = 45")
        self.assertLess(theme_at, angle_at)
        self.assertIn("rotate(-45", svg, "x tick labels are not rotated in the rendered SVG")

        ticks = _scene_by_role(layout, "x_tick_labels")
        self.assertEqual(len(ticks), 1)
        self.assertTrue(ticks[0]["editable"])
        self.assertEqual(ticks[0]["setting_path"], "options.x_text_angle")

        bars = _scene_by_role(layout, "colorbar")
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0]["setting_path"], "options.legend_position")

        for element in _scene_by_role(layout, "x_label"):
            self.assertTrue(element.get("placeholder"),
                            "unset x label must be flagged as a placeholder band")

    def test_rotated_tick_labels_hug_the_axis(self):
        """2026-08-19 feedback: vjust=0.5 centred rotated labels inside the
        tall axis-text band, opening an ~84px (20pt) gap at 300dpi. With the
        end/top anchoring plus a 1.5pt margin the first glyph must start
        within ~30px of the axis line."""
        from PIL import Image

        result, layout, _svg = _render("heatmap", self.HEATMAP_MAPPING, {}, self.HEATMAP_DF)
        self.assertTrue(result.success, result.log)
        image = Image.open(result.outputs["png"]).convert("L")
        panel = layout["panel_px"]
        pixels = image.load()
        x_lo = max(0, int(panel["x0"]) - 120)
        x_hi = min(image.width, int(panel["x1"]) + 10)

        def row_has_ink(y: int) -> bool:
            return any(pixels[x, y] < 120 for x in range(x_lo, x_hi, 2))

        y_axis = int(panel["y1"])
        ink_rows = [y for y in range(y_axis + 1, min(image.height, y_axis + 260)) if row_has_ink(y)]
        self.assertTrue(ink_rows, "no tick/label ink found below the panel")
        # Skip the tick-mark run attached to the axis; the first ink row after
        # the following blank gap is the top of the rotated tick labels.
        run_end = ink_rows[0]
        for y in ink_rows[1:]:
            if y == run_end + 1:
                run_end = y
            else:
                break
        text_rows = [y for y in ink_rows if y > run_end + 1]
        self.assertTrue(text_rows, "no tick-label glyphs found below the ticks")
        gap = text_rows[0] - y_axis
        self.assertLessEqual(
            gap, 30, f"axis-to-label gap {gap}px is too wide (was ~84px before the anchor fix)")
        self.assertGreaterEqual(gap, 4, f"axis-to-label gap {gap}px is implausibly tight")

    def test_explicit_zero_angle_overrides_template_default(self):
        result, _layout, svg = _render(
            "heatmap", self.HEATMAP_MAPPING, {"x_text_angle": 0}, self.HEATMAP_DF)
        self.assertTrue(result.success, result.log)
        self.assertIn("axis.text.x = element_text(angle = 0", result.r_code)
        self.assertNotIn("rotate(-45", svg)

    def test_colorbar_moves_between_bottom_and_right(self):
        result_bottom, layout_bottom, _ = _render(
            "heatmap", self.HEATMAP_MAPPING, {"legend_position": "bottom"}, self.HEATMAP_DF)
        self.assertTrue(result_bottom.success, result_bottom.log)
        self.assertIn('legend.position = "bottom"', result_bottom.r_code)
        bar_bottom = _scene_by_role(layout_bottom, "colorbar")[0]["bbox_px"]
        panel_bottom = layout_bottom["panel_px"]
        self.assertGreater(bar_bottom["y0"], panel_bottom["y1"],
                           "bottom colorbar should sit below the panel")

        result_right, layout_right, _ = _render(
            "heatmap", self.HEATMAP_MAPPING,
            {"legend_position": "right", "legend_direction": "vertical"}, self.HEATMAP_DF)
        self.assertTrue(result_right.success, result_right.log)
        self.assertIn('legend.position = "right"', result_right.r_code)
        self.assertIn('legend.direction = "vertical"', result_right.r_code)
        bar_right = _scene_by_role(layout_right, "colorbar")[0]["bbox_px"]
        panel_right = layout_right["panel_px"]
        self.assertGreater(bar_right["x0"], panel_right["x1"],
                           "right colorbar should sit to the right of the panel")

    def test_correlation_heatmap_keeps_rotation_and_grid_removal(self):
        df = pd.DataFrame({
            "Alpha metric": [1.0, 2.0, 3.0, 4.0, 5.0],
            "Beta metric": [2.0, 1.0, 4.0, 3.0, 5.0],
            "Gamma metric": [5.0, 4.0, 3.0, 2.0, 1.0],
        })
        result, layout, svg = _render(
            "correlation_heatmap", {"columns": list(df.columns)}, {}, df)
        self.assertTrue(result.success, result.log)
        theme_at = result.r_code.index("labplot_theme()")
        self.assertLess(theme_at, result.r_code.index("axis.text.x = element_text(angle = 45"))
        self.assertLess(theme_at, result.r_code.index("theme(panel.grid = element_blank())"))
        self.assertIn("rotate(-45", svg)
        self.assertEqual(len(_scene_by_role(layout, "colorbar")), 1)

    def test_ungrouped_kaplan_meier_hides_the_all_legend(self):
        df = pd.DataFrame({
            "time": [3, 5, 8, 11, 14, 20, 26, 30],
            "status": [1, 0, 1, 1, 0, 1, 0, 1],
        })
        result, layout, _ = _render(
            "kaplan_meier", {"time": "time", "status": "status"}, {}, df)
        self.assertTrue(result.success, result.log)
        self.assertIn('guides(colour = "none")', result.r_code)
        self.assertEqual(_scene_by_role(layout, "legend"), [])
        self.assertEqual(_scene_by_role(layout, "colorbar"), [])

    def test_discrete_legend_box_is_a_legend_scene_target(self):
        df = pd.DataFrame({
            "dose": [1, 2, 3, 1, 2, 3],
            "response": [2.0, 3.1, 4.2, 1.2, 2.2, 3.0],
            "arm": ["Treated", "Treated", "Treated", "Control", "Control", "Control"],
        })
        result, layout, _ = _render(
            "scatter", {"x": "dose", "y": "response", "color": "arm"}, {}, df)
        self.assertTrue(result.success, result.log)
        boxes = _scene_by_role(layout, "legend")
        self.assertEqual(len(boxes), 1)
        self.assertEqual(boxes[0]["setting_path"], "options.legend_position")
        self.assertEqual(_scene_by_role(layout, "colorbar"), [])


if __name__ == "__main__":
    unittest.main()
