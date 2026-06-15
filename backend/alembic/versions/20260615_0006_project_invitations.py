"""project collaborator invitations

Revision ID: 20260615_0006
Revises: 20260615_0005
Create Date: 2026-06-15
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "20260615_0006"
down_revision = "20260615_0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("ALTER TABLE project_collaborators ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'accepted'"))
    bind.execute(text("ALTER TABLE project_collaborators ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ"))
    bind.execute(text("""
        UPDATE project_collaborators
        SET accepted_at = COALESCE(accepted_at, created_at)
        WHERE status = 'accepted'
    """))
    bind.execute(text("ALTER TABLE project_collaborators ALTER COLUMN status SET DEFAULT 'pending'"))
    bind.execute(text("CREATE INDEX IF NOT EXISTS ix_project_collaborators_status ON project_collaborators (status)"))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("DROP INDEX IF EXISTS ix_project_collaborators_status"))
    bind.execute(text("ALTER TABLE project_collaborators DROP COLUMN IF EXISTS accepted_at"))
    bind.execute(text("ALTER TABLE project_collaborators DROP COLUMN IF EXISTS status"))
