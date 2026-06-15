#!/usr/bin/env python3
"""Migrate existing local dataset and figure asset paths to object storage.

Run inside the backend container after setting STORAGE_BACKEND=s3 or
STORAGE_BACKEND=filesystem_object:
  docker cp scripts/migrate_assets_to_object_storage.py labplot-backend:/tmp/migrate_assets_to_object_storage.py
  docker exec -e STORAGE_BACKEND=s3 ... labplot-backend sh -lc \
    "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/migrate_assets_to_object_storage.py --dry-run"
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.getcwd())

from app.ai import models as _ai_models  # noqa: F401
from app.audit import models as _audit_models  # noqa: F401
from app.auth import models as _auth_models  # noqa: F401
from app.auth.models import User
from app.organizations import models as _organization_models  # noqa: F401
from app.common import storage
from app.database import SessionLocal
from app.datasets.models import Dataset
from app.figures.models import Figure, FigureVersion
from app.projects import models as _project_models  # noqa: F401

_FIGURE_ATTRS = {
    "png_path": ("png", "image/png"),
    "svg_path": ("svg", "image/svg+xml"),
    "tiff_path": ("tiff", "image/tiff"),
    "pdf_path": ("pdf", "application/pdf"),
    "r_path": ("R", "text/plain"),
}


def _owner_id(db, email: str | None):
    if not email:
        return None
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise RuntimeError(f"Owner email not found: {email}")
    return user.id


def _dataset_query(db, owner_id):
    q = db.query(Dataset)
    if owner_id is not None:
        q = q.filter(Dataset.owner_id == owner_id)
    return q.order_by(Dataset.created_at.asc())


def _version_query(db, owner_id):
    q = db.query(FigureVersion, Figure)
    q = q.join(Figure, FigureVersion.figure_id == Figure.id)
    if owner_id is not None:
        q = q.filter(Figure.owner_id == owner_id)
    return q.order_by(FigureVersion.created_at.asc())


def main() -> None:
    parser = argparse.ArgumentParser(description="Move LabPlot local asset paths to object storage.")
    parser.add_argument("--apply", action="store_true", help="Update DB paths after uploading objects.")
    parser.add_argument("--delete-local", action="store_true", help="Delete local files after successful DB update.")
    parser.add_argument("--owner-email", help="Limit migration to one owner email.")
    args = parser.parse_args()

    if not storage.object_storage_enabled():
        raise RuntimeError("Set STORAGE_BACKEND=s3 or STORAGE_BACKEND=filesystem_object before running this script")

    checked_datasets = migrated_datasets = missing_datasets = 0
    checked_assets = migrated_assets = missing_assets = 0
    local_files_to_delete: list[str] = []

    with SessionLocal() as db:
        owner_id = _owner_id(db, args.owner_email)

        for ds in _dataset_query(db, owner_id):
            checked_datasets += 1
            path = ds.file_path
            if not path or storage.is_object_ref(path):
                continue
            if not os.path.exists(path):
                missing_datasets += 1
                continue
            key = storage.object_key("uploads", f"{ds.id}.{ds.format}")
            if args.apply:
                new_ref = storage.put_bytes(key, storage.read_bytes(path), content_type="application/octet-stream")
                ds.file_path = new_ref
                local_files_to_delete.append(path)
            migrated_datasets += 1

        for version, fig in _version_query(db, owner_id):
            for attr, (_, content_type) in _FIGURE_ATTRS.items():
                checked_assets += 1
                path = getattr(version, attr)
                if not path or storage.is_object_ref(path):
                    continue
                if not os.path.exists(path):
                    missing_assets += 1
                    continue
                key = storage.object_key("figures", fig.id, version.id, os.path.basename(path))
                if args.apply:
                    new_ref = storage.upload_file(path, key, content_type=content_type)
                    setattr(version, attr, new_ref)
                    local_files_to_delete.append(path)
                migrated_assets += 1

        if args.apply:
            db.commit()
            for path in local_files_to_delete:
                if args.delete_local:
                    storage.delete_file(path)
        else:
            db.rollback()

    mode = "UPDATED" if args.apply else "DRY-RUN"
    print(
        f"{mode} object storage migration: "
        f"datasets_checked={checked_datasets} datasets_to_migrate={migrated_datasets} datasets_missing={missing_datasets} "
        f"assets_checked={checked_assets} assets_to_migrate={migrated_assets} assets_missing={missing_assets}"
    )


if __name__ == "__main__":
    main()
