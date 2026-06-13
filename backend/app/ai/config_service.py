from sqlalchemy.orm import Session

from app.ai.models import AIConfig
from app.config import settings


def get_config(db: Session) -> AIConfig:
    cfg = db.query(AIConfig).first()
    if cfg is None:
        cfg = AIConfig(
            provider=settings.AI_PROVIDER or "claude",
            enabled=settings.AI_ENABLED,
            claude_model=settings.ANTHROPIC_MODEL,
            gemini_model=settings.GEMINI_MODEL,
            anthropic_api_key=settings.ANTHROPIC_API_KEY or None,
            gemini_api_key=settings.GEMINI_API_KEY or None,
        )
        db.add(cfg)
        db.commit()
        db.refresh(cfg)
    return cfg


def public_view(cfg: AIConfig) -> dict:
    return {
        "provider": cfg.provider,
        "enabled": cfg.enabled,
        "claude_model": cfg.claude_model,
        "gemini_model": cfg.gemini_model,
        "has_anthropic_key": bool(cfg.anthropic_api_key),
        "has_gemini_key": bool(cfg.gemini_api_key),
        "updated_at": cfg.updated_at,
    }


def update_config(db: Session, data: dict) -> AIConfig:
    cfg = get_config(db)
    for field in ("provider", "enabled", "claude_model", "gemini_model"):
        if data.get(field) is not None:
            setattr(cfg, field, data[field])
    # only overwrite keys when a non-empty value is provided (avoid wiping on UI save)
    if data.get("anthropic_api_key"):
        cfg.anthropic_api_key = data["anthropic_api_key"]
    if data.get("gemini_api_key"):
        cfg.gemini_api_key = data["gemini_api_key"]
    db.commit()
    db.refresh(cfg)
    return cfg


def active_model_and_key(cfg: AIConfig) -> tuple[str, str | None]:
    if cfg.provider == "gemini":
        return cfg.gemini_model, cfg.gemini_api_key
    return cfg.claude_model, cfg.anthropic_api_key
