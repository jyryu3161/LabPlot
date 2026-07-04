"""canvas text/shape annotation objects (U8)

Revision ID: 20260704_0020
Revises: 20260702_0019
Create Date: 2026-07-04
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "20260704_0020"
down_revision = "20260702_0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # Free-form list of text/arrow/line/rect/ellipse annotation objects (design
    # §U8) that paint ABOVE every panel. Server-validated shape lives in
    # app.canvases.service._sanitize_annotations; the column itself is a plain
    # JSONB list, default empty (matches the focus_columns / colors precedent).
    bind.execute(text(
        "ALTER TABLE canvases ADD COLUMN IF NOT EXISTS annotations JSONB NOT NULL DEFAULT '[]'::jsonb"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("ALTER TABLE canvases DROP COLUMN IF EXISTS annotations"))
