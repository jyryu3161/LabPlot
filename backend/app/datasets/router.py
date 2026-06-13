import uuid

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi import Form
from sqlalchemy.orm import Session

from app.auth.models import User
from app.common.deps import get_current_user, get_db
from app.datasets import service
from app.datasets.schemas import DatasetListItem, DatasetResponse, DatasetUpdate
from app.projects import service as project_service
from app.recommend import rules

router = APIRouter(prefix="/api/datasets", tags=["datasets"])


@router.post("", response_model=DatasetResponse, status_code=201)
async def upload_dataset(
    file: UploadFile = File(...),
    name: str | None = Form(None),
    description: str | None = Form(None),
    project_id: uuid.UUID | None = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if project_id is None:
        project_id = project_service.ensure_default_project(db, current_user.id).id
    else:
        project_service.get_project(db, project_id, current_user.id)  # ownership check
    content = await file.read()
    return service.create_dataset(db, current_user.id, file.filename, content,
                                  name=name, project_id=project_id, description=description)


@router.get("", response_model=list[DatasetListItem])
def list_datasets(project_id: uuid.UUID | None = None, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.list_datasets(db, current_user.id, project_id=project_id)


@router.patch("/{dataset_id}", response_model=DatasetResponse)
def update_dataset(dataset_id: uuid.UUID, data: DatasetUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.update_dataset(db, dataset_id, current_user.id, data.model_dump(exclude_unset=True))


@router.get("/{dataset_id}", response_model=DatasetResponse)
def get_dataset(dataset_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.get_dataset(db, dataset_id, current_user.id)


@router.delete("/{dataset_id}", status_code=204)
def delete_dataset(dataset_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    service.delete_dataset(db, dataset_id, current_user.id)


@router.get("/{dataset_id}/chart-suggestions")
def chart_suggestions(dataset_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    ds = service.get_dataset(db, dataset_id, current_user.id)
    return {"suggestions": rules.suggest_charts(ds.column_profile)}
