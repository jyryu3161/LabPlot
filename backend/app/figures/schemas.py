import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class FigureCreate(BaseModel):
    dataset_id: uuid.UUID
    name: str = Field(..., min_length=1, max_length=255)
    plot_type: str
    mapping: dict[str, Any] = {}
    options: dict[str, Any] = {}
    style_preset: str = "nature"


class RerenderRequest(BaseModel):
    plot_type: str | None = None
    mapping: dict[str, Any] | None = None
    options: dict[str, Any] | None = None
    style_preset: str | None = None
    change_note: str | None = None


class FigureUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    legend: str | None = None


class LegendResponse(BaseModel):
    legend: str


class EnhancePromptRequest(BaseModel):
    draft: str = ""
    kind: str = "dataset_description"
    context: str | None = None


class EnhancePromptResponse(BaseModel):
    enhanced: str


class VersionResponse(BaseModel):
    id: uuid.UUID
    version_number: int
    mapping: dict[str, Any]
    options: dict[str, Any]
    style_preset: str
    change_note: str | None = None
    created_at: datetime
    png_url: str | None = None
    svg_url: str | None = None
    tiff_url: str | None = None
    pdf_url: str | None = None
    r_url: str | None = None


class FigureListItem(BaseModel):
    id: uuid.UUID
    name: str
    plot_type: str
    style_preset: str
    status: str
    dataset_id: uuid.UUID
    project_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    thumb_url: str | None = None


class GalleryFigureItem(BaseModel):
    id: uuid.UUID
    name: str
    plot_type: str
    style_preset: str
    status: str
    dataset_id: uuid.UUID
    dataset_name: str | None = None
    project_id: uuid.UUID | None = None
    project_name: str | None = None
    owner_name: str | None = None
    owner_email: str | None = None
    current_version_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    thumb_url: str | None = None
    r_url: str | None = None


class FigureDetail(BaseModel):
    id: uuid.UUID
    name: str
    plot_type: str
    style_preset: str
    status: str
    dataset_id: uuid.UUID
    project_id: uuid.UUID | None = None
    dataset_name: str | None = None
    description: str | None = None
    legend: str | None = None
    current_version_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    versions: list[VersionResponse] = []


class ReviewResponse(BaseModel):
    id: uuid.UUID
    figure_version_id: uuid.UUID
    publication_score: int | None = None
    payload: dict[str, Any]
    created_at: datetime


class ImprovementResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    figure_version_id: uuid.UUID
    suggestion_type: str | None = None
    current_state: str | None = None
    recommended: str | None = None
    param_patch: dict[str, Any]
    priority: str | None = None
    applied: bool
    created_at: datetime


class RecommendationItem(BaseModel):
    plot_type: str
    title: str | None = None
    score: float | str | None = None
    rationale: str | None = None
    required_vars: dict[str, Any] | None = None
    suggested_mapping: dict[str, Any] | None = None
    example_usage: str | None = None
    source: str = "rule"
