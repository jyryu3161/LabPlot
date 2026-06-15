import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class CanvasCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    project_id: uuid.UUID | None = None
    preset: str = "double_column"
    width_px: int = Field(default=720, ge=300, le=2400)
    height_px: int = Field(default=500, ge=300, le=2400)
    state: dict[str, Any] = Field(default_factory=dict)


class CanvasUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    project_id: uuid.UUID | None = None
    preset: str | None = None
    width_px: int | None = Field(default=None, ge=300, le=2400)
    height_px: int | None = Field(default=None, ge=300, le=2400)
    state: dict[str, Any] | None = None


class CanvasListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None = None
    project_id: uuid.UUID | None = None
    preset: str
    width_px: int
    height_px: int
    item_count: int
    created_at: datetime
    updated_at: datetime


class CanvasResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None = None
    project_id: uuid.UUID | None = None
    preset: str
    width_px: int
    height_px: int
    state: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class CanvasStyleSuggestionRequest(BaseModel):
    selected_item_id: str | None = Field(default=None, max_length=120)
    instruction: str | None = Field(default=None, max_length=1000)


class CanvasStyleSuggestionResponse(BaseModel):
    palette_key: str
    font_size: int
    layout: str
    rationale: str


class CanvasLegendResponse(BaseModel):
    legend: str
