"""High-level AI features (provider-agnostic). Reads the active AIConfig from DB
and dispatches to the configured provider (Claude or Gemini)."""
from __future__ import annotations

import base64
import json
import os

from sqlalchemy.orm import Session

from app.ai import providers
from app.ai.config_service import active_model_and_key, get_config
from app.ai.prompts import IMPROVE_SYSTEM, LEGEND_SYSTEM, RECOMMEND_SYSTEM, REVIEW_SYSTEM
from app.common.exceptions import BadRequestError

_PLOT_TYPES = ["box", "violin", "scatter", "bar", "line", "heatmap", "volcano", "pca", "kaplan_meier"]
_MAPPING_PATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "x": {"type": "string"}, "y": {"type": "string"}, "color": {"type": "string"},
        "group": {"type": "string"}, "time": {"type": "string"}, "status": {"type": "string"},
        "log2fc": {"type": "string"}, "pvalue": {"type": "string"}, "gene_label": {"type": "string"},
        "row_label": {"type": "string"}, "columns": {"type": "array", "items": {"type": "string"}},
    },
}
_OPTIONS_PATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "show_points": {"type": "boolean"}, "show_box": {"type": "boolean"},
        "add_smooth": {"type": "boolean"}, "error_bars": {"type": "boolean"},
        "scale_rows": {"type": "boolean"}, "stat": {"type": "string", "enum": ["mean", "sum", "count"]},
        "palette": {"type": "string", "enum": ["viridis", "magma", "inferno", "plasma", "cividis"]},
        "fc_threshold": {"type": "number"}, "p_threshold": {"type": "number"},
        "label_top": {"type": "integer"}, "palette_name": {"type": "string"},
        "size": {"type": "string", "enum": ["single_column", "wide", "double_column", "square", "custom"]},
        "width_in": {"type": "number"}, "height_in": {"type": "number"},
        "color_mode": {"type": "string", "enum": ["color", "grayscale"]},
        "font_scale": {"type": "number"}, "dpi": {"type": "integer"},
        "title": {"type": "string"}, "subtitle": {"type": "string"},
        "x_label": {"type": "string"}, "y_label": {"type": "string"},
        "legend_title": {"type": "string"}, "hide_legend": {"type": "boolean"},
        "log_x": {"type": "boolean"}, "log_y": {"type": "boolean"}, "flip_coords": {"type": "boolean"},
    },
}


def _ctx_block(project_context: str | None) -> list[dict]:
    if project_context and project_context.strip():
        return [{"kind": "text", "text": "PROJECT RESEARCH CONTEXT (use to interpret variables; do NOT invent findings):\n" + project_context.strip()}]
    return []


def _ready(db: Session):
    cfg = get_config(db)
    if not cfg.enabled:
        raise BadRequestError("AI features are disabled", error_code="AI_DISABLED")
    model, key = active_model_and_key(cfg)
    if not key:
        raise BadRequestError(f"No API key configured for provider '{cfg.provider}'", error_code="AI_NO_KEY")
    return cfg, model, key


def active_provider_label(db: Session) -> str:
    cfg = get_config(db)
    return f"{cfg.provider}:{active_model_and_key(cfg)[0]}"


# ----------------------------------------------------------------- recommend
def recommend_charts(db: Session, column_profile: list[dict], project_context: str | None = None) -> list[dict]:
    cfg, model, key = _ready(db)
    cols = [{"name": c["name"], "dtype": c["dtype"], "role": c["role"],
             "n_unique": c["n_unique"], "sample": c.get("sample_values", [])[:4]} for c in column_profile]
    system = RECOMMEND_SYSTEM
    mapping_schema = {
        "type": "object",
        "properties": {
            "x": {"type": "string"}, "y": {"type": "string"}, "color": {"type": "string"},
            "group": {"type": "string"}, "time": {"type": "string"}, "status": {"type": "string"},
            "log2fc": {"type": "string"}, "pvalue": {"type": "string"}, "gene_label": {"type": "string"},
            "row_label": {"type": "string"}, "columns": {"type": "array", "items": {"type": "string"}},
        },
    }
    schema = {
        "type": "object",
        "properties": {"recommendations": {"type": "array", "items": {"type": "object", "properties": {
            "plot_type": {"type": "string", "enum": _PLOT_TYPES},
            "title": {"type": "string"}, "score": {"type": "number"},
            "rationale": {"type": "string"}, "required_vars": mapping_schema,
            "suggested_mapping": mapping_schema,
            "example_usage": {"type": "string"}},
            "required": ["plot_type", "title", "score", "rationale"]}}},
        "required": ["recommendations"],
    }
    content = _ctx_block(project_context) + [{"kind": "text", "text": "Column profile:\n" + json.dumps(cols, ensure_ascii=False)}]
    out = providers.run_structured(cfg.provider, model, key, system, content, schema, "chart_recommendations", 2000)
    recs = out.get("recommendations", [])
    for r in recs:
        r["source"] = cfg.provider
        if not r.get("suggested_mapping") and isinstance(r.get("required_vars"), dict):
            r["suggested_mapping"] = {k: v for k, v in r["required_vars"].items() if v not in (None, "", [])}
    return recs


# ----------------------------------------------------------------- review
def review_figure(db: Session, png_path: str, plot_type: str, mapping: dict, options: dict, project_context: str | None = None) -> dict:
    cfg, model, key = _ready(db)
    if not os.path.exists(png_path):
        raise BadRequestError("Rendered image not found for review", error_code="NO_IMAGE")
    with open(png_path, "rb") as f:
        b64 = base64.standard_b64encode(f.read()).decode("ascii")
    system = REVIEW_SYSTEM
    review_section_schema = {
        "type": "object",
        "properties": {
            "score": {"type": "integer"},
            "comments": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["score", "comments"],
    }
    schema = {
        "type": "object",
        "properties": {
            "publication_score": {"type": "integer"},
            "summary": {"type": "string"},
            "visual_quality": review_section_schema,
            "statistical": review_section_schema,
            "suitability": review_section_schema,
            "strengths": {"type": "array", "items": {"type": "string"}},
            "issues": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["publication_score", "summary", "visual_quality", "statistical", "suitability", "strengths", "issues"],
    }
    content = _ctx_block(project_context) + [
        {"kind": "text", "text": f"Figure type: {plot_type}. Mapping: {json.dumps(mapping, ensure_ascii=False)}. "
                                 f"Style options: {json.dumps(options, ensure_ascii=False)}."},
        {"kind": "image", "mime": "image/png", "b64": b64},
    ]
    return _normalize_review_payload(
        providers.run_structured(cfg.provider, model, key, system, content, schema, "figure_review", 2500)
    )


def _score_comments(value: dict | None) -> dict | None:
    if not isinstance(value, dict):
        return None
    comments = value.get("comments")
    if comments is None and value.get("comment"):
        comments = [value["comment"]]
    if comments is None:
        comments = []
    return {"score": value.get("score"), "comments": comments}


def _normalize_review_payload(payload: dict) -> dict:
    """Accept both the current flat shape and older category-shaped reviews."""
    if not isinstance(payload, dict):
        return payload
    categories = payload.get("categories")
    if isinstance(categories, dict):
        mapping = {
            "visual_quality": "visual_quality",
            "statistical_representation": "statistical",
            "journal_suitability": "suitability",
        }
        for source, target in mapping.items():
            if target not in payload:
                normalized = _score_comments(categories.get(source))
                if normalized:
                    payload[target] = normalized
    return payload


# ----------------------------------------------------------------- improve
def improve_figure(db: Session, plot_type: str, mapping: dict, options: dict, style_preset: str,
                   review: dict | None, available_options: list[dict], project_context: str | None = None) -> list[dict]:
    cfg, model, key = _ready(db)
    system = IMPROVE_SYSTEM
    schema = {
        "type": "object",
        "properties": {"suggestions": {"type": "array", "items": {"type": "object", "properties": {
            "suggestion_type": {"type": "string"}, "current": {"type": "string"},
            "recommended": {"type": "string"}, "priority": {"type": "string", "enum": ["high", "medium", "low"]},
            "param_patch": {"type": "object", "properties": {
                "style_preset": {"type": "string", "enum": ["nature", "science", "cell", "minimal", "colorblind"]},
                "mapping": _MAPPING_PATCH_SCHEMA,
                "options": _OPTIONS_PATCH_SCHEMA,
            }}},
            "required": ["suggestion_type", "recommended", "param_patch"]}}},
        "required": ["suggestions"],
    }
    ctx = {"plot_type": plot_type, "current_mapping": mapping, "current_options": options,
           "current_style_preset": style_preset, "available_options_for_this_type": available_options,
           "prior_review": review or {}}
    content = _ctx_block(project_context) + [{"kind": "text", "text": "Context:\n" + json.dumps(ctx, ensure_ascii=False)}]
    try:
        out = providers.run_structured(cfg.provider, model, key, system, content, schema, "figure_improvements", 2000)
    except BadRequestError as e:
        if getattr(e, "error_code", None) == "AI_BAD_RESPONSE":
            return _fallback_improvements(options, style_preset)
        raise
    return out.get("suggestions", [])


def _fallback_improvements(options: dict, style_preset: str) -> list[dict]:
    patch = {"options": {"size": "wide", "dpi": 300, "font_scale": 1.1}}
    if not options.get("palette_name"):
        patch["options"]["palette_name"] = "okabe_ito"
    if style_preset not in ("nature", "science", "cell", "colorblind"):
        patch["style_preset"] = "colorblind"
    return [{
        "suggestion_type": "Publication export settings",
        "current": "The AI provider returned an incomplete improvement payload.",
        "recommended": "Apply conservative publication defaults: wide export, 300 dpi, slightly larger text, and a colorblind-safe palette when no palette is set.",
        "priority": "medium",
        "param_patch": patch,
    }]


# ----------------------------------------------------------------- figure legend
def generate_legend(db: Session, plot_type: str, mapping: dict, options: dict,
                    dataset_summary: dict, author_notes: str | None, style: str = "nature",
                    project_context: str | None = None) -> str:
    cfg, model, key = _ready(db)
    system = LEGEND_SYSTEM
    schema = {"type": "object", "properties": {"legend": {"type": "string"}}, "required": ["legend"]}
    ctx = {"plot_type": plot_type, "mapping": mapping, "options": options,
           "dataset_summary": dataset_summary, "author_notes": author_notes or "", "journal_style": style}
    content = _ctx_block(project_context) + [{"kind": "text", "text": "Context:\n" + json.dumps(ctx, ensure_ascii=False)}]
    out = providers.run_structured(cfg.provider, model, key, system, content, schema, "figure_legend", 900)
    return out.get("legend", "")


# ----------------------------------------------------------------- prompt enhance
_ENHANCE_TARGET = {
    "dataset_description": "a description of a scientific dataset that an AI will use as context for chart recommendation, figure review and legend writing",
    "interpretation": "a researcher's interpretation / results notes about a figure, for a manuscript",
    "figure_edit": "an instruction describing how to modify a ggplot2 figure (chart type, axes, labels, colours, size)",
    "project": "a description of a research project / study used as AI context",
    "legend": "a publication figure legend",
}


def enhance_prompt(db: Session, draft: str, kind: str = "dataset_description", context: str | None = None) -> str:
    cfg, model, key = _ready(db)
    target = _ENHANCE_TARGET.get(kind, "a prompt")
    system = (
        f"You are a writing assistant. Improve the user's rough draft into a clear, specific, well-phrased {target}. "
        "Preserve the user's intent and any facts they state; do NOT invent data, results, statistics or details that "
        "were not provided. Keep it concise (1-4 sentences). Output ONLY the improved text — no preamble, no quotation "
        "marks, no markdown."
    )
    schema = {"type": "object", "properties": {"enhanced": {"type": "string"}}, "required": ["enhanced"]}
    draft_text = draft.strip() if draft and draft.strip() else "(empty — propose a reasonable starting point from the context)"
    content = _ctx_block(context) + [{"kind": "text", "text": "Draft to improve:\n" + draft_text}]
    out = providers.run_structured(cfg.provider, model, key, system, content, schema, "enhanced_prompt", 700)
    return out.get("enhanced", "")
