"""project collaborators

Revision ID: 20260615_0005
Revises: 20260615_0004
Create Date: 2026-06-15
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "20260615_0005"
down_revision = "20260615_0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("""
        CREATE TABLE IF NOT EXISTS project_collaborators (
            id UUID PRIMARY KEY,
            project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role VARCHAR(20) NOT NULL DEFAULT 'editor',
            added_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_project_collaborator_project_user UNIQUE (project_id, user_id)
        )
    """))
    bind.execute(text("CREATE INDEX IF NOT EXISTS ix_project_collaborators_project_id ON project_collaborators (project_id)"))
    bind.execute(text("CREATE INDEX IF NOT EXISTS ix_project_collaborators_user_id ON project_collaborators (user_id)"))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("DROP TABLE IF EXISTS project_collaborators"))
