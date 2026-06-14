import uuid

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi import Form
from sqlalchemy.orm import Session

from app.audit import service as audit_service
from app.auth.models import User
from app.common.deps import get_current_user, get_db
from app.common.exceptions import FileTooLargeError
from app.common.quotas import enforce_storage_quota
from app.common.security import rate_limit
from app.config import settings
from app.datasets import service
from app.datasets.schemas import DatasetListItem, DatasetResponse, DatasetUpdate
from app.projects import service as project_service
from app.recommend import rules

router = APIRouter(prefix="/api/datasets", tags=["datasets"])


async def _read_upload_limited(file: UploadFile) -> bytes:
    max_bytes = int(settings.max_upload_size_mb) * 1024 * 1024
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise FileTooLargeError(settings.max_upload_size_mb)
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("", response_model=DatasetResponse, status_code=201)
async def upload_dataset(
    request: Request,
    file: UploadFile = File(...),
    name: str | None = Form(None),
    description: str | None = Form(None),
    project_id: uuid.UUID | None = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    _: None = Depends(rate_limit("dataset_upload", 30, 3600)),
):
    if project_id is None:
        project_id = project_service.ensure_default_project(db, current_user.id).id
    else:
        project_service.get_project(db, project_id, current_user.id)  # ownership check
    content = await _read_upload_limited(file)
    enforce_storage_quota(db, current_user, len(content))
    ds = service.create_dataset(db, current_user.id, file.filename, content,
                                name=name, project_id=project_id, description=description)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="dataset.upload",
        target_type="dataset",
        target_id=ds.id,
        metadata={"filename": file.filename, "bytes": len(content), "format": ds.format},
        request=request,
    )
    db.commit()
    return ds


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
def delete_dataset(dataset_id: uuid.UUID, request: Request, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    service.delete_dataset(db, dataset_id, current_user.id)
    audit_service.log_event(db, actor_id=current_user.id, action="dataset.delete", target_type="dataset", target_id=dataset_id, metadata={}, request=request)
    db.commit()


@router.get("/{dataset_id}/chart-suggestions")
def chart_suggestions(dataset_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    ds = service.get_dataset(db, dataset_id, current_user.id)
    return {"suggestions": rules.suggest_charts(ds.column_profile)}
