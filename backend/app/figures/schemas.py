import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class FigureCreate(BaseModel):
    dataset_id: uuid.UUID
    name: str = Field(..., min_length=1, max_length=255)
    plot_type: str
    mapping: dict[str, Any] = Field(default_factory=dict)
    options: dict[str, Any] = Field(default_factory=dict)
    style_preset: str = "nature"
    # Fresh figures receive the current explicit publication defaults. Figure
    # templates/format copies opt into preserve so their saved visual contract
    # is not silently restyled while being reused.
    defaults_profile: Literal["publication_v2", "preserve"] = "publication_v2"


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
    grounding: dict[str, Any] = Field(default_factory=dict)
    prompt_version: str | None = None


class LegendRequest(BaseModel):
    prompt: str | None = Field(default=None, max_length=1500)
    current_legend: str | None = Field(default=None, max_length=5000)


class MethodsTextResponse(BaseModel):
    methods_text: str
    grounding: dict[str, Any] = Field(default_factory=dict)
    runtime_versions: dict[str, str] = Field(default_factory=dict)
    generator_version: str | None = None


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
    grounding: dict[str, Any] = Field(default_factory=dict)
    prompt_version: str | None = None


class EnhancePromptRequest(BaseModel):
    draft: str = ""
    kind: str = "dataset_description"
    context: str | None = None


class EnhancePromptResponse(BaseModel):
    enhanced: str


class RecommendationRequest(BaseModel):
    refresh: bool = False
    prompt: str | None = Field(default=None, max_length=1500)


class ImprovementNormalizedPoint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(..., ge=0, le=1)
    y: float = Field(..., ge=0, le=1)


class ImprovementNormalizedBBox(ImprovementNormalizedPoint):
    width: float = Field(..., ge=0, le=1)
    height: float = Field(..., ge=0, le=1)


class ImprovementResolvedTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str = Field(..., min_length=1, max_length=80)
    label: str | None = Field(default=None, max_length=160)
    # Accepts simple dotted paths AND per-element override roots
    # ("options.element_overrides.<renderer mark id>"): mark ids contain
    # ':', '=', '&' and %-escapes, and rejecting them here made the WHOLE
    # /improve request 422 whenever a mark resolved to a bar/point/cell —
    # which then dropped the AI-busy state and let a leftover draft render as
    # a stray "Live preview" version. The value stays untrusted either way:
    # the service re-derives targets from the persisted layout.
    setting_path: str | None = Field(
        default=None,
        max_length=700,
        pattern=r"^(?:style_preset|mapping(?:\.[A-Za-z0-9_]+)?|options(?:\.[A-Za-z0-9_]+)?|options\.element_overrides\.[^\s]{1,600})$",
    )
    element_id: str | None = Field(default=None, max_length=160)
    role: str | None = Field(default=None, max_length=80)
    category: str | None = Field(default=None, max_length=160)
    series: str | None = Field(default=None, max_length=160)
    editable: bool | None = None
    unsupported_reason: str | None = Field(default=None, max_length=500)
    bbox_source: str | None = Field(default=None, max_length=80)
    # Client echo of the sidecar's degenerate "add here" band flag. Untrusted
    # like every other field here: the service re-derives placeholder status
    # from the persisted layout when it matters.
    placeholder: bool | None = None


class ImprovementMark(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # `id` is the stable client identity; label/display_number are presentation
    # aliases. The service persists all three and never substitutes a provider
    # invented identifier.
    id: str = Field(..., min_length=1, max_length=100)
    label: str = Field(..., min_length=1, max_length=100)
    display_number: int | None = Field(default=None, ge=1, le=9999)
    type: str = Field(..., pattern=r"^(?:region|arrow|note)$")
    # A general prompt may carry the instruction for a geometric mark, so an
    # empty per-mark memo is valid and must not turn an otherwise actionable
    # request into a 422 response.
    memo: str = Field(default="", max_length=1000)
    bbox_normalized: ImprovementNormalizedBBox | None = None
    point_normalized: ImprovementNormalizedPoint | None = None
    resolved_target: ImprovementResolvedTarget | None = None
    # Explicit target chosen by the user after reviewing the inferred target.
    # This remains untrusted input: the service must resolve it back to a
    # nearby editable element in the persisted FigureVersion.layout.
    target_override: ImprovementResolvedTarget | None = None


class ImprovementRequest(BaseModel):
    prompt: str | None = Field(default=None, max_length=4000)
    # Exact user-authored text, without generated coordinate summaries or
    # provider prose.  The service binds this provenance to the durable plan
    # so a later apply request cannot substitute a different verification
    # target.  `prompt` remains the model-facing, annotated request.
    original_request: str | None = Field(default=None, max_length=20_000)
    annotated_image: str | None = Field(default=None, max_length=12_000_000)
    marks: list[ImprovementMark] = Field(default_factory=list, max_length=20)


class ImprovementApplyRequest(BaseModel):
    improvement_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=20)
    # U10c self-verify loop, opt-in per apply call. For current plans the
    # server-owned request captured during /improve is authoritative.
    verify: bool = False
    # Legacy/advisory echo retained for backwards compatibility and mismatch
    # diagnostics; it must never replace a request already bound to the plan.
    original_request: str | None = Field(default=None, max_length=20_000)
    # Optional selected-plan summary retained as audit context. Verification
    # remains grounded in the server-bound original request and edit scopes.
    verification_request: str | None = Field(default=None, max_length=20_000)
    # Optimistic-concurrency guard for a reviewed plan. Applying a suggestion
    # generated for an older figure version must never overwrite a newer edit.
    expected_base_version_id: uuid.UUID | None = None
    # When False (the suggestion-apply UI paths), an unsatisfied verdict is
    # reported as-is - the auto-retry never creates a version the user did not
    # explicitly select. Defaults True for the direct "Apply edit" path.
    retry: bool = True


class ImprovementApplyOneRequest(BaseModel):
    verify: bool = False
    original_request: str | None = Field(default=None, max_length=20_000)
    verification_request: str | None = Field(default=None, max_length=20_000)
    expected_base_version_id: uuid.UUID | None = None
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
    r_available: bool = False
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
    # True when `from` is the renderer-effective default of a previously
    # UNSET option (e.g. heatmap's implicit 45deg tick angle), so the UI can
    # label it "(default)" instead of showing a misleading "(unset)".
    from_is_default: bool = False

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
    allowed_patch_keys: list[str] = Field(default_factory=list)
    unrequested_changes: list[AppliedChangeItem] = Field(default_factory=list)


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
    mark_id: str | None = None
    resolved_target: str | None = None


class ImprovementResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    figure_version_id: uuid.UUID
    suggestion_type: str | None = None
    current_state: str | None = None
    recommended: str | None = None
    param_patch: dict[str, Any]
    # Stable, server-derived provenance for a general request or Mark #n. The
    # allowed_patch_keys list is the request whitelist intersected with this
    # suggestion's sanitized patch, and is enforced again during apply/verify.
    edit_scope: dict[str, Any] | None = None
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
    scores: dict[str, float] = Field(default_factory=dict)
    rank: int | None = None
    fit: str | None = None
    rationale: str | None = None
    required_vars: dict[str, Any] | None = None
    suggested_mapping: dict[str, Any] | None = None
    suggested_options: dict[str, Any] = Field(default_factory=dict)
    intent: dict[str, Any] = Field(default_factory=dict)
    mapping_complete: bool = True
    missing_required_mappings: list[dict[str, str]] = Field(default_factory=list)
    example_usage: str | None = None
    source: str = "rule"


class RecommendationCacheResponse(BaseModel):
    cached: bool = False
    suggestions: list[RecommendationItem] = Field(default_factory=list)
