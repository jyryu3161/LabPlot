"""user figure template favorites

Revision ID: 20260618_0008
Revises: 20260615_0007
Create Date: 2026-06-18
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "20260618_0008"
down_revision = "20260615_0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("""
        CREATE TABLE IF NOT EXISTS figure_template_favorites (
            id UUID PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            figure_id UUID NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
            source_version_id UUID NULL REFERENCES figure_versions(id) ON DELETE SET NULL,
            name VARCHAR(255),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_figure_template_favorites_user_figure UNIQUE (user_id, figure_id)
        )
    """))
    bind.execute(text("CREATE INDEX IF NOT EXISTS ix_figure_template_favorites_user_id ON figure_template_favorites (user_id)"))
    bind.execute(text("CREATE INDEX IF NOT EXISTS ix_figure_template_favorites_figure_id ON figure_template_favorites (figure_id)"))
    bind.execute(text("CREATE INDEX IF NOT EXISTS ix_figure_template_favorites_source_version_id ON figure_template_favorites (source_version_id)"))
    bind.execute(text("""
        INSERT INTO figure_template_favorites (
            id, user_id, figure_id, source_version_id, name, created_at, updated_at
        )
        SELECT
            (
                substr(md5(f.owner_id::text || ':' || f.id::text), 1, 8) || '-' ||
                substr(md5(f.owner_id::text || ':' || f.id::text), 9, 4) || '-4' ||
                substr(md5(f.owner_id::text || ':' || f.id::text), 14, 3) || '-8' ||
                substr(md5(f.owner_id::text || ':' || f.id::text), 18, 3) || '-' ||
                substr(md5(f.owner_id::text || ':' || f.id::text), 21, 12)
            )::uuid,
            f.owner_id,
            f.id,
            f.current_version_id,
            NULL,
            COALESCE(f.updated_at, NOW()),
            COALESCE(f.updated_at, NOW())
        FROM figures f
        WHERE f.is_favorite IS TRUE
        ON CONFLICT ON CONSTRAINT uq_figure_template_favorites_user_figure DO NOTHING
    """))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("""
        UPDATE figures f
        SET is_favorite = TRUE
        FROM figure_template_favorites fav
        WHERE fav.figure_id = f.id
          AND fav.user_id = f.owner_id
    """))
    bind.execute(text("DROP TABLE IF EXISTS figure_template_favorites"))
