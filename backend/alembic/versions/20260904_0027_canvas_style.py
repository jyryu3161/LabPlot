"""canvas panel-label + typography style (M-C1 §3)

Revision ID: 20260904_0027
Revises: 20260904_0026
Create Date: 2026-09-04
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "20260904_0027"
down_revision = "20260904_0026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # Free-form {label?, typography?} object (design M-C1 §3) that carries the
    # canvas's panel-label typography (format/bold/pt/placement/offset_mm) and
    # a typography override applied to every figure panel. Server-validated
    # shape lives in app.canvases.service._sanitize_canvas_style; the column
    # itself is a plain JSONB object, default empty (matches the annotations
    # precedent from 20260704_0020).
    bind.execute(text(
        "ALTER TABLE canvases ADD COLUMN IF NOT EXISTS style JSONB NOT NULL DEFAULT '{}'::jsonb"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("ALTER TABLE canvases DROP COLUMN IF EXISTS style"))
