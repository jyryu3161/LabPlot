"""[9] duplicate_canvas must deep-copy canvas.style (label style + typography),
not silently drop it -- the copy must render identically to the source
immediately (docstring's own promise).

Uses a minimal fake DB (add/commit no-ops) and monkeypatches get_canvas /
canvas_detail so the Canvas(...) constructor call inside duplicate_canvas can
be inspected directly, without a real database.
"""
import unittest
import uuid
from unittest import mock

from app.canvases import service
from app.canvases.models import Canvas


class _FakeDB:
    def __init__(self):
        self.added = []

    def add(self, obj):
        self.added.append(obj)

    def commit(self):
        pass


class DuplicateCanvasStyleTests(unittest.TestCase):
    def _make_source(self, style):
        src = Canvas(
            id=uuid.uuid4(),
            owner_id=uuid.uuid4(),
            project_id=None,
            name="Source",
            description=None,
            width_mm=210.0,
            height_mm=297.0,
            preset=None,
            background="white",
            annotations=[],
            annotations_rev=0,
            style=style,
        )
        src.panels = []
        return src

    def test_style_is_copied_onto_the_duplicate(self):
        style = {
            "label": {"format": "(A)", "bold": False, "pt": 9.0, "placement": "outside", "offset_mm": 2.0},
            "typography": {"base_pt": 8.0},
        }
        src = self._make_source(style)
        fake_db = _FakeDB()

        with mock.patch.object(service, "get_canvas", return_value=src), \
             mock.patch.object(service, "canvas_detail", return_value={"id": "stub"}):
            service.duplicate_canvas(fake_db, src.id, src.owner_id)

        new_canvas = next(o for o in fake_db.added if isinstance(o, Canvas))
        self.assertEqual(new_canvas.style, style)

    def test_style_is_deep_copied_not_aliased(self):
        style = {"label": {"format": "(A)", "placement": "outside", "pt": 9.0, "bold": True, "offset_mm": 1.0}}
        src = self._make_source(style)
        fake_db = _FakeDB()

        with mock.patch.object(service, "get_canvas", return_value=src), \
             mock.patch.object(service, "canvas_detail", return_value={"id": "stub"}):
            service.duplicate_canvas(fake_db, src.id, src.owner_id)

        new_canvas = next(o for o in fake_db.added if isinstance(o, Canvas))
        self.assertIsNot(new_canvas.style, style)
        self.assertIsNot(new_canvas.style["label"], style["label"])
        # Mutating the copy must never alias the source.
        new_canvas.style["label"]["pt"] = 99.0
        self.assertEqual(style["label"]["pt"], 9.0)

    def test_missing_or_non_dict_style_becomes_empty_dict(self):
        for bad_style in (None, "not-a-dict", []):
            with self.subTest(bad_style=bad_style):
                src = self._make_source(bad_style)
                fake_db = _FakeDB()
                with mock.patch.object(service, "get_canvas", return_value=src), \
                     mock.patch.object(service, "canvas_detail", return_value={"id": "stub"}):
                    service.duplicate_canvas(fake_db, src.id, src.owner_id)
                new_canvas = next(o for o in fake_db.added if isinstance(o, Canvas))
                self.assertEqual(new_canvas.style, {})


if __name__ == "__main__":
    unittest.main()
