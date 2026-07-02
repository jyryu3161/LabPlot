import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ColumnProfile(BaseModel):
    name: str
    dtype: str          # numeric | categorical | datetime | text
    role: str           # numeric | category | group | time | status | gene | log2fc | pvalue | expression | text
    n_unique: int
    n_missing: int
    sample_values: list[Any] = Field(default_factory=list)
    stats: dict[str, Any] | None = None


class DatasetUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    focus_columns: list[str] | None = None
    column_roles: dict[str, str] | None = None


class DatasetReorderRequest(BaseModel):
    dataset_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=200)


class TransformOperation(BaseModel):
    """One step of a dataset transform pipeline.

    Fields are a union across all supported ops; the service validates that
    the fields required for the given ``op`` are present and well-formed.
    """

    op: str  # melt | filter | derive | select | rename
    # melt
    id_columns: list[str] | None = None
    value_columns: list[str] | None = None
    names_to: str | None = None
    values_to: str | None = None
    # filter
    column: str | None = None
    operator: str | None = None
    value: Any | None = None
    # derive
    new_column: str | None = None
    function: str | None = None
    columns: list[str] | None = None
    constant: float | None = None
    # rename
    mapping: dict[str, str] | None = None


class DatasetTransformRequest(BaseModel):
    name: str | None = None
    operations: list[TransformOperation] = Field(..., min_length=1, max_length=20)


class DatasetTransformPreviewResponse(BaseModel):
    columns: list[str]
    rows: list[list[Any]]
    total_rows: int


class DatasetPreviewResponse(BaseModel):
    filename: str
    format: str
    sheets: list[str] = Field(default_factory=list)
    selected_sheet: str | None = None
    ingest_options: dict[str, Any]
    raw_preview: list[list[Any]]
    parsed_preview: list[dict[str, Any]]
    column_profile: list[dict[str, Any]]
    n_rows: int
    n_cols: int


class DatasetListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None = None
    original_filename: str
    format: str
    n_rows: int
    n_cols: int
    project_id: uuid.UUID | None = None
    display_order: int | None = None
    created_at: datetime


class DatasetResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None = None
    original_filename: str
    format: str
    n_rows: int
    n_cols: int
    project_id: uuid.UUID | None = None
    display_order: int | None = None
    column_profile: list[dict[str, Any]]
    preview: list[dict[str, Any]]
    statistics: dict[str, Any] | None = None
    ingest_options: dict[str, Any] = Field(default_factory=dict)
    focus_columns: list[str] = Field(default_factory=list)
    created_at: datetime
