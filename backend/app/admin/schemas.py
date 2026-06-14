import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class AdminUserItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    display_name: str
    is_active: bool
    is_approved: bool
    is_admin: bool
    created_at: datetime
    dataset_count: int = 0
    figure_count: int = 0
    ai_request_count: int = 0
    ai_input_tokens: int = 0
    ai_output_tokens: int = 0
    ai_total_tokens: int = 0
    ai_estimated_cost_usd: float = 0.0
    ai_monthly_limit: int = 0
    render_monthly_limit: int = 0
    storage_limit_mb: int = 0
    ai_monthly_used: int = 0
    render_monthly_used: int = 0
    storage_used_mb: float = 0.0


class AdminUserUpdate(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=100)
    is_active: bool | None = None
    is_approved: bool | None = None
    is_admin: bool | None = None
    ai_monthly_limit: int | None = Field(None, ge=0, le=100000)
    render_monthly_limit: int | None = Field(None, ge=0, le=100000)
    storage_limit_mb: int | None = Field(None, ge=0, le=102400)


class AdminPasswordReset(BaseModel):
    password: str = Field(..., min_length=10, max_length=256)


class AdminUserCreate(BaseModel):
    email: str = Field(..., min_length=3, max_length=255, pattern=EMAIL_PATTERN)
    password: str = Field(..., min_length=10, max_length=256)
    display_name: str = Field(..., min_length=1, max_length=100)
    is_admin: bool = False


class AIConfigView(BaseModel):
    provider: str
    enabled: bool
    claude_model: str
    gemini_model: str
    has_anthropic_key: bool
    has_gemini_key: bool
    updated_at: datetime


class AIConfigUpdate(BaseModel):
    provider: str | None = Field(None, pattern="^(claude|gemini)$")
    enabled: bool | None = None
    claude_model: str | None = None
    gemini_model: str | None = None
    anthropic_api_key: str | None = None
    gemini_api_key: str | None = None


class AuditLogItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    actor_id: uuid.UUID | None = None
    action: str
    target_type: str | None = None
    target_id: str | None = None
    ip_address: str | None = None
    user_agent: str | None = None
    metadata_json: dict
    created_at: datetime


class ClientErrorItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_id: uuid.UUID | None = None
    source: str
    message: str
    path: str | None = None
    stack: str | None = None
    user_agent: str | None = None
    created_at: datetime
