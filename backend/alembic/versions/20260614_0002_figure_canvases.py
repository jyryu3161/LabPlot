"""add figure canvases

Revision ID: 20260614_0002
Revises: 20260614_0001
Create Date: 2026-06-14
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "20260614_0002"
down_revision = "20260614_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(text(
        """
        CREATE TABLE IF NOT EXISTS figure_canvases (
            id UUID PRIMARY KEY,
            owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            preset VARCHAR(40) NOT NULL DEFAULT 'double_column',
            width_px INTEGER NOT NULL DEFAULT 720,
            height_px INTEGER NOT NULL DEFAULT 500,
            state JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMP WITH TIME ZONE,
            updated_at TIMESTAMP WITH TIME ZONE
        )
        """
    ))
    bind.execute(text("CREATE INDEX IF NOT EXISTS ix_figure_canvases_owner_id ON figure_canvases (owner_id)"))
    bind.execute(text("CREATE INDEX IF NOT EXISTS ix_figure_canvases_project_id ON figure_canvases (project_id)"))
    bind.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_figure_canvases_owner_updated ON figure_canvases (owner_id, updated_at)"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("DROP INDEX IF EXISTS ix_figure_canvases_owner_updated"))
    bind.execute(text("DROP INDEX IF EXISTS ix_figure_canvases_project_id"))
    bind.execute(text("DROP INDEX IF EXISTS ix_figure_canvases_owner_id"))
    bind.execute(text("DROP TABLE IF EXISTS figure_canvases"))
