"""M-C1 §9 bug fixes — _annotation_bbox_mm stroke/arrowhead padding and
_content_bbox_mm including panel labels (an outside label extends the crop
bbox upward).

Pure-function tests: Canvas/CanvasPanel are only ever constructed in memory
(never added to a session), so no DB is touched.
"""
import unittest

from app.canvases.models import Canvas, CanvasPanel
from app.canvases.service import _PT_TO_MM, _annotation_bbox_mm, _content_bbox_mm


class AnnotationBboxRectEllipseTests(unittest.TestCase):
    def test_absent_stroke_pt_defaults_to_1pt(self):
        # `ann.get("stroke_pt") or 1.0` (same idiom as _annotation_svg) means
        # an absent OR falsy (0.0) stroke_pt both fall back to the 1pt default
        # -- there is no "no stroke" annotation shape, so the bbox always
        # carries at least the 1pt padding.
        ann = {"type": "rect", "x_mm": 10.0, "y_mm": 10.0, "w_mm": 5.0, "h_mm": 5.0}
        bbox = _annotation_bbox_mm(ann)
        pad = (1.0 * _PT_TO_MM) / 2.0
        self.assertAlmostEqual(bbox[0], 10.0 - pad, places=9)
        self.assertAlmostEqual(bbox[2], 15.0 + pad, places=9)

    def test_stroke_padding_extends_bbox(self):
        stroke_pt = 4.0
        ann = {"type": "rect", "x_mm": 10.0, "y_mm": 10.0, "w_mm": 5.0, "h_mm": 5.0, "stroke_pt": stroke_pt}
        bbox = _annotation_bbox_mm(ann)
        pad = (stroke_pt * _PT_TO_MM) / 2.0
        self.assertAlmostEqual(bbox[0], 10.0 - pad, places=9)
        self.assertAlmostEqual(bbox[1], 10.0 - pad, places=9)
        self.assertAlmostEqual(bbox[2], 15.0 + pad, places=9)
        self.assertAlmostEqual(bbox[3], 15.0 + pad, places=9)

    def test_ellipse_gets_same_stroke_padding(self):
        stroke_pt = 2.0
        ann = {"type": "ellipse", "x_mm": 0.0, "y_mm": 0.0, "w_mm": 10.0, "h_mm": 10.0, "stroke_pt": stroke_pt}
        bbox = _annotation_bbox_mm(ann)
        pad = (stroke_pt * _PT_TO_MM) / 2.0
        self.assertAlmostEqual(bbox[0], -pad, places=9)
        self.assertAlmostEqual(bbox[2], 10.0 + pad, places=9)


class AnnotationBboxLineArrowTests(unittest.TestCase):
    def test_line_padded_by_half_stroke_only(self):
        stroke_pt = 4.0
        ann = {"type": "line", "points_mm": [0.0, 0.0, 10.0, 0.0], "stroke_pt": stroke_pt}
        bbox = _annotation_bbox_mm(ann)
        pad = (stroke_pt * _PT_TO_MM) / 2.0
        self.assertAlmostEqual(bbox[0], 0.0 - pad, places=9)
        self.assertAlmostEqual(bbox[2], 10.0 + pad, places=9)

    def test_arrow_padded_more_than_equivalent_line(self):
        stroke_pt = 4.0
        line = {"type": "line", "points_mm": [0.0, 0.0, 10.0, 0.0], "stroke_pt": stroke_pt}
        arrow = {"type": "arrow", "points_mm": [0.0, 0.0, 10.0, 0.0], "stroke_pt": stroke_pt}
        line_bbox = _annotation_bbox_mm(line)
        arrow_bbox = _annotation_bbox_mm(arrow)
        # The arrow's extra arrowhead half-width must extend the box further
        # than the plain stroke padding a line gets.
        self.assertGreater(arrow_bbox[3] - arrow_bbox[1], line_bbox[3] - line_bbox[1])
        self.assertLess(arrow_bbox[0], line_bbox[0])
        self.assertGreater(arrow_bbox[2], line_bbox[2])

    def test_malformed_points_returns_none(self):
        self.assertIsNone(_annotation_bbox_mm({"type": "arrow", "points_mm": [0.0, 0.0]}))

    def test_arrow_pad_exact_numbers(self):
        # Independently restate the arrowhead math from _annotation_svg
        # (head_len = max(2.5*stroke_mm, 2.0); half_w = 0.6*head_len) rather
        # than only checking arrow_bbox > line_bbox -- a >-only check would
        # not catch a wrong multiplier that still happens to pad more than a
        # plain line.
        stroke_pt = 4.0
        stroke_mm = stroke_pt * _PT_TO_MM
        head_len = max(2.5 * stroke_mm, 2.0)
        half_w = 0.6 * head_len
        expected_pad = stroke_mm / 2.0 + half_w
        ann = {"type": "arrow", "points_mm": [0.0, 0.0, 10.0, 0.0], "stroke_pt": stroke_pt}
        bbox = _annotation_bbox_mm(ann)
        self.assertAlmostEqual(bbox[0], 0.0 - expected_pad, places=9)
        self.assertAlmostEqual(bbox[1], 0.0 - expected_pad, places=9)
        self.assertAlmostEqual(bbox[2], 10.0 + expected_pad, places=9)
        self.assertAlmostEqual(bbox[3], 0.0 + expected_pad, places=9)

    def test_arrow_pad_exact_numbers_short_stroke_uses_2mm_floor(self):
        # stroke_pt small enough that 2.5*stroke_mm < 2.0 -> head_len floors
        # at 2.0mm (the `max(2.5*stroke_mm, 2.0)` branch).
        stroke_pt = 1.0
        stroke_mm = stroke_pt * _PT_TO_MM
        self.assertLess(2.5 * stroke_mm, 2.0)  # sanity: this stroke hits the floor
        head_len = 2.0
        half_w = 0.6 * head_len
        expected_pad = stroke_mm / 2.0 + half_w
        ann = {"type": "arrow", "points_mm": [0.0, 0.0, 10.0, 0.0], "stroke_pt": stroke_pt}
        bbox = _annotation_bbox_mm(ann)
        self.assertAlmostEqual(bbox[0], 0.0 - expected_pad, places=9)
        self.assertAlmostEqual(bbox[2], 10.0 + expected_pad, places=9)


class AnnotationBboxTextTests(unittest.TestCase):
    def test_left_align_default(self):
        ann = {"type": "text", "x_mm": 5.0, "y_mm": 5.0, "text": "Hi", "font_pt": 10.0}
        bbox = _annotation_bbox_mm(ann)
        self.assertEqual(bbox[0], 5.0)

    def test_center_and_right_align_do_not_shift_unboxed_text(self):
        # Un-boxed text (no w_mm): _annotation_svg ignores align entirely and
        # anchors at x_mm regardless of align, so the bbox must too — align
        # must never move x0 away from x_mm.
        ann_left = {"type": "text", "x_mm": 5.0, "y_mm": 5.0, "text": "Hi", "font_pt": 10.0, "align": "left"}
        bbox_left = _annotation_bbox_mm(ann_left)
        for align in ("center", "right"):
            ann = {"type": "text", "x_mm": 5.0, "y_mm": 5.0, "text": "Hi", "font_pt": 10.0, "align": align}
            bbox = _annotation_bbox_mm(ann)
            self.assertEqual(bbox[0], 5.0)
            self.assertEqual(bbox, bbox_left)

    def test_center_and_right_align_do_not_shift_boxed_text(self):
        # Boxed text (w_mm given): _annotation_svg keeps the anchored text
        # INSIDE [x, x+w] for every align, so the box itself is always
        # [x, x+w] -- align must not shift x0 here either.
        ann_left = {"type": "text", "x_mm": 5.0, "y_mm": 5.0, "w_mm": 20.0, "text": "Hi", "font_pt": 10.0, "align": "left"}
        bbox_left = _annotation_bbox_mm(ann_left)
        self.assertEqual(bbox_left[0], 5.0)
        self.assertEqual(bbox_left[2], 25.0)
        for align in ("center", "right"):
            ann = {"type": "text", "x_mm": 5.0, "y_mm": 5.0, "w_mm": 20.0, "text": "Hi", "font_pt": 10.0, "align": align}
            bbox = _annotation_bbox_mm(ann)
            self.assertEqual(bbox[0], 5.0)
            self.assertEqual(bbox, bbox_left)


class ContentBboxPanelLabelTests(unittest.TestCase):
    def _canvas_with_panel(self, *, label_visible=True, placement="inside"):
        canvas = Canvas(
            width_mm=210.0, height_mm=297.0, background="white",
            style={"label": {"placement": placement, "pt": 12.0, "offset_mm": 1.0, "format": "A", "bold": True}},
            annotations=[],
        )
        panel = CanvasPanel(
            x_mm=10.0, y_mm=20.0, width_mm=50.0, height_mm=40.0,
            label="A", label_visible=label_visible,
        )
        canvas.panels = [panel]
        return canvas

    def test_inside_label_stays_within_panel_bbox(self):
        canvas = self._canvas_with_panel(placement="inside")
        bbox = _content_bbox_mm(canvas)
        # Inside labels are nudged IN from the panel's top-left corner, so the
        # union bbox should still start at the panel's own top-left.
        self.assertEqual(bbox[0], 10.0)
        self.assertEqual(bbox[1], 20.0)

    def test_outside_label_extends_bbox_upward(self):
        canvas = self._canvas_with_panel(placement="outside")
        bbox = _content_bbox_mm(canvas)
        # An outside label sits ABOVE the panel (smaller y) -- the bbox's
        # top edge (min y) must move up past the panel's own y_mm.
        self.assertLess(bbox[1], 20.0)

    def test_hidden_label_does_not_extend_bbox(self):
        canvas = self._canvas_with_panel(placement="outside", label_visible=False)
        bbox = _content_bbox_mm(canvas)
        self.assertEqual(bbox[1], 20.0)

    def test_empty_canvas_returns_none(self):
        canvas = Canvas(width_mm=210.0, height_mm=297.0, style={}, annotations=[])
        canvas.panels = []
        self.assertIsNone(_content_bbox_mm(canvas))


if __name__ == "__main__":
    unittest.main()
