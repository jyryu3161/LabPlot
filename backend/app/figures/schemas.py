import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class FigureCreate(BaseModel):
    dataset_id: uuid.UUID
    name: str = Field(..., min_length=1, max_length=255)
    plot_type: str
    mapping: dict[str, Any] = Field(default_factory=dict)
    options: dict[str, Any] = Field(default_factory=dict)
    style_preset: str = "nature"


class RerenderRequest(BaseModel):
    plot_type: str | None = None
    mapping: dict[str, Any] | None = None
    options: dict[str, Any] | None = None
    style_preset: str | None = None
    change_note: str | None = None


class SvgEditRequest(BaseModel):
    svg: str = Field(..., min_length=1, max_length=5_000_000)
    change_note: str | None = Field(default=None, max_length=512)


class FigureUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    legend: str | None = None
    is_favorite: bool | None = None
    is_public: bool | None = None


class FigureShareRequest(BaseModel):
    enable: bool


class FigureShareResponse(BaseModel):
    share_token: str | None = None
    share_url: str | None = None


class FigureReorderRequest(BaseModel):
    figure_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=200)


class TemplateFavoriteRequest(BaseModel):
    source_version_id: uuid.UUID | None = None
    name: str | None = Field(default=None, max_length=255)


class LegendResponse(BaseModel):
    legend: str


class LegendRequest(BaseModel):
    prompt: str | None = Field(default=None, max_length=1500)
    current_legend: str | None = Field(default=None, max_length=5000)


class MethodsTextResponse(BaseModel):
    methods_text: str


class FigureCommentCreate(BaseModel):
    # Length is validated after stripping in the service layer (1-2000 chars);
    # the schema cap only guards against pathological payloads.
    body: str = Field(..., min_length=1, max_length=10_000)


class FigureCommentItem(BaseModel):
    id: uuid.UUID
    figure_id: uuid.UUID
    author_id: uuid.UUID
    author_name: str
    body: str
    created_at: datetime
    can_delete: bool


class FigureCodeResponse(BaseModel):
    language: str
    filename: str
    code: str


class AltTextRequest(BaseModel):
    prompt: str | None = Field(default=None, max_length=1000)


class AltTextResponse(BaseModel):
    alt_text: str


class EnhancePromptRequest(BaseModel):
    draft: str = ""
    kind: str = "dataset_description"
    context: str | None = None


class EnhancePromptResponse(BaseModel):
    enhanced: str


class RecommendationRequest(BaseModel):
    refresh: bool = False
    prompt: str | None = Field(default=None, max_length=1500)


class ImprovementRequest(BaseModel):
    prompt: str | None = Field(default=None, max_length=4000)
    annotated_image: str | None = Field(default=None, max_length=12_000_000)


class ImprovementApplyRequest(BaseModel):
    improvement_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=20)


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
    eps_url: str | None = None
    r_url: str | None = None
    # Populated when a version is produced by applying AI suggestions; empty for
    # plain rerenders / manual edits. Lets the UI show "N of M changes applied".
    applied: list[str] = Field(default_factory=list)
    skipped: list[str] = Field(default_factory=list)


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
    display_order: int | None = None
    is_favorite: bool = False
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
    current_version_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    is_favorite: bool = False
    is_public: bool = False
    thumb_url: str | None = None
    r_url: str | None = None


class FigureTemplateFavoriteItem(BaseModel):
    id: uuid.UUID
    figure_id: uuid.UUID
    source_version_id: uuid.UUID | None = None
    name: str
    figure_name: str
    plot_type: str
    style_preset: str
    source_version_number: int | None = None
    mapping: dict[str, Any] = Field(default_factory=dict)
    options: dict[str, Any] = Field(default_factory=dict)
    status: str
    dataset_id: uuid.UUID
    project_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    figure_updated_at: datetime
    is_favorite: bool = True
    thumb_url: str | None = None


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
    is_favorite: bool = False
    is_public: bool = False
    share_token: str | None = None
    versions: list[VersionResponse] = Field(default_factory=list)


class ComplianceCheckItem(BaseModel):
    name: str
    ok: bool
    actual: str
    expected: str
    hint: str | None = None


class ComplianceReport(BaseModel):
    figure_id: uuid.UUID
    version_id: uuid.UUID
    style_preset: str
    journal: str
    passed: bool
    width_in: float
    height_in: float
    dpi: int
    available_formats: list[str] = Field(default_factory=list)
    checks: list[ComplianceCheckItem] = Field(default_factory=list)


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
    # Dotted paths the AI proposed for this suggestion that were dropped by
    # sanitization (unsupported key, wrong type, or unknown column).
    skipped: list[str] = Field(default_factory=list)


class RecommendationItem(BaseModel):
    plot_type: str
    title: str | None = None
    score: float | str | None = None
    rank: int | None = None
    fit: str | None = None
    rationale: str | None = None
    required_vars: dict[str, Any] | None = None
    suggested_mapping: dict[str, Any] | None = None
    example_usage: str | None = None
    source: str = "rule"


class RecommendationCacheResponse(BaseModel):
    cached: bool = False
    suggestions: list[RecommendationItem] = Field(default_factory=list)
