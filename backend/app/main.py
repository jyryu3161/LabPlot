import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.common.exceptions import AppError, app_error_handler
from app.common.security import allowed_origins, SECURITY_HEADERS

# import models so metadata is registered before migrations
from sqlalchemy import text

from app.auth import models as _auth_models  # noqa: F401
from app.account.router import router as account_router
from app.organizations import models as _org_models  # noqa: F401
from app.projects import models as _proj_models  # noqa: F401
from app.datasets import models as _ds_models  # noqa: F401
from app.figures import models as _fig_models  # noqa: F401
from app.ai import models as _ai_models  # noqa: F401
from app.audit import models as _audit_models  # noqa: F401
from app.client_errors import models as _client_error_models  # noqa: F401
from app.palettes import models as _palette_models  # noqa: F401
from app.database import engine

from app.auth.router import router as auth_router
from app.admin.router import router as admin_router
from app.assets.router import router as assets_router
from app.client_errors.router import router as client_errors_router
from app.organizations.router import router as organizations_router
from app.projects.router import router as projects_router
from app.datasets.router import router as datasets_router
from app.figures.router import router as figures_router, meta_router
from app.palettes.router import router as palettes_router
from app.public.router import router as public_router


def _init_sentry() -> None:
    if not settings.SENTRY_DSN:
        return
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.sqlalchemy import SqlalchemyIntegration
    except Exception:
        return
    sentry_sdk.init(
        dsn=settings.SENTRY_DSN,
        environment=settings.SENTRY_ENVIRONMENT,
        release=settings.SENTRY_RELEASE or None,
        traces_sample_rate=0.05,
        profiles_sample_rate=0.0,
        integrations=[FastApiIntegration(), SqlalchemyIntegration()],
    )


_init_sentry()

app = FastAPI(
    title="LabPlot AI",
    description="AI-powered publication figure copilot",
    version="1.0.0",
    # Interactive API docs / OpenAPI schema are disabled in production and only
    # exposed when insecure dev config is explicitly allowed.
    docs_url="/docs" if settings.ALLOW_INSECURE_DEV_CONFIG else None,
    redoc_url="/redoc" if settings.ALLOW_INSECURE_DEV_CONFIG else None,
    openapi_url="/openapi.json" if settings.ALLOW_INSECURE_DEV_CONFIG else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def apply_security_headers(request, call_next):
    response = await call_next(request)
    for header, value in SECURITY_HEADERS.items():
        response.headers[header] = value
    return response


app.add_exception_handler(AppError, app_error_handler)

app.include_router(auth_router)
app.include_router(account_router)
app.include_router(admin_router)
app.include_router(assets_router)
app.include_router(client_errors_router)
app.include_router(organizations_router)
app.include_router(projects_router)
app.include_router(datasets_router)
app.include_router(figures_router)
app.include_router(meta_router)
app.include_router(palettes_router)
app.include_router(public_router)

# static mount for rendered figures (/static/figures/...)
_static_root = os.path.dirname(settings.figures_dir.rstrip("/"))
os.makedirs(settings.figures_dir, exist_ok=True)
os.makedirs(settings.upload_dir, exist_ok=True)
app.mount("/static", StaticFiles(directory=_static_root), name="static")


def _seed_root():
    from sqlalchemy.orm import Session
    from app.auth.models import User
    from app.auth.service import _hash_password, _verify_password

    with Session(engine) as db:
        existing = db.query(User).filter(User.email == settings.ROOT_EMAIL).first()
        if existing:
            changed = False
            if not _verify_password(settings.ROOT_PASSWORD, existing.hashed_password):
                existing.hashed_password = _hash_password(settings.ROOT_PASSWORD)
                existing.token_version = int(existing.token_version or 0) + 1
                changed = True
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


def _run_migrations():
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    command.upgrade(cfg, "head")


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
    settings.validate_runtime_security()
    _run_migrations()
    _seed_root()
    _seed_ai_config()
    _backfill_projects()


@app.get("/api/health")
def health_check():
    return {"status": "ok", "service": "labplot-ai", "ai_enabled": bool(settings.ANTHROPIC_API_KEY)}
