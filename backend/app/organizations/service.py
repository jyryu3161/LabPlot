from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.audit import service as audit_service
from app.ai.models import AIUsage
from app.auth.models import User
from app.common.exceptions import AppError, BadRequestError, NotFoundError
from app.common.secrets import decrypt_secret, encrypt_secret, secret_status
from app.config import settings
from app.organizations.models import Organization, OrganizationAIConfig, OrganizationMembership


def _now():
    return datetime.now(timezone.utc)


def _month_start() -> datetime:
    now = _now()
    return datetime(now.year, now.month, 1, tzinfo=timezone.utc)


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    slug = re.sub(r"-+", "-", slug)
    return slug[:120] or "organization"


def _normalize_domain(domain: str | None) -> str | None:
    if not domain:
        return None
    value = domain.strip().lower()
    value = value.removeprefix("https://").removeprefix("http://").split("/", 1)[0]
    return value or None


def _org_or_404(db: Session, organization_id: uuid.UUID) -> Organization:
    org = db.query(Organization).filter(Organization.id == organization_id, Organization.is_active == True).first()
    if not org:
        raise NotFoundError("Organization", str(organization_id))
    return org


def _membership(db: Session, organization_id: uuid.UUID, user_id: uuid.UUID) -> OrganizationMembership | None:
    return (
        db.query(OrganizationMembership)
        .filter(OrganizationMembership.organization_id == organization_id, OrganizationMembership.user_id == user_id)
        .first()
    )


def is_org_admin(db: Session, organization_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    row = _membership(db, organization_id, user_id)
    return bool(row and row.status == "active" and row.role == "admin")


def require_org_admin(db: Session, organization_id: uuid.UUID, user_id: uuid.UUID) -> Organization:
    org = _org_or_404(db, organization_id)
    if not is_org_admin(db, organization_id, user_id):
        raise AppError(status_code=403, detail="Organization admin privileges required", error_code="ORG_ADMIN_REQUIRED")
    return org


def _membership_item(org: Organization, membership: OrganizationMembership, user: User) -> dict:
    return {
        "id": membership.id,
        "organization_id": org.id,
        "organization_name": org.name,
        "user_id": user.id,
        "email": user.email,
        "display_name": user.display_name,
        "role": membership.role,
        "status": membership.status,
        "requested_at": membership.requested_at,
        "reviewed_at": membership.reviewed_at,
    }


def search_organizations(db: Session, q: str | None = None, limit: int = 20) -> list[dict]:
    limit = max(1, min(limit, 50))
    query = db.query(Organization).filter(Organization.is_active == True)
    if q and q.strip():
        term = f"%{q.strip().lower()}%"
        query = query.filter(or_(func.lower(Organization.name).like(term), func.lower(Organization.slug).like(term), func.lower(Organization.domain).like(term)))
    orgs = query.order_by(Organization.name.asc()).limit(limit).all()
    counts = dict(
        db.query(OrganizationMembership.organization_id, func.count(OrganizationMembership.id))
        .filter(OrganizationMembership.status == "active", OrganizationMembership.organization_id.in_([o.id for o in orgs]))
        .group_by(OrganizationMembership.organization_id)
        .all()
    ) if orgs else {}
    return [
        {"id": org.id, "name": org.name, "slug": org.slug, "domain": org.domain, "member_count": int(counts.get(org.id, 0))}
        for org in orgs
    ]


def my_organizations(db: Session, user: User) -> list[dict]:
    rows = (
        db.query(Organization, OrganizationMembership, User)
        .join(OrganizationMembership, OrganizationMembership.organization_id == Organization.id)
        .join(User, User.id == OrganizationMembership.user_id)
        .filter(OrganizationMembership.user_id == user.id, Organization.is_active == True)
        .order_by(Organization.name.asc())
        .all()
    )
    return [
        {
            "organization": org,
            "membership": _membership_item(org, membership, member_user),
            "active": bool(user.active_organization_id == org.id),
            "is_org_admin": membership.status == "active" and membership.role == "admin",
        }
        for org, membership, member_user in rows
    ]


def create_organization(db: Session, user: User, data, request=None) -> Organization:
    slug = (data.slug or _slugify(data.name)).lower()
    if db.query(Organization.id).filter(Organization.slug == slug).first():
        raise BadRequestError("Organization slug is already in use", error_code="ORG_SLUG_EXISTS")
    org = Organization(
        name=data.name.strip(),
        slug=slug,
        domain=_normalize_domain(data.domain),
        description=data.description,
        created_by_id=user.id,
    )
    db.add(org)
    db.flush()
    membership = OrganizationMembership(
        organization_id=org.id,
        user_id=user.id,
        role="admin",
        status="active",
        reviewed_at=_now(),
        reviewed_by_id=user.id,
    )
    db.add(membership)
    user.active_organization_id = org.id
    audit_service.log_event(
        db,
        actor_id=user.id,
        action="organization.create",
        target_type="organization",
        target_id=org.id,
        metadata={"name": org.name, "slug": org.slug},
        request=request,
    )
    db.commit()
    db.refresh(org)
    return org


def request_join(db: Session, organization_id: uuid.UUID, user: User, request=None) -> OrganizationMembership:
    org = _org_or_404(db, organization_id)
    existing = _membership(db, organization_id, user.id)
    if existing:
        if existing.status == "active":
            return existing
        existing.status = "pending"
        existing.role = "member"
        existing.requested_at = _now()
        existing.reviewed_at = None
        existing.reviewed_by_id = None
        membership = existing
    else:
        membership = OrganizationMembership(organization_id=org.id, user_id=user.id, role="member", status="pending")
        db.add(membership)
    audit_service.log_event(
        db,
        actor_id=user.id,
        action="organization.membership.request",
        target_type="organization",
        target_id=org.id,
        metadata={"organization": org.name},
        request=request,
    )
    db.commit()
    db.refresh(membership)
    return membership


def list_members(db: Session, organization_id: uuid.UUID, acting_user: User) -> list[dict]:
    org = require_org_admin(db, organization_id, acting_user.id)
    rows = (
        db.query(OrganizationMembership, User)
        .join(User, User.id == OrganizationMembership.user_id)
        .filter(OrganizationMembership.organization_id == org.id)
        .order_by(OrganizationMembership.status.desc(), OrganizationMembership.requested_at.asc())
        .all()
    )
    return [_membership_item(org, membership, user) for membership, user in rows]


def search_users_for_organization(db: Session, organization_id: uuid.UUID, q: str | None, acting_user: User, limit: int = 10) -> list[dict]:
    org = require_org_admin(db, organization_id, acting_user.id)
    term = (q or "").strip().lower()
    if len(term) < 2:
        return []
    limit = max(1, min(limit, 25))
    rows = (
        db.query(User, OrganizationMembership)
        .outerjoin(
            OrganizationMembership,
            (OrganizationMembership.user_id == User.id) & (OrganizationMembership.organization_id == org.id),
        )
        .filter(
            User.is_active == True,
            or_(func.lower(User.email).like(f"%{term}%"), func.lower(User.display_name).like(f"%{term}%")),
        )
        .order_by(User.email.asc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": user.id,
            "email": user.email,
            "display_name": user.display_name,
            "is_approved": user.is_approved,
            "membership_status": membership.status if membership else None,
            "membership_role": membership.role if membership else None,
        }
        for user, membership in rows
    ]


def approve_member(db: Session, organization_id: uuid.UUID, membership_id: uuid.UUID, role: str, acting_user: User, request=None) -> dict:
    org = require_org_admin(db, organization_id, acting_user.id)
    membership = db.query(OrganizationMembership).filter(OrganizationMembership.id == membership_id, OrganizationMembership.organization_id == org.id).first()
    if not membership:
        raise NotFoundError("OrganizationMembership", str(membership_id))
    member_user = db.query(User).filter(User.id == membership.user_id).first()
    if not member_user:
        raise NotFoundError("User", str(membership.user_id))
    membership.status = "active"
    membership.role = role if role in {"admin", "member"} else "member"
    membership.reviewed_at = _now()
    membership.reviewed_by_id = acting_user.id
    member_user.is_approved = True
    if member_user.active_organization_id is None:
        member_user.active_organization_id = org.id
    audit_service.log_event(
        db,
        actor_id=acting_user.id,
        action="organization.membership.approve",
        target_type="organization_membership",
        target_id=membership.id,
        metadata={"organization_id": org.id, "user_id": member_user.id, "role": membership.role},
        request=request,
    )
    db.commit()
    return _membership_item(org, membership, member_user)


def add_existing_member(db: Session, organization_id: uuid.UUID, email: str, role: str, acting_user: User, request=None) -> dict:
    org = require_org_admin(db, organization_id, acting_user.id)
    normalized_email = email.strip().lower()
    member_user = db.query(User).filter(User.email == normalized_email).first()
    if not member_user:
        raise NotFoundError("User", normalized_email)
    membership = _membership(db, organization_id, member_user.id)
    if membership:
        membership.status = "active"
        membership.role = role if role in {"admin", "member"} else "member"
        membership.reviewed_at = _now()
        membership.reviewed_by_id = acting_user.id
    else:
        membership = OrganizationMembership(
            organization_id=org.id,
            user_id=member_user.id,
            role=role if role in {"admin", "member"} else "member",
            status="active",
            reviewed_at=_now(),
            reviewed_by_id=acting_user.id,
        )
        db.add(membership)
    member_user.is_approved = True
    if member_user.active_organization_id is None:
        member_user.active_organization_id = org.id
    audit_service.log_event(
        db,
        actor_id=acting_user.id,
        action="organization.membership.add_existing",
        target_type="organization_membership",
        target_id=membership.id,
        metadata={"organization_id": org.id, "user_id": member_user.id, "role": membership.role},
        request=request,
    )
    db.commit()
    return _membership_item(org, membership, member_user)


def reject_member(db: Session, organization_id: uuid.UUID, membership_id: uuid.UUID, acting_user: User, request=None) -> dict:
    org = require_org_admin(db, organization_id, acting_user.id)
    membership = db.query(OrganizationMembership).filter(OrganizationMembership.id == membership_id, OrganizationMembership.organization_id == org.id).first()
    if not membership:
        raise NotFoundError("OrganizationMembership", str(membership_id))
    member_user = db.query(User).filter(User.id == membership.user_id).first()
    if not member_user:
        raise NotFoundError("User", str(membership.user_id))
    membership.status = "rejected"
    membership.reviewed_at = _now()
    membership.reviewed_by_id = acting_user.id
    if member_user.active_organization_id == org.id:
        member_user.active_organization_id = None
    audit_service.log_event(
        db,
        actor_id=acting_user.id,
        action="organization.membership.reject",
        target_type="organization_membership",
        target_id=membership.id,
        metadata={"organization_id": org.id, "user_id": member_user.id},
        request=request,
    )
    db.commit()
    return _membership_item(org, membership, member_user)


def set_active_organization(db: Session, user: User, organization_id: uuid.UUID | None) -> User:
    if organization_id is None:
        user.active_organization_id = None
    else:
        membership = _membership(db, organization_id, user.id)
        if not membership or membership.status != "active":
            raise BadRequestError("You are not an active member of that organization", error_code="ORG_MEMBERSHIP_REQUIRED")
        user.active_organization_id = organization_id
    db.commit()
    db.refresh(user)
    return user


def _secret_context(org_id: uuid.UUID, field: str) -> dict[str, str]:
    return {"scope": "organization_ai_config", "organization_id": str(org_id), "field": field}


def get_ai_config(db: Session, organization_id: uuid.UUID, acting_user: User) -> OrganizationAIConfig:
    org = require_org_admin(db, organization_id, acting_user.id)
    cfg = db.query(OrganizationAIConfig).filter(OrganizationAIConfig.organization_id == org.id).first()
    if not cfg:
        cfg = OrganizationAIConfig(
            organization_id=org.id,
            provider=settings.AI_PROVIDER or "claude",
            enabled=True,
            claude_model=settings.ANTHROPIC_MODEL,
            gemini_model=settings.GEMINI_MODEL,
        )
        db.add(cfg)
        db.commit()
        db.refresh(cfg)
    return cfg


def ai_config_view(cfg: OrganizationAIConfig) -> dict:
    statuses = [secret_status(cfg.anthropic_api_key), secret_status(cfg.gemini_api_key)]
    providers = {s["provider"] for s in statuses if s["set"]}
    provider = providers.pop() if len(providers) == 1 else "mixed" if providers else ""
    return {
        "provider": cfg.provider,
        "enabled": cfg.enabled,
        "claude_model": cfg.claude_model,
        "gemini_model": cfg.gemini_model,
        "has_anthropic_key": bool(cfg.anthropic_api_key),
        "has_gemini_key": bool(cfg.gemini_api_key),
        "secret_provider": provider,
        "updated_at": cfg.updated_at,
    }


def update_ai_config(db: Session, organization_id: uuid.UUID, data: dict, acting_user: User, request=None) -> OrganizationAIConfig:
    cfg = get_ai_config(db, organization_id, acting_user)
    for field in ("provider", "enabled", "claude_model", "gemini_model"):
        if data.get(field) is not None:
            setattr(cfg, field, data[field])
    if data.get("anthropic_api_key"):
        cfg.anthropic_api_key = encrypt_secret(data["anthropic_api_key"], _secret_context(cfg.organization_id, "anthropic_api_key"))
    if data.get("gemini_api_key"):
        cfg.gemini_api_key = encrypt_secret(data["gemini_api_key"], _secret_context(cfg.organization_id, "gemini_api_key"))
    cfg.updated_by_id = acting_user.id
    audit_service.log_event(
        db,
        actor_id=acting_user.id,
        action="organization.ai_config.update",
        target_type="organization",
        target_id=organization_id,
        metadata={k: v for k, v in data.items() if v is not None},
        request=request,
    )
    db.commit()
    db.refresh(cfg)
    return cfg


def active_ai_config_for_user(db: Session, user: User) -> tuple[OrganizationAIConfig | None, uuid.UUID | None]:
    org_id = user.active_organization_id
    if not org_id:
        return None, None
    membership = _membership(db, org_id, user.id)
    if not membership or membership.status != "active":
        return None, None
    cfg = db.query(OrganizationAIConfig).filter(OrganizationAIConfig.organization_id == org_id, OrganizationAIConfig.enabled == True).first()
    if not cfg:
        return None, None
    if cfg.provider == "gemini" and not cfg.gemini_api_key:
        return None, None
    if cfg.provider != "gemini" and not cfg.anthropic_api_key:
        return None, None
    return cfg, org_id


def decrypt_org_ai_key(cfg: OrganizationAIConfig) -> tuple[str, str | None]:
    if cfg.provider == "gemini":
        return cfg.gemini_model, decrypt_secret(cfg.gemini_api_key, _secret_context(cfg.organization_id, "gemini_api_key"))
    return cfg.claude_model, decrypt_secret(cfg.anthropic_api_key, _secret_context(cfg.organization_id, "anthropic_api_key"))


def usage_summary(db: Session, organization_id: uuid.UUID, acting_user: User) -> dict:
    org = require_org_admin(db, organization_id, acting_user.id)
    row = (
        db.query(
            func.count(AIUsage.id),
            func.coalesce(func.sum(AIUsage.input_tokens), 0),
            func.coalesce(func.sum(AIUsage.output_tokens), 0),
            func.coalesce(func.sum(AIUsage.total_tokens), 0),
            func.coalesce(func.sum(AIUsage.estimated_cost_usd), 0.0),
        )
        .filter(AIUsage.organization_id == org.id, AIUsage.created_at >= _month_start())
        .one()
    )
    return {
        "ai_request_count": int(row[0] or 0),
        "ai_input_tokens": int(row[1] or 0),
        "ai_output_tokens": int(row[2] or 0),
        "ai_total_tokens": int(row[3] or 0),
        "ai_estimated_cost_usd": float(row[4] or 0.0),
    }
