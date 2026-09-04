"""M-C1 §8/§9 — export filename slugging, the "eps" export format, and the
z-normalization bug fix in _sanitize_annotations.

Pure-function tests: no DB, no rsvg-convert invocation.
"""
import unittest
from typing import get_args

from app.canvases.models import Canvas
from app.canvases.schemas import CanvasExportRequest, CanvasExportResponse
from app.canvases.service import _journal_filename, _sanitize_annotations


class JournalFilenameSlugTests(unittest.TestCase):
    def test_ascii_letters_digits_hyphen_kept(self):
        canvas = Canvas(name="My-Figure 1!", width_mm=89.0, preset=None)
        name = _journal_filename(canvas, "svg", None)
        # Everything but ASCII letters/digits/'-' is stripped (space and '!'
        # both dropped, the hyphen kept).
        self.assertTrue(name.startswith("Fig_My-Figure1_custom_89mm"))
        self.assertTrue(name.endswith(".svg"))

    def test_empty_name_falls_back_to_figure(self):
        canvas = Canvas(name="!!!", width_mm=89.0, preset=None)
        name = _journal_filename(canvas, "svg", None)
        self.assertTrue(name.startswith("Fig_figure_custom_89mm"))

    def test_long_name_truncated_to_40_chars(self):
        canvas = Canvas(name="A" * 100, width_mm=89.0, preset=None)
        name = _journal_filename(canvas, "svg", None)
        slug = name[len("Fig_"):].split("_custom_")[0]
        self.assertLessEqual(len(slug), 40)

    def test_no_preset_uses_custom(self):
        canvas = Canvas(name="Fig1", width_mm=89.0, preset=None)
        name = _journal_filename(canvas, "svg", None)
        self.assertIn("_custom_", name)

    def test_known_preset_uses_journal_key(self):
        canvas = Canvas(name="Fig1", width_mm=89.0, preset="nature_single")
        name = _journal_filename(canvas, "svg", None)
        self.assertIn("_nature_", name)

    def test_unparseable_preset_falls_back_to_custom(self):
        canvas = Canvas(name="Fig1", width_mm=89.0, preset="not_a_real_preset")
        name = _journal_filename(canvas, "svg", None)
        self.assertIn("_custom_", name)

    def test_width_rounded_to_mm(self):
        canvas = Canvas(name="Fig1", width_mm=89.6, preset=None)
        name = _journal_filename(canvas, "svg", None)
        self.assertIn("_90mm", name)

    def test_dpi_suffix_only_for_raster(self):
        canvas = Canvas(name="Fig1", width_mm=89.0, preset=None)
        png_name = _journal_filename(canvas, "png", 300)
        svg_name = _journal_filename(canvas, "svg", None)
        self.assertTrue(png_name.endswith("_300dpi.png"))
        self.assertFalse(svg_name.endswith("dpi.svg"))
        self.assertNotIn("dpi", svg_name)

    def test_tiff_dpi_suffix(self):
        canvas = Canvas(name="Fig1", width_mm=89.0, preset=None)
        name = _journal_filename(canvas, "tiff", 600)
        self.assertTrue(name.endswith("_600dpi.tiff"))


class ExportFormatLiteralTests(unittest.TestCase):
    def test_eps_is_a_valid_request_format(self):
        req = CanvasExportRequest(format="eps")
        self.assertEqual(req.format, "eps")

    def test_eps_in_request_literal_args(self):
        field = CanvasExportRequest.model_fields["format"]
        self.assertIn("eps", get_args(field.annotation))

    def test_eps_in_response_literal_args(self):
        field = CanvasExportResponse.model_fields["format"]
        self.assertIn("eps", get_args(field.annotation))

    def test_response_carries_skipped_panels_and_filename(self):
        resp = CanvasExportResponse(url="http://x/f.svg", format="svg", filename="Fig_x_custom_89mm.svg")
        self.assertEqual(resp.skipped_panels, [])
        self.assertEqual(resp.filename, "Fig_x_custom_89mm.svg")


class AnnotationZNormalizationTests(unittest.TestCase):
    def test_z_reassigned_densely_from_zero(self):
        # NOTE: asserting `zs == [0, 1, 2]` alone is tautological -- dense
        # reassignment from 0..n-1 holds trivially for ANY output order, so it
        # can never catch a sort-order regression. The real assertion is the
        # actual ID sequence after normalization: original z (50, 5, -3) must
        # stable-sort ascending to c, b, a.
        items = [
            {"id": "a", "type": "text", "x_mm": 0, "y_mm": 0, "text": "x", "z": 50},
            {"id": "b", "type": "text", "x_mm": 0, "y_mm": 0, "text": "y", "z": 5},
            {"id": "c", "type": "text", "x_mm": 0, "y_mm": 0, "text": "z", "z": -3},
        ]
        out = _sanitize_annotations(items, 210.0, 297.0)
        self.assertEqual([e["id"] for e in out], ["c", "b", "a"])
        self.assertEqual([e["z"] for e in out], [0, 1, 2])

    def test_order_by_ascending_original_z(self):
        items = [
            {"id": "a", "type": "text", "x_mm": 0, "y_mm": 0, "text": "x", "z": 9},
            {"id": "b", "type": "text", "x_mm": 0, "y_mm": 0, "text": "y", "z": 1},
        ]
        out = _sanitize_annotations(items, 210.0, 297.0)
        by_id = {e["id"]: e["z"] for e in out}
        self.assertLess(by_id["b"], by_id["a"])

    def test_ties_broken_by_id_stable(self):
        items = [
            {"id": "z-item", "type": "text", "x_mm": 0, "y_mm": 0, "text": "x", "z": 0},
            {"id": "a-item", "type": "text", "x_mm": 0, "y_mm": 0, "text": "y", "z": 0},
        ]
        out = _sanitize_annotations(items, 210.0, 297.0)
        by_id = {e["id"]: e["z"] for e in out}
        self.assertLess(by_id["a-item"], by_id["z-item"])

    def test_no_gaps_after_duplicate_z_values(self):
        items = [
            {"id": "a", "type": "text", "x_mm": 0, "y_mm": 0, "text": "x", "z": 7},
            {"id": "b", "type": "text", "x_mm": 0, "y_mm": 0, "text": "y", "z": 7},
            {"id": "c", "type": "text", "x_mm": 0, "y_mm": 0, "text": "z", "z": 7},
        ]
        out = _sanitize_annotations(items, 210.0, 297.0)
        self.assertEqual(sorted(e["z"] for e in out), [0, 1, 2])


if __name__ == "__main__":
    unittest.main()
