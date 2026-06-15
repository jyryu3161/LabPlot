#!/usr/bin/env python3
"""Smoke-test LabPlot object-storage code paths with the filesystem object backend.

Run inside the backend container:
  docker cp scripts/smoke_object_storage.py labplot-backend:/tmp/smoke_object_storage.py
  docker exec \
    -e STORAGE_BACKEND=filesystem_object \
    -e OBJECT_STORAGE_BUCKET=labplot-smoke \
    -e OBJECT_STORAGE_LOCAL_DIR=/tmp/labplot-object-smoke/store \
    -e OBJECT_STORAGE_CACHE_DIR=/tmp/labplot-object-smoke/cache \
    labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/smoke_object_storage.py"
"""
from __future__ import annotations

import os
import shutil
import sys
import uuid

sys.path.insert(0, os.getcwd())

from app.ai import models as _ai_models  # noqa: F401
from app.audit import models as _audit_models  # noqa: F401
from app.auth import models as _auth_models  # noqa: F401
from app.auth.models import User
from app.auth.service import _hash_password
from app.organizations import models as _organization_models  # noqa: F401
from app.common import storage
from app.common.encryption import decrypt_private_bytes
from app.database import SessionLocal
from app.datasets import service as dataset_service
from app.datasets.models import Dataset
from app.figures import service as figure_service
from app.figures.models import Figure, FigureCodeArtifact, FigureVersion
from app.figures.schemas import FigureCreate
from app.projects.models import Project


def assert_ok(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    assert_ok(storage.object_storage_enabled(), "object storage backend is not enabled")
    assert_ok(storage.backend() == "filesystem_object", "smoke requires STORAGE_BACKEND=filesystem_object")

    root_dir = os.environ.get("OBJECT_STORAGE_LOCAL_DIR", "/tmp/labplot-object-smoke/store")
    shutil.rmtree(os.path.dirname(root_dir), ignore_errors=True)

    user_id = uuid.uuid4()
    project_id = uuid.uuid4()
    email = f"smoke-object-{uuid.uuid4().hex[:8]}@example.com"
    dataset_id = None
    figure_id = None

    with SessionLocal() as db:
        user = User(
            id=user_id,
            email=email,
            hashed_password=_hash_password("SmokeObjectPass12345"),
            display_name="Smoke Object",
            is_active=True,
            is_approved=True,
            is_admin=False,
        )
        project = Project(id=project_id, owner_id=user_id, name="Smoke Object Project")
        db.add(user)
        db.add(project)
        db.commit()

        try:
            csv = b"group,value\nA,1.0\nA,2.0\nB,3.0\nB,4.0\n"
            ds = dataset_service.create_dataset(db, user_id, "object-smoke.csv", csv, name="Object smoke", project_id=project_id)
            dataset_id = ds.id
            assert_ok(ds.file_path.startswith("s3://"), f"dataset path is not object URI: {ds.file_path}")
            assert_ok(storage.exists(ds.file_path), "dataset object missing")
            assert_ok(decrypt_private_bytes(storage.read_bytes(ds.file_path)) == csv, "dataset object bytes mismatch")

            detail = figure_service.create_figure(
                db,
                user_id,
                FigureCreate(
                    dataset_id=ds.id,
                    name="Object smoke figure",
                    plot_type="box",
                    mapping={"x": "group", "y": "value"},
                    options={"show_points": True},
                    style_preset="publication",
                ),
            )
            figure_id = detail["id"]
            version = db.query(FigureVersion).filter(FigureVersion.id == detail["current_version_id"]).first()
            assert_ok(version is not None, "figure version missing")
            assert_ok(version.png_path and version.png_path.startswith("s3://"), f"png path is not object URI: {version.png_path}")
            assert_ok(version.svg_path and version.svg_path.startswith("s3://"), f"svg path is not object URI: {version.svg_path}")
            assert_ok(storage.exists(version.png_path), "png object missing")
            assert_ok(storage.exists(version.r_path), "R object missing")
            assert_ok((detail["versions"][0]["png_url"] or "").startswith("/api/assets/"), "object asset URL was not generated")

            svg = storage.read_bytes(version.svg_path).decode("utf-8")
            edited = figure_service.save_svg_edit(db, figure_id, version.id, user_id, svg, "Object storage SVG smoke")
            edited_version = db.query(FigureVersion).filter(FigureVersion.id == edited["id"]).first()
            assert_ok(edited_version and edited_version.svg_path.startswith("s3://"), "edited SVG was not stored as object")
            assert_ok(storage.exists(edited_version.svg_path), "edited SVG object missing")

            artifact_count = db.query(FigureCodeArtifact).filter(FigureCodeArtifact.owner_id == user_id).count()
            assert_ok(artifact_count >= 2, "figure code artifacts were not archived")
        finally:
            if figure_id:
                try:
                    figure_service.delete_figure(db, figure_id, user_id)
                except Exception:
                    pass
            if dataset_id:
                try:
                    dataset_service.delete_dataset(db, dataset_id, user_id)
                except Exception:
                    pass
            db.query(Dataset).filter(Dataset.owner_id == user_id).delete(synchronize_session=False)
            db.query(Figure).filter(Figure.owner_id == user_id).delete(synchronize_session=False)
            db.query(Project).filter(Project.owner_id == user_id).delete(synchronize_session=False)
            db.query(User).filter(User.id == user_id).delete(synchronize_session=False)
            db.commit()

    remaining_files = []
    if os.path.exists(root_dir):
        for current, _, files in os.walk(root_dir):
            remaining_files.extend(os.path.join(current, name) for name in files)
    assert_ok(not remaining_files, f"object smoke store was not cleaned: {remaining_files[:3]}")
    shutil.rmtree(os.path.dirname(root_dir), ignore_errors=True)
    print("PASS object storage scenario: dataset upload, render assets, SVG edit, code archive, cleanup")


if __name__ == "__main__":
    main()
