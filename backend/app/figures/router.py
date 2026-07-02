import uuid

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from app.audit import service as audit_service
from app.auth.models import User
from app.common import storage
from app.common.deps import get_current_user, get_db
from app.common.security import rate_limit
from app.figures import service
from app.figures.schemas import (
    AltTextRequest,
    AltTextResponse,
    ComplianceReport,
    EnhancePromptRequest,
    EnhancePromptResponse,
    FigureBulkStyleRequest,
    FigureBulkStyleResponse,
    FigureCodeResponse,
    FigureCommentCreate,
    FigureCommentItem,
    FigureCreate,
    FigureDetail,
    FigureListItem,
    FigureReorderRequest,
    FigureShareRequest,
    FigureShareResponse,
    FigureTemplateFavoriteItem,
    FigureUpdate,
    GalleryFigureItem,
    ImprovementApplyRequest,
    ImprovementRequest,
    ImprovementResponse,
    LegendRequest,
    LegendResponse,
    MethodsTextResponse,
    RecommendationCacheResponse,
    RecommendationItem,
    RecommendationRequest,
    RerenderRequest,
    ReviewResponse,
    SvgEditRequest,
    TemplateFavoriteRequest,
    VersionResponse,
)
from app.palettes import service as palette_service
from app.r_engine.presets import PRESET_DESCRIPTIONS, PRESET_LABELS, PRESETS, list_palettes
from app.r_engine.templates import PLOT_TYPES, is_color_editable

router = APIRouter(prefix="/api/figures", tags=["figures"])
meta_router = APIRouter(prefix="/api", tags=["meta"])


# -------- meta --------
@meta_router.get("/plot-types")
def plot_types(_: User = Depends(get_current_user)):
    # Augment each entry with the color-edit capability flag (design §6).
    # Build new dicts so the shared PLOT_TYPES objects are never mutated.
    return {
        "plot_types": [
            {**p, "color_editable": is_color_editable(p["type"])} for p in PLOT_TYPES
        ]
    }


@meta_router.get("/styles")
def styles(_: User = Depends(get_current_user)):
    return {
        "styles": [
            {"key": p, "label": PRESET_LABELS.get(p, p), "description": PRESET_DESCRIPTIONS.get(p, "")}
            for p in PRESETS
        ]
    }


@meta_router.get("/palettes")
def palettes(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return {"palettes": list_palettes(palette_service.list_palette_options(db, current_user.id))}


@meta_router.post("/ai/enhance-prompt", response_model=EnhancePromptResponse,
                  dependencies=[Depends(rate_limit("ai_enhance_prompt", 60, 3600))])
def enhance_prompt(data: EnhancePromptRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    from app.ai import client as ai_client
    return {"enhanced": ai_client.enhance_prompt(db, data.draft, data.kind, data.context, user_id=current_user.id)}


@meta_router.post("/datasets/{dataset_id}/recommend", response_model=list[RecommendationItem],
                  dependencies=[Depends(rate_limit("ai_recommend", 60, 3600))])
def ai_recommend(dataset_id: uuid.UUID, data: RecommendationRequest | None = None,
                 db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    req = data or RecommendationRequest()
    return service.ai_recommend(
        db, dataset_id, current_user.id, refresh=req.refresh, prompt=req.prompt
    )


@meta_router.get("/datasets/{dataset_id}/recommendations", response_model=RecommendationCacheResponse)
def ai_recommendations(dataset_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    suggestions, cached = service.cached_recommendations(db, dataset_id, current_user.id)
    return {"cached": cached, "suggestions": suggestions}


@meta_router.post("/datasets/{dataset_id}/recommend-from-image", response_model=list[RecommendationItem])
async def ai_recommend_from_image(dataset_id: uuid.UUID, file: UploadFile = File(...),
                                  _: None = Depends(rate_limit("ai_recommend_image", 30, 3600)),
                                  db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    image_bytes = await file.read()
    return service.ai_recommend_from_reference_image(
        db, dataset_id, current_user.id, image_bytes, file.content_type or "application/octet-stream"
    )


# -------- figures --------
@router.post("", response_model=FigureDetail, status_code=201,
             dependencies=[Depends(rate_limit("figure_create", 60, 3600))])
def create_figure(data: FigureCreate, request: Request, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    detail = service.create_figure(db, current_user.id, data)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="figure.create",
        target_type="figure",
        target_id=detail["id"],
        metadata={"plot_type": detail["plot_type"], "version_id": detail.get("current_version_id")},
        request=request,
    )
    db.commit()
    return detail


@router.get("", response_model=list[FigureListItem])
def list_figures(project_id: uuid.UUID | None = None, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.list_figures(db, current_user.id, project_id=project_id)


@router.post("/reorder", response_model=list[FigureListItem])
def reorder_figures(data: FigureReorderRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.reorder_figures(db, current_user.id, data.figure_ids)


@router.post("/bulk-style", response_model=FigureBulkStyleResponse,
             dependencies=[Depends(rate_limit("figure_bulk_style", 30, 3600))])
def bulk_style(data: FigureBulkStyleRequest, request: Request,
               db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    result = service.bulk_apply_style(db, data.source_figure_id, data.target_figure_ids, current_user.id)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="figure.bulk_style",
        target_type="figure",
        target_id=data.source_figure_id,
        metadata={
            "updated": [str(x) for x in result["updated"]],
            "skipped": [str(x) for x in result["skipped"]],
        },
        request=request,
    )
    db.commit()
    return result


@router.get("/gallery", response_model=list[GalleryFigureItem])
def gallery(limit: int = 200, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return service.list_gallery_figures(db, limit=limit)


@router.get("/template-favorites", response_model=list[FigureTemplateFavoriteItem])
def list_template_favorites(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.list_template_favorites(db, current_user.id)


@router.get("/gallery/{figure_id}/versions/{version_id}/export")
def gallery_export(figure_id: uuid.UUID, version_id: uuid.UUID, format: str = "r",
                   db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    path, media, filename = service.gallery_export_path(db, figure_id, version_id, format)
    if storage.is_object_ref(path):
        return Response(
            storage.read_bytes(path),
            media_type=media,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    return FileResponse(path, media_type=media, filename=filename)


@router.get("/{figure_id}", response_model=FigureDetail)
def get_figure(figure_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.figure_detail(db, figure_id, current_user.id)


@router.post("/{figure_id}/duplicate", response_model=FigureDetail, status_code=201,
             dependencies=[Depends(rate_limit("figure_duplicate", 60, 3600))])
def duplicate_figure(figure_id: uuid.UUID, request: Request,
                     db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    detail = service.duplicate_figure(db, figure_id, current_user.id)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="figure.duplicate",
        target_type="figure",
        target_id=detail["id"],
        metadata={"source_figure_id": str(figure_id), "version_id": detail.get("current_version_id")},
        request=request,
    )
    db.commit()
    return detail


@router.patch("/{figure_id}", response_model=FigureDetail)
def update_figure(figure_id: uuid.UUID, data: FigureUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.update_figure(db, figure_id, current_user.id, data.model_dump(exclude_unset=True))


@router.post("/{figure_id}/share", response_model=FigureShareResponse,
             dependencies=[Depends(rate_limit("figure_share", 60, 3600))])
def set_share(figure_id: uuid.UUID, data: FigureShareRequest, request: Request,
              db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    result = service.set_figure_share(db, figure_id, current_user.id, data.enable)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="figure.share" if data.enable else "figure.unshare",
        target_type="figure",
        target_id=figure_id,
        metadata={"enabled": data.enable},
        request=request,
    )
    db.commit()
    return result


@router.post("/{figure_id}/template-favorite", response_model=FigureTemplateFavoriteItem)
def save_template_favorite(
    figure_id: uuid.UUID,
    data: TemplateFavoriteRequest | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    req = data or TemplateFavoriteRequest()
    return service.save_template_favorite(
        db,
        figure_id,
        current_user.id,
        source_version_id=req.source_version_id,
        name=req.name,
    )


@router.delete("/{figure_id}/template-favorite", status_code=204)
def remove_template_favorite(figure_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    service.remove_template_favorite(db, figure_id, current_user.id)


@router.post("/{figure_id}/versions/{version_id}/legend", response_model=LegendResponse,
             dependencies=[Depends(rate_limit("ai_legend", 60, 3600))])
def generate_legend(figure_id: uuid.UUID, version_id: uuid.UUID, data: LegendRequest | None = None,
                    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    req = data or LegendRequest()
    return service.generate_legend(
        db,
        figure_id,
        version_id,
        current_user.id,
        prompt=req.prompt,
        current_legend=req.current_legend,
    )


@router.get("/{figure_id}/comments", response_model=list[FigureCommentItem])
def list_comments(figure_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.list_comments(db, figure_id, current_user.id)


@router.post("/{figure_id}/comments", response_model=FigureCommentItem, status_code=201,
             dependencies=[Depends(rate_limit("figure_comment_create", 120, 3600))])
def create_comment(figure_id: uuid.UUID, data: FigureCommentCreate,
                   db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.create_comment(db, figure_id, current_user.id, data.body)


@router.delete("/{figure_id}/comments/{comment_id}", status_code=204)
def delete_comment(figure_id: uuid.UUID, comment_id: uuid.UUID,
                   db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    service.delete_comment(db, figure_id, comment_id, current_user.id)


@router.post("/{figure_id}/versions/{version_id}/methods-text", response_model=MethodsTextResponse,
             dependencies=[Depends(rate_limit("figure_methods_text", 120, 3600))])
def generate_methods_text(figure_id: uuid.UUID, version_id: uuid.UUID,
                          db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.generate_methods_text(db, figure_id, version_id, current_user.id)


@router.get("/{figure_id}/versions/{version_id}/code", response_model=FigureCodeResponse,
            dependencies=[Depends(rate_limit("figure_code_export", 120, 3600))])
def export_figure_code(figure_id: uuid.UUID, version_id: uuid.UUID, lang: str = "python",
                       db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.generate_figure_code(db, figure_id, version_id, current_user.id, lang)


@router.post("/{figure_id}/versions/{version_id}/alt-text", response_model=AltTextResponse,
             dependencies=[Depends(rate_limit("ai_alt_text", 60, 3600))])
def generate_alt_text(figure_id: uuid.UUID, version_id: uuid.UUID, data: AltTextRequest | None = None,
                      db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    req = data or AltTextRequest()
    return service.generate_alt_text(db, figure_id, version_id, current_user.id, prompt=req.prompt)


@router.delete("/{figure_id}", status_code=204)
def delete_figure(figure_id: uuid.UUID, request: Request, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    service.delete_figure(db, figure_id, current_user.id)
    audit_service.log_event(db, actor_id=current_user.id, action="figure.delete", target_type="figure", target_id=figure_id, metadata={}, request=request)
    db.commit()


@router.delete("/{figure_id}/versions/{version_id}", response_model=FigureDetail)
def delete_figure_version(figure_id: uuid.UUID, version_id: uuid.UUID, request: Request,
                          db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    detail = service.delete_figure_version(db, figure_id, version_id, current_user.id)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="figure.version.delete",
        target_type="figure",
        target_id=figure_id,
        metadata={"version_id": str(version_id), "current_version_id": str(detail["current_version_id"])},
        request=request,
    )
    db.commit()
    return detail


@router.post("/{figure_id}/rerender", response_model=VersionResponse,
             dependencies=[Depends(rate_limit("figure_rerender", 60, 3600))])
def rerender(figure_id: uuid.UUID, req: RerenderRequest, request: Request, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    version = service.rerender(db, figure_id, current_user.id, req)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="figure.rerender",
        target_type="figure",
        target_id=figure_id,
        metadata={"version_id": version["id"], "style_preset": version["style_preset"]},
        request=request,
    )
    db.commit()
    return version


@router.post("/{figure_id}/versions/{version_id}/svg-edit", response_model=VersionResponse,
             dependencies=[Depends(rate_limit("figure_svg_edit", 120, 3600))])
def save_svg_edit(figure_id: uuid.UUID, version_id: uuid.UUID, data: SvgEditRequest,
                  request: Request, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    version = service.save_svg_edit(db, figure_id, version_id, current_user.id, data.svg, data.change_note)
    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="figure.svg_edit",
        target_type="figure",
        target_id=figure_id,
        metadata={"source_version_id": str(version_id), "version_id": version["id"]},
        request=request,
    )
    db.commit()
    return version


@router.post("/{figure_id}/versions/{version_id}/review", response_model=ReviewResponse,
             dependencies=[Depends(rate_limit("ai_review", 60, 3600))])
def review(figure_id: uuid.UUID, version_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.review_version(db, figure_id, version_id, current_user.id)


@router.post("/{figure_id}/versions/{version_id}/improve", response_model=list[ImprovementResponse],
             dependencies=[Depends(rate_limit("ai_improve", 60, 3600))])
def improve(figure_id: uuid.UUID, version_id: uuid.UUID, data: ImprovementRequest | None = None,
            db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    req = data or ImprovementRequest()
    return service.improve_version(
        db, figure_id, version_id, current_user.id,
        prompt=req.prompt, annotated_image=req.annotated_image,
    )


@router.get("/{figure_id}/versions/{version_id}/improvements", response_model=list[ImprovementResponse])
def list_improvements(figure_id: uuid.UUID, version_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.list_improvements(db, figure_id, version_id, current_user.id)


@router.post("/{figure_id}/improvements/apply", response_model=VersionResponse)
def apply_improvements(figure_id: uuid.UUID, data: ImprovementApplyRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.apply_improvements(db, figure_id, data.improvement_ids, current_user.id)


@router.post("/{figure_id}/improvements/{improvement_id}/apply", response_model=VersionResponse)
def apply_improvement(figure_id: uuid.UUID, improvement_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.apply_improvement(db, figure_id, improvement_id, current_user.id)


@router.get("/{figure_id}/versions/{version_id}/export")
def export(figure_id: uuid.UUID, version_id: uuid.UUID, format: str = "png",
           db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    path, media, filename = service.export_path(db, figure_id, version_id, format, current_user.id)
    if storage.is_object_ref(path):
        return Response(
            storage.read_bytes(path),
            media_type=media,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    return FileResponse(path, media_type=media, filename=filename)


@router.get("/{figure_id}/versions/{version_id}/compliance", response_model=ComplianceReport)
def compliance(figure_id: uuid.UUID, version_id: uuid.UUID,
               db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.check_compliance(db, figure_id, version_id, current_user.id)


@router.get("/{figure_id}/versions/{version_id}/submission-bundle",
            dependencies=[Depends(rate_limit("figure_submission_bundle", 30, 3600))])
def submission_bundle(figure_id: uuid.UUID, version_id: uuid.UUID, column: str = "single",
                      db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    data, filename = service.build_submission_bundle(db, figure_id, version_id, current_user.id, column)
    return Response(
        data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
