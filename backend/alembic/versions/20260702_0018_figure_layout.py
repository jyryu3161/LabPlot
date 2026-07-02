"""figure panel layout geometry sidecar

Revision ID: 20260702_0018
Revises: 20260702_0017
Create Date: 2026-07-02
"""

from alembic import op
import sqlalchemy as sa


revision = "20260702_0018"
down_revision = "20260702_0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # Machine-generated panel geometry (pixel bounds + data ranges) captured at
    # render time so the frontend can map pointer positions to panel-relative /
    # data coordinates. Sits next to the png/svg/... export paths on the version.
    bind.execute(sa.text("ALTER TABLE figure_versions ADD COLUMN IF NOT EXISTS layout JSONB"))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("ALTER TABLE figure_versions DROP COLUMN IF EXISTS layout"))
