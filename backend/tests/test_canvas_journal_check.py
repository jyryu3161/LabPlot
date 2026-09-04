"""M-C1 §7 — the pure journal-check core `_evaluate_journal_checks`, plus
end-to-end-ish coverage of the DB-backed `journal_check` wrapper and
`_resolve_panel_sources` (JournalCheckWrapperTests below) via monkeypatched
collaborators and a stub db.
"""
import unittest
import uuid
from types import SimpleNamespace
from unittest import mock

from app.canvases import service
from app.canvases.service import DEFAULT_LABEL_STYLE, _evaluate_journal_checks

_NATURE_SPEC = {
    "journal": "Nature",
    "col_mm": {"single": 89, "onehalf": 120, "double": 183},
    "max_height_mm": 247,
    "min_font_pt": 5,
    "recommended_font_pt": 7,
    "preferred_font": "sans",
    "preferred_formats": ["tiff", "eps", "pdf"],
    "min_dpi": 300,
    "max_dpi": 1200,
}


def _checks_by_name(checks):
    return {c["name"]: c for c in checks}


def _panel(pt=7.0, font_family="sans", panel_id="p1", label="A"):
    return {"panel_id": panel_id, "label": label, "pt": pt, "font_family": font_family}


class PassingCanvasTests(unittest.TestCase):
    def test_all_checks_pass(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE,
            [_panel(pt=7.0)], [], "pdf", 300, [],
        )
        by_name = _checks_by_name(checks)
        self.assertEqual(len(checks), 9)
        for name, check in by_name.items():
            with self.subTest(check=name):
                self.assertTrue(check["ok"], check)
                self.assertIsNone(check["hint"])


class ColumnWidthTests(unittest.TestCase):
    def test_exact_match_passes(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE, [_panel()], [], "pdf", 300, [],
        )
        self.assertTrue(_checks_by_name(checks)["Column width"]["ok"])

    def test_off_by_3mm_fails(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 92.0, 70.0, DEFAULT_LABEL_STYLE, [_panel()], [], "pdf", 300, [],
        )
        check = _checks_by_name(checks)["Column width"]
        self.assertFalse(check["ok"])
        self.assertIsNotNone(check["hint"])

    def test_within_half_mm_tolerance_passes(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.4, 70.0, DEFAULT_LABEL_STYLE, [_panel()], [], "pdf", 300, [],
        )
        self.assertTrue(_checks_by_name(checks)["Column width"]["ok"])


class HeightTests(unittest.TestCase):
    def test_over_max_height_fails(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 300.0, DEFAULT_LABEL_STYLE, [_panel()], [], "pdf", 300, [],
        )
        self.assertFalse(_checks_by_name(checks)["Height"]["ok"])

    def test_at_max_height_passes(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 247.0, DEFAULT_LABEL_STYLE, [_panel()], [], "pdf", 300, [],
        )
        self.assertTrue(_checks_by_name(checks)["Height"]["ok"])


class MinimumFontSizeTests(unittest.TestCase):
    def test_6pt_passes_5pt_spec(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE, [_panel(pt=6.0)], [], "pdf", 300, [],
        )
        self.assertTrue(_checks_by_name(checks)["Minimum font size"]["ok"])

    def test_4pt_fails_5pt_spec(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE, [_panel(pt=4.0)], [], "pdf", 300, [],
        )
        check = _checks_by_name(checks)["Minimum font size"]
        self.assertFalse(check["ok"])
        self.assertIn("4", check["actual"])

    def test_no_figure_panels_is_ok(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE, [], [], "pdf", 300, [],
        )
        self.assertTrue(_checks_by_name(checks)["Minimum font size"]["ok"])

    def test_worst_panel_reported(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE,
            [_panel(pt=7.0, panel_id="p1", label="A"), _panel(pt=4.0, panel_id="p2", label="B")],
            [], "pdf", 300, [],
        )
        check = _checks_by_name(checks)["Minimum font size"]
        self.assertFalse(check["ok"])
        self.assertIn("B", check["actual"])


class LabelFontSizeTests(unittest.TestCase):
    def test_below_min_fails(self):
        style = {**DEFAULT_LABEL_STYLE, "pt": 4.0}
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, style, [_panel()], [], "pdf", 300, [],
        )
        self.assertFalse(_checks_by_name(checks)["Label font size"]["ok"])


class AnnotationFontSizeTests(unittest.TestCase):
    def test_small_text_annotation_fails(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE, [_panel()],
            [{"type": "text", "font_pt": 4.0}], "pdf", 300, [],
        )
        self.assertFalse(_checks_by_name(checks)["Annotation font size"]["ok"])

    def test_non_text_annotations_ignored(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE, [_panel()],
            [{"type": "rect", "x_mm": 0, "y_mm": 0, "w_mm": 1, "h_mm": 1}], "pdf", 300, [],
        )
        self.assertTrue(_checks_by_name(checks)["Annotation font size"]["ok"])


class FontFamilyTests(unittest.TestCase):
    def test_sans_family_matches_preferred_sans(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE,
            [_panel(font_family="dejavu_sans")], [], "pdf", 300, [],
        )
        self.assertTrue(_checks_by_name(checks)["Font family"]["ok"])

    def test_serif_family_fails_preferred_sans(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE,
            [_panel(font_family="times")], [], "pdf", 300, [],
        )
        self.assertFalse(_checks_by_name(checks)["Font family"]["ok"])


class ExportFormatTests(unittest.TestCase):
    def test_preferred_format_ok(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE, [_panel()], [], "eps", 300, [],
        )
        self.assertTrue(_checks_by_name(checks)["Export format"]["ok"])

    def test_non_preferred_format_fails(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE, [_panel()], [], "png", 300, [],
        )
        self.assertFalse(_checks_by_name(checks)["Export format"]["ok"])


class ResolutionTests(unittest.TestCase):
    def test_raster_below_min_dpi_fails(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE, [_panel()], [], "png", 150, [],
        )
        self.assertFalse(_checks_by_name(checks)["Resolution"]["ok"])

    def test_vector_always_ok_regardless_of_dpi(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE, [_panel()], [], "pdf", 72, [],
        )
        check = _checks_by_name(checks)["Resolution"]
        self.assertTrue(check["ok"])
        self.assertEqual(check["actual"], "vector")

    def test_raster_at_min_dpi_passes(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE, [_panel()], [], "tiff", 300, [],
        )
        self.assertTrue(_checks_by_name(checks)["Resolution"]["ok"])


class PanelsRenderableTests(unittest.TestCase):
    def test_skipped_panels_fail_check(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE, [_panel()], [], "pdf", 300,
            [{"panel_id": "p9", "reason": "no rendered version"}],
        )
        self.assertFalse(_checks_by_name(checks)["Panels renderable"]["ok"])

    def test_no_skipped_panels_passes(self):
        checks = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE, [_panel()], [], "pdf", 300, [],
        )
        self.assertTrue(_checks_by_name(checks)["Panels renderable"]["ok"])


class NoPresetTests(unittest.TestCase):
    def test_width_and_height_ok_with_hint(self):
        checks = _evaluate_journal_checks(
            None, None, 150.0, 400.0, DEFAULT_LABEL_STYLE, [_panel()], [], "pdf", 300, [],
        )
        by_name = _checks_by_name(checks)
        for name in ("Column width", "Height"):
            with self.subTest(check=name):
                check = by_name[name]
                self.assertTrue(check["ok"])
                self.assertEqual(check["actual"], "no journal preset")
                self.assertEqual(check["hint"], "Pick a journal preset to check column width and height")

    def test_other_checks_use_minimal_spec(self):
        # No preset -> min_font_pt falls back to JOURNAL_SPECS["minimal"] (5).
        checks = _evaluate_journal_checks(
            None, None, 150.0, 400.0, DEFAULT_LABEL_STYLE, [_panel(pt=4.0)], [], "pdf", 300, [],
        )
        self.assertFalse(_checks_by_name(checks)["Minimum font size"]["ok"])


class OverallPassTests(unittest.TestCase):
    def test_passed_is_and_of_all_checks(self):
        checks_pass = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 89.0, 70.0, DEFAULT_LABEL_STYLE, [_panel()], [], "pdf", 300, [],
        )
        checks_fail = _evaluate_journal_checks(
            _NATURE_SPEC, "single", 92.0, 70.0, DEFAULT_LABEL_STYLE, [_panel()], [], "pdf", 300, [],
        )
        self.assertTrue(all(c["ok"] for c in checks_pass))
        self.assertFalse(all(c["ok"] for c in checks_fail))


class _StubQuery:
    def __init__(self, rows):
        self._rows = rows

    def filter(self, *args, **kwargs):
        return self

    def all(self):
        return self._rows


class _StubDB:
    """Minimal stand-in for the one query journal_check issues directly
    (FigureVersion.id/options by id.in_(...)) -- everything else is reached
    through monkeypatched service functions, never through this db."""

    def __init__(self, rows):
        self._rows = rows

    def query(self, *args, **kwargs):
        return _StubQuery(self._rows)


class JournalCheckWrapperTests(unittest.TestCase):
    """[3] the ~25-line DB-backed wrapper body (version_options query,
    resolve_base_size, parse_canvas_preset -> JOURNAL_SPECS lookup,
    panel_infos assembly) and _resolve_panel_sources had zero coverage --
    only the pure core above was ever exercised."""

    def test_wrapper_resolves_versions_preset_and_skips_unreadable_image(self):
        owner_id = uuid.uuid4()
        canvas_id = uuid.uuid4()
        fig_id = uuid.uuid4()
        version_id = uuid.uuid4()
        image_panel_id = uuid.uuid4()

        fig_panel = SimpleNamespace(
            id=uuid.uuid4(), figure_id=fig_id, image_key=None,
            pinned_version_id=None, label="A",
        )
        image_panel = SimpleNamespace(
            id=image_panel_id, figure_id=None, image_key="some-image-key",
            pinned_version_id=None, label="B",
        )
        canvas = SimpleNamespace(
            id=canvas_id, preset="nature_single", width_mm=89.0, height_mm=70.0,
            style=None, annotations=[], panels=[fig_panel, image_panel],
        )
        stub_db = _StubDB([(version_id, {"base_size": 6, "font_scale": 1.0, "font_family": "helvetica"})])

        with mock.patch.object(service, "get_canvas", return_value=canvas), \
             mock.patch.object(service, "_figure_current_versions", return_value={fig_id: version_id}), \
             mock.patch.object(service.storage, "read_bytes", side_effect=OSError("missing")):
            result = service.journal_check(stub_db, canvas_id, owner_id, fmt="pdf", dpi=300)

        self.assertEqual(result["journal"], "Nature")
        self.assertEqual(result["column"], "single")
        self.assertEqual(
            [c["name"] for c in result["checks"]],
            [
                "Column width", "Height", "Minimum font size", "Label font size",
                "Annotation font size", "Font family", "Export format", "Resolution",
                "Panels renderable",
            ],
        )
        by_name = {c["name"]: c for c in result["checks"]}
        # Proves version_options keying (by real UUID, not str) + resolve_base_size.
        self.assertEqual(by_name["Minimum font size"]["actual"], "6 pt (panel A)")
        self.assertTrue(by_name["Font family"]["ok"])  # helvetica is in the sans class
        self.assertFalse(by_name["Panels renderable"]["ok"])
        self.assertEqual(
            result["skipped_panels"],
            [{"panel_id": str(image_panel_id), "reason": "image missing"}],
        )
        self.assertFalse(result["passed"])


if __name__ == "__main__":
    unittest.main()
