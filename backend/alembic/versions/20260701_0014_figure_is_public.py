"""figure is_public

Revision ID: 20260701_0014
Revises: 20260619_0013
Create Date: 2026-07-01
"""

from alembic import op
import sqlalchemy as sa


revision = "20260701_0014"
down_revision = "20260619_0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("ALTER TABLE figures ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false"))
    bind.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_figures_is_public ON figures (is_public)"))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("DROP INDEX IF EXISTS ix_figures_is_public"))
    bind.execute(sa.text("ALTER TABLE figures DROP COLUMN IF EXISTS is_public"))
