import unittest

from app.figures import service as figure_service


class FigureDuplicateNameTests(unittest.TestCase):
    def test_repeated_copy_suffixes_are_collapsed_and_numbered(self):
        self.assertEqual(
            figure_service._next_figure_copy_name(
                "Expression by genotype (copy) (copy)",
                "grouped_bar",
                {"Expression by genotype", "Expression by genotype (copy)"},
            ),
            "Expression by genotype (copy 2)",
        )

    def test_generic_name_uses_human_readable_chart_type(self):
        self.assertEqual(
            figure_service._next_figure_copy_name("Figure (copy)", "grouped_bar", set()),
            "Grouped bar chart (copy)",
        )

    def test_copy_name_stays_within_database_limit(self):
        result = figure_service._next_figure_copy_name("x" * 300, "line", set())
        self.assertEqual(len(result), 255)
        self.assertTrue(result.endswith(" (copy)"))


if __name__ == "__main__":
    unittest.main()
