"""figure interactive HTML export path

Revision ID: 20260702_0017
Revises: 20260702_0016
Create Date: 2026-07-02
"""

from alembic import op
import sqlalchemy as sa


revision = "20260702_0017"
down_revision = "20260702_0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # Self-contained interactive plotly HTML export path on figure_versions,
    # next to png/svg/tiff/pdf/eps paths.
    bind.execute(sa.text("ALTER TABLE figure_versions ADD COLUMN IF NOT EXISTS html_path VARCHAR(512)"))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("ALTER TABLE figure_versions DROP COLUMN IF EXISTS html_path"))
