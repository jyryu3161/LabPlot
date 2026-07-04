"""canvas annotations optimistic-concurrency revision counter (U8 review F1)

Revision ID: 20260704_0021
Revises: 20260704_0020
Create Date: 2026-07-04
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "20260704_0021"
down_revision = "20260704_0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # Server-incremented on every whole-array annotations replace; clients send
    # the rev they based their edit on (CanvasUpdate.base_annotations_rev) and
    # a mismatch 409s (ANNOTATIONS_CONFLICT) instead of silently last-write-
    # winning another editor's objects away.
    bind.execute(text(
        "ALTER TABLE canvases ADD COLUMN IF NOT EXISTS annotations_rev INTEGER NOT NULL DEFAULT 0"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("ALTER TABLE canvases DROP COLUMN IF EXISTS annotations_rev"))
