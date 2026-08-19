"""store structured AI edit context on figure versions

Revision ID: 20260817_0023
Revises: 20260707_0022
Create Date: 2026-08-17
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260817_0023"
down_revision = "20260707_0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "figure_versions",
        sa.Column("edit_context", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("figure_versions", "edit_context")
