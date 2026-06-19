import json
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
from app.datasets.schemas import DatasetListItem, DatasetPreviewResponse, DatasetReorderRequest, DatasetResponse, DatasetUpdate
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


def _ingest_options_from_form(
    sheet_name: str | None,
    header_row: int | None,
    data_start_row: int | None,
    end_row: int | None,
    start_col: int | None,
    end_col: int | None,
) -> dict:
    options = {}
    if sheet_name:
        options["sheet_name"] = sheet_name
    for key, value in {
        "header_row": header_row,
        "data_start_row": data_start_row,
        "end_row": end_row,
        "start_col": start_col,
        "end_col": end_col,
    }.items():
        if value is not None:
            options[key] = value
    return options


def _focus_columns_from_form(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [str(item) for item in parsed if isinstance(item, str)]
    except json.JSONDecodeError:
        pass
    return [part.strip() for part in raw.split(",") if part.strip()]


def _column_roles_from_form(raw: str | None) -> dict[str, str]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {str(name): str(role) for name, role in parsed.items() if isinstance(name, str) and isinstance(role, str)}


@router.post("/preview", response_model=DatasetPreviewResponse)
async def preview_dataset_upload(
    file: UploadFile = File(...),
    sheet_name: str | None = Form(None),
    header_row: int | None = Form(None),
    data_start_row: int | None = Form(None),
    end_row: int | None = Form(None),
    start_col: int | None = Form(None),
    end_col: int | None = Form(None),
    current_user: User = Depends(get_current_user),
    _: None = Depends(rate_limit("dataset_preview", 80, 3600)),
):
    _ = current_user
    content = await _read_upload_limited(file)
    options = _ingest_options_from_form(sheet_name, header_row, data_start_row, end_row, start_col, end_col)
    return service.preview_upload(file.filename, content, options)


@router.post("", response_model=DatasetResponse, status_code=201)
async def upload_dataset(
    request: Request,
    file: UploadFile = File(...),
    name: str | None = Form(None),
    description: str | None = Form(None),
    project_id: uuid.UUID | None = Form(None),
    sheet_name: str | None = Form(None),
    header_row: int | None = Form(None),
    data_start_row: int | None = Form(None),
    end_row: int | None = Form(None),
    start_col: int | None = Form(None),
    end_col: int | None = Form(None),
    focus_columns: str | None = Form(None),
    column_roles: str | None = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    _: None = Depends(rate_limit("dataset_upload", 30, 3600)),
):
    if project_id is None:
        project_id = project_service.ensure_default_project(db, current_user.id).id
    else:
        project_service.require_project_write(db, project_id, current_user.id)
    content = await _read_upload_limited(file)
    enforce_storage_quota(db, current_user, len(content))
    options = _ingest_options_from_form(sheet_name, header_row, data_start_row, end_row, start_col, end_col)
    focus = _focus_columns_from_form(focus_columns)
    roles = _column_roles_from_form(column_roles)
    ds = service.create_dataset(db, current_user.id, file.filename, content,
                                name=name, project_id=project_id, description=description,
                                ingest_options=options, focus_columns=focus, column_roles=roles)
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


@router.post("/reorder", response_model=list[DatasetListItem])
def reorder_datasets(data: DatasetReorderRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.reorder_datasets(db, current_user.id, data.dataset_ids)


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
    return {"suggestions": rules.suggest_charts(service.focused_column_profile(ds))}
