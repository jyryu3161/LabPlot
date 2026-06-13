import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.auth.models import User
from app.common.deps import get_current_user, get_db
from app.projects import service
from app.projects.schemas import ProjectCreate, ProjectListItem, ProjectResponse, ProjectUpdate

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("", response_model=list[ProjectListItem])
def list_projects(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    service.ensure_default_project(db, current_user.id)
    return service.list_projects(db, current_user.id)


@router.post("", response_model=ProjectResponse, status_code=201)
def create_project(data: ProjectCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.create_project(db, current_user.id, data.name, data.description)


@router.get("/{project_id}", response_model=ProjectResponse)
def get_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.get_project(db, project_id, current_user.id)


@router.patch("/{project_id}", response_model=ProjectResponse)
def update_project(project_id: uuid.UUID, data: ProjectUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.update_project(db, project_id, current_user.id, data)


@router.get("/{project_id}/export")
def export_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    path, filename = service.build_project_pack(db, project_id, current_user.id)
    return FileResponse(path, media_type="application/zip", filename=filename)


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    service.delete_project(db, project_id, current_user.id)
