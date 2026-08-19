import os
import tempfile
import uuid
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd

from app.figures import service as figure_service
from app.figures.models import FigureVersion
from app.r_engine.presets import (
    DEFAULT_NEW_FIGURE_OPTIONS,
    NAMED_PALETTES,
    NAMED_PALETTE_STROKES,
    list_palettes,
)
from app.r_engine import renderer
from app.r_engine.renderer import build_script


EXPECTED_PUBLICATION_MUTED = [
    "#62B9C5",
    "#E4776B",
    "#7569AE",
    "#61A574",
    "#E7A85A",
    "#C36CA5",
    "#8BB8D4",
    "#B5BAC0",
]

EXPECTED_PUBLICATION_STROKES = [
    "#2F8998",
    "#B94A3F",
    "#51458E",
    "#347B49",
    "#B97626",
    "#913C75",
    "#557E9E",
    "#707780",
]

EXPECTED_LEGACY_JOURNAL_MUTED = [
    "#4C6F91",
    "#B24745",
    "#6A8A6B",
    "#8E6C8A",
    "#B79A43",
    "#5D8D8A",
    "#8C7A6B",
    "#7A7A7A",
    "#A06B5F",
]


class _QueryStub:
    def filter(self, *_args, **_kwargs):
        return self

    def first(self):
        return None

    def scalar(self):
        return None


class _DbStub:
    def __init__(self):
        self.added = []
        self.committed = False

    def query(self, *_args, **_kwargs):
        return _QueryStub()

    def add(self, value):
        self.added.append(value)

    def flush(self):
        return None

    def commit(self):
        self.committed = True


class PublicationDefaultPaletteTests(unittest.TestCase):
    def test_new_palette_has_requested_order_and_neutral_public_label(self):
        # R-PUB-1 / R-PUB-2: the default starts teal/coral and never presents
        # itself as an official journal-owned palette.
        self.assertEqual(NAMED_PALETTES["publication_muted_v2"], EXPECTED_PUBLICATION_MUTED)
        self.assertEqual(NAMED_PALETTE_STROKES["publication_muted_v2"], EXPECTED_PUBLICATION_STROKES)
        palette = next(item for item in list_palettes() if item["key"] == "publication_muted_v2")
        self.assertTrue(palette["is_default_for_new_figures"])
        label = palette["label"].lower()
        self.assertNotIn("nature genetics", label)
        self.assertNotIn("official", label)
        self.assertIn("marker and line-type redundancy", palette["usage_note"])

    def test_publication_typography_and_line_tokens_are_explicit_points(self):
        # R-PUB-11: the persisted token names and generated R must agree. The
        # backend image does not ship proprietary Arial, so expose the installed
        # fallback honestly and convert publication point widths explicitly.
        self.assertEqual(DEFAULT_NEW_FIGURE_OPTIONS["font_family"], "dejavu_sans")
        self.assertEqual(DEFAULT_NEW_FIGURE_OPTIONS["axis_line_width_pt"], 0.5)
        self.assertEqual(DEFAULT_NEW_FIGURE_OPTIONS["data_line_width_pt"], 0.8)
        self.assertEqual(DEFAULT_NEW_FIGURE_OPTIONS["linewidth_scale"], 1.0)
        script = build_script(
            "line",
            {"x": "time", "y": "value", "group": "condition"},
            DEFAULT_NEW_FIGURE_OPTIONS,
            "nature",
        )
        self.assertIn('family = "DejaVu Sans"', script)
        self.assertIn("labplot_pt_to_mm <- function(pt) pt * 25.4 / 72.27", script)
        self.assertIn("axis.line = element_line(colour = \"black\", linewidth = labplot_pt_to_mm(0.5))", script)
        self.assertIn("axis.ticks = element_line(colour = \"black\", linewidth = labplot_pt_to_mm(0.5))", script)
        self.assertIn(".labplot_data_linewidth_mm <- labplot_pt_to_mm(0.8)", script)
        self.assertIn('c("GeomLine", "GeomPath", "GeomStep", "GeomSmooth", "GeomDensity", "GeomFreqpoly")', script)

    def test_legacy_palette_and_renderer_contract_are_unchanged(self):
        # R-PUB-3: existing versions that explicitly store journal_muted keep
        # their original colors after the new default is introduced.
        self.assertEqual(NAMED_PALETTES["journal_muted"], EXPECTED_LEGACY_JOURNAL_MUTED)
        script = build_script(
            "line",
            {"x": "time", "y": "value", "group": "condition"},
            {"palette_name": "journal_muted"},
            "nature",
        )
        self.assertIn('pal <- c("#4C6F91", "#B24745"', script)
        self.assertNotIn('pal <- c("#62B9C5", "#E4776B"', script)

    def test_new_default_script_is_explicit_and_reproducible(self):
        # R-PUB-4: generated code carries the palette, typeface, base size and
        # line scale instead of relying on a mutable renderer fallback.
        self.assertEqual(
            figure_service.sanitize_options("line", DEFAULT_NEW_FIGURE_OPTIONS, {"time", "value", "condition"}),
            DEFAULT_NEW_FIGURE_OPTIONS,
        )
        script = build_script(
            "line",
            {"x": "time", "y": "value", "group": "condition"},
            DEFAULT_NEW_FIGURE_OPTIONS,
            "nature",
        )
        self.assertIn('pal <- c("#62B9C5", "#E4776B"', script)
        self.assertIn('pal <- c("#2F8998", "#B94A3F"', script)
        self.assertIn('family = "DejaVu Sans"', script)
        self.assertIn("theme_classic(base_size = 7)", script)
        self.assertIn(".labplot_data_linewidth_mm <- labplot_pt_to_mm(0.8)", script)
        self.assertIn(
            "$linewidth <- if (.is_data_line) .labplot_data_linewidth_mm * 1 else .pl$linewidth * 1",
            script,
        )
        self.assertIn("panel.grid = element_blank()", script)
        self.assertIn("linetype = factor(.data[[\"condition\"]])", script)
        self.assertIn("shape = factor(.data[[\"condition\"]])", script)
        self.assertIn(
            'scale_linetype_manual(name = "condition", values = rep(c("solid", "dashed", "dotdash", "dotted"), length.out = 100))',
            script,
        )
        self.assertIn('scale_shape_manual(name = "condition"', script)
        self.assertNotIn("linetype = 'none'", script)
        self.assertNotIn("shape = 'none'", script)

    def test_explicit_grouped_line_controls_override_automatic_aesthetics(self):
        # R-PUB-4b: the accessible per-series cycle is a default, not a trap.
        # Explicit global controls from the builder or AI must still render.
        explicit = build_script(
            "line",
            {"x": "time", "y": "value", "group": "condition"},
            {
                **DEFAULT_NEW_FIGURE_OPTIONS,
                "line_type": "longdash",
                "point_shape": "diamond",
            },
            "nature",
        )
        self.assertNotIn('linetype = factor(.data[["condition"]])', explicit)
        self.assertNotIn('shape = factor(.data[["condition"]])', explicit)
        self.assertNotIn("scale_linetype_manual", explicit)
        self.assertNotIn("scale_shape_manual", explicit)
        self.assertIn('geom_line(linewidth = 0.35, linetype = "longdash")', explicit)
        self.assertIn("geom_point(size = 1.8, shape = 18)", explicit)

        partial = build_script(
            "line",
            {"x": "time", "y": "value", "group": "condition"},
            {**DEFAULT_NEW_FIGURE_OPTIONS, "line_type": "dashed"},
            "nature",
        )
        self.assertNotIn('linetype = factor(.data[["condition"]])', partial)
        self.assertIn('shape = factor(.data[["condition"]])', partial)
        self.assertNotIn("scale_linetype_manual", partial)
        self.assertIn("scale_shape_manual", partial)
        self.assertIn('geom_line(linewidth = 0.35, linetype = "dashed")', partial)

    @unittest.skipUnless(os.path.isfile(renderer._rscript_bin()), "R renderer is unavailable")
    def test_six_series_line_with_redundant_encoding_renders(self):
        # R-PUB-9: the accessibility fallback is executable R at the threshold
        # where color alone is insufficient; this catches malformed scale code.
        frame = pd.DataFrame({
            "time": [0, 1] * 6,
            "value": [1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7],
            "condition": [name for name in "ABCDEF" for _ in range(2)],
        })
        with tempfile.TemporaryDirectory(prefix="labplot_publication_defaults_") as output_dir:
            result = renderer.render(
                "line",
                {"x": "time", "y": "value", "group": "condition"},
                DEFAULT_NEW_FIGURE_OPTIONS,
                "nature",
                frame,
                output_dir,
            )
            self.assertTrue(result.success, result.log)
            self.assertTrue(os.path.isfile(result.outputs["svg"]))
            svg = Path(result.outputs["svg"]).read_text(encoding="utf-8")
            # Isolate markup after the legend title so body geometry cannot
            # produce a false positive. The legend itself must communicate the
            # redundant encodings: solid/circle, dashed/triangle and
            # dot-dash/square (then the cycle repeats for later series).
            self.assertIn(">condition</text>", svg)
            legend = svg.split(">condition</text>", 1)[1]
            self.assertGreaterEqual(legend.count("stroke-dasharray"), 2)
            self.assertIn("<circle", legend)
            self.assertIn("<polygon", legend)
            self.assertIn("stroke: #B94A3F; stroke-dasharray: 4.00,4.00", legend)
            self.assertIn("stroke: #51458E; stroke-dasharray:", legend)

    @unittest.skipUnless(os.path.isfile(renderer._rscript_bin()), "R renderer is unavailable")
    def test_colour_and_series_overrides_keep_one_accessible_legend(self):
        # R-PUB-10: both user-facing colour override paths replace manual
        # scales after the base plot is built. They must preserve the shared
        # scale name or ggplot2 splits colour from linetype/shape into two
        # contradictory legends.
        frame = pd.DataFrame({
            "time": [0, 1] * 3,
            "value": [1, 2, 2, 3, 3, 4],
            "condition": [name for name in "ABC" for _ in range(2)],
        })
        cases = {
            "category-colour": {"category_colors": {"B": "#123456"}},
            "series-style": {
                "series_styles": {
                    "B": {"color": "#123456", "linetype": "dotted", "shape": "diamond"},
                },
            },
        }
        for case_name, override in cases.items():
            with self.subTest(case=case_name), tempfile.TemporaryDirectory(
                prefix=f"labplot_publication_{case_name}_",
            ) as output_dir:
                result = renderer.render(
                    "line",
                    {"x": "time", "y": "value", "group": "condition"},
                    {**DEFAULT_NEW_FIGURE_OPTIONS, **override},
                    "nature",
                    frame,
                    output_dir,
                )
                self.assertTrue(result.success, result.log)
                svg = Path(result.outputs["svg"]).read_text(encoding="utf-8")
                self.assertEqual(svg.count(">condition</text>"), 1)
                self.assertNotIn(">factor(condition)</text>", svg)
                legend = svg.split(">condition</text>", 1)[1]
                self.assertIn("stroke: #123456; stroke-dasharray:", legend)
                self.assertIn("fill: #123456", legend)
                self.assertIn("<circle", legend)
                self.assertIn("<polygon", legend)


class NewFigureDefaultPersistenceTests(unittest.TestCase):
    def _create(self, supplied_options, defaults_profile="publication_v2"):
        owner_id = uuid.uuid4()
        dataset_id = uuid.uuid4()
        db = _DbStub()
        dataset = SimpleNamespace(
            id=dataset_id,
            project_id=None,
            column_profile=[],
            name="Publication defaults data",
            n_rows=2,
            n_cols=2,
        )
        data = SimpleNamespace(
            dataset_id=dataset_id,
            name="Publication defaults figure",
            plot_type="line",
            mapping={"x": "time", "y": "value"},
            options=supplied_options,
            style_preset="nature",
            defaults_profile=defaults_profile,
        )
        render_result = SimpleNamespace(
            r_code="# deterministic render",
            outputs={},
            layout={"img_px": {"w": 1000, "h": 800}},
            log="",
        )

        with (
            patch.object(figure_service.ds_service, "get_dataset", return_value=dataset),
            patch.object(figure_service.ds_service, "load_dataframe", return_value=pd.DataFrame()),
            patch.object(figure_service, "validate_mapping"),
            patch.object(
                figure_service, "_render_into_version",
                return_value=(render_result, "/tmp/unused"),
            ) as render_into_version,
            patch.object(figure_service, "_archive_code_artifact"),
            patch.object(figure_service, "_auto_quality_correct_initial_figure") as auto_quality,
            patch.object(figure_service, "figure_detail", return_value={"id": "created"}),
        ):
            result = figure_service.create_figure(db, owner_id, data)

        version = next(item for item in db.added if isinstance(item, FigureVersion))
        self.last_auto_quality_call_count = auto_quality.call_count
        self.last_render_call_count = render_into_version.call_count
        self.assertTrue(db.committed)
        self.assertEqual(result, {"id": "created"})
        return version.options

    def test_empty_create_options_persist_new_defaults(self):
        # R-PUB-5: API clients that omit visual options receive the same defaults
        # as the browser builder, and the values are stored in FigureVersion v1.
        self.assertEqual(self._create({}), DEFAULT_NEW_FIGURE_OPTIONS)
        self.assertEqual(self.last_auto_quality_call_count, 0)
        self.assertEqual(self.last_render_call_count, 1)

    def test_explicit_visual_options_win_over_defaults(self):
        # R-PUB-6: templates and deliberate user choices remain authoritative.
        explicit = {
            "palette_name": "okabe_ito",
            "font_family": "serif",
            "base_size": 6,
            "linewidth_scale": 1.25,
            "redundant_series_encoding": False,
        }
        self.assertEqual(self._create(explicit), {**DEFAULT_NEW_FIGURE_OPTIONS, **explicit})

    def test_preserved_template_does_not_receive_fresh_defaults(self):
        # R-PUB-7: a format copy that relied on its style preset is reproduced,
        # not silently converted to today's palette/font/line defaults.
        self.assertEqual(
            self._create({"palette_name": "preset"}, defaults_profile="preserve"),
            {"palette_name": "preset"},
        )
        self.assertEqual(self.last_auto_quality_call_count, 0)

    def test_initial_ai_quality_pass_cannot_replace_explicit_style_defaults(self):
        # R-PUB-8: the best-effort initial AI review may improve layout but may
        # not immediately undo the deterministic publication-style contract.
        patch_result = figure_service._combined_quality_patch(
            [{
                "param_patch": {
                    "options": {
                        "palette_name": "journal_muted",
                        "font_family": "serif",
                        "base_size": 5,
                        "linewidth_scale": 1.5,
                        "x_text_angle": 45,
                    },
                },
            }],
            {"required": [], "optional": [], "options": []},
            {},
            DEFAULT_NEW_FIGURE_OPTIONS,
            "nature",
            set(),
        )
        self.assertEqual(patch_result, {"options": {"x_text_angle": 45.0}})


if __name__ == "__main__":
    unittest.main()
