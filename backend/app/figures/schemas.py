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
    # Optimistic-concurrency guard: when supplied, the rerender only proceeds if
    # the figure's current version still matches what the client last loaded.
    # Mismatch -> 409 VERSION_CONFLICT (no version created). Omitted (None) keeps
    # the legacy behavior for the figure editor and other existing callers.
    base_version_id: uuid.UUID | None = None


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


class FigureBulkStyleRequest(BaseModel):
    source_figure_id: uuid.UUID
    target_figure_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=20)


class FigureBulkStyleResponse(BaseModel):
    updated: list[uuid.UUID] = Field(default_factory=list)
    skipped: list[uuid.UUID] = Field(default_factory=list)


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
    # U10c self-verify loop, opt-in per apply call. Both must be set (verify
    # true AND a non-empty original_request) for verification to run.
    verify: bool = False
    # Advisory (verification-only): verify_edit truncates to 4000 chars itself,
    # so the cap here is a generous abuse backstop rather than a hard 422 on a
    # long combined prompt (the client also truncates to 4000).
    original_request: str | None = Field(default=None, max_length=20_000)
    # When False (the suggestion-apply UI paths), an unsatisfied verdict is
    # reported as-is - the auto-retry never creates a version the user did not
    # explicitly select. Defaults True for the direct "Apply edit" path.
    retry: bool = True


class ImprovementApplyOneRequest(BaseModel):
    verify: bool = False
    original_request: str | None = Field(default=None, max_length=20_000)
    retry: bool = True


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
    html_url: str | None = None
    r_url: str | None = None
    # Panel geometry captured at render time: {panel_px:{x0,x1,y0,y1}, img_px:
    # {w,h}, x_range, y_range, x_discrete, y_discrete}. Pixels are for figure.png
    # with y from the image TOP. None when the sidecar was unavailable.
    layout: dict[str, Any] | None = None
    # Populated when a version is produced by applying AI suggestions; empty for
    # plain rerenders / manual edits. Lets the UI show "N of M changes applied".
    applied: list[str] = Field(default_factory=list)
    skipped: list[str] = Field(default_factory=list)


class AppliedChangeItem(BaseModel):
    # Dotted path: "style_preset", "mapping.<key>", or "options.<key>".
    key: str
    from_value: Any = Field(default=None, alias="from")
    to: Any = None

    model_config = ConfigDict(populate_by_name=True)


class VerificationResult(BaseModel):
    # U10c: number of verify_edit calls made (1, or 2 when a retry happened;
    # 0 when verification was requested but could not run - see `skipped`).
    attempts: int
    satisfied: bool
    feedback: str
    # Machine-readable reason verification could not run (e.g.
    # AI_QUOTA_EXCEEDED, AI_API_ERROR, NO_IMAGE). None when it ran normally.
    skipped: str | None = None


class ImprovementApplyResponse(BaseModel):
    """Wraps VersionResponse instead of extending it (U10b/U10c), so existing
    VersionResponse consumers (rerender, svg-edit, ...) are unaffected; only
    the two apply endpoints return this shape."""
    version: VersionResponse
    # (U10b) {key, from, to} for patch keys that visibly changed the render.
    applied_changes: list[AppliedChangeItem] = Field(default_factory=list)
    # (U10b) Patch keys that sanitize_options removed, or that provably
    # changed nothing versus the pre-apply state.
    dropped_keys: list[str] = Field(default_factory=list)
    # (U10c) Present only when the caller opted in with verify=true AND a
    # non-empty original_request.
    verification: VerificationResult | None = None


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
    # Physical size (mm) of the current version's render — the "native" size
    # the canvas editor places new panels at. None when no version exists.
    native_width_mm: float | None = None
    native_height_mm: float | None = None


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


class UnsupportedRequestItem(BaseModel):
    request: str
    reason: str


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
    # Parts of the improve request the AI reported it could NOT express as a
    # supported param_patch (U10b). Property of the whole improve_version call
    # this suggestion came from, not of this suggestion alone - the same list
    # is repeated on every ImprovementResponse from that call so the client
    # can read it off any one of them.
    unsupported: list[UnsupportedRequestItem] = Field(default_factory=list)


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
