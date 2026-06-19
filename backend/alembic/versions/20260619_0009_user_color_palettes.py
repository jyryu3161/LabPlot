"""user color palettes

Revision ID: 20260619_0009
Revises: 20260618_0008
Create Date: 2026-06-19
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "20260619_0009"
down_revision = "20260618_0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("""
        CREATE TABLE IF NOT EXISTS user_color_palettes (
            id UUID PRIMARY KEY,
            owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name VARCHAR(100) NOT NULL,
            colors JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_user_color_palettes_owner_name UNIQUE (owner_id, name)
        )
    """))
    bind.execute(text("CREATE INDEX IF NOT EXISTS ix_user_color_palettes_owner_id ON user_color_palettes (owner_id)"))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("DROP TABLE IF EXISTS user_color_palettes"))
