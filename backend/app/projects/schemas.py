import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ProjectCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None


class ProjectResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    description: str | None = None
    created_at: datetime
    updated_at: datetime


class ProjectListItem(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None = None
    created_at: datetime
    updated_at: datetime
    dataset_count: int = 0
    figure_count: int = 0
