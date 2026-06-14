"""organization membership and organization AI keys

Revision ID: 20260614_0003
Revises: 20260614_0002
Create Date: 2026-06-14
"""

from __future__ import annotations

from alembic import op
from sqlalchemy import text

revision = "20260614_0003"
down_revision = "20260614_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(text("""
        CREATE TABLE IF NOT EXISTS organizations (
            id UUID PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            slug VARCHAR(120) NOT NULL UNIQUE,
            domain VARCHAR(255),
            description TEXT,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """))
    bind.execute(text("""
        CREATE TABLE IF NOT EXISTS organization_memberships (
            id UUID PRIMARY KEY,
            organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role VARCHAR(20) NOT NULL DEFAULT 'member',
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            reviewed_at TIMESTAMPTZ,
            reviewed_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
            CONSTRAINT uq_org_membership_org_user UNIQUE (organization_id, user_id)
        )
    """))
    bind.execute(text("""
        CREATE TABLE IF NOT EXISTS organization_ai_config (
            id UUID PRIMARY KEY,
            organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
            provider VARCHAR(20) NOT NULL DEFAULT 'claude',
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            claude_model VARCHAR(64) NOT NULL DEFAULT 'claude-sonnet-4-6',
            gemini_model VARCHAR(64) NOT NULL DEFAULT 'gemini-3.5-flash',
            anthropic_api_key TEXT,
            gemini_api_key TEXT,
            updated_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """))
    for stmt in [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS active_organization_id UUID",
        "ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS organization_id UUID",
        "CREATE INDEX IF NOT EXISTS ix_organizations_slug ON organizations (slug)",
        "CREATE INDEX IF NOT EXISTS ix_organizations_domain ON organizations (domain)",
        "CREATE INDEX IF NOT EXISTS ix_organizations_created_by_id ON organizations (created_by_id)",
        "CREATE INDEX IF NOT EXISTS ix_organization_memberships_organization_id ON organization_memberships (organization_id)",
        "CREATE INDEX IF NOT EXISTS ix_organization_memberships_user_id ON organization_memberships (user_id)",
        "CREATE INDEX IF NOT EXISTS ix_organization_memberships_status ON organization_memberships (status)",
        "CREATE INDEX IF NOT EXISTS ix_organization_ai_config_organization_id ON organization_ai_config (organization_id)",
        "CREATE INDEX IF NOT EXISTS ix_users_active_organization_id ON users (active_organization_id)",
        "CREATE INDEX IF NOT EXISTS ix_ai_usage_organization_id ON ai_usage (organization_id)",
        "CREATE INDEX IF NOT EXISTS ix_ai_usage_organization_created ON ai_usage (organization_id, created_at DESC)",
    ]:
        bind.execute(text(stmt))
    bind.execute(text("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'fk_users_active_organization_id'
            ) THEN
                ALTER TABLE users
                    ADD CONSTRAINT fk_users_active_organization_id
                    FOREIGN KEY (active_organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_usage_organization_id'
            ) THEN
                ALTER TABLE ai_usage
                    ADD CONSTRAINT fk_ai_usage_organization_id
                    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
            END IF;
        END $$;
    """))


def downgrade() -> None:
    raise RuntimeError("LabPlot organization migration cannot be downgraded automatically")
