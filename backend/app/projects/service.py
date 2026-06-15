import os
import re
import shutil
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.common import storage
from app.auth.models import User
from app.common.exceptions import BadRequestError, ForbiddenError, NotFoundError
from app.config import settings
from app.datasets.models import Dataset
from app.figures.models import Figure, FigureVersion
from app.projects.models import Project, ProjectCollaborator

WRITE_ROLES = {"editor"}
ACCEPTED_STATUS = "accepted"
PENDING_STATUS = "pending"


def ensure_default_project(db: Session, owner_id: uuid.UUID) -> Project:
    proj = (db.query(Project).filter(Project.owner_id == owner_id)
            .order_by(Project.created_at.asc()).first())
    if proj is None:
        proj = Project(owner_id=owner_id, name="My Project",
                       description="Default project")
        db.add(proj)
        db.commit()
        db.refresh(proj)
    return proj


def _project_role(db: Session, project_id: uuid.UUID, user_id: uuid.UUID) -> str | None:
    owner = db.query(Project.id).filter(Project.id == project_id, Project.owner_id == user_id).first()
    if owner:
        return "owner"
    collab = (
        db.query(ProjectCollaborator)
        .filter(
            ProjectCollaborator.project_id == project_id,
            ProjectCollaborator.user_id == user_id,
            ProjectCollaborator.status == ACCEPTED_STATUS,
        )
        .first()
    )
    return collab.role if collab else None


def accessible_project_ids(db: Session, user_id: uuid.UUID) -> list[uuid.UUID]:
    owned = [pid for (pid,) in db.query(Project.id).filter(Project.owner_id == user_id).all()]
    shared = [
        pid for (pid,) in db.query(ProjectCollaborator.project_id)
        .filter(ProjectCollaborator.user_id == user_id, ProjectCollaborator.status == ACCEPTED_STATUS)
        .all()
    ]
    return list(dict.fromkeys([*owned, *shared]))


def can_access_project(db: Session, project_id: uuid.UUID | None, user_id: uuid.UUID) -> bool:
    if project_id is None:
        return False
    return _project_role(db, project_id, user_id) is not None


def can_write_project(db: Session, project_id: uuid.UUID | None, user_id: uuid.UUID) -> bool:
    if project_id is None:
        return False
    role = _project_role(db, project_id, user_id)
    return role == "owner" or role in WRITE_ROLES


def require_project_write(db: Session, project_id: uuid.UUID | None, user_id: uuid.UUID) -> None:
    if project_id is None or not can_write_project(db, project_id, user_id):
        raise ForbiddenError("You do not have edit access to this project")


def _project_collaborators(db: Session, project_id: uuid.UUID) -> list[dict]:
    rows = (
        db.query(ProjectCollaborator, User.email, User.display_name)
        .join(User, ProjectCollaborator.user_id == User.id)
        .filter(ProjectCollaborator.project_id == project_id)
        .order_by(User.display_name.asc(), User.email.asc())
        .all()
    )
    return [
        {
            "id": row.id,
            "user_id": row.user_id,
            "email": email,
            "display_name": display_name,
            "role": row.role,
            "status": row.status,
            "created_at": row.created_at,
            "accepted_at": row.accepted_at,
        }
        for row, email, display_name in rows
    ]


def _project_response(db: Session, project: Project, viewer_id: uuid.UUID) -> dict:
    return {
        "id": project.id,
        "owner_id": project.owner_id,
        "name": project.name,
        "description": project.description,
        "created_at": project.created_at,
        "updated_at": project.updated_at,
        "role": _project_role(db, project.id, viewer_id) or "viewer",
        "collaborators": _project_collaborators(db, project.id),
    }


def list_projects(db: Session, owner_id: uuid.UUID) -> list[dict]:
    projects = (
        db.query(Project)
        .outerjoin(ProjectCollaborator, ProjectCollaborator.project_id == Project.id)
        .filter(or_(
            Project.owner_id == owner_id,
            (ProjectCollaborator.user_id == owner_id) & (ProjectCollaborator.status == ACCEPTED_STATUS),
        ))
        .order_by(Project.created_at.asc())
        .distinct()
        .all()
    )
    if not projects:
        return []
    ids = [p.id for p in projects]
    dsc = dict(db.query(Dataset.project_id, func.count(Dataset.id))
               .filter(Dataset.project_id.in_(ids)).group_by(Dataset.project_id).all())
    fic = dict(db.query(Figure.project_id, func.count(Figure.id))
               .filter(Figure.project_id.in_(ids)).group_by(Figure.project_id).all())
    coc = dict(db.query(ProjectCollaborator.project_id, func.count(ProjectCollaborator.id))
               .filter(ProjectCollaborator.project_id.in_(ids)).group_by(ProjectCollaborator.project_id).all())
    return [{
        "id": p.id, "owner_id": p.owner_id, "name": p.name, "description": p.description,
        "created_at": p.created_at, "updated_at": p.updated_at,
        "dataset_count": dsc.get(p.id, 0), "figure_count": fic.get(p.id, 0),
        "collaborator_count": coc.get(p.id, 0),
        "role": _project_role(db, p.id, owner_id) or "viewer",
    } for p in projects]


def get_project_model(db: Session, project_id: uuid.UUID, user_id: uuid.UUID) -> Project:
    p = db.query(Project).filter(Project.id == project_id).first()
    if not p:
        raise NotFoundError("Project", str(project_id))
    if not can_access_project(db, project_id, user_id):
        raise NotFoundError("Project", str(project_id))
    return p


def get_project(db: Session, project_id: uuid.UUID, owner_id: uuid.UUID) -> dict:
    return _project_response(db, get_project_model(db, project_id, owner_id), owner_id)


def add_collaborator(db: Session, project_id: uuid.UUID, owner_id: uuid.UUID, user_id: uuid.UUID,
                     role: str = "editor") -> dict:
    project = get_project_model(db, project_id, owner_id)
    if project.owner_id != owner_id:
        raise ForbiddenError("Only the project owner can manage collaborators")
    if user_id == owner_id:
        raise BadRequestError("Project owner is already included", error_code="OWNER_COLLABORATOR")
    user = (
        db.query(User)
        .filter(User.id == user_id, User.is_active.is_(True), User.is_approved.is_(True))
        .first()
    )
    if not user:
        raise NotFoundError("User", str(user_id))
    if role not in {"editor", "viewer"}:
        role = "editor"
    existing = (
        db.query(ProjectCollaborator)
        .filter(ProjectCollaborator.project_id == project_id, ProjectCollaborator.user_id == user_id)
        .first()
    )
    if existing:
        existing.role = role
        existing.status = PENDING_STATUS
        existing.accepted_at = None
        row = existing
    else:
        row = ProjectCollaborator(
            project_id=project_id,
            user_id=user_id,
            role=role,
            status=PENDING_STATUS,
            added_by_id=owner_id,
        )
        db.add(row)
    db.commit()
    db.refresh(row)
    return next(item for item in _project_collaborators(db, project_id) if item["id"] == row.id)


def remove_collaborator(db: Session, project_id: uuid.UUID, owner_id: uuid.UUID, collaborator_id: uuid.UUID) -> None:
    project = get_project_model(db, project_id, owner_id)
    if project.owner_id != owner_id:
        raise ForbiddenError("Only the project owner can manage collaborators")
    row = (
        db.query(ProjectCollaborator)
        .filter(ProjectCollaborator.id == collaborator_id, ProjectCollaborator.project_id == project_id)
        .first()
    )
    if not row:
        raise NotFoundError("Project collaborator", str(collaborator_id))
    db.delete(row)
    db.commit()


def list_collaborators(db: Session, project_id: uuid.UUID, user_id: uuid.UUID) -> list[dict]:
    get_project_model(db, project_id, user_id)
    return _project_collaborators(db, project_id)


def list_invitations(db: Session, user_id: uuid.UUID) -> list[dict]:
    rows = (
        db.query(ProjectCollaborator, Project, User.display_name, User.email)
        .join(Project, ProjectCollaborator.project_id == Project.id)
        .join(User, Project.owner_id == User.id)
        .filter(ProjectCollaborator.user_id == user_id, ProjectCollaborator.status == PENDING_STATUS)
        .order_by(ProjectCollaborator.created_at.desc())
        .all()
    )
    return [
        {
            "id": row.id,
            "project_id": project.id,
            "project_name": project.name,
            "project_description": project.description,
            "owner_name": owner_name,
            "owner_email": owner_email,
            "role": row.role,
            "created_at": row.created_at,
        }
        for row, project, owner_name, owner_email in rows
    ]


def accept_invitation(db: Session, invitation_id: uuid.UUID, user_id: uuid.UUID) -> dict:
    row = (
        db.query(ProjectCollaborator)
        .filter(
            ProjectCollaborator.id == invitation_id,
            ProjectCollaborator.user_id == user_id,
            ProjectCollaborator.status == PENDING_STATUS,
        )
        .first()
    )
    if not row:
        raise NotFoundError("Project invitation", str(invitation_id))
    row.status = ACCEPTED_STATUS
    row.accepted_at = datetime.now(timezone.utc)
    db.commit()
    project = db.query(Project).filter(Project.id == row.project_id).first()
    if not project:
        raise NotFoundError("Project", str(row.project_id))
    return _project_response(db, project, user_id)


def reject_invitation(db: Session, invitation_id: uuid.UUID, user_id: uuid.UUID) -> None:
    row = (
        db.query(ProjectCollaborator)
        .filter(
            ProjectCollaborator.id == invitation_id,
            ProjectCollaborator.user_id == user_id,
            ProjectCollaborator.status == PENDING_STATUS,
        )
        .first()
    )
    if not row:
        raise NotFoundError("Project invitation", str(invitation_id))
    db.delete(row)
    db.commit()


def search_users(db: Session, current_user_id: uuid.UUID, q: str, limit: int = 8) -> list[dict]:
    q = (q or "").strip()
    if len(q) < 2:
        return []
    like = f"%{q.lower()}%"
    rows = (
        db.query(User)
        .filter(
            User.id != current_user_id,
            User.is_active.is_(True),
            User.is_approved.is_(True),
            or_(func.lower(User.email).like(like), func.lower(User.display_name).like(like)),
        )
        .order_by(User.display_name.asc(), User.email.asc())
        .limit(max(1, min(limit, 20)))
        .all()
    )
    return [{"id": u.id, "email": u.email, "display_name": u.display_name} for u in rows]


def create_project(db: Session, owner_id: uuid.UUID, name: str, description: str | None,
                   collaborator_ids: list[uuid.UUID] | None = None,
                   collaborators: list | None = None) -> dict:
    p = Project(owner_id=owner_id, name=name, description=description)
    db.add(p)
    db.flush()
    invite_specs = [{"user_id": user_id, "role": "editor"} for user_id in (collaborator_ids or [])]
    for item in collaborators or []:
        invite_specs.append({"user_id": item.user_id, "role": item.role})
    seen: set[uuid.UUID] = set()
    for item in invite_specs:
        user_id = item["user_id"]
        role = item.get("role") if item.get("role") in {"editor", "viewer"} else "editor"
        if user_id == owner_id:
            continue
        if user_id in seen:
            continue
        seen.add(user_id)
        user = (
            db.query(User.id)
            .filter(User.id == user_id, User.is_active.is_(True), User.is_approved.is_(True))
            .first()
        )
        if user:
            db.add(ProjectCollaborator(
                project_id=p.id,
                user_id=user_id,
                role=role,
                status=PENDING_STATUS,
                added_by_id=owner_id,
            ))
    db.commit()
    db.refresh(p)
    return _project_response(db, p, owner_id)


def update_project(db: Session, project_id: uuid.UUID, owner_id: uuid.UUID, data) -> dict:
    p = get_project_model(db, project_id, owner_id)
    require_project_write(db, project_id, owner_id)
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(p, k, v)
    db.commit()
    db.refresh(p)
    return _project_response(db, p, owner_id)


def build_project_pack(db: Session, project_id: uuid.UUID, owner_id: uuid.UUID) -> tuple[str, str]:
    """Build a ZIP figure pack with current-version images, scripts, and legends."""
    proj = get_project_model(db, project_id, owner_id)
    figs = (db.query(Figure).filter(Figure.project_id == project_id)
            .order_by(Figure.created_at.asc()).all())
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    legends = [f"# {proj.name} — figure pack\n"]
    with zipfile.ZipFile(tmp.name, "w", zipfile.ZIP_DEFLATED) as z:
        for i, f in enumerate(figs, start=1):
            v = db.query(FigureVersion).filter(FigureVersion.id == f.current_version_id).first()
            safe = re.sub(r"[^A-Za-z0-9_-]+", "_", f.name)
            for attr, ext in (("png_path", "png"), ("svg_path", "svg"), ("pdf_path", "pdf"), ("r_path", "R")):
                path = getattr(v, attr, None) if v else None
                if path and storage.exists(path):
                    z.writestr(f"Figure{i:02d}_{safe}.{ext}", storage.read_bytes(path))
            legends.append(f"Figure {i}. {f.name} ({f.plot_type})\n"
                           f"Legend: {f.legend or '(none yet)'}\n"
                           f"Interpretation: {f.description or '-'}\n")
        z.writestr("legends.txt", "\n".join(legends))
    fname = re.sub(r"[^A-Za-z0-9_-]+", "_", proj.name) + "_figures.zip"
    return tmp.name, fname


def delete_project(db: Session, project_id: uuid.UUID, owner_id: uuid.UUID) -> None:
    p = get_project_model(db, project_id, owner_id)
    if p.owner_id != owner_id:
        raise ForbiddenError("Only the project owner can delete the project")
    fig_ids = [fid for (fid,) in db.query(Figure.id).filter(Figure.project_id == project_id).all()]
    dataset_paths = [path for (path,) in db.query(Dataset.file_path).filter(Dataset.project_id == project_id).all()]
    for fig_id in fig_ids:
        shutil.rmtree(os.path.join(settings.figures_dir, str(fig_id)), ignore_errors=True)
        if storage.object_storage_enabled():
            storage.delete_prefix(f"figures/{fig_id}")
    for path in dataset_paths:
        storage.delete_file(path)
    db.query(Figure).filter(Figure.project_id == project_id).delete(synchronize_session=False)
    db.query(Dataset).filter(Dataset.project_id == project_id).delete(synchronize_session=False)
    db.delete(p)
    db.commit()
