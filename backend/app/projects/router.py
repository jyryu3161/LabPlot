import os
import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from sqlalchemy.orm import Session

from app.auth.models import User
from app.common.deps import get_current_user, get_db
from app.projects import service
from app.projects.schemas import (
    ProjectCollaboratorCreate,
    ProjectCollaboratorItem,
    ProjectCreate,
    ProjectInvitationItem,
    ProjectListItem,
    ProjectResponse,
    ProjectUpdate,
    ProjectUserSearchItem,
)

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("", response_model=list[ProjectListItem])
def list_projects(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    service.ensure_default_project(db, current_user.id)
    return service.list_projects(db, current_user.id)


@router.post("", response_model=ProjectResponse, status_code=201)
def create_project(data: ProjectCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.create_project(db, current_user.id, data.name, data.description, data.collaborator_ids, data.collaborators)


@router.get("/collaborators/search", response_model=list[ProjectUserSearchItem])
def search_project_collaborators(q: str, limit: int = 8, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.search_users(db, current_user.id, q, limit=limit)


@router.get("/invitations", response_model=list[ProjectInvitationItem])
def list_project_invitations(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.list_invitations(db, current_user.id)


@router.post("/invitations/{invitation_id}/accept", response_model=ProjectResponse)
def accept_project_invitation(invitation_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.accept_invitation(db, invitation_id, current_user.id)


@router.post("/invitations/{invitation_id}/reject", status_code=204)
def reject_project_invitation(invitation_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    service.reject_invitation(db, invitation_id, current_user.id)


@router.get("/{project_id}", response_model=ProjectResponse)
def get_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.get_project(db, project_id, current_user.id)


@router.get("/{project_id}/collaborators", response_model=list[ProjectCollaboratorItem])
def list_project_collaborators(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.list_collaborators(db, project_id, current_user.id)


@router.post("/{project_id}/collaborators", response_model=ProjectCollaboratorItem, status_code=201)
def add_project_collaborator(project_id: uuid.UUID, data: ProjectCollaboratorCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.add_collaborator(db, project_id, current_user.id, data.user_id, data.role)


@router.delete("/{project_id}/collaborators/{collaborator_id}", status_code=204)
def remove_project_collaborator(project_id: uuid.UUID, collaborator_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    service.remove_collaborator(db, project_id, current_user.id, collaborator_id)


@router.patch("/{project_id}", response_model=ProjectResponse)
def update_project(project_id: uuid.UUID, data: ProjectUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.update_project(db, project_id, current_user.id, data)


@router.get("/{project_id}/export")
def export_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    path, filename = service.build_project_pack(db, project_id, current_user.id)
    return FileResponse(
        path,
        media_type="application/zip",
        filename=filename,
        background=BackgroundTask(os.remove, path),
    )


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    service.delete_project(db, project_id, current_user.id)
