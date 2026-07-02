"""multi-panel canvases + canvas_panels; drop orphan figure_canvases

Revision ID: 20260702_0019
Revises: 20260702_0018
Create Date: 2026-07-02
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "20260702_0019"
down_revision = "20260702_0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # Normalized multi-panel canvas model. Physical geometry in mm (DOUBLE
    # PRECISION); ids set by the ORM (uuid4), matching the existing raw-SQL
    # migrations (e.g. 20260614_0002) which declare id without a DB default.
    bind.execute(text(
        """
        CREATE TABLE IF NOT EXISTS canvases (
            id UUID PRIMARY KEY,
            owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            width_mm DOUBLE PRECISION NOT NULL,
            height_mm DOUBLE PRECISION NOT NULL,
            preset VARCHAR(40),
            background VARCHAR(20) NOT NULL DEFAULT 'white',
            export_snapshot JSONB,
            created_at TIMESTAMP WITH TIME ZONE,
            updated_at TIMESTAMP WITH TIME ZONE
        )
        """
    ))
    bind.execute(text("CREATE INDEX IF NOT EXISTS ix_canvases_owner_id ON canvases (owner_id)"))
    bind.execute(text("CREATE INDEX IF NOT EXISTS ix_canvases_project_id ON canvases (project_id)"))

    bind.execute(text(
        """
        CREATE TABLE IF NOT EXISTS canvas_panels (
            id UUID PRIMARY KEY,
            canvas_id UUID NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
            figure_id UUID NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
            pinned_version_id UUID,
            x_mm DOUBLE PRECISION NOT NULL,
            y_mm DOUBLE PRECISION NOT NULL,
            width_mm DOUBLE PRECISION NOT NULL,
            height_mm DOUBLE PRECISION NOT NULL,
            z_order INTEGER NOT NULL DEFAULT 0,
            label VARCHAR(8),
            label_visible BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMP WITH TIME ZONE,
            updated_at TIMESTAMP WITH TIME ZONE
        )
        """
    ))
    bind.execute(text("CREATE INDEX IF NOT EXISTS ix_canvas_panels_canvas_id ON canvas_panels (canvas_id)"))
    bind.execute(text("CREATE INDEX IF NOT EXISTS ix_canvas_panels_figure_id ON canvas_panels (figure_id)"))

    # Drop the orphan table (dead since commit 106daca; replaced by the tables
    # above). Recreated verbatim on downgrade for strict reversibility.
    bind.execute(text("DROP INDEX IF EXISTS ix_figure_canvases_owner_updated"))
    bind.execute(text("DROP INDEX IF EXISTS ix_figure_canvases_project_id"))
    bind.execute(text("DROP INDEX IF EXISTS ix_figure_canvases_owner_id"))
    bind.execute(text("DROP TABLE IF EXISTS figure_canvases"))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("DROP INDEX IF EXISTS ix_canvas_panels_figure_id"))
    bind.execute(text("DROP INDEX IF EXISTS ix_canvas_panels_canvas_id"))
    bind.execute(text("DROP TABLE IF EXISTS canvas_panels"))
    bind.execute(text("DROP INDEX IF EXISTS ix_canvases_project_id"))
    bind.execute(text("DROP INDEX IF EXISTS ix_canvases_owner_id"))
    bind.execute(text("DROP TABLE IF EXISTS canvases"))

    # Recreate the orphan figure_canvases exactly as migration 20260614_0002
    # created it, restoring the pre-0019 database state.
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
