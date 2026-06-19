"""template favorite snapshots

Revision ID: 20260619_0010
Revises: 20260619_0009
Create Date: 2026-06-19
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "20260619_0010"
down_revision = "20260619_0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("ALTER TABLE figure_template_favorites ADD COLUMN IF NOT EXISTS source_version_number INTEGER"))
    bind.execute(text("ALTER TABLE figure_template_favorites ADD COLUMN IF NOT EXISTS source_plot_type VARCHAR(40)"))
    bind.execute(text("ALTER TABLE figure_template_favorites ADD COLUMN IF NOT EXISTS source_style_preset VARCHAR(40)"))
    bind.execute(text("ALTER TABLE figure_template_favorites ADD COLUMN IF NOT EXISTS source_mapping JSONB NOT NULL DEFAULT '{}'::jsonb"))
    bind.execute(text("ALTER TABLE figure_template_favorites ADD COLUMN IF NOT EXISTS source_options JSONB NOT NULL DEFAULT '{}'::jsonb"))
    bind.execute(text("""
        UPDATE figure_template_favorites fav
        SET
            source_version_id = COALESCE(fav.source_version_id, src.current_version_id),
            source_version_number = COALESCE(fav.source_version_number, src.version_number),
            source_plot_type = COALESCE(fav.source_plot_type, src.plot_type),
            source_style_preset = COALESCE(fav.source_style_preset, src.version_style_preset, src.figure_style_preset),
            source_mapping = CASE
                WHEN fav.source_mapping = '{}'::jsonb THEN COALESCE(src.mapping, '{}'::jsonb)
                ELSE fav.source_mapping
            END,
            source_options = CASE
                WHEN fav.source_options = '{}'::jsonb THEN COALESCE(src.options, '{}'::jsonb)
                ELSE fav.source_options
            END
        FROM (
            SELECT
                fav_inner.id AS favorite_id,
                f.current_version_id,
                f.plot_type,
                f.style_preset AS figure_style_preset,
                v.version_number,
                v.style_preset AS version_style_preset,
                v.mapping,
                v.options
            FROM figure_template_favorites fav_inner
            JOIN figures f ON f.id = fav_inner.figure_id
            LEFT JOIN figure_versions v ON v.id = COALESCE(fav_inner.source_version_id, f.current_version_id)
        ) src
        WHERE fav.id = src.favorite_id
    """))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("ALTER TABLE figure_template_favorites DROP COLUMN IF EXISTS source_options"))
    bind.execute(text("ALTER TABLE figure_template_favorites DROP COLUMN IF EXISTS source_mapping"))
    bind.execute(text("ALTER TABLE figure_template_favorites DROP COLUMN IF EXISTS source_style_preset"))
    bind.execute(text("ALTER TABLE figure_template_favorites DROP COLUMN IF EXISTS source_plot_type"))
    bind.execute(text("ALTER TABLE figure_template_favorites DROP COLUMN IF EXISTS source_version_number"))
