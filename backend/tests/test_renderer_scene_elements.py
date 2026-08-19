import json
import os
import tempfile
import unittest
import xml.etree.ElementTree as ET

import pandas as pd

from app.r_engine import renderer
from app.r_engine.templates import build_plot_r


def _render_artifacts(
    testcase: unittest.TestCase,
    plot_type: str,
    mapping: dict,
    options: dict,
    data: pd.DataFrame,
) -> tuple[dict, str, str]:
    with tempfile.TemporaryDirectory(prefix=f"labplot_{plot_type}_scene_test_") as out_dir:
        result = renderer.render(plot_type, mapping, options, "nature", data, out_dir)
        testcase.assertTrue(result.success, result.log)
        testcase.assertNotIn("unknown aesthetic", result.log.lower())
        with open(result.outputs["layout"], encoding="utf-8") as handle:
            layout = json.load(handle)
        with open(result.outputs["svg"], encoding="utf-8") as handle:
            svg = handle.read()
        return layout, svg, result.r_code


def _svg_nodes(svg: str, local_name: str) -> list[tuple[dict[str, str], dict[str, str]]]:
    root = ET.fromstring(svg)
    nodes: list[tuple[dict[str, str], dict[str, str]]] = []
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] != local_name:
            continue
        style: dict[str, str] = {}
        for item in element.attrib.get("style", "").split(";"):
            key, sep, value = item.partition(":")
            if sep:
                style[key.strip().lower()] = value.strip().upper()
        for key in ("fill", "stroke", "fill-opacity", "stroke-opacity"):
            if key in element.attrib:
                style[key] = element.attrib[key].strip().upper()
        nodes.append((dict(element.attrib), style))
    return nodes


def _nodes_at_scene_box(
    svg: str, local_name: str, box: dict, tolerance: float = 1.1,
) -> list[dict[str, str]]:
    matched: list[dict[str, str]] = []
    for attrs, style in _svg_nodes(svg, local_name):
        try:
            if local_name == "circle":
                cx = float(attrs["cx"])
                cy = float(attrs["cy"])
                expected_x = (float(box["x0"]) + float(box["x1"])) / 2
                expected_y = (float(box["y0"]) + float(box["y1"])) / 2
                same_geometry = abs(cx - expected_x) <= tolerance and abs(cy - expected_y) <= tolerance
            else:
                same_geometry = all((
                    abs(float(attrs["x"]) - float(box["x0"])) <= tolerance,
                    abs(float(attrs["y"]) - float(box["y0"])) <= tolerance,
                    abs(float(attrs["width"]) - (float(box["x1"]) - float(box["x0"]))) <= tolerance * 2,
                    abs(float(attrs["height"]) - (float(box["y1"]) - float(box["y0"]))) <= tolerance * 2,
                ))
        except (KeyError, TypeError, ValueError):
            continue
        if same_geometry:
            matched.append(style)
    return matched


def _svg_image_payloads(svg: str) -> list[str]:
    return [
        next((value for key, value in attrs.items() if key.rsplit("}", 1)[-1] == "href"), "")
        for attrs, _style in _svg_nodes(svg, "image")
    ]


class GroupedBarSceneElementTests(unittest.TestCase):
    def setUp(self):
        self.mapping = {
            "x": "Genotype",
            "y": "Expression",
            "group": "Time_h",
        }
        self.options = {
            "title": "Expression by genotype and time",
            "x_label": "Genotype",
            "y_label": "Expression",
            "size": "single_column",
            "dpi": 72,
        }
        self.data = pd.DataFrame(
            {
                "Genotype": [
                    "Control", "Control", "Control", "Control",
                    "Knockout", "Knockout", "Knockout", "Knockout",
                ],
                "Time_h": ["0h", "0h", "24h", "24h"] * 2,
                "Expression": [1.0, 1.2, 2.0, 2.2, 0.8, 0.9, 1.4, 1.5],
            }
        )

    def test_grouped_bar_template_preserves_semantic_mark_metadata(self):
        grouped = build_plot_r("grouped_bar", self.mapping, self.options)
        scatter = build_plot_r(
            "scatter",
            {"x": "Expression", "y": "Expression"},
            self.options,
        )

        self.assertIn("labplot_mark_id", grouped)
        self.assertIn("labplot_category", grouped)
        self.assertIn("labplot_series", grouped)
        self.assertIn("labplot_mark_id", scatter)
        self.assertIn("labplot_row_identity", scatter)

    def test_grouped_bar_template_emits_only_a_non_legend_override_layer(self):
        mark_id = "mark:grouped_bar:category=Control&series=24h"
        grouped = build_plot_r(
            "grouped_bar",
            self.mapping,
            {
                **self.options,
                "element_overrides": {
                    mark_id: {"fill": "#7E22CE", "stroke": "#3B0764"},
                },
            },
        )

        self.assertIn(".labplot_element_fill_overrides", grouped)
        self.assertIn(f'"{mark_id}" = "#7E22CE"', grouped)
        self.assertIn(f'"{mark_id}" = "#3B0764"', grouped)
        self.assertIn("show.legend = FALSE", grouped)
        self.assertIn(".labplot_override_fill", grouped)
        self.assertIn(".labplot_override_stroke", grouped)
        self.assertIn('] <- "grey25"', grouped)

        unsafe = build_plot_r("grouped_bar", self.mapping, {
            **self.options,
            "element_overrides": {
                'mark:grouped_bar:category=x\");system("touch /tmp/pwn")&series=24h': {
                    "fill": "#7E22CE",
                },
            },
        })
        self.assertNotIn("system(\"touch /tmp/pwn\")", unsafe)
        self.assertNotIn(".labplot_element_fill_overrides", unsafe)

    @unittest.skipUnless(os.path.isfile(renderer._rscript_bin()), "R renderer is unavailable")
    def test_render_emits_stable_pixel_bounded_scene_elements_without_mutating_svg(self):
        def render_layout(frame: pd.DataFrame, options: dict | None = None):
            with tempfile.TemporaryDirectory(prefix="labplot_scene_test_") as out_dir:
                result = renderer.render(
                    "grouped_bar",
                    self.mapping,
                    options or self.options,
                    "nature",
                    frame,
                    out_dir,
                )
                self.assertTrue(result.success, result.log)
                self.assertNotIn("unknown aesthetic", result.log.lower())
                with open(result.outputs["layout"], encoding="utf-8") as handle:
                    layout = json.load(handle)
                with open(result.outputs["svg"], encoding="utf-8") as handle:
                    svg = handle.read()
                return layout, svg

        layout, svg = render_layout(self.data)
        reordered_layout, _ = render_layout(
            self.data.iloc[::-1].reset_index(drop=True),
            {**self.options, "flip_coords": True},
        )

        elements = layout.get("scene_elements", [])
        text_by_id = {
            item["id"]: item
            for item in elements
            if item.get("kind") == "text"
        }
        self.assertEqual(text_by_id["element:title"]["setting_path"], "options.title")
        self.assertEqual(text_by_id["element:axis:x:label"]["setting_path"], "options.x_label")
        self.assertEqual(text_by_id["element:axis:y:label"]["setting_path"], "options.y_label")
        self.assertTrue(all(item.get("bbox_source") == "gtable_cell" for item in text_by_id.values()))
        flipped_text_by_id = {
            item["id"]: item
            for item in reordered_layout.get("scene_elements", [])
            if item.get("kind") == "text"
        }
        self.assertEqual(flipped_text_by_id["element:axis:x:label"]["setting_path"], "options.x_label")
        self.assertEqual(flipped_text_by_id["element:axis:y:label"]["setting_path"], "options.y_label")
        self.assertEqual(flipped_text_by_id["element:axis:x:label"]["bbox_px"], reordered_layout["ylab_px"])
        self.assertEqual(flipped_text_by_id["element:axis:y:label"]["bbox_px"], reordered_layout["xlab_px"])

        bars = [
            item for item in elements
            if item.get("kind") == "mark" and item.get("role") == "bar"
        ]
        self.assertEqual(
            {(bar["category"], bar["series"]) for bar in bars},
            {
                ("Control", "0h"),
                ("Control", "24h"),
                ("Knockout", "0h"),
                ("Knockout", "24h"),
            },
        )
        self.assertEqual(
            {bar["id"] for bar in bars},
            {
                item["id"]
                for item in reordered_layout.get("scene_elements", [])
                if item.get("kind") == "mark" and item.get("role") == "bar"
            },
        )

        img = layout["img_px"]
        for bar in bars:
            box = bar["bbox_px"]
            self.assertLess(box["x0"], box["x1"])
            self.assertLess(box["y0"], box["y1"])
            self.assertGreaterEqual(box["x0"], 0)
            self.assertGreaterEqual(box["y0"], 0)
            self.assertLessEqual(box["x1"], img["w"])
            self.assertLessEqual(box["y1"], img["h"])
            self.assertTrue(bar["editable"])
            self.assertEqual(
                bar["setting_path"],
                f'options.element_overrides.{bar["id"]}',
            )
            self.assertNotIn("unsupported_reason", bar)

        # The semantic labels must describe the visible rectangles, not merely
        # produce four in-bounds IDs.  Factor/dodge order places 0h before 24h
        # inside each genotype, and the pixel heights follow the four known
        # group means (2.1 > 1.45 > 1.1 > 0.85).
        by_pair = {(bar["category"], bar["series"]): bar["bbox_px"] for bar in bars}
        center_x = lambda box: (box["x0"] + box["x1"]) / 2
        height = lambda box: box["y1"] - box["y0"]
        self.assertLess(center_x(by_pair[("Control", "0h")]), center_x(by_pair[("Control", "24h")]))
        self.assertLess(center_x(by_pair[("Control", "24h")]), center_x(by_pair[("Knockout", "0h")]))
        self.assertLess(center_x(by_pair[("Knockout", "0h")]), center_x(by_pair[("Knockout", "24h")]))
        self.assertGreater(height(by_pair[("Control", "24h")]), height(by_pair[("Knockout", "24h")]))
        self.assertGreater(height(by_pair[("Knockout", "24h")]), height(by_pair[("Control", "0h")]))
        self.assertGreater(height(by_pair[("Control", "0h")]), height(by_pair[("Knockout", "0h")]))

        # Scene identity is a sidecar contract. The exported SVG remains the
        # ordinary ggsave/svglite document and receives no LabPlot-only IDs.
        self.assertNotIn("mark:grouped_bar:", svg)
        self.assertNotIn("data-labplot-", svg)

    @unittest.skipUnless(os.path.isfile(renderer._rscript_bin()), "R renderer is unavailable")
    def test_render_applies_one_bar_override_without_geometry_or_legend_drift(self):
        selected_id = "mark:grouped_bar:category=Control&series=24h"

        def render_layout(options: dict):
            with tempfile.TemporaryDirectory(prefix="labplot_override_test_") as out_dir:
                result = renderer.render(
                    "grouped_bar", self.mapping, options, "nature", self.data, out_dir,
                )
                self.assertTrue(result.success, result.log)
                with open(result.outputs["layout"], encoding="utf-8") as handle:
                    layout = json.load(handle)
                with open(result.outputs["svg"], encoding="utf-8") as handle:
                    svg = handle.read()
                return layout, svg, result.r_code

        before, before_svg, _ = render_layout(self.options)
        after, after_svg, r_code = render_layout({
            **self.options,
            "element_overrides": {
                selected_id: {"fill": "#7E22CE", "stroke": "#3B0764"},
            },
        })

        before_bars = {
            item["id"]: item for item in before["scene_elements"]
            if item.get("role") == "bar"
        }
        after_bars = {
            item["id"]: item for item in after["scene_elements"]
            if item.get("role") == "bar"
        }
        self.assertEqual(set(before_bars), set(after_bars))
        self.assertEqual(
            {key: value["bbox_px"] for key, value in before_bars.items()},
            {key: value["bbox_px"] for key, value in after_bars.items()},
        )
        self.assertEqual(after_bars[selected_id]["fill"], "#7E22CE")
        self.assertEqual(after_bars[selected_id]["stroke"], "#3B0764")
        for mark_id in set(after_bars) - {selected_id}:
            self.assertEqual(after_bars[mark_id]["fill"], before_bars[mark_id]["fill"])
            self.assertEqual(after_bars[mark_id].get("stroke"), before_bars[mark_id].get("stroke"))

        self.assertEqual(before.get("series_hex"), after.get("series_hex"))
        self.assertEqual(
            [item.get("series") for item in before.get("legend_keys", [])],
            [item.get("series") for item in after.get("legend_keys", [])],
        )
        self.assertNotIn("#7E22CE", before_svg.upper())
        self.assertIn("#7E22CE", after_svg.upper())
        self.assertIn("#3B0764", after_svg.upper())
        self.assertIn(selected_id, r_code)

    @unittest.skipUnless(os.path.isfile(renderer._rscript_bin()), "R renderer is unavailable")
    def test_fill_only_bar_override_preserves_the_rendered_base_outline(self):
        selected_id = "mark:grouped_bar:category=Control&series=24h"
        with tempfile.TemporaryDirectory(prefix="labplot_fill_override_test_") as out_dir:
            result = renderer.render(
                "grouped_bar",
                self.mapping,
                {
                    **self.options,
                    "element_overrides": {selected_id: {"fill": "#7E22CE"}},
                },
                "nature",
                self.data,
                out_dir,
            )
            self.assertTrue(result.success, result.log)
            with open(result.outputs["layout"], encoding="utf-8") as handle:
                layout = json.load(handle)
            with open(result.outputs["svg"], encoding="utf-8") as handle:
                svg = handle.read().upper()

        selected = next(
            item for item in layout["scene_elements"] if item.get("id") == selected_id
        )
        self.assertEqual(selected["fill"], "#7E22CE")
        self.assertEqual(selected["stroke"], "grey25")

        # svglite serializes R's grey25 as #404040.  Assert the same rendered
        # SVG element carries both the replacement fill and the original
        # outline, rather than merely finding those colours elsewhere.
        rendered_styles = [
            chunk.split("'", 1)[0]
            for chunk in svg.split("STYLE='")[1:]
        ]
        selected_styles = [style for style in rendered_styles if "FILL: #7E22CE" in style]
        self.assertTrue(selected_styles, "selected bar fill was not present in the SVG")
        self.assertTrue(
            any("STROKE: #404040" in style for style in selected_styles),
            f"fill-only override lost its grey25 outline: {selected_styles}",
        )


class PointAndCellElementOverrideContractTests(unittest.TestCase):
    def test_scatter_template_carries_source_row_identity_and_safe_overrides(self):
        point_id = "mark:scatter:row=sample%202"
        script = build_plot_r(
            "scatter",
            {"x": "x", "y": "y", "color": "group"},
            {
                "point_alpha": 0.64,
                "element_overrides": {
                    point_id: {"fill": "#7E22CE", "stroke": "#3B0764"},
                    'mark:scatter:row=x\");system("touch /tmp/pwn")': {"fill": "#FFFFFF"},
                },
            },
        )

        self.assertIn(".labplot_source_row_id", script)
        self.assertIn("labplot_mark_id", script)
        self.assertIn(f'"{point_id}" = "#7E22CE"', script)
        self.assertIn(f'"{point_id}" = "#3B0764"', script)
        self.assertIn("show.legend = FALSE", script)
        self.assertIn("alpha = 0.64", script)
        self.assertNotIn('system("touch /tmp/pwn")', script)

    def test_heatmap_templates_emit_semantic_cell_ids_and_nonlegend_overlays(self):
        heatmap_id = "mark:heatmap:row=Sample%20A&col=Gene%2F1"
        correlation_id = "mark:correlation_heatmap:x=Gene%20A&y=Gene%2F1"
        heatmap = build_plot_r(
            "heatmap",
            {"columns": ["Gene/1", "Gene B"], "row_label": "Sample"},
            {"element_overrides": {heatmap_id: {"fill": "#7E22CE"}}},
        )
        correlation = build_plot_r(
            "correlation_heatmap",
            {"columns": ["Gene A", "Gene/1"]},
            {"element_overrides": {correlation_id: {"stroke": "#3B0764"}}},
        )

        for script, mark_id in ((heatmap, heatmap_id), (correlation, correlation_id)):
            self.assertIn("labplot_mark_id", script)
            self.assertIn(mark_id, script)
            self.assertIn("show.legend = FALSE", script)
        self.assertIn('colour = "grey90"', heatmap)
        self.assertIn('colour = "white"', correlation)


@unittest.skipUnless(os.path.isfile(renderer._rscript_bin()), "R renderer is unavailable")
class PointAndCellElementOverrideRenderTests(unittest.TestCase):
    options = {
        "title": "Element override test",
        "size": "single_column",
        "dpi": 72,
    }

    def test_scatter_override_uses_source_row_ids_and_preserves_geometry_legend_and_alpha(self):
        mapping = {"x": "x", "y": "y", "color": "group"}
        data = pd.DataFrame(
            {
                "x": [1.0, 1.0, 2.0, 3.0],
                "y": [2.0, 2.0, 3.2, 4.1],
                "group": ["A", "B", "A", "B"],
            },
            index=[101, 202, 303, 404],
        )
        selected_id = "mark:scatter:row=int%3A202"
        stroke_id = "mark:scatter:row=int%3A303"
        base_options = {**self.options, "point_alpha": 0.64}
        before, before_svg, _ = _render_artifacts(
            self, "scatter", mapping, base_options, data,
        )
        after, after_svg, r_code = _render_artifacts(
            self,
            "scatter",
            mapping,
            {
                **base_options,
                "element_overrides": {
                    selected_id: {"fill": "#7E22CE"},
                    stroke_id: {"stroke": "#3B0764"},
                },
            },
            data.iloc[::-1],
        )

        before_points = {
            item["id"]: item for item in before["scene_elements"] if item.get("role") == "point"
        }
        after_points = {
            item["id"]: item for item in after["scene_elements"] if item.get("role") == "point"
        }
        self.assertEqual(set(before_points), set(after_points))
        self.assertEqual(len(after_points), 4)
        self.assertEqual(before_points["mark:scatter:row=int%3A101"]["bbox_px"],
                         before_points[selected_id]["bbox_px"])
        self.assertTrue(all(point["editable"] for point in after_points.values()))
        self.assertTrue(all(
            point["setting_path"] == f"options.element_overrides.{point['id']}"
            for point in after_points.values()
        ))
        self.assertEqual(after_points[selected_id]["fill"], "#7E22CE")
        self.assertEqual(after_points[selected_id]["stroke"], before_points[selected_id]["stroke"])
        self.assertEqual(after_points[stroke_id]["fill"], before_points[stroke_id]["fill"])
        self.assertEqual(after_points[stroke_id]["stroke"], "#3B0764")
        self.assertAlmostEqual(after_points[selected_id]["alpha"], 0.64, places=6)
        for point_id in set(after_points) - {selected_id, stroke_id}:
            self.assertEqual(after_points[point_id]["fill"], before_points[point_id]["fill"])
            self.assertEqual(after_points[point_id]["bbox_px"], before_points[point_id]["bbox_px"])
        self.assertEqual(before.get("series_hex"), after.get("series_hex"))
        self.assertEqual(
            [item.get("series") for item in before.get("legend_keys", [])],
            [item.get("series") for item in after.get("legend_keys", [])],
        )
        selected_styles = _nodes_at_scene_box(after_svg, "circle", after_points[selected_id]["bbox_px"])
        purple = [style for style in selected_styles if style.get("fill") == "#7E22CE"]
        self.assertTrue(purple, selected_styles)
        self.assertTrue(any(
            style.get("stroke") == after_points[selected_id]["stroke"].upper()
            for style in purple
        ), purple)
        self.assertTrue(any(
            style.get("fill-opacity") == "0.64" or style.get("stroke-opacity") == "0.64"
            for style in purple
        ), purple)
        stroke_styles = _nodes_at_scene_box(after_svg, "circle", after_points[stroke_id]["bbox_px"])
        self.assertTrue(any(style.get("stroke") == "#3B0764" for style in stroke_styles), stroke_styles)
        self.assertNotIn("#7E22CE", before_svg.upper())
        self.assertIn(selected_id, r_code)

    def test_scatter_duplicate_source_identity_is_noneditable_and_cannot_be_overridden(self):
        selected_id = "mark:scatter:row=int%3A101"
        data = pd.DataFrame(
            {"x": [1.0, 2.0, 3.0], "y": [1.0, 2.0, 3.0]},
            index=[101, 101, 303],
        )
        layout, svg, _ = _render_artifacts(
            self,
            "scatter",
            {"x": "x", "y": "y"},
            {
                **self.options,
                "element_overrides": {selected_id: {"fill": "#7E22CE"}},
            },
            data,
        )

        duplicates = [
            item for item in layout["scene_elements"] if item.get("id") == selected_id
        ]
        self.assertEqual(len(duplicates), 2)
        self.assertTrue(all(not item["editable"] for item in duplicates))
        self.assertTrue(all(not item.get("setting_path") for item in duplicates))
        self.assertTrue(all(item.get("fill") != "#7E22CE" for item in duplicates))
        self.assertNotIn("#7E22CE", svg.upper())

    def test_renderer_private_row_identity_does_not_overwrite_a_same_named_user_column(self):
        reserved_name = ".labplot_source_row_id"
        data = pd.DataFrame({reserved_name: [10.0, 20.0], "y": [1.0, 2.0]})
        layout, _svg, r_code = _render_artifacts(
            self,
            "scatter",
            {"x": reserved_name, "y": "y"},
            self.options,
            data,
        )

        points = [item for item in layout["scene_elements"] if item.get("role") == "point"]
        self.assertEqual({point["x_value"] for point in points}, {"10", "20"})
        self.assertIn('.data[[".labplot_source_row_id"]]', r_code)
        self.assertIn('.data[[".labplot_source_row_id_1"]]', r_code)

    def test_heatmap_override_is_semantic_across_row_reorder_and_preserves_colorbar_and_border(self):
        mapping = {"columns": ["Gene/1", "Gene B"], "row_label": "Sample"}
        data = pd.DataFrame({
            "Sample": ["Sample A", "Sample/B", "Sample C"],
            "Gene/1": [1.0, 2.0, 3.0],
            "Gene B": [4.0, 5.0, 6.0],
        })
        selected_id = "mark:heatmap:row=Sample%20A&col=Gene%2F1"
        before, before_svg, _ = _render_artifacts(
            self, "heatmap", mapping, self.options, data,
        )
        after, after_svg, r_code = _render_artifacts(
            self,
            "heatmap",
            mapping,
            {
                **self.options,
                "element_overrides": {selected_id: {"fill": "#7E22CE"}},
            },
            data.iloc[::-1],
        )

        before_cells = {
            item["id"]: item for item in before["scene_elements"] if item.get("role") == "cell"
        }
        after_cells = {
            item["id"]: item for item in after["scene_elements"] if item.get("role") == "cell"
        }
        self.assertEqual(set(before_cells), set(after_cells))
        self.assertEqual(len(after_cells), 6)
        self.assertEqual(after_cells[selected_id]["fill"], "#7E22CE")
        self.assertEqual(after_cells[selected_id]["stroke"], "grey90")
        self.assertEqual(after_cells[selected_id]["row"], "Sample A")
        self.assertEqual(after_cells[selected_id]["column"], "Gene/1")
        self.assertTrue(all(cell["editable"] for cell in after_cells.values()))
        for cell_id in set(after_cells) - {selected_id}:
            self.assertEqual(after_cells[cell_id]["fill"], before_cells[cell_id]["fill"])
            self.assertEqual(after_cells[cell_id]["stroke"], before_cells[cell_id]["stroke"])
        selected_styles = _nodes_at_scene_box(after_svg, "rect", after_cells[selected_id]["bbox_px"])
        purple = [style for style in selected_styles if style.get("fill") == "#7E22CE"]
        self.assertTrue(purple, selected_styles)
        self.assertTrue(any(style.get("stroke") == "#E5E5E5" for style in purple), purple)
        self.assertEqual(_svg_image_payloads(before_svg), _svg_image_payloads(after_svg))
        self.assertIn(selected_id, r_code)

    def test_duplicate_heatmap_row_label_is_noneditable_and_stale_override_is_blocked(self):
        selected_id = "mark:heatmap:row=Sample%20A&col=Gene%2F1"
        data = pd.DataFrame({
            "Sample": ["Sample A", "Sample A"],
            "Gene/1": [1.0, 2.0],
        })
        layout, svg, _ = _render_artifacts(
            self,
            "heatmap",
            {"columns": ["Gene/1"], "row_label": "Sample"},
            {
                **self.options,
                "element_overrides": {selected_id: {"fill": "#7E22CE"}},
            },
            data,
        )

        duplicates = [
            item for item in layout["scene_elements"] if item.get("id") == selected_id
        ]
        self.assertEqual(len(duplicates), 2)
        self.assertTrue(all(not item["editable"] for item in duplicates))
        self.assertTrue(all(not item.get("setting_path") for item in duplicates))
        self.assertTrue(all(item.get("fill") != "#7E22CE" for item in duplicates))
        self.assertNotIn("#7E22CE", svg.upper())

    def test_correlation_cell_override_is_stable_across_data_row_reorder(self):
        mapping = {"columns": ["Gene A", "Gene/1", "Gene C"]}
        data = pd.DataFrame({
            "Gene A": [1.0, 2.0, 4.0, 8.0],
            "Gene/1": [8.0, 4.0, 3.0, 1.0],
            "Gene C": [1.0, 3.0, 2.0, 5.0],
        })
        selected_id = "mark:correlation_heatmap:x=Gene%20A&y=Gene%2F1"
        stroke_id = "mark:correlation_heatmap:x=Gene%2F1&y=Gene%20A"
        before, before_svg, _ = _render_artifacts(
            self, "correlation_heatmap", mapping, self.options, data,
        )
        after, after_svg, r_code = _render_artifacts(
            self,
            "correlation_heatmap",
            mapping,
            {
                **self.options,
                "element_overrides": {
                    selected_id: {"fill": "#7E22CE"},
                    stroke_id: {"stroke": "#3B0764"},
                },
            },
            data.iloc[::-1],
        )

        before_cells = {
            item["id"]: item for item in before["scene_elements"] if item.get("role") == "cell"
        }
        after_cells = {
            item["id"]: item for item in after["scene_elements"] if item.get("role") == "cell"
        }
        self.assertEqual(set(before_cells), set(after_cells))
        self.assertEqual(len(after_cells), 9)
        self.assertEqual(
            {item: cell["bbox_px"] for item, cell in before_cells.items()},
            {item: cell["bbox_px"] for item, cell in after_cells.items()},
        )
        self.assertEqual(after_cells[selected_id]["fill"], "#7E22CE")
        self.assertEqual(after_cells[selected_id]["stroke"], "white")
        self.assertEqual(after_cells[selected_id]["x_value"], "Gene A")
        self.assertEqual(after_cells[selected_id]["y_value"], "Gene/1")
        self.assertEqual(after_cells[stroke_id]["fill"], before_cells[stroke_id]["fill"])
        self.assertEqual(after_cells[stroke_id]["stroke"], "#3B0764")
        for cell_id in set(after_cells) - {selected_id, stroke_id}:
            self.assertEqual(after_cells[cell_id]["fill"], before_cells[cell_id]["fill"])
            self.assertEqual(after_cells[cell_id]["stroke"], before_cells[cell_id]["stroke"])
        selected_styles = _nodes_at_scene_box(after_svg, "rect", after_cells[selected_id]["bbox_px"])
        purple = [style for style in selected_styles if style.get("fill") == "#7E22CE"]
        self.assertTrue(purple, selected_styles)
        self.assertTrue(any(style.get("stroke") == "#FFFFFF" for style in purple), purple)
        self.assertNotIn("#3B0764", before_svg.upper())
        self.assertIn("#3B0764", after_svg.upper())
        self.assertEqual(_svg_image_payloads(before_svg), _svg_image_payloads(after_svg))
        self.assertIn(selected_id, r_code)


if __name__ == "__main__":
    unittest.main()
