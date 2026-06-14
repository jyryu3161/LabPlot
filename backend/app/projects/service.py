import os
import re
import shutil
import tempfile
import uuid
import zipfile

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.common import storage
from app.common.exceptions import NotFoundError
from app.config import settings
from app.datasets.models import Dataset
from app.figures.models import Figure, FigureVersion
from app.projects.models import Project


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


def list_projects(db: Session, owner_id: uuid.UUID) -> list[dict]:
    projects = (db.query(Project).filter(Project.owner_id == owner_id)
                .order_by(Project.created_at.asc()).all())
    if not projects:
        return []
    ids = [p.id for p in projects]
    dsc = dict(db.query(Dataset.project_id, func.count(Dataset.id))
               .filter(Dataset.project_id.in_(ids)).group_by(Dataset.project_id).all())
    fic = dict(db.query(Figure.project_id, func.count(Figure.id))
               .filter(Figure.project_id.in_(ids)).group_by(Figure.project_id).all())
    return [{
        "id": p.id, "name": p.name, "description": p.description,
        "created_at": p.created_at, "updated_at": p.updated_at,
        "dataset_count": dsc.get(p.id, 0), "figure_count": fic.get(p.id, 0),
    } for p in projects]


def get_project(db: Session, project_id: uuid.UUID, owner_id: uuid.UUID) -> Project:
    p = db.query(Project).filter(Project.id == project_id, Project.owner_id == owner_id).first()
    if not p:
        raise NotFoundError("Project", str(project_id))
    return p


def create_project(db: Session, owner_id: uuid.UUID, name: str, description: str | None) -> Project:
    p = Project(owner_id=owner_id, name=name, description=description)
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def update_project(db: Session, project_id: uuid.UUID, owner_id: uuid.UUID, data) -> Project:
    p = get_project(db, project_id, owner_id)
    for k, v in data.model_dump(exclude_unset=True).items():
        setattr(p, k, v)
    db.commit()
    db.refresh(p)
    return p


def build_project_pack(db: Session, project_id: uuid.UUID, owner_id: uuid.UUID) -> tuple[str, str]:
    """Build a ZIP figure pack with current-version images, scripts, and legends."""
    proj = get_project(db, project_id, owner_id)
    figs = (db.query(Figure).filter(Figure.project_id == project_id, Figure.owner_id == owner_id)
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
    p = get_project(db, project_id, owner_id)
    fig_ids = [fid for (fid,) in db.query(Figure.id).filter(Figure.project_id == project_id, Figure.owner_id == owner_id).all()]
    dataset_paths = [path for (path,) in db.query(Dataset.file_path).filter(Dataset.project_id == project_id, Dataset.owner_id == owner_id).all()]
    for fig_id in fig_ids:
        shutil.rmtree(os.path.join(settings.figures_dir, str(fig_id)), ignore_errors=True)
        if storage.object_storage_enabled():
            storage.delete_prefix(f"figures/{fig_id}")
    for path in dataset_paths:
        storage.delete_file(path)
    db.query(Figure).filter(Figure.project_id == project_id, Figure.owner_id == owner_id).delete(synchronize_session=False)
    db.query(Dataset).filter(Dataset.project_id == project_id, Dataset.owner_id == owner_id).delete(synchronize_session=False)
    db.delete(p)
    db.commit()
