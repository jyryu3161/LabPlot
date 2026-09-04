"""gemini 3.8 flash default

Revision ID: 20260904_0026
Revises: 20260818_0025
Create Date: 2026-09-04
"""

from alembic import op
import sqlalchemy as sa


revision = "20260904_0026"
down_revision = "20260818_0025"
branch_labels = None
depends_on = None


NEW_MODEL = "gemini-3.8-flash"
# Both previous defaults are migrated forward; rows on any other model (an
# explicit admin choice) are left alone.
OLD_MODELS = ("gemini-3.1-flash-lite", "gemini-3.5-flash")


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.text(f"ALTER TABLE ai_config ALTER COLUMN gemini_model SET DEFAULT '{NEW_MODEL}'"))
    bind.execute(sa.text(f"ALTER TABLE organization_ai_config ALTER COLUMN gemini_model SET DEFAULT '{NEW_MODEL}'"))
    for table in ("ai_config", "organization_ai_config"):
        bind.execute(
            sa.text(f"UPDATE {table} SET gemini_model = :new_model WHERE gemini_model IN :old_models").bindparams(
                sa.bindparam("old_models", expanding=True)
            ),
            {"new_model": NEW_MODEL, "old_models": list(OLD_MODELS)},
        )


def downgrade() -> None:
    bind = op.get_bind()
    old = OLD_MODELS[0]
    bind.execute(sa.text(f"ALTER TABLE ai_config ALTER COLUMN gemini_model SET DEFAULT '{old}'"))
    bind.execute(sa.text(f"ALTER TABLE organization_ai_config ALTER COLUMN gemini_model SET DEFAULT '{old}'"))
    for table in ("ai_config", "organization_ai_config"):
        bind.execute(
            sa.text(f"UPDATE {table} SET gemini_model = :old_model WHERE gemini_model = :new_model"),
            {"new_model": NEW_MODEL, "old_model": old},
        )
