import uuid

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.auth.models import User
from app.auth.schemas import UserResponse
from app.common.deps import get_current_user, get_db
from app.common.security import rate_limit
from app.organizations import service
from app.organizations.schemas import (
    ActiveOrganizationRequest,
    AddOrganizationMemberRequest,
    JoinOrganizationRequest,
    MembershipDecision,
    MembershipItem,
    MyOrganizationItem,
    OrganizationAIConfigUpdate,
    OrganizationAIConfigView,
    OrganizationCreate,
    OrganizationItem,
    OrganizationSearchItem,
    OrganizationUpdate,
    OrganizationUsageSummary,
)

router = APIRouter(prefix="/api/organizations", tags=["organizations"])


@router.get("/search", response_model=list[OrganizationSearchItem])
def search_organizations(q: str | None = None, limit: int = 20, db: Session = Depends(get_db)):
    return service.search_organizations(db, q=q, limit=limit)


@router.get("/my", response_model=list[MyOrganizationItem])
def my_organizations(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return service.my_organizations(db, current_user)


@router.post("", response_model=OrganizationItem, status_code=201,
             dependencies=[Depends(rate_limit("organization_create", 20, 3600))])
def create_organization(
    data: OrganizationCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.create_organization(db, current_user, data, request=request)


@router.patch("/{organization_id}", response_model=OrganizationItem)
def update_organization(
    organization_id: uuid.UUID,
    data: OrganizationUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    org = service.require_org_admin(db, organization_id, current_user.id)
    payload = data.model_dump(exclude_unset=True)
    for key, value in payload.items():
        if key == "domain":
            value = value.strip().lower() if value else None
        setattr(org, key, value)
    from app.audit import service as audit_service

    audit_service.log_event(
        db,
        actor_id=current_user.id,
        action="organization.update",
        target_type="organization",
        target_id=organization_id,
        metadata=payload,
        request=request,
    )
    db.commit()
    db.refresh(org)
    return org


@router.post("/{organization_id}/join", response_model=MembershipItem,
             dependencies=[Depends(rate_limit("organization_join", 30, 3600))])
def join_organization(
    organization_id: uuid.UUID,
    _: JoinOrganizationRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    membership = service.request_join(db, organization_id, current_user, request=request)
    org = service._org_or_404(db, organization_id)
    return service._membership_item(org, membership, current_user)


@router.post("/active", response_model=UserResponse)
def set_active_organization(
    data: ActiveOrganizationRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.set_active_organization(db, current_user, data.organization_id)


@router.get("/{organization_id}/members", response_model=list[MembershipItem])
def list_members(
    organization_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.list_members(db, organization_id, current_user)


@router.post("/{organization_id}/members/{membership_id}/approve", response_model=MembershipItem)
def approve_member(
    organization_id: uuid.UUID,
    membership_id: uuid.UUID,
    data: MembershipDecision,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.approve_member(db, organization_id, membership_id, data.role, current_user, request=request)


@router.post("/{organization_id}/members/{membership_id}/reject", response_model=MembershipItem)
def reject_member(
    organization_id: uuid.UUID,
    membership_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.reject_member(db, organization_id, membership_id, current_user, request=request)


@router.post("/{organization_id}/members", response_model=MembershipItem)
def add_existing_member(
    organization_id: uuid.UUID,
    data: AddOrganizationMemberRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.add_existing_member(db, organization_id, data.email, data.role, current_user, request=request)


@router.get("/{organization_id}/ai-config", response_model=OrganizationAIConfigView)
def get_ai_config(
    organization_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.ai_config_view(service.get_ai_config(db, organization_id, current_user))


@router.put("/{organization_id}/ai-config", response_model=OrganizationAIConfigView)
def update_ai_config(
    organization_id: uuid.UUID,
    data: OrganizationAIConfigUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    cfg = service.update_ai_config(db, organization_id, data.model_dump(exclude_unset=True), current_user, request=request)
    return service.ai_config_view(cfg)


@router.get("/{organization_id}/usage", response_model=OrganizationUsageSummary)
def usage_summary(
    organization_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return service.usage_summary(db, organization_id, current_user)
