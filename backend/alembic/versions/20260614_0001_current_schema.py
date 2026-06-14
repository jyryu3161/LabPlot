"""current LabPlot schema baseline

Revision ID: 20260614_0001
Revises:
Create Date: 2026-06-14
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

from app.database import Base

# Register all model metadata before create_all.
from app.ai import models as _ai_models  # noqa: F401
from app.audit import models as _audit_models  # noqa: F401
from app.auth import models as _auth_models  # noqa: F401
from app.canvases import models as _canvas_models  # noqa: F401
from app.client_errors import models as _client_error_models  # noqa: F401
from app.datasets import models as _dataset_models  # noqa: F401
from app.figures import models as _figure_models  # noqa: F401
from app.organizations import models as _org_models  # noqa: F401
from app.projects import models as _project_models  # noqa: F401

revision = "20260614_0001"
down_revision = None
branch_labels = None
depends_on = None


_IDEMPOTENT_DDL = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS active_organization_id UUID",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_monthly_limit INTEGER NOT NULL DEFAULT 200",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS render_monthly_limit INTEGER NOT NULL DEFAULT 300",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_limit_mb INTEGER NOT NULL DEFAULT 1024",
    "ALTER TABLE datasets ADD COLUMN IF NOT EXISTS project_id UUID",
    "ALTER TABLE datasets ADD COLUMN IF NOT EXISTS statistics JSONB",
    "ALTER TABLE datasets ADD COLUMN IF NOT EXISTS description TEXT",
    "ALTER TABLE figures ADD COLUMN IF NOT EXISTS project_id UUID",
    "ALTER TABLE figures ADD COLUMN IF NOT EXISTS description TEXT",
    "ALTER TABLE figures ADD COLUMN IF NOT EXISTS legend TEXT",
    "CREATE INDEX IF NOT EXISTS ix_projects_owner_created ON projects (owner_id, created_at)",
    "CREATE INDEX IF NOT EXISTS ix_datasets_owner_project_created ON datasets (owner_id, project_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS ix_figures_owner_updated ON figures (owner_id, updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS ix_figures_owner_project_updated ON figures (owner_id, project_id, updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS ix_figures_owner_status_updated ON figures (owner_id, status, updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS ix_ai_usage_user_created ON ai_usage (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS ix_ai_usage_organization_created ON ai_usage (organization_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS ix_ai_usage_provider_model ON ai_usage (provider, model)",
    "CREATE INDEX IF NOT EXISTS ix_figure_code_artifacts_owner ON figure_code_artifacts (owner_id)",
    "CREATE INDEX IF NOT EXISTS ix_figure_code_artifacts_plot_type ON figure_code_artifacts (plot_type)",
    "CREATE INDEX IF NOT EXISTS ix_figure_code_artifacts_code_hash ON figure_code_artifacts (code_hash)",
    "CREATE INDEX IF NOT EXISTS ix_figure_code_artifacts_created ON figure_code_artifacts (created_at DESC)",
    "CREATE INDEX IF NOT EXISTS ix_password_reset_tokens_user_id ON password_reset_tokens (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_password_reset_tokens_token_hash ON password_reset_tokens (token_hash)",
    "CREATE INDEX IF NOT EXISTS ix_audit_logs_actor_id ON audit_logs (actor_id)",
    "CREATE INDEX IF NOT EXISTS ix_audit_logs_action ON audit_logs (action)",
    "CREATE INDEX IF NOT EXISTS ix_audit_logs_created_at ON audit_logs (created_at DESC)",
    "CREATE INDEX IF NOT EXISTS ix_client_error_events_user_id ON client_error_events (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_client_error_events_created_at ON client_error_events (created_at DESC)",
]


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)
    for stmt in _IDEMPOTENT_DDL:
        bind.execute(text(stmt))


def downgrade() -> None:
    raise RuntimeError("LabPlot baseline migration cannot be downgraded automatically")
