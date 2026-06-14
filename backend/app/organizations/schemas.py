import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"
ORG_SLUG_PATTERN = r"^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$"


class OrganizationCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=255)
    slug: str | None = Field(default=None, min_length=3, max_length=120, pattern=ORG_SLUG_PATTERN)
    domain: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=2000)


class OrganizationUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=255)
    domain: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=2000)


class OrganizationItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    slug: str
    domain: str | None = None
    description: str | None = None
    is_active: bool
    created_at: datetime


class OrganizationSearchItem(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    domain: str | None = None
    member_count: int = 0


class MembershipItem(BaseModel):
    id: uuid.UUID
    organization_id: uuid.UUID
    organization_name: str
    user_id: uuid.UUID
    email: str
    display_name: str
    role: str
    status: str
    requested_at: datetime
    reviewed_at: datetime | None = None


class MyOrganizationItem(BaseModel):
    organization: OrganizationItem
    membership: MembershipItem
    active: bool = False
    is_org_admin: bool = False


class JoinOrganizationRequest(BaseModel):
    note: str | None = Field(default=None, max_length=1000)


class MembershipDecision(BaseModel):
    role: str = Field(default="member", pattern="^(admin|member)$")


class ActiveOrganizationRequest(BaseModel):
    organization_id: uuid.UUID | None = None


class OrganizationAIConfigView(BaseModel):
    provider: str
    enabled: bool
    claude_model: str
    gemini_model: str
    has_anthropic_key: bool
    has_gemini_key: bool
    secret_provider: str
    updated_at: datetime | None = None


class OrganizationAIConfigUpdate(BaseModel):
    provider: str | None = Field(None, pattern="^(claude|gemini)$")
    enabled: bool | None = None
    claude_model: str | None = Field(None, min_length=1, max_length=64)
    gemini_model: str | None = Field(None, min_length=1, max_length=64)
    anthropic_api_key: str | None = Field(None, max_length=4096)
    gemini_api_key: str | None = Field(None, max_length=4096)


class OrganizationUsageSummary(BaseModel):
    ai_request_count: int = 0
    ai_input_tokens: int = 0
    ai_output_tokens: int = 0
    ai_total_tokens: int = 0
    ai_estimated_cost_usd: float = 0.0
