"""figure comments

Revision ID: 20260702_0016
Revises: 20260702_0015
Create Date: 2026-07-02
"""

from alembic import op
import sqlalchemy as sa


revision = "20260702_0016"
down_revision = "20260702_0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(
        """
        CREATE TABLE IF NOT EXISTS figure_comments (
            id UUID PRIMARY KEY,
            figure_id UUID NOT NULL REFERENCES figures (id) ON DELETE CASCADE,
            author_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            body TEXT NOT NULL,
            created_at TIMESTAMPTZ
        )
        """
    ))
    bind.execute(sa.text(
        "CREATE INDEX IF NOT EXISTS ix_figure_comments_figure_id ON figure_comments (figure_id)"
    ))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text("DROP INDEX IF EXISTS ix_figure_comments_figure_id"))
    bind.execute(sa.text("DROP TABLE IF EXISTS figure_comments"))
