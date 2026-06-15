import os
import uuid
from io import BytesIO
from numbers import Integral, Real
from typing import Any

import pandas as pd
from sqlalchemy import or_
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

_EXCEL_FORMATS = {"xlsx", "xls"}


def _detect_format(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower().lstrip(".")
    if ext not in _FORMATS:
        raise BadRequestError(
            f"Unsupported file type '.{ext}'. Supported: CSV, TSV, TXT, XLSX",
            error_code="UNSUPPORTED_FORMAT",
        )
    return ext


def _json_clean(value: Any) -> Any:
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, bool):
        return value
    if isinstance(value, Integral):
        return int(value)
    if isinstance(value, Real):
        return float(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _positive_int(value: Any, default: int | None = None) -> int | None:
    if value in (None, ""):
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _non_empty_positions(values: pd.Series) -> list[int]:
    positions: list[int] = []
    for idx, value in enumerate(values.tolist()):
        cleaned = _json_clean(value)
        if cleaned is None:
            continue
        if isinstance(cleaned, str) and not cleaned.strip():
            continue
        positions.append(idx)
    return positions


def _dedupe_columns(values: list[Any], start_col: int) -> list[str]:
    columns: list[str] = []
    seen: dict[str, int] = {}
    for offset, value in enumerate(values):
        cleaned = _json_clean(value)
        base = str(cleaned).strip() if cleaned is not None else ""
        if not base:
            base = f"Column {start_col + offset}"
        count = seen.get(base, 0)
        seen[base] = count + 1
        columns.append(base if count == 0 else f"{base}_{count + 1}")
    return columns


def _sheet_names(content: bytes, fmt: str) -> list[str]:
    if fmt not in _EXCEL_FORMATS:
        return []
    try:
        return pd.ExcelFile(BytesIO(content)).sheet_names
    except Exception as e:
        raise BadRequestError(f"Could not inspect Excel workbook: {e}", error_code="PARSE_ERROR")


def _read_raw_dataframe(content: bytes, fmt: str, options: dict[str, Any] | None = None) -> tuple[pd.DataFrame, list[str]]:
    options = options or {}
    try:
        if fmt == "csv":
            return pd.read_csv(BytesIO(content), header=None, dtype=object), []
        if fmt == "tsv":
            return pd.read_csv(BytesIO(content), sep="\t", header=None, dtype=object), []
        if fmt == "txt":
            return pd.read_csv(BytesIO(content), sep=None, engine="python", header=None, dtype=object), []
        if fmt in _EXCEL_FORMATS:
            sheets = _sheet_names(content, fmt)
            if not sheets:
                raise BadRequestError("Workbook does not contain any sheets", error_code="EMPTY_FILE")
            selected = str(options.get("sheet_name") or sheets[0])
            if selected not in sheets:
                raise BadRequestError(f"Sheet '{selected}' was not found", error_code="BAD_SHEET")
            raw = pd.read_excel(BytesIO(content), sheet_name=selected, header=None, dtype=object)
            return raw, sheets
    except BadRequestError:
        raise
    except Exception as e:
        raise BadRequestError(f"Could not parse file: {e}", error_code="PARSE_ERROR")
    raise BadRequestError("Unsupported format", error_code="UNSUPPORTED_FORMAT")


def _infer_options(raw: pd.DataFrame, fmt: str, sheets: list[str], options: dict[str, Any] | None = None) -> dict[str, Any]:
    requested = options or {}
    if raw.shape[0] == 0 or raw.shape[1] == 0:
        raise BadRequestError("File appears to be empty", error_code="EMPTY_FILE")

    header_row = _positive_int(requested.get("header_row"))
    if header_row is None:
        best_idx = 0
        best_count = 0
        for idx in range(min(20, raw.shape[0])):
            count = len(_non_empty_positions(raw.iloc[idx]))
            if count > best_count:
                best_idx = idx
                best_count = count
        header_row = best_idx + 1 if best_count >= 2 else 1

    header_idx = min(header_row - 1, raw.shape[0] - 1)
    header_positions = _non_empty_positions(raw.iloc[header_idx])
    if not header_positions:
        scan = raw.iloc[: min(20, raw.shape[0])]
        header_positions = sorted({pos for _, row in scan.iterrows() for pos in _non_empty_positions(row)})
    start_col = _positive_int(requested.get("start_col"), (min(header_positions) + 1) if header_positions else 1) or 1
    end_col = _positive_int(requested.get("end_col"), (max(header_positions) + 1) if header_positions else raw.shape[1])
    data_start_row = _positive_int(requested.get("data_start_row"), header_row + 1) or (header_row + 1)
    end_row = _positive_int(requested.get("end_row"))

    if end_col is not None and end_col < start_col:
        raise BadRequestError("End column must be after start column", error_code="BAD_RANGE")
    if data_start_row <= header_row:
        raise BadRequestError("Data start row must be after the header row", error_code="BAD_RANGE")
    if end_row is not None and end_row < data_start_row:
        raise BadRequestError("End row must be after data start row", error_code="BAD_RANGE")

    normalized: dict[str, Any] = {
        "header_row": header_row,
        "data_start_row": data_start_row,
        "start_col": start_col,
        "end_col": min(end_col or raw.shape[1], raw.shape[1]),
    }
    if end_row is not None:
        normalized["end_row"] = end_row
    if fmt in _EXCEL_FORMATS and sheets:
        normalized["sheet_name"] = str(requested.get("sheet_name") or sheets[0])
    return normalized


def _build_dataframe(raw: pd.DataFrame, options: dict[str, Any]) -> pd.DataFrame:
    header_idx = (_positive_int(options.get("header_row"), 1) or 1) - 1
    data_start_idx = (_positive_int(options.get("data_start_row"), header_idx + 2) or (header_idx + 2)) - 1
    start_col_idx = (_positive_int(options.get("start_col"), 1) or 1) - 1
    end_col_idx = _positive_int(options.get("end_col"), raw.shape[1]) or raw.shape[1]
    end_row_idx = _positive_int(options.get("end_row"))

    if header_idx >= raw.shape[0] or data_start_idx >= raw.shape[0] or start_col_idx >= raw.shape[1]:
        raise BadRequestError("Selected data range is outside the file", error_code="BAD_RANGE")

    end_col_idx = min(end_col_idx, raw.shape[1])
    row_slice = slice(data_start_idx, end_row_idx)
    col_slice = slice(start_col_idx, end_col_idx)
    column_names = _dedupe_columns(raw.iloc[header_idx, col_slice].tolist(), start_col_idx + 1)
    df = raw.iloc[row_slice, col_slice].copy()
    df.columns = column_names[: df.shape[1]]
    df = df.replace(r"^\s*$", pd.NA, regex=True)
    df = df.dropna(axis=0, how="all")
    df = df.dropna(axis=1, how="all")
    if df.shape[1] == 0 or df.shape[0] == 0:
        raise BadRequestError("Selected data range appears to be empty", error_code="EMPTY_FILE")
    df = df.reset_index(drop=True)
    df.columns = [str(c) for c in df.columns]
    return df


def _parse_content(filename: str, content: bytes, ingest_options: dict[str, Any] | None = None) -> tuple[str, pd.DataFrame, dict[str, Any], list[str], list[list[Any]]]:
    fmt = _detect_format(filename)
    raw, sheets = _read_raw_dataframe(content, fmt, ingest_options)
    normalized = _infer_options(raw, fmt, sheets, ingest_options)
    raw, sheets = _read_raw_dataframe(content, fmt, normalized)
    df = _build_dataframe(raw, normalized)
    raw_preview = [
        [_json_clean(value) for value in row]
        for row in raw.iloc[:20, :20].itertuples(index=False, name=None)
    ]
    return fmt, df, normalized, sheets, raw_preview


def read_file(path: str, fmt: str, ingest_options: dict[str, Any] | None = None) -> pd.DataFrame:
    raw = decrypt_private_bytes(storage.read_bytes(path))
    _, df, _, _, _ = _parse_content(f"dataset.{fmt}", raw, ingest_options)
    return df


def preview_upload(filename: str, content: bytes, ingest_options: dict[str, Any] | None = None) -> dict[str, Any]:
    fmt, df, normalized, sheets, raw_preview = _parse_content(filename, content, ingest_options)
    prof = profile_dataframe(df)
    return {
        "filename": filename,
        "format": fmt,
        "sheets": sheets,
        "selected_sheet": normalized.get("sheet_name"),
        "ingest_options": normalized,
        "raw_preview": raw_preview,
        "parsed_preview": prof["preview"],
        "column_profile": prof["columns"],
        "n_rows": prof["n_rows"],
        "n_cols": prof["n_cols"],
    }


def _clean_focus_columns(focus_columns: list[str] | None, column_profile: list[dict[str, Any]]) -> list[str]:
    if not focus_columns:
        return []
    known = {c.get("name") for c in column_profile}
    clean: list[str] = []
    for name in focus_columns:
        if name in known and name not in clean:
            clean.append(name)
    return clean


def focused_column_profile(dataset: Dataset) -> list[dict[str, Any]]:
    focus = set(dataset.focus_columns or [])
    columns = dataset.column_profile or []
    if not focus:
        return columns
    focused = [c for c in columns if c.get("name") in focus]
    return focused or columns


def create_dataset(db: Session, owner_id: uuid.UUID, filename: str, content: bytes,
                   name: str | None = None, project_id: uuid.UUID | None = None,
                   description: str | None = None,
                   ingest_options: dict[str, Any] | None = None,
                   focus_columns: list[str] | None = None) -> Dataset:
    max_bytes = settings.max_upload_size_mb * 1024 * 1024
    if len(content) > max_bytes:
        raise FileTooLargeError(settings.max_upload_size_mb)

    fmt, df, normalized_options, _, _ = _parse_content(filename, content, ingest_options)
    prof = profile_dataframe(df)
    focus = _clean_focus_columns(focus_columns, prof["columns"])
    try:
        stats = compute_statistics(df, prof["columns"])
    except Exception:
        stats = {"descriptive": [], "comparisons": []}

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
        ingest_options=normalized_options,
        focus_columns=focus,
    )
    db.add(dataset)
    db.commit()
    db.refresh(dataset)
    return dataset


def list_datasets(db: Session, owner_id: uuid.UUID, project_id: uuid.UUID | None = None) -> list[Dataset]:
    from app.projects import service as project_service

    if project_id is not None:
        project_service.get_project_model(db, project_id, owner_id)
        q = db.query(Dataset).filter(Dataset.project_id == project_id)
    else:
        ids = project_service.accessible_project_ids(db, owner_id)
        q = db.query(Dataset).filter(or_(Dataset.owner_id == owner_id, Dataset.project_id.in_(ids)))
    return q.order_by(Dataset.created_at.desc()).all()


def get_dataset(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID) -> Dataset:
    from app.projects import service as project_service

    ds = (
        db.query(Dataset)
        .filter(Dataset.id == dataset_id)
        .first()
    )
    if not ds or (ds.owner_id != owner_id and not project_service.can_access_project(db, ds.project_id, owner_id)):
        raise NotFoundError("Dataset", str(dataset_id))
    return ds


def update_dataset(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID, data: dict) -> Dataset:
    from app.projects import service as project_service

    ds = get_dataset(db, dataset_id, owner_id)
    if ds.owner_id != owner_id:
        project_service.require_project_write(db, ds.project_id, owner_id)
    for k in ("name", "description"):
        if k in data and data[k] is not None:
            setattr(ds, k, data[k])
    if "focus_columns" in data and data["focus_columns"] is not None:
        ds.focus_columns = _clean_focus_columns(data["focus_columns"], ds.column_profile or [])
    db.commit()
    db.refresh(ds)
    return ds


def load_dataframe(dataset: Dataset) -> pd.DataFrame:
    return read_file(dataset.file_path, dataset.format, dataset.ingest_options or None)


def delete_dataset(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID) -> None:
    from app.projects import service as project_service

    ds = get_dataset(db, dataset_id, owner_id)
    if ds.owner_id != owner_id:
        project_service.require_project_write(db, ds.project_id, owner_id)
    storage.delete_file(ds.file_path)
    db.delete(ds)
    db.commit()
