"""gemini flash lite default

Revision ID: 20260619_0012
Revises: 20260619_0011
Create Date: 2026-06-19
"""

from alembic import op
import sqlalchemy as sa


revision = "20260619_0012"
down_revision = "20260619_0011"
branch_labels = None
depends_on = None


NEW_MODEL = "gemini-3.1-flash-lite"
OLD_MODEL = "gemini-3.5-flash"


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(f"ALTER TABLE ai_config ALTER COLUMN gemini_model SET DEFAULT '{NEW_MODEL}'"))
    bind.execute(sa.text(f"ALTER TABLE organization_ai_config ALTER COLUMN gemini_model SET DEFAULT '{NEW_MODEL}'"))
    bind.execute(
        sa.text("UPDATE ai_config SET gemini_model = :new_model WHERE gemini_model = :old_model"),
        {"new_model": NEW_MODEL, "old_model": OLD_MODEL},
    )
    bind.execute(
        sa.text("UPDATE organization_ai_config SET gemini_model = :new_model WHERE gemini_model = :old_model"),
        {"new_model": NEW_MODEL, "old_model": OLD_MODEL},
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(f"ALTER TABLE ai_config ALTER COLUMN gemini_model SET DEFAULT '{OLD_MODEL}'"))
    bind.execute(sa.text(f"ALTER TABLE organization_ai_config ALTER COLUMN gemini_model SET DEFAULT '{OLD_MODEL}'"))
    bind.execute(
        sa.text("UPDATE ai_config SET gemini_model = :old_model WHERE gemini_model = :new_model"),
        {"new_model": NEW_MODEL, "old_model": OLD_MODEL},
    )
    bind.execute(
        sa.text("UPDATE organization_ai_config SET gemini_model = :old_model WHERE gemini_model = :new_model"),
        {"new_model": NEW_MODEL, "old_model": OLD_MODEL},
    )
