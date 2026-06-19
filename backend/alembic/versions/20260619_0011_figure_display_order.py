"""figure display order

Revision ID: 20260619_0011
Revises: 20260619_0010
Create Date: 2026-06-19
"""

from alembic import op
import sqlalchemy as sa


revision = "20260619_0011"
down_revision = "20260619_0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("ALTER TABLE figures ADD COLUMN IF NOT EXISTS display_order INTEGER"))
    bind.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_figures_display_order ON figures (display_order)"))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("DROP INDEX IF EXISTS ix_figures_display_order"))
    bind.execute(sa.text("ALTER TABLE figures DROP COLUMN IF EXISTS display_order"))
