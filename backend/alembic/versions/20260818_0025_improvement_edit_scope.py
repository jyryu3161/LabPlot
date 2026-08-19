"""store localized AI improvement request scope

Revision ID: 20260818_0025
Revises: 20260817_0024
Create Date: 2026-08-18
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260818_0025"
down_revision = "20260817_0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "improvements",
        sa.Column("edit_scope", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("improvements", "edit_scope")
