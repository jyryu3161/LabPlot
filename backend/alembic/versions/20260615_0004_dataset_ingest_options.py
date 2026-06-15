"""dataset ingest options and focus columns

Revision ID: 20260615_0004
Revises: 20260614_0003
Create Date: 2026-06-15
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "20260615_0004"
down_revision = "20260614_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("ALTER TABLE datasets ADD COLUMN IF NOT EXISTS ingest_options JSONB NOT NULL DEFAULT '{}'::jsonb"))
    bind.execute(text("ALTER TABLE datasets ADD COLUMN IF NOT EXISTS focus_columns JSONB NOT NULL DEFAULT '[]'::jsonb"))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("ALTER TABLE datasets DROP COLUMN IF EXISTS focus_columns"))
    bind.execute(text("ALTER TABLE datasets DROP COLUMN IF EXISTS ingest_options"))
