import os
import uuid
from io import BytesIO

import pandas as pd
from sqlalchemy.orm import Session

from app.common import storage
from app.config import settings
from app.common.encryption import decrypt_private_bytes, encrypt_private_bytes
from app.common.exceptions import BadRequestError, FileTooLargeError, NotFoundError
from app.datasets.models import Dataset
from app.datasets.profiler import profile_dataframe
from app.datasets.stats import compute_statistics

_FORMATS = {
    "csv": ".csv",
    "tsv": ".tsv",
    "txt": ".txt",
    "xlsx": ".xlsx",
    "xls": ".xls",
}


def _detect_format(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower().lstrip(".")
    if ext not in _FORMATS:
        raise BadRequestError(
            f"Unsupported file type '.{ext}'. Supported: CSV, TSV, TXT, XLSX",
            error_code="UNSUPPORTED_FORMAT",
        )
    return ext


def read_file(path: str, fmt: str) -> pd.DataFrame:
    raw = decrypt_private_bytes(storage.read_bytes(path))
    buf = BytesIO(raw)
    try:
        if fmt == "csv":
            df = pd.read_csv(buf)
        elif fmt == "tsv":
            df = pd.read_csv(buf, sep="\t")
        elif fmt == "txt":
            df = pd.read_csv(buf, sep=None, engine="python")
        elif fmt in ("xlsx", "xls"):
            df = pd.read_excel(buf)
        else:  # pragma: no cover
            raise BadRequestError("Unsupported format")
    except BadRequestError:
        raise
    except Exception as e:  # parsing failure
        raise BadRequestError(f"Could not parse file: {e}", error_code="PARSE_ERROR")

    if df.shape[1] == 0 or df.shape[0] == 0:
        raise BadRequestError("File appears to be empty", error_code="EMPTY_FILE")
    # normalise column names to strings
    df.columns = [str(c) for c in df.columns]
    return df


def create_dataset(db: Session, owner_id: uuid.UUID, filename: str, content: bytes,
                   name: str | None = None, project_id: uuid.UUID | None = None,
                   description: str | None = None) -> Dataset:
    max_bytes = settings.max_upload_size_mb * 1024 * 1024
    if len(content) > max_bytes:
        raise FileTooLargeError(settings.max_upload_size_mb)

    fmt = _detect_format(filename)
    dataset_id = uuid.uuid4()
    encoded = encrypt_private_bytes(content)
    if storage.object_storage_enabled():
        stored_path = storage.put_bytes(
            storage.object_key("uploads", f"{dataset_id}.{fmt}"),
            encoded,
            content_type="application/octet-stream",
        )
    else:
        os.makedirs(settings.upload_dir, exist_ok=True)
        stored_path = os.path.join(settings.upload_dir, f"{dataset_id}.{fmt}")
        storage.write_bytes(stored_path, encoded, content_type="application/octet-stream")

    df = read_file(stored_path, fmt)
    prof = profile_dataframe(df)
    try:
        stats = compute_statistics(df, prof["columns"])
    except Exception:
        stats = {"descriptive": [], "comparisons": []}

    dataset = Dataset(
        id=dataset_id,
        owner_id=owner_id,
        project_id=project_id,
        name=name or os.path.splitext(filename)[0],
        description=description,
        original_filename=filename,
        file_path=stored_path,
        format=fmt,
        n_rows=prof["n_rows"],
        n_cols=prof["n_cols"],
        column_profile=prof["columns"],
        preview=prof["preview"],
        statistics=stats,
    )
    db.add(dataset)
    db.commit()
    db.refresh(dataset)
    return dataset


def list_datasets(db: Session, owner_id: uuid.UUID, project_id: uuid.UUID | None = None) -> list[Dataset]:
    q = db.query(Dataset).filter(Dataset.owner_id == owner_id)
    if project_id is not None:
        q = q.filter(Dataset.project_id == project_id)
    return q.order_by(Dataset.created_at.desc()).all()


def get_dataset(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID) -> Dataset:
    ds = (
        db.query(Dataset)
        .filter(Dataset.id == dataset_id, Dataset.owner_id == owner_id)
        .first()
    )
    if not ds:
        raise NotFoundError("Dataset", str(dataset_id))
    return ds


def update_dataset(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID, data: dict) -> Dataset:
    ds = get_dataset(db, dataset_id, owner_id)
    for k in ("name", "description"):
        if k in data and data[k] is not None:
            setattr(ds, k, data[k])
    db.commit()
    db.refresh(ds)
    return ds


def load_dataframe(dataset: Dataset) -> pd.DataFrame:
    return read_file(dataset.file_path, dataset.format)


def delete_dataset(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID) -> None:
    ds = get_dataset(db, dataset_id, owner_id)
    storage.delete_file(ds.file_path)
    db.delete(ds)
    db.commit()
