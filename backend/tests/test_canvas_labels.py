"""M-C1 §4 — panel label formula: _format_label / _label_layout_mm / _label_style.

Pure-function tests: no DB. Expected numbers are computed independently from
the shared formula (PT_TO_MM = 25.4/72, LABEL_BASELINE_RATIO = 0.8) rather
than by re-deriving them through the function under test.
"""
import unittest

from app.common.exceptions import BadRequestError
from app.canvases.service import (
    DEFAULT_LABEL_STYLE,
    _format_label,
    _label_layout_mm,
    _label_style,
    _sanitize_canvas_style,
    _style_response,
)
from app.canvases.models import Canvas

# Independent restatement of the §4 constants (NOT imported from service) so
# the test actually checks the formula, not just self-consistency.
_PT_TO_MM = 25.4 / 72.0
_BASELINE_RATIO = 0.8


class FormatLabelTests(unittest.TestCase):
    def test_format_a_uppercase_passthrough(self):
        self.assertEqual(_format_label("B", "A"), "B")

    def test_format_a_lowercase(self):
        self.assertEqual(_format_label("B", "a"), "b")

    def test_format_parens(self):
        self.assertEqual(_format_label("B", "(A)"), "(B)")

    def test_format_dot(self):
        self.assertEqual(_format_label("B", "A."), "B.")

    def test_strips_whitespace(self):
        self.assertEqual(_format_label("  C  ", "A"), "C")

    def test_unknown_format_falls_back_to_canonical(self):
        self.assertEqual(_format_label("D", "bogus"), "D")


class LabelLayoutMmTests(unittest.TestCase):
    """pt=12, offset_mm=1, panel at (10, 20) — numbers hand-computed from §4."""

    def setUp(self):
        self.x_mm, self.y_mm = 10.0, 20.0
        self.style = {"format": "A", "bold": True, "pt": 12.0, "placement": "inside", "offset_mm": 1.0}
        self.font_mm = 12.0 * _PT_TO_MM  # 4.233333333333333

    def test_inside_placement(self):
        style = {**self.style, "placement": "inside"}
        layout = _label_layout_mm(self.x_mm, self.y_mm, "B", style)
        self.assertAlmostEqual(layout["left"], self.x_mm + 1.0, places=9)
        self.assertAlmostEqual(layout["top"], self.y_mm + 1.0, places=9)
        expected_baseline = (self.y_mm + 1.0) + _BASELINE_RATIO * self.font_mm
        self.assertAlmostEqual(layout["baseline_y"], expected_baseline, places=9)
        self.assertAlmostEqual(layout["font_mm"], self.font_mm, places=9)
        self.assertEqual(layout["text"], "B")
        self.assertTrue(layout["bold"])

    def test_outside_placement(self):
        style = {**self.style, "placement": "outside"}
        layout = _label_layout_mm(self.x_mm, self.y_mm, "B", style)
        expected_top = self.y_mm - 1.0 - self.font_mm
        self.assertAlmostEqual(layout["left"], self.x_mm, places=9)
        self.assertAlmostEqual(layout["top"], expected_top, places=9)
        expected_baseline = expected_top + _BASELINE_RATIO * self.font_mm
        self.assertAlmostEqual(layout["baseline_y"], expected_baseline, places=9)
        # Outside placement sits ABOVE the panel's top-left corner (smaller y).
        self.assertLess(layout["top"], self.y_mm)

    def test_box_size_single_letter(self):
        layout = _label_layout_mm(self.x_mm, self.y_mm, "B", self.style)
        expected_box_w = 0.62 * self.font_mm * len("B") + 0.4 * self.font_mm
        self.assertAlmostEqual(layout["box_w"], expected_box_w, places=9)
        self.assertAlmostEqual(layout["box_h"], self.font_mm, places=9)

    def test_bold_flag_from_style(self):
        style = {**self.style, "bold": False}
        layout = _label_layout_mm(self.x_mm, self.y_mm, "B", style)
        self.assertFalse(layout["bold"])

    def test_box_width_grows_with_text_length(self):
        # The formatted TEXT length drives box_w -- longer display formats
        # ((A) / A.) must produce a wider box than the bare "A" form, which is
        # exactly the growth the PPTX textbox now tracks (M-C1 §8, replacing
        # the old fixed 20mm box).
        w_bare = _label_layout_mm(self.x_mm, self.y_mm, "A", {**self.style, "format": "A"})["box_w"]
        w_dot = _label_layout_mm(self.x_mm, self.y_mm, "A", {**self.style, "format": "A."})["box_w"]
        w_paren = _label_layout_mm(self.x_mm, self.y_mm, "A", {**self.style, "format": "(A)"})["box_w"]
        self.assertLess(w_bare, w_dot)
        self.assertLess(w_dot, w_paren)


class LabelStyleDefaultsTests(unittest.TestCase):
    def test_absent_style_returns_defaults(self):
        canvas = Canvas(style=None)
        self.assertEqual(_label_style(canvas), DEFAULT_LABEL_STYLE)

    def test_empty_style_returns_defaults(self):
        canvas = Canvas(style={})
        self.assertEqual(_label_style(canvas), DEFAULT_LABEL_STYLE)

    def test_partial_label_fills_missing_defaults(self):
        canvas = Canvas(style={"label": {"pt": 10.0}})
        style = _label_style(canvas)
        self.assertEqual(style["pt"], 10.0)
        self.assertEqual(style["format"], DEFAULT_LABEL_STYLE["format"])
        self.assertEqual(style["placement"], DEFAULT_LABEL_STYLE["placement"])
        self.assertEqual(style["offset_mm"], DEFAULT_LABEL_STYLE["offset_mm"])
        self.assertEqual(style["bold"], DEFAULT_LABEL_STYLE["bold"])

    def test_unknown_keys_in_stored_label_are_ignored(self):
        canvas = Canvas(style={"label": {"pt": 9.0, "rogue_key": "x"}})
        style = _label_style(canvas)
        self.assertNotIn("rogue_key", style)
        self.assertEqual(style["pt"], 9.0)


class SanitizeCanvasStyleTests(unittest.TestCase):
    def test_empty_input_returns_empty(self):
        self.assertEqual(_sanitize_canvas_style(None), {})
        self.assertEqual(_sanitize_canvas_style({}), {})

    def test_unknown_top_level_and_nested_keys_dropped(self):
        out = _sanitize_canvas_style({"rogue": 1, "label": {"pt": 10.0, "rogue2": "x"}})
        self.assertNotIn("rogue", out)
        self.assertNotIn("rogue2", out["label"])
        self.assertEqual(out["label"], {"pt": 10.0})

    def test_only_supplied_label_keys_are_returned(self):
        # PATCH-style partial: absent keys are NOT filled with defaults here
        # (that happens at read time via _label_style).
        out = _sanitize_canvas_style({"label": {"format": "a"}})
        self.assertEqual(out["label"], {"format": "a"})

    def test_label_format_out_of_choices_rejected(self):
        with self.assertRaises(BadRequestError) as ctx:
            _sanitize_canvas_style({"label": {"format": "roman"}})
        self.assertEqual(ctx.exception.error_code, "CANVAS_STYLE_INVALID")

    def test_label_pt_out_of_range_rejected(self):
        with self.assertRaises(BadRequestError) as ctx:
            _sanitize_canvas_style({"label": {"pt": 30.0}})
        self.assertEqual(ctx.exception.error_code, "CANVAS_STYLE_INVALID")

    def test_label_pt_below_range_rejected(self):
        with self.assertRaises(BadRequestError):
            _sanitize_canvas_style({"label": {"pt": 3.0}})

    def test_label_offset_out_of_range_rejected(self):
        with self.assertRaises(BadRequestError):
            _sanitize_canvas_style({"label": {"offset_mm": 11.0}})

    def test_label_bold_must_be_bool(self):
        with self.assertRaises(BadRequestError):
            _sanitize_canvas_style({"label": {"bold": "yes"}})

    def test_label_placement_invalid_rejected(self):
        with self.assertRaises(BadRequestError):
            _sanitize_canvas_style({"label": {"placement": "center"}})

    def test_typography_font_family_must_be_known(self):
        with self.assertRaises(BadRequestError) as ctx:
            _sanitize_canvas_style({"typography": {"font_family": "comic_sans"}})
        self.assertEqual(ctx.exception.error_code, "CANVAS_STYLE_INVALID")

    def test_typography_base_pt_out_of_range_rejected(self):
        with self.assertRaises(BadRequestError):
            _sanitize_canvas_style({"typography": {"base_pt": 20.0}})

    def test_typography_line_width_out_of_range_rejected(self):
        with self.assertRaises(BadRequestError):
            _sanitize_canvas_style({"typography": {"axis_line_width_pt": 5.0}})
        with self.assertRaises(BadRequestError):
            _sanitize_canvas_style({"typography": {"data_line_width_pt": 0.0}})

    def test_valid_full_style_round_trips(self):
        raw = {
            "label": {"format": "(A)", "bold": False, "pt": 9.0, "placement": "outside", "offset_mm": 2.0},
            "typography": {"font_family": "dejavu_sans", "base_pt": 8.0,
                          "axis_line_width_pt": 0.5, "data_line_width_pt": 0.8},
        }
        out = _sanitize_canvas_style(raw)
        self.assertEqual(out, raw)

    def test_non_object_raises(self):
        with self.assertRaises(BadRequestError):
            _sanitize_canvas_style("not-an-object")

    def test_label_non_object_raises(self):
        with self.assertRaises(BadRequestError):
            _sanitize_canvas_style({"label": "nope"})

    def test_typography_non_object_raises(self):
        with self.assertRaises(BadRequestError):
            _sanitize_canvas_style({"typography": "nope"})

    def test_label_format_unhashable_value_raises_400_not_typeerror(self):
        # [8] a list/dict value used to hit bare `in` against a set and raise
        # an uncaught TypeError (-> 500) instead of the contract's 400.
        with self.assertRaises(BadRequestError) as ctx:
            _sanitize_canvas_style({"label": {"format": ["A"]}})
        self.assertEqual(ctx.exception.error_code, "CANVAS_STYLE_INVALID")
        with self.assertRaises(BadRequestError) as ctx2:
            _sanitize_canvas_style({"label": {"format": {"x": 1}}})
        self.assertEqual(ctx2.exception.error_code, "CANVAS_STYLE_INVALID")

    def test_label_placement_unhashable_value_raises_400_not_typeerror(self):
        with self.assertRaises(BadRequestError) as ctx:
            _sanitize_canvas_style({"label": {"placement": ["inside"]}})
        self.assertEqual(ctx.exception.error_code, "CANVAS_STYLE_INVALID")
        with self.assertRaises(BadRequestError) as ctx2:
            _sanitize_canvas_style({"label": {"placement": {"x": 1}}})
        self.assertEqual(ctx2.exception.error_code, "CANVAS_STYLE_INVALID")

    def test_typography_font_family_unhashable_value_raises_400(self):
        with self.assertRaises(BadRequestError) as ctx:
            _sanitize_canvas_style({"typography": {"font_family": ["Arial"]}})
        self.assertEqual(ctx.exception.error_code, "CANVAS_STYLE_INVALID")


class StyleResponseTests(unittest.TestCase):
    def test_label_always_carries_full_defaults(self):
        canvas = Canvas(style={"label": {"pt": 9.0}})
        resp = _style_response(canvas)
        self.assertEqual(resp["label"]["pt"], 9.0)
        self.assertEqual(resp["label"]["format"], DEFAULT_LABEL_STYLE["format"])
        self.assertEqual(resp["typography"], {})

    def test_typography_left_as_stored(self):
        canvas = Canvas(style={"typography": {"font_family": "dejavu_sans"}})
        resp = _style_response(canvas)
        self.assertEqual(resp["typography"], {"font_family": "dejavu_sans"})

    def test_none_style_yields_defaults_and_empty_typography(self):
        canvas = Canvas(style=None)
        resp = _style_response(canvas)
        self.assertEqual(resp["label"], DEFAULT_LABEL_STYLE)
        self.assertEqual(resp["typography"], {})


if __name__ == "__main__":
    unittest.main()
