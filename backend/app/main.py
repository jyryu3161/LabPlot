import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.common.exceptions import AppError, app_error_handler
from app.common.security import SECURITY_HEADERS, allowed_origins

# import models so metadata is registered before create_all
from sqlalchemy import text

from app.auth import models as _auth_models  # noqa: F401
from app.projects import models as _proj_models  # noqa: F401
from app.datasets import models as _ds_models  # noqa: F401
from app.figures import models as _fig_models  # noqa: F401
from app.ai import models as _ai_models  # noqa: F401
from app.database import Base, engine

from app.auth.router import router as auth_router
from app.admin.router import router as admin_router
from app.projects.router import router as projects_router
from app.datasets.router import router as datasets_router
from app.figures.router import router as figures_router, meta_router
from app.public.router import router as public_router

app = FastAPI(title="LabPlot AI", description="AI-powered publication figure copilot", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_security_headers(request, call_next):
    response = await call_next(request)
    for key, value in SECURITY_HEADERS.items():
        response.headers.setdefault(key, value)
    return response


app.add_exception_handler(AppError, app_error_handler)

app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(projects_router)
app.include_router(datasets_router)
app.include_router(figures_router)
app.include_router(meta_router)
app.include_router(public_router)

# static mount for rendered figures (/static/figures/...)
_static_root = os.path.dirname(settings.figures_dir.rstrip("/"))
os.makedirs(settings.figures_dir, exist_ok=True)
os.makedirs(settings.upload_dir, exist_ok=True)
app.mount("/static", StaticFiles(directory=_static_root), name="static")


def _seed_root():
    from sqlalchemy.orm import Session
    from app.auth.models import User
    from app.auth.service import _hash_password

    with Session(engine) as db:
        existing = db.query(User).filter(User.email == settings.ROOT_EMAIL).first()
        if existing:
            changed = False
            if not existing.is_admin:
                existing.is_admin = True
                changed = True
            if not existing.is_active:
                existing.is_active = True
                changed = True
            if not existing.is_approved:
                existing.is_approved = True
                changed = True
            if changed:
                db.commit()
            return
        root = User(
            email=settings.ROOT_EMAIL,
            hashed_password=_hash_password(settings.ROOT_PASSWORD),
            display_name="Root Admin",
            is_active=True,
            is_approved=True,
            is_admin=True,
        )
        db.add(root)
        db.commit()


def _seed_ai_config():
    from sqlalchemy.orm import Session
    from app.ai.config_service import get_config
    with Session(engine) as db:
        get_config(db)  # creates the single config row from env defaults if absent


_MIGRATIONS = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0",
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
    """
    CREATE TABLE IF NOT EXISTS ai_usage (
        id UUID PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        provider VARCHAR(20) NOT NULL,
        model VARCHAR(128) NOT NULL,
        feature VARCHAR(64) NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_ai_usage_user_created ON ai_usage (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS ix_ai_usage_provider_model ON ai_usage (provider, model)",
    """
    CREATE TABLE IF NOT EXISTS figure_code_artifacts (
        id UUID PRIMARY KEY,
        owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
        dataset_id UUID REFERENCES datasets(id) ON DELETE SET NULL,
        figure_id UUID REFERENCES figures(id) ON DELETE SET NULL,
        figure_version_id UUID UNIQUE REFERENCES figure_versions(id) ON DELETE SET NULL,
        plot_type VARCHAR(40) NOT NULL,
        style_preset VARCHAR(40) NOT NULL DEFAULT 'nature',
        mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
        options JSONB NOT NULL DEFAULT '{}'::jsonb,
        dataset_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
        r_code TEXT NOT NULL,
        render_log TEXT,
        code_hash VARCHAR(64) NOT NULL,
        reusable BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_figure_code_artifacts_owner ON figure_code_artifacts (owner_id)",
    "CREATE INDEX IF NOT EXISTS ix_figure_code_artifacts_plot_type ON figure_code_artifacts (plot_type)",
    "CREATE INDEX IF NOT EXISTS ix_figure_code_artifacts_code_hash ON figure_code_artifacts (code_hash)",
    "CREATE INDEX IF NOT EXISTS ix_figure_code_artifacts_created ON figure_code_artifacts (created_at DESC)",
    """
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_password_reset_tokens_user_id ON password_reset_tokens (user_id)",
    "CREATE INDEX IF NOT EXISTS ix_password_reset_tokens_token_hash ON password_reset_tokens (token_hash)",
]


def _light_migrations():
    with engine.begin() as conn:
        for stmt in _MIGRATIONS:
            conn.execute(text(stmt))


def _backfill_projects():
    from sqlalchemy.orm import Session
    from app.auth.models import User
    from app.projects.service import ensure_default_project
    with Session(engine) as db:
        needs_work = db.execute(text("""
            SELECT EXISTS (
                SELECT 1 FROM users u
                WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.owner_id = u.id)
            )
            OR EXISTS (SELECT 1 FROM datasets WHERE project_id IS NULL)
            OR EXISTS (SELECT 1 FROM figures WHERE project_id IS NULL)
        """)).scalar()
        if not needs_work:
            return
        for u in db.query(User).all():
            proj = ensure_default_project(db, u.id)
            db.execute(text("UPDATE datasets SET project_id = :p WHERE owner_id = :o AND project_id IS NULL"),
                       {"p": str(proj.id), "o": str(u.id)})
            db.execute(text("UPDATE figures SET project_id = :p WHERE owner_id = :o AND project_id IS NULL"),
                       {"p": str(proj.id), "o": str(u.id)})
            db.commit()


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)
    _light_migrations()
    _seed_root()
    _seed_ai_config()
    _backfill_projects()


@app.get("/api/health")
def health_check():
    return {"status": "ok", "service": "labplot-ai", "ai_enabled": bool(settings.ANTHROPIC_API_KEY)}
