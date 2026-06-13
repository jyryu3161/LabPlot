import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class ColumnProfile(BaseModel):
    name: str
    dtype: str          # numeric | categorical | datetime | text
    role: str           # numeric | category | group | time | status | gene | log2fc | pvalue | expression | text
    n_unique: int
    n_missing: int
    sample_values: list[Any] = []
    stats: dict[str, Any] | None = None


class DatasetUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


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
    column_profile: list[dict[str, Any]]
    preview: list[dict[str, Any]]
    statistics: dict[str, Any] | None = None
    created_at: datetime
