import csv
import math
import os
import uuid
from io import BytesIO, StringIO
from numbers import Integral, Real
from typing import Any

import pandas as pd
from sqlalchemy import func, or_
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

_ALLOWED_COLUMN_ROLES = {"numeric", "category", "group", "time", "status", "gene", "log2fc", "pvalue", "text"}
_NUMERIC_OVERRIDE_ROLES = {"numeric", "time", "log2fc", "pvalue"}
_CATEGORICAL_OVERRIDE_ROLES = {"category", "group", "gene"}

# Hard caps on the parsed dataframe to bound memory/CPU for downstream rendering
# and statistics. Enforced at ingest for both preview and create paths.
MAX_ROWS = 1_000_000
MAX_COLS = 2_000


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
    for column in df.columns:
        series = df[column]
        present = series.notna() & series.astype(str).str.strip().ne("")
        if not bool(present.any()):
            continue
        converted = pd.to_numeric(series, errors="coerce")
        if bool(converted[present].notna().all()):
            df[column] = converted
    return df


def _parse_content(filename: str, content: bytes, ingest_options: dict[str, Any] | None = None) -> tuple[str, pd.DataFrame, dict[str, Any], list[str], list[list[Any]]]:
    fmt = _detect_format(filename)
    raw, sheets = _read_raw_dataframe(content, fmt, ingest_options)
    normalized = _infer_options(raw, fmt, sheets, ingest_options)
    raw, sheets = _read_raw_dataframe(content, fmt, normalized)
    df = _build_dataframe(raw, normalized)
    if df.shape[0] > MAX_ROWS:
        raise BadRequestError(
            f"Dataset has too many rows ({df.shape[0]:,}); the maximum is {MAX_ROWS:,}.",
            error_code="TOO_MANY_ROWS",
        )
    if df.shape[1] > MAX_COLS:
        raise BadRequestError(
            f"Dataset has too many columns ({df.shape[1]:,}); the maximum is {MAX_COLS:,}.",
            error_code="TOO_MANY_COLS",
        )
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


def _sample_values_numeric_like(values: Any) -> bool:
    if not isinstance(values, list):
        return False
    present = [value for value in values if value not in (None, "")]
    if not present:
        return False
    for value in present:
        try:
            pd.to_numeric(pd.Series([value]), errors="raise")
        except Exception:
            return False
    return True


def _apply_column_role_overrides(
    column_profile: list[dict[str, Any]],
    column_roles: dict[str, str] | None,
) -> list[dict[str, Any]]:
    if not column_roles:
        return [dict(column) for column in column_profile]
    clean_roles = {
        str(name): str(role)
        for name, role in column_roles.items()
        if str(role) in _ALLOWED_COLUMN_ROLES
    }
    if not clean_roles:
        return [dict(column) for column in column_profile]

    updated: list[dict[str, Any]] = []
    for column in column_profile:
        item = dict(column)
        role = clean_roles.get(str(item.get("name")))
        if not role:
            updated.append(item)
            continue
        item["role"] = role
        numeric_like = item.get("dtype") == "numeric" or _sample_values_numeric_like(item.get("sample_values"))
        if role in _NUMERIC_OVERRIDE_ROLES and numeric_like:
            item["dtype"] = "numeric"
        elif role == "status":
            item["dtype"] = "numeric" if numeric_like else "categorical"
        elif role in _CATEGORICAL_OVERRIDE_ROLES:
            item["dtype"] = "categorical"
        elif role == "text":
            item["dtype"] = "text"
        updated.append(item)
    return updated


def normalized_column_profile(column_profile: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for column in column_profile or []:
        item = dict(column)
        if item.get("dtype") == "text" and item.get("role") == "text" and _sample_values_numeric_like(item.get("sample_values")):
            item["dtype"] = "numeric"
            item["role"] = "numeric"
        normalized.append(item)
    return normalized


def _statistics_match_profile(statistics: dict[str, Any] | None, column_profile: list[dict[str, Any]]) -> bool:
    numeric_names = {c.get("name") for c in column_profile if c.get("dtype") == "numeric"}
    if not numeric_names:
        return True
    descriptive = (statistics or {}).get("descriptive") or []
    described_names = {item.get("column") for item in descriptive if isinstance(item, dict)}
    return numeric_names.issubset(described_names)


def _recompute_statistics(dataset: Dataset, column_profile: list[dict[str, Any]]) -> dict[str, Any]:
    try:
        return compute_statistics(load_dataframe(dataset), column_profile)
    except Exception:
        return {"descriptive": [], "comparisons": []}


def _apply_normalized_column_profile(db: Session, dataset: Dataset) -> Dataset:
    normalized = normalized_column_profile(dataset.column_profile)
    profile_changed = normalized != (dataset.column_profile or [])
    stats_stale = not _statistics_match_profile(dataset.statistics, normalized)
    if profile_changed:
        dataset.column_profile = normalized
    if profile_changed or stats_stale:
        dataset.statistics = _recompute_statistics(dataset, normalized)
        db.commit()
        db.refresh(dataset)
    return dataset


def focused_column_profile(dataset: Dataset) -> list[dict[str, Any]]:
    focus = set(dataset.focus_columns or [])
    columns = normalized_column_profile(dataset.column_profile)
    if not focus:
        return columns
    focused = [c for c in columns if c.get("name") in focus]
    return focused or columns


def create_dataset(db: Session, owner_id: uuid.UUID, filename: str, content: bytes,
                   name: str | None = None, project_id: uuid.UUID | None = None,
                   description: str | None = None,
                   ingest_options: dict[str, Any] | None = None,
                   focus_columns: list[str] | None = None,
                   column_roles: dict[str, str] | None = None) -> Dataset:
    max_bytes = settings.max_upload_size_mb * 1024 * 1024
    if len(content) > max_bytes:
        raise FileTooLargeError(settings.max_upload_size_mb)

    fmt, df, normalized_options, _, _ = _parse_content(filename, content, ingest_options)
    prof = profile_dataframe(df)
    column_profile = _apply_column_role_overrides(prof["columns"], column_roles)
    focus = _clean_focus_columns(focus_columns, column_profile)
    try:
        stats = compute_statistics(df, column_profile)
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

    next_display_order = (
        (db.query(func.max(Dataset.display_order)).filter(Dataset.project_id == project_id).scalar() or -1) + 1
    )

    dataset = Dataset(
        id=dataset_id,
        owner_id=owner_id,
        project_id=project_id,
        display_order=next_display_order,
        name=name or os.path.splitext(filename)[0],
        description=description,
        original_filename=filename,
        file_path=stored_path,
        format=fmt,
        n_rows=prof["n_rows"],
        n_cols=prof["n_cols"],
        column_profile=column_profile,
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
    if project_id is not None:
        return q.order_by(Dataset.display_order.is_(None), Dataset.display_order.asc(), Dataset.created_at.desc()).all()
    return q.order_by(Dataset.created_at.desc()).all()


def reorder_datasets(db: Session, owner_id: uuid.UUID, dataset_ids: list[uuid.UUID]) -> list[Dataset]:
    from app.projects import service as project_service

    unique_ids = list(dict.fromkeys(dataset_ids))
    if len(unique_ids) != len(dataset_ids):
        raise BadRequestError("Dataset order contains duplicate items.", error_code="DUPLICATE_DATASET_ORDER")
    datasets = db.query(Dataset).filter(Dataset.id.in_(unique_ids)).all()
    if len(datasets) != len(unique_ids):
        raise NotFoundError("Dataset", "reorder")
    project_ids = {dataset.project_id for dataset in datasets}
    if len(project_ids) != 1:
        raise BadRequestError("Datasets can only be reordered within one project.", error_code="MIXED_PROJECT_REORDER")
    project_id = next(iter(project_ids))
    if project_id is not None:
        project_service.require_project_write(db, project_id, owner_id)
    elif any(dataset.owner_id != owner_id for dataset in datasets):
        raise NotFoundError("Dataset", "reorder")

    by_id = {dataset.id: dataset for dataset in datasets}
    for index, dataset_id in enumerate(unique_ids):
        by_id[dataset_id].display_order = index
    db.commit()
    return list_datasets(db, owner_id, project_id=project_id)


def get_dataset(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID) -> Dataset:
    from app.projects import service as project_service

    ds = (
        db.query(Dataset)
        .filter(Dataset.id == dataset_id)
        .first()
    )
    if not ds or (ds.owner_id != owner_id and not project_service.can_access_project(db, ds.project_id, owner_id)):
        raise NotFoundError("Dataset", str(dataset_id))
    return _apply_normalized_column_profile(db, ds)


def update_dataset(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID, data: dict) -> Dataset:
    from app.projects import service as project_service

    ds = get_dataset(db, dataset_id, owner_id)
    if ds.owner_id != owner_id:
        project_service.require_project_write(db, ds.project_id, owner_id)
    clear_recommendations = False
    for k in ("name", "description"):
        if k in data and data[k] is not None:
            if k == "description" and getattr(ds, k) != data[k]:
                clear_recommendations = True
            setattr(ds, k, data[k])
    if "focus_columns" in data and data["focus_columns"] is not None:
        next_focus = _clean_focus_columns(data["focus_columns"], ds.column_profile or [])
        if next_focus != (ds.focus_columns or []):
            clear_recommendations = True
        ds.focus_columns = next_focus
    if "column_roles" in data and data["column_roles"] is not None:
        next_profile = _apply_column_role_overrides(normalized_column_profile(ds.column_profile), data["column_roles"])
        if next_profile != (ds.column_profile or []):
            clear_recommendations = True
            ds.column_profile = next_profile
            ds.statistics = _recompute_statistics(ds, next_profile)
    if clear_recommendations:
        from app.figures.models import Recommendation

        db.query(Recommendation).filter(Recommendation.dataset_id == ds.id).delete(synchronize_session=False)
    db.commit()
    db.refresh(ds)
    return ds


def load_dataframe(dataset: Dataset) -> pd.DataFrame:
    return read_file(dataset.file_path, dataset.format, dataset.ingest_options or None)


def column_values(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID,
                  column: str, limit: int = 200) -> dict:
    """Distinct values of one column, for per-category color/level ordering UIs.

    Returns the true distinct values (not a truncated preview sample) so the
    editor can build category-color pickers and explicit level orders that
    actually match what R renders.
    """
    limit = max(1, min(int(limit), 1000))
    ds = get_dataset(db, dataset_id, owner_id)
    df = load_dataframe(ds)
    if column not in df.columns:
        raise NotFoundError("Column", column)
    uniques = pd.unique(df[column].dropna())
    total = int(len(uniques))
    values = ["" if v is None else str(v) for v in uniques[:limit]]
    return {"column": column, "values": values, "distinct_count": total, "truncated": total > limit}


# ---------------------------------------------------------------------------
# Dataset transform pipeline (pure-Python, whitelisted ops — no eval/exec).
# Operates on a simple table representation: (columns: list[str],
# rows: list[list[Any]]) so each step is independently testable.
# ---------------------------------------------------------------------------

MAX_TRANSFORM_OPERATIONS = 20
TRANSFORM_PREVIEW_ROWS = 20

_FILTER_OPERATORS = {"==", "!=", ">", ">=", "<", "<=", "contains", "not_null"}
_DERIVE_BINARY_FUNCTIONS = {"add", "subtract", "multiply", "divide"}
_DERIVE_UNARY_FUNCTIONS = {"log", "log2", "log10", "sqrt", "zscore", "abs"}
_DERIVE_FUNCTIONS = _DERIVE_BINARY_FUNCTIONS | _DERIVE_UNARY_FUNCTIONS


def _to_number(value: Any) -> float | None:
    """Best-effort numeric coercion; returns None when not a finite number."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    text = str(value).strip()
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def _is_blank(value: Any) -> bool:
    if value is None:
        return True
    try:
        if isinstance(value, float) and math.isnan(value):
            return True
    except TypeError:
        pass
    return isinstance(value, str) and not value.strip()


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value]


def _require_columns(columns: list[str], requested: list[str], label: str) -> None:
    missing = [name for name in requested if name not in columns]
    if missing:
        raise BadRequestError(
            f"{label}: column(s) not found: {', '.join(missing)}. Available: {', '.join(columns)}",
            error_code="TRANSFORM_UNKNOWN_COLUMN",
        )


def _op_melt(columns: list[str], rows: list[list[Any]], op: dict[str, Any], label: str) -> tuple[list[str], list[list[Any]]]:
    id_columns = _string_list(op.get("id_columns"))
    value_columns = _string_list(op.get("value_columns"))
    if not value_columns:
        raise BadRequestError(f"{label}: 'value_columns' must list at least one column", error_code="TRANSFORM_INVALID_OP")
    if len(set(id_columns)) != len(id_columns) or len(set(value_columns)) != len(value_columns):
        raise BadRequestError(f"{label}: duplicate column names in 'id_columns'/'value_columns'", error_code="TRANSFORM_INVALID_OP")
    _require_columns(columns, id_columns + value_columns, label)
    names_to = str(op.get("names_to") or "variable").strip() or "variable"
    values_to = str(op.get("values_to") or "value").strip() or "value"
    new_columns = id_columns + [names_to, values_to]
    if len(set(new_columns)) != len(new_columns):
        raise BadRequestError(
            f"{label}: output columns must be unique ('names_to'/'values_to' collide with id columns)",
            error_code="TRANSFORM_INVALID_OP",
        )
    id_idx = [columns.index(name) for name in id_columns]
    value_idx = [(name, columns.index(name)) for name in value_columns]
    out_rows: list[list[Any]] = []
    for row in rows:
        base = [row[i] for i in id_idx]
        for name, i in value_idx:
            out_rows.append(base + [name, row[i]])
    return new_columns, out_rows


def _op_filter(columns: list[str], rows: list[list[Any]], op: dict[str, Any], label: str) -> tuple[list[str], list[list[Any]]]:
    column = str(op.get("column") or "")
    _require_columns(columns, [column], label)
    operator = str(op.get("operator") or "")
    if operator not in _FILTER_OPERATORS:
        raise BadRequestError(
            f"{label}: unsupported operator '{operator}'. Supported: {', '.join(sorted(_FILTER_OPERATORS))}",
            error_code="TRANSFORM_INVALID_OP",
        )
    idx = columns.index(column)
    if operator == "not_null":
        return columns, [row for row in rows if not _is_blank(row[idx])]

    value = op.get("value")
    if value is None:
        raise BadRequestError(f"{label}: 'value' is required for operator '{operator}'", error_code="TRANSFORM_INVALID_OP")
    value_number = _to_number(value)

    def matches(cell: Any) -> bool:
        if operator == "contains":
            return not _is_blank(cell) and str(value) in str(cell)
        cell_number = _to_number(cell)
        left: Any
        right: Any
        if value_number is not None and cell_number is not None:
            left, right = cell_number, value_number
        elif _is_blank(cell):
            return operator == "!="
        else:
            left, right = str(cell), str(value)
        if operator == "==":
            return left == right
        if operator == "!=":
            return left != right
        if operator == ">":
            return left > right
        if operator == ">=":
            return left >= right
        if operator == "<":
            return left < right
        return left <= right  # "<="

    return columns, [row for row in rows if matches(row[idx])]


def _derive_values(function: str, rows: list[list[Any]], col_idx: list[int], constant: float | None) -> list[Any]:
    if function in _DERIVE_BINARY_FUNCTIONS:
        def second(row: list[Any]) -> float | None:
            return _to_number(row[col_idx[1]]) if len(col_idx) == 2 else constant

        out: list[Any] = []
        for row in rows:
            a = _to_number(row[col_idx[0]])
            b = second(row)
            if a is None or b is None:
                out.append(None)
            elif function == "add":
                out.append(a + b)
            elif function == "subtract":
                out.append(a - b)
            elif function == "multiply":
                out.append(a * b)
            else:  # divide
                out.append(a / b if b != 0 else None)
        return out

    values = [_to_number(row[col_idx[0]]) for row in rows]
    if function == "zscore":
        present = [v for v in values if v is not None]
        if len(present) < 2:
            return [None] * len(values)
        mean = sum(present) / len(present)
        variance = sum((v - mean) ** 2 for v in present) / (len(present) - 1)
        std = math.sqrt(variance)
        if std == 0:
            return [None] * len(values)
        return [None if v is None else (v - mean) / std for v in values]
    if function == "abs":
        return [None if v is None else abs(v) for v in values]
    if function == "sqrt":
        return [math.sqrt(v) if v is not None and v >= 0 else None for v in values]
    log_fn = {"log": math.log, "log2": math.log2, "log10": math.log10}[function]
    return [log_fn(v) if v is not None and v > 0 else None for v in values]


def _op_derive(columns: list[str], rows: list[list[Any]], op: dict[str, Any], label: str) -> tuple[list[str], list[list[Any]]]:
    new_column = str(op.get("new_column") or "").strip()
    if not new_column:
        raise BadRequestError(f"{label}: 'new_column' is required", error_code="TRANSFORM_INVALID_OP")
    if new_column in columns:
        raise BadRequestError(f"{label}: column '{new_column}' already exists", error_code="TRANSFORM_INVALID_OP")
    function = str(op.get("function") or "")
    if function not in _DERIVE_FUNCTIONS:
        raise BadRequestError(
            f"{label}: unsupported function '{function}'. Supported: {', '.join(sorted(_DERIVE_FUNCTIONS))}",
            error_code="TRANSFORM_INVALID_OP",
        )
    source_columns = _string_list(op.get("columns"))
    _require_columns(columns, source_columns, label)
    constant = op.get("constant")
    if constant is not None:
        constant = _to_number(constant)
        if constant is None:
            raise BadRequestError(f"{label}: 'constant' must be a finite number", error_code="TRANSFORM_INVALID_OP")
    if function in _DERIVE_BINARY_FUNCTIONS:
        if not (len(source_columns) == 2 or (len(source_columns) == 1 and constant is not None)):
            raise BadRequestError(
                f"{label}: '{function}' needs two columns, or one column plus 'constant'",
                error_code="TRANSFORM_INVALID_OP",
            )
    elif len(source_columns) != 1:
        raise BadRequestError(f"{label}: '{function}' needs exactly one column", error_code="TRANSFORM_INVALID_OP")
    col_idx = [columns.index(name) for name in source_columns]
    derived = _derive_values(function, rows, col_idx, constant)
    return columns + [new_column], [row + [value] for row, value in zip(rows, derived)]


def _op_select(columns: list[str], rows: list[list[Any]], op: dict[str, Any], label: str) -> tuple[list[str], list[list[Any]]]:
    requested = list(dict.fromkeys(_string_list(op.get("columns"))))
    if not requested:
        raise BadRequestError(f"{label}: 'columns' must list at least one column", error_code="TRANSFORM_INVALID_OP")
    _require_columns(columns, requested, label)
    idx = [columns.index(name) for name in requested]
    return requested, [[row[i] for i in idx] for row in rows]


def _op_rename(columns: list[str], rows: list[list[Any]], op: dict[str, Any], label: str) -> tuple[list[str], list[list[Any]]]:
    mapping = op.get("mapping")
    if not isinstance(mapping, dict) or not mapping:
        raise BadRequestError(f"{label}: 'mapping' must be a non-empty object of {{old: new}} names", error_code="TRANSFORM_INVALID_OP")
    clean = {str(old): str(new).strip() for old, new in mapping.items()}
    _require_columns(columns, list(clean), label)
    if any(not new for new in clean.values()):
        raise BadRequestError(f"{label}: new column names must be non-empty", error_code="TRANSFORM_INVALID_OP")
    new_columns = [clean.get(name, name) for name in columns]
    if len(set(new_columns)) != len(new_columns):
        raise BadRequestError(f"{label}: rename would produce duplicate column names", error_code="TRANSFORM_INVALID_OP")
    return new_columns, rows


_TRANSFORM_HANDLERS = {
    "melt": _op_melt,
    "filter": _op_filter,
    "derive": _op_derive,
    "select": _op_select,
    "rename": _op_rename,
}


def apply_transform_operations(
    columns: list[str], rows: list[list[Any]], operations: list[dict[str, Any]]
) -> tuple[list[str], list[list[Any]]]:
    """Apply a whitelisted sequence of transform ops to a (columns, rows) table."""
    if not operations:
        raise BadRequestError("At least one operation is required", error_code="TRANSFORM_INVALID_OP")
    if len(operations) > MAX_TRANSFORM_OPERATIONS:
        raise BadRequestError(
            f"Too many operations ({len(operations)}); the maximum is {MAX_TRANSFORM_OPERATIONS}.",
            error_code="TRANSFORM_TOO_MANY_OPS",
        )
    for index, op in enumerate(operations, start=1):
        if not isinstance(op, dict):
            raise BadRequestError(f"Operation {index}: must be an object", error_code="TRANSFORM_INVALID_OP")
        name = str(op.get("op") or "")
        handler = _TRANSFORM_HANDLERS.get(name)
        if handler is None:
            raise BadRequestError(
                f"Operation {index}: unknown op '{name}'. Supported: {', '.join(sorted(_TRANSFORM_HANDLERS))}",
                error_code="TRANSFORM_INVALID_OP",
            )
        columns, rows = handler(columns, rows, op, f"Operation {index} ({name})")
        if len(rows) > MAX_ROWS:
            raise BadRequestError(
                f"Operation {index} ({name}): result has too many rows ({len(rows):,}); the maximum is {MAX_ROWS:,}.",
                error_code="TOO_MANY_ROWS",
            )
        if len(columns) > MAX_COLS:
            raise BadRequestError(
                f"Operation {index} ({name}): result has too many columns ({len(columns):,}); the maximum is {MAX_COLS:,}.",
                error_code="TOO_MANY_COLS",
            )
    if not columns or not rows:
        raise BadRequestError("Transform produced an empty dataset", error_code="TRANSFORM_EMPTY_RESULT")
    return columns, rows


def _dataframe_to_table(df: pd.DataFrame) -> tuple[list[str], list[list[Any]]]:
    columns = [str(c) for c in df.columns]
    rows = [[_json_clean(value) for value in row] for row in df.itertuples(index=False, name=None)]
    return columns, rows


def _table_to_csv_bytes(columns: list[str], rows: list[list[Any]]) -> bytes:
    buffer = StringIO()
    writer = csv.writer(buffer)
    writer.writerow(columns)
    for row in rows:
        writer.writerow(["" if value is None else value for value in row])
    return buffer.getvalue().encode("utf-8")


def _transformed_table(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID,
                       operations: list[dict[str, Any]]) -> tuple[Dataset, list[str], list[list[Any]]]:
    ds = get_dataset(db, dataset_id, owner_id)
    columns, rows = _dataframe_to_table(load_dataframe(ds))
    columns, rows = apply_transform_operations(columns, rows, operations)
    return ds, columns, rows


def transform_preview(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID,
                      operations: list[dict[str, Any]]) -> dict[str, Any]:
    """Apply ops and return a small preview without persisting anything."""
    _, columns, rows = _transformed_table(db, dataset_id, owner_id, operations)
    return {"columns": columns, "rows": rows[:TRANSFORM_PREVIEW_ROWS], "total_rows": len(rows)}


def build_transformed_csv(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID,
                          operations: list[dict[str, Any]]) -> tuple[Dataset, bytes]:
    """Apply ops to the source dataset and return (source dataset, CSV bytes)."""
    ds, columns, rows = _transformed_table(db, dataset_id, owner_id, operations)
    return ds, _table_to_csv_bytes(columns, rows)


def delete_dataset(db: Session, dataset_id: uuid.UUID, owner_id: uuid.UUID) -> None:
    from app.projects import service as project_service

    ds = get_dataset(db, dataset_id, owner_id)
    if ds.owner_id != owner_id:
        project_service.require_project_write(db, ds.project_id, owner_id)
    storage.delete_file(ds.file_path)
    db.delete(ds)
    db.commit()
