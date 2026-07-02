"""figure EPS export path + share token

Revision ID: 20260702_0015
Revises: 20260701_0014
Create Date: 2026-07-02
"""

from alembic import op
import sqlalchemy as sa


revision = "20260702_0015"
down_revision = "20260701_0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # EPS export path lives on figure_versions, next to png/svg/tiff/pdf paths.
    bind.execute(sa.text("ALTER TABLE figure_versions ADD COLUMN IF NOT EXISTS eps_path VARCHAR(512)"))
    # Share-link token on figures: nullable, unique, indexed for O(1) lookup.
    bind.execute(sa.text("ALTER TABLE figures ADD COLUMN IF NOT EXISTS share_token VARCHAR(64)"))
    bind.execute(sa.text("CREATE UNIQUE INDEX IF NOT EXISTS ix_figures_share_token ON figures (share_token)"))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("DROP INDEX IF EXISTS ix_figures_share_token"))
    bind.execute(sa.text("ALTER TABLE figures DROP COLUMN IF EXISTS share_token"))
    bind.execute(sa.text("ALTER TABLE figure_versions DROP COLUMN IF EXISTS eps_path"))
