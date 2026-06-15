"""figure favorites

Revision ID: 20260615_0007
Revises: 20260615_0006
Create Date: 2026-06-15
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "20260615_0007"
down_revision = "20260615_0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("ALTER TABLE figures ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT FALSE"))
    bind.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_figures_owner_favorite_updated "
        "ON figures (owner_id, is_favorite, updated_at DESC)"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("DROP INDEX IF EXISTS ix_figures_owner_favorite_updated"))
    bind.execute(text("ALTER TABLE figures DROP COLUMN IF EXISTS is_favorite"))
