"""M-C1 §1/§2 — journal specs + parse_canvas_preset + the canvas presets list.

Pure data / pure-function tests: no DB, no rendering.
"""
import unittest

from app.canvases.service import list_canvas_presets
from app.r_engine.presets import (
    DEFAULT_NEW_FIGURE_OPTIONS,
    FONT_FAMILY_CLASSES,
    JOURNAL_SPECS,
    font_family_matches,
    parse_canvas_preset,
)


class JournalSpecsShapeTests(unittest.TestCase):
    """Every JOURNAL_SPECS entry must carry the new M-C1 §1 keys, and the
    legacy *_col_in keys must be left untouched (figures.check_compliance
    still reads them)."""

    def test_every_entry_has_col_mm_and_font_bounds(self):
        for key, spec in JOURNAL_SPECS.items():
            with self.subTest(journal=key):
                self.assertIn("col_mm", spec)
                self.assertIn("single", spec["col_mm"])
                self.assertIn("onehalf", spec["col_mm"])
                self.assertIn("double", spec["col_mm"])
                self.assertIn("max_height_mm", spec)
                self.assertEqual(spec.get("min_font_pt"), 5)
                self.assertEqual(spec.get("recommended_font_pt"), 7)
                # Legacy keys (figures.check_compliance) must still be present.
                self.assertIn("single_col_in", spec)
                self.assertIn("double_col_in", spec)

    def test_col_mm_agrees_with_col_in(self):
        # [6] col_mm must not silently contradict the *_col_in values used by
        # figures.service.check_compliance / build_submission_bundle -- both
        # sides describe the SAME physical width for "single"/"double".
        for key, spec in JOURNAL_SPECS.items():
            with self.subTest(journal=key):
                single_mm = spec["col_mm"]["single"]
                double_mm = spec["col_mm"]["double"]
                self.assertLessEqual(abs(round(spec["single_col_in"] * 25.4) - single_mm), 1)
                self.assertLessEqual(abs(round(spec["double_col_in"] * 25.4) - double_mm), 1)
                onehalf_mm = spec["col_mm"].get("onehalf")
                if onehalf_mm is not None:
                    self.assertNotEqual(onehalf_mm, double_mm)

    def test_science_double_column_is_120mm(self):
        # [6] regression guard: Science's real 2-column width is 120 mm
        # (4.72 in); it must not be mislabeled or contradicted by "onehalf".
        spec = JOURNAL_SPECS["science"]
        self.assertEqual(spec["col_mm"]["double"], 120)
        self.assertIsNone(spec["col_mm"]["onehalf"])

    def test_elsevier_added(self):
        self.assertIn("elsevier", JOURNAL_SPECS)
        spec = JOURNAL_SPECS["elsevier"]
        self.assertEqual(spec["journal"], "Elsevier")
        self.assertEqual(spec["col_mm"], {"single": 90, "onehalf": 140, "double": 190})
        self.assertEqual(spec["max_height_mm"], 240)
        self.assertEqual(spec["preferred_font"], "sans")
        self.assertEqual(spec["preferred_formats"], ["tiff", "eps", "pdf"])
        self.assertEqual(spec["min_dpi"], 300)
        self.assertEqual(spec["max_dpi"], 1000)
        self.assertAlmostEqual(spec["single_col_in"], 3.54)
        self.assertAlmostEqual(spec["double_col_in"], 7.48)


class FontFamilyMatchesTests(unittest.TestCase):
    """[7] shared font-class helper used by BOTH figures.service.check_compliance
    and the canvas journal-check, so the two checklists never disagree on the
    same figure."""

    def test_default_new_figure_font_matches_preferred_sans(self):
        # Every new figure defaults to font_family="dejavu_sans" -- it must
        # be treated as a sans font, not fail strict equality against "sans".
        self.assertEqual(DEFAULT_NEW_FIGURE_OPTIONS["font_family"], "dejavu_sans")
        self.assertTrue(font_family_matches(DEFAULT_NEW_FIGURE_OPTIONS["font_family"], "sans"))

    def test_arial_helvetica_noto_sans_match_sans(self):
        for family in ("arial", "helvetica", "noto_sans", "sans"):
            with self.subTest(family=family):
                self.assertTrue(font_family_matches(family, "sans"))

    def test_times_does_not_match_sans(self):
        self.assertFalse(font_family_matches("times", "sans"))

    def test_times_and_noto_serif_match_serif(self):
        for family in ("times", "noto_serif", "serif"):
            with self.subTest(family=family):
                self.assertTrue(font_family_matches(family, "serif"))

    def test_dejavu_sans_does_not_match_serif(self):
        self.assertFalse(font_family_matches("dejavu_sans", "serif"))

    def test_missing_family_defaults_to_sans(self):
        self.assertTrue(font_family_matches(None, "sans"))

    def test_unrecognised_preferred_falls_back_to_equality(self):
        self.assertTrue(font_family_matches("mono", "mono"))
        self.assertFalse(font_family_matches("sans", "mono"))

    def test_classes_cover_every_font_families_key_used_by_sans_or_serif(self):
        # Guard against a new FONT_FAMILIES key silently falling outside both
        # classes (which would make it fail compliance under both classes).
        covered = FONT_FAMILY_CLASSES["sans"] | FONT_FAMILY_CLASSES["serif"]
        self.assertTrue({"sans", "serif", "helvetica", "arial", "dejavu_sans", "noto_sans", "times", "noto_serif"} <= covered)


class ParseCanvasPresetTests(unittest.TestCase):
    def test_parses_every_valid_combination(self):
        for key, spec in JOURNAL_SPECS.items():
            for column, width in (spec["col_mm"] or {}).items():
                if not width:
                    continue
                with self.subTest(key=key, column=column):
                    self.assertEqual(parse_canvas_preset(f"{key}_{column}"), (key, column))

    def test_rejects_unknown_journal(self):
        self.assertIsNone(parse_canvas_preset("not_a_journal_single"))

    def test_rejects_unknown_column(self):
        self.assertIsNone(parse_canvas_preset("nature_triple"))

    def test_rejects_iso_paper_keys(self):
        self.assertIsNone(parse_canvas_preset("a4_portrait"))
        self.assertIsNone(parse_canvas_preset("a4_landscape"))

    def test_rejects_column_the_journal_does_not_define(self):
        # plos/ieee/science have no "onehalf" width (col_mm["onehalf"] is
        # None) -- the key must not parse even though "plos"/"ieee"/"science"
        # are real journals and "onehalf" is a real column name.
        self.assertIsNone(JOURNAL_SPECS["plos"]["col_mm"].get("onehalf"))
        self.assertIsNone(parse_canvas_preset("plos_onehalf"))
        self.assertIsNone(JOURNAL_SPECS["ieee"]["col_mm"].get("onehalf"))
        self.assertIsNone(parse_canvas_preset("ieee_onehalf"))
        self.assertIsNone(JOURNAL_SPECS["science"]["col_mm"].get("onehalf"))
        self.assertIsNone(parse_canvas_preset("science_onehalf"))

    def test_rejects_non_string_and_no_underscore(self):
        self.assertIsNone(parse_canvas_preset(None))
        self.assertIsNone(parse_canvas_preset("nature"))


class ListCanvasPresetsTests(unittest.TestCase):
    def setUp(self):
        self.presets = list_canvas_presets()
        self.by_key = {p["key"]: p for p in self.presets}

    def test_a4_first(self):
        self.assertEqual(self.presets[0]["key"], "a4_portrait")
        self.assertEqual(self.presets[1]["key"], "a4_landscape")
        for p in self.presets[:2]:
            self.assertIsNone(p["journal"])
            self.assertIsNone(p["journal_key"])
            self.assertIsNone(p["column"])
            self.assertIsNone(p["max_height_mm"])

    def test_a4_portrait_dims(self):
        p = self.by_key["a4_portrait"]
        self.assertEqual(p["width_mm"], 210.0)
        self.assertEqual(p["height_mm"], 297.0)

    def test_every_journal_preset_width_matches_col_mm(self):
        for key, spec in JOURNAL_SPECS.items():
            for column, width in (spec["col_mm"] or {}).items():
                if not width:
                    continue
                preset_key = f"{key}_{column}"
                with self.subTest(preset_key=preset_key):
                    self.assertIn(preset_key, self.by_key)
                    entry = self.by_key[preset_key]
                    self.assertEqual(entry["width_mm"], float(width))
                    self.assertEqual(entry["journal"], spec.get("journal", key))
                    self.assertEqual(entry["journal_key"], key)
                    self.assertEqual(entry["column"], column)
                    self.assertEqual(entry["max_height_mm"], spec.get("max_height_mm"))

    def test_height_never_exceeds_max_height(self):
        for entry in self.presets:
            if entry["max_height_mm"] is None:
                continue
            with self.subTest(key=entry["key"]):
                self.assertLessEqual(entry["height_mm"], entry["max_height_mm"])

    def test_height_formula(self):
        # height_mm = min(max_height_mm, round(width_mm * 0.9, 2))
        entry = self.by_key["nature_single"]
        expected = min(247.0, round(89.0 * 0.9, 2))
        self.assertEqual(entry["height_mm"], expected)

    def test_no_onehalf_column_omitted(self):
        # e.g. plos has no "onehalf" width -> plos_onehalf must not exist.
        self.assertNotIn("plos_onehalf", self.by_key)
        self.assertIn("plos_single", self.by_key)
        self.assertIn("plos_double", self.by_key)

    def test_label_format(self):
        entry = self.by_key["nature_onehalf"]
        self.assertEqual(entry["label"], "Nature — 1.5 column (120 mm)")


if __name__ == "__main__":
    unittest.main()
