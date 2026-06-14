from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import uuid
import zipfile
from datetime import datetime
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.audit import service as audit_service
from app.auth.models import PasswordResetToken, User
from app.auth.service import _verify_password
from app.common import storage
from app.common.encryption import decrypt_private_bytes
from app.common.exceptions import BadRequestError
from app.config import settings
from app.datasets.models import Dataset
from app.figures.models import Figure, FigureCodeArtifact, FigureVersion, Improvement, Review
from app.projects.models import Project


def _jsonable(value: Any) -> Any:
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    return value


def _safe_name(name: str | None, fallback: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9_.-]+", "_", (name or fallback).strip())
    return clean[:160] or fallback


def build_account_export(db: Session, user: User) -> tuple[str, str]:
    projects = db.query(Project).filter(Project.owner_id == user.id).order_by(Project.created_at.asc()).all()
    datasets = db.query(Dataset).filter(Dataset.owner_id == user.id).order_by(Dataset.created_at.asc()).all()
    figures = db.query(Figure).filter(Figure.owner_id == user.id).order_by(Figure.created_at.asc()).all()
    version_rows = (
        db.query(FigureVersion)
        .join(Figure, FigureVersion.figure_id == Figure.id)
        .filter(Figure.owner_id == user.id)
        .order_by(FigureVersion.created_at.asc())
        .all()
    )
    reviews = (
        db.query(Review)
        .join(FigureVersion, Review.figure_version_id == FigureVersion.id)
        .join(Figure, FigureVersion.figure_id == Figure.id)
        .filter(Figure.owner_id == user.id)
        .all()
    )
    improvements = (
        db.query(Improvement)
        .join(FigureVersion, Improvement.figure_version_id == FigureVersion.id)
        .join(Figure, FigureVersion.figure_id == Figure.id)
        .filter(Figure.owner_id == user.id)
        .all()
    )
    artifacts = db.query(FigureCodeArtifact).filter(FigureCodeArtifact.owner_id == user.id).all()
    audit_logs = (
        db.query(AuditLog)
        .filter(AuditLog.actor_id == user.id)
        .order_by(AuditLog.created_at.asc())
        .limit(5000)
        .all()
    )

    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as z:
        manifest = {
            "exported_at": datetime.utcnow().isoformat() + "Z",
            "user": {
                "id": user.id,
                "email": user.email,
                "display_name": user.display_name,
                "created_at": user.created_at,
            },
            "counts": {
                "projects": len(projects),
                "datasets": len(datasets),
                "figures": len(figures),
                "versions": len(version_rows),
                "reviews": len(reviews),
                "improvements": len(improvements),
                "code_artifacts": len(artifacts),
                "audit_events": len(audit_logs),
            },
        }
        z.writestr("manifest.json", json.dumps(_jsonable(manifest), indent=2, ensure_ascii=False))
        z.writestr("account/profile.json", json.dumps(_jsonable(manifest["user"]), indent=2, ensure_ascii=False))
        z.writestr(
            "account/audit_events.json",
            json.dumps(
                _jsonable([
                    {
                        "id": row.id,
                        "action": row.action,
                        "target_type": row.target_type,
                        "target_id": row.target_id,
                        "metadata": row.metadata_json,
                        "created_at": row.created_at,
                    }
                    for row in audit_logs
                ]),
                indent=2,
                ensure_ascii=False,
            ),
        )
        z.writestr(
            "projects/projects.json",
            json.dumps(
                _jsonable([
                    {"id": p.id, "name": p.name, "description": p.description, "created_at": p.created_at, "updated_at": p.updated_at}
                    for p in projects
                ]),
                indent=2,
                ensure_ascii=False,
            ),
        )
        z.writestr(
            "datasets/datasets.json",
            json.dumps(
                _jsonable([
                    {
                        "id": ds.id,
                        "project_id": ds.project_id,
                        "name": ds.name,
                        "description": ds.description,
                        "original_filename": ds.original_filename,
                        "format": ds.format,
                        "n_rows": ds.n_rows,
                        "n_cols": ds.n_cols,
                        "column_profile": ds.column_profile,
                        "statistics": ds.statistics,
                        "created_at": ds.created_at,
                    }
                    for ds in datasets
                ]),
                indent=2,
                ensure_ascii=False,
            ),
        )
        for ds in datasets:
            if ds.file_path and storage.exists(ds.file_path):
                raw = decrypt_private_bytes(storage.read_bytes(ds.file_path))
                fname = _safe_name(ds.original_filename, f"{ds.id}.{ds.format}")
                z.writestr(f"datasets/files/{ds.id}_{fname}", raw)

        z.writestr(
            "figures/figures.json",
            json.dumps(
                _jsonable([
                    {
                        "id": fig.id,
                        "project_id": fig.project_id,
                        "dataset_id": fig.dataset_id,
                        "name": fig.name,
                        "plot_type": fig.plot_type,
                        "style_preset": fig.style_preset,
                        "status": fig.status,
                        "legend": fig.legend,
                        "description": fig.description,
                        "current_version_id": fig.current_version_id,
                        "created_at": fig.created_at,
                        "updated_at": fig.updated_at,
                    }
                    for fig in figures
                ]),
                indent=2,
                ensure_ascii=False,
            ),
        )
        for version in version_rows:
            fig = next((f for f in figures if f.id == version.figure_id), None)
            fig_name = _safe_name(fig.name if fig else None, str(version.figure_id))
            prefix = f"figures/files/{fig_name}/v{version.version_number:03d}"
            z.writestr(
                f"{prefix}/version.json",
                json.dumps(
                    _jsonable({
                        "id": version.id,
                        "figure_id": version.figure_id,
                        "version_number": version.version_number,
                        "mapping": version.mapping,
                        "options": version.options,
                        "style_preset": version.style_preset,
                        "change_note": version.change_note,
                        "render_log": version.render_log,
                        "created_at": version.created_at,
                    }),
                    indent=2,
                    ensure_ascii=False,
                ),
            )
            for attr, ext in (("png_path", "png"), ("svg_path", "svg"), ("tiff_path", "tiff"), ("pdf_path", "pdf"), ("r_path", "R")):
                path = getattr(version, attr, None)
                if path and storage.exists(path):
                    z.writestr(f"{prefix}/figure.{ext}", storage.read_bytes(path))

        z.writestr(
            "figures/reviews.json",
            json.dumps(_jsonable([{"id": r.id, "figure_version_id": r.figure_version_id, "payload": r.payload, "created_at": r.created_at} for r in reviews]), indent=2, ensure_ascii=False),
        )
        z.writestr(
            "figures/improvements.json",
            json.dumps(_jsonable([{"id": i.id, "figure_version_id": i.figure_version_id, "param_patch": i.param_patch, "applied": i.applied, "created_at": i.created_at} for i in improvements]), indent=2, ensure_ascii=False),
        )
        z.writestr(
            "figures/code_artifacts.json",
            json.dumps(_jsonable([{"id": a.id, "figure_id": a.figure_id, "figure_version_id": a.figure_version_id, "plot_type": a.plot_type, "style_preset": a.style_preset, "code_hash": a.code_hash, "created_at": a.created_at} for a in artifacts]), indent=2, ensure_ascii=False),
        )
    return tmp.name, f"labplot-account-export-{_safe_name(user.email, str(user.id))}.zip"


def _assert_can_delete_self(db: Session, user: User, password: str) -> None:
    if not _verify_password(password, user.hashed_password):
        raise BadRequestError("Password confirmation failed", error_code="PASSWORD_CONFIRMATION_FAILED")
    if user.is_admin:
        admins = (
            db.query(func.count(User.id))
            .filter(User.is_admin == True, User.is_active == True, User.is_approved == True)
            .scalar()
            or 0
        )
        if admins <= 1:
            raise BadRequestError("The last active admin account cannot be deleted", error_code="LAST_ADMIN_DELETE_BLOCKED")


def scrub_user_audit_subject(db: Session, user_id: uuid.UUID) -> None:
    rows = db.query(AuditLog).filter((AuditLog.actor_id == user_id) | (AuditLog.target_id == str(user_id))).all()
    for row in rows:
        row.actor_id = None if row.actor_id == user_id else row.actor_id
        row.target_id = None if row.target_id == str(user_id) else row.target_id
        row.metadata_json = {"redacted_subject": True}


def delete_own_account(db: Session, user: User, password: str, request=None) -> None:
    _assert_can_delete_self(db, user, password)
    dataset_paths = [path for (path,) in db.query(Dataset.file_path).filter(Dataset.owner_id == user.id).all() if path]
    figure_ids = [fid for (fid,) in db.query(Figure.id).filter(Figure.owner_id == user.id).all()]
    audit_service.log_event(
        db,
        actor_id=user.id,
        action="account.delete",
        target_type="user",
        target_id=user.id,
        metadata={},
        request=request,
    )
    scrub_user_audit_subject(db, user.id)
    db.query(PasswordResetToken).filter(PasswordResetToken.user_id == user.id).delete(synchronize_session=False)
    db.query(FigureCodeArtifact).filter(FigureCodeArtifact.owner_id == user.id).delete(synchronize_session=False)
    db.delete(user)
    db.commit()
    for path in dataset_paths:
        storage.delete_file(path)
    for figure_id in figure_ids:
        shutil.rmtree(os.path.join(settings.figures_dir, str(figure_id)), ignore_errors=True)
        if storage.object_storage_enabled():
            storage.delete_prefix(f"figures/{figure_id}")
