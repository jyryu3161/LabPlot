#!/usr/bin/env python3
"""Retention cleanup for LabPlot operational data.

Run inside the backend container:
  docker cp scripts/retention_cleanup.py labplot-backend:/tmp/retention_cleanup.py
  docker exec labplot-backend sh -lc "cd /app/backend && /app/.pixi/envs/default/bin/python /tmp/retention_cleanup.py --dry-run"
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.getcwd())

from app.ai import models as _ai_models  # noqa: F401
from app.audit.models import AuditLog
from app.auth import models as _auth_models  # noqa: F401
from app.auth.models import PasswordResetToken
from app.config import settings
from app.database import SessionLocal
from app.datasets.models import Dataset
from app.figures.models import Figure
from app.projects import models as _project_models  # noqa: F401
from app.figures import models as _figure_models  # noqa: F401


def _cutoff(days: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=days)


def _dataset_paths(db) -> set[str]:
    return {path for (path,) in db.query(Dataset.file_path).all() if path}


def _figure_ids(db) -> set[str]:
    return {str(fid) for (fid,) in db.query(Figure.id).all()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--audit-days", type=int, default=int(os.environ.get("AUDIT_LOG_RETENTION_DAYS", "365")))
    parser.add_argument("--password-reset-days", type=int, default=int(os.environ.get("PASSWORD_RESET_TOKEN_RETENTION_DAYS", "30")))
    parser.add_argument("--orphan-files", action="store_true")
    args = parser.parse_args()

    with SessionLocal() as db:
        audit_q = db.query(AuditLog).filter(AuditLog.created_at < _cutoff(args.audit_days))
        reset_q = db.query(PasswordResetToken).filter(
            (PasswordResetToken.used_at.isnot(None)) | (PasswordResetToken.expires_at < _cutoff(args.password_reset_days))
        )
        audit_count = audit_q.count()
        reset_count = reset_q.count()

        orphan_uploads: list[str] = []
        orphan_figure_dirs: list[str] = []
        if args.orphan_files:
            known_datasets = _dataset_paths(db)
            if os.path.isdir(settings.upload_dir):
                for name in os.listdir(settings.upload_dir):
                    path = os.path.join(settings.upload_dir, name)
                    if os.path.isfile(path) and path not in known_datasets:
                        orphan_uploads.append(path)
            known_figures = _figure_ids(db)
            if os.path.isdir(settings.figures_dir):
                for name in os.listdir(settings.figures_dir):
                    path = os.path.join(settings.figures_dir, name)
                    if os.path.isdir(path) and name not in known_figures:
                        orphan_figure_dirs.append(path)

        if not args.dry_run:
            audit_q.delete(synchronize_session=False)
            reset_q.delete(synchronize_session=False)
            for path in orphan_uploads:
                try:
                    os.remove(path)
                except OSError:
                    pass
            for path in orphan_figure_dirs:
                shutil.rmtree(path, ignore_errors=True)
            db.commit()

    mode = "DRY-RUN" if args.dry_run else "UPDATED"
    print(
        f"{mode} retention cleanup: audit_logs={audit_count} password_reset_tokens={reset_count} "
        f"orphan_uploads={len(orphan_uploads)} orphan_figure_dirs={len(orphan_figure_dirs)}"
    )


if __name__ == "__main__":
    main()
