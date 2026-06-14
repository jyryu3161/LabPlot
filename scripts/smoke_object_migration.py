#!/usr/bin/env python3
"""Smoke-test migration of existing local assets to object storage."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import uuid

sys.path.insert(0, os.getcwd())

from app.ai import models as _ai_models  # noqa: F401
from app.audit import models as _audit_models  # noqa: F401
from app.auth import models as _auth_models  # noqa: F401
from app.auth.models import User
from app.auth.service import _hash_password
from app.common import storage
from app.config import settings
from app.database import SessionLocal
from app.datasets import service as dataset_service
from app.datasets.models import Dataset
from app.figures import service as figure_service
from app.figures.models import Figure, FigureVersion
from app.figures.schemas import FigureCreate
from app.projects.models import Project


def assert_ok(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _set_storage(mode: str, root_dir: str) -> None:
    settings.STORAGE_BACKEND = mode
    settings.OBJECT_STORAGE_BUCKET = "labplot-migration-smoke"
    settings.OBJECT_STORAGE_PREFIX = "labplot"
    settings.OBJECT_STORAGE_LOCAL_DIR = os.path.join(root_dir, "store")
    settings.OBJECT_STORAGE_CACHE_DIR = os.path.join(root_dir, "cache")


def _cleanup(email: str, root_dir: str) -> None:
    _set_storage("filesystem_object", root_dir)
    with SessionLocal() as db:
        user = db.query(User).filter(User.email == email).first()
        if user:
            for (fig_id,) in db.query(Figure.id).filter(Figure.owner_id == user.id).all():
                try:
                    figure_service.delete_figure(db, fig_id, user.id)
                except Exception:
                    pass
            for ds in list(db.query(Dataset).filter(Dataset.owner_id == user.id).all()):
                try:
                    dataset_service.delete_dataset(db, ds.id, user.id)
                except Exception:
                    pass
            db.query(Project).filter(Project.owner_id == user.id).delete(synchronize_session=False)
            db.query(User).filter(User.id == user.id).delete(synchronize_session=False)
            db.commit()
    shutil.rmtree(root_dir, ignore_errors=True)


def main() -> None:
    root_dir = os.environ.get("OBJECT_MIGRATION_SMOKE_DIR", "/tmp/labplot-object-migration-smoke")
    migration_script = os.environ.get("MIGRATION_SCRIPT_PATH", "/tmp/migrate_assets_to_object_storage.py")
    if not os.path.exists(migration_script):
        migration_script = "scripts/migrate_assets_to_object_storage.py"

    shutil.rmtree(root_dir, ignore_errors=True)
    email = f"smoke-object-migrate-{uuid.uuid4().hex[:8]}@example.com"
    user_id = uuid.uuid4()
    project_id = uuid.uuid4()
    figure_id = None
    dataset_id = None

    try:
        _set_storage("local", root_dir)
        with SessionLocal() as db:
            user = User(
                id=user_id,
                email=email,
                hashed_password=_hash_password("SmokeMigratePass12345"),
                display_name="Smoke Migrate",
                is_active=True,
                is_approved=True,
                is_admin=False,
            )
            project = Project(id=project_id, owner_id=user_id, name="Smoke Migration Project")
            db.add(user)
            db.add(project)
            db.commit()

            ds = dataset_service.create_dataset(
                db,
                user_id,
                "migration-smoke.csv",
                b"group,value\nA,1\nB,2\n",
                name="Migration smoke",
                project_id=project_id,
            )
            dataset_id = ds.id
            detail = figure_service.create_figure(
                db,
                user_id,
                FigureCreate(
                    dataset_id=ds.id,
                    name="Migration smoke figure",
                    plot_type="box",
                    mapping={"x": "group", "y": "value"},
                    options={},
                    style_preset="publication",
                ),
            )
            figure_id = detail["id"]
            version = db.query(FigureVersion).filter(FigureVersion.id == detail["current_version_id"]).first()
            assert_ok(ds.file_path and not ds.file_path.startswith("s3://"), f"dataset was not local: {ds.file_path}")
            assert_ok(version and version.png_path and not version.png_path.startswith("s3://"), f"figure was not local: {version.png_path if version else None}")

        env = {
            **os.environ,
            "STORAGE_BACKEND": "filesystem_object",
            "OBJECT_STORAGE_BUCKET": settings.OBJECT_STORAGE_BUCKET,
            "OBJECT_STORAGE_PREFIX": settings.OBJECT_STORAGE_PREFIX,
            "OBJECT_STORAGE_LOCAL_DIR": settings.OBJECT_STORAGE_LOCAL_DIR,
            "OBJECT_STORAGE_CACHE_DIR": settings.OBJECT_STORAGE_CACHE_DIR,
        }
        subprocess.run(
            [
                sys.executable,
                migration_script,
                "--apply",
                "--delete-local",
                "--owner-email",
                email,
            ],
            cwd=os.getcwd(),
            env=env,
            check=True,
        )

        _set_storage("filesystem_object", root_dir)
        with SessionLocal() as db:
            ds = db.query(Dataset).filter(Dataset.id == dataset_id).first()
            version = (
                db.query(FigureVersion)
                .join(Figure, FigureVersion.figure_id == Figure.id)
                .filter(Figure.id == figure_id)
                .first()
            )
            assert_ok(ds and ds.file_path.startswith("s3://") and storage.exists(ds.file_path), "dataset object migration failed")
            assert_ok(version and version.png_path.startswith("s3://") and storage.exists(version.png_path), "figure object migration failed")
    finally:
        _cleanup(email, root_dir)

    print("PASS object migration scenario: local assets migrated to object URIs and cleaned")


if __name__ == "__main__":
    main()
