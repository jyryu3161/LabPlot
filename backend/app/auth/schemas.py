import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class UserRegister(BaseModel):
    email: str = Field(..., min_length=3, max_length=255, pattern=EMAIL_PATTERN)
    password: str = Field(..., min_length=10, max_length=256)
    display_name: str = Field(..., min_length=1, max_length=100)


class UserLogin(BaseModel):
    email: str
    password: str


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    display_name: str
    is_active: bool
    is_approved: bool
    is_admin: bool
    created_at: datetime


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class TokenRefreshRequest(BaseModel):
    refresh_token: str


class PasswordResetRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=255, pattern=EMAIL_PATTERN)


class PasswordResetConfirm(BaseModel):
    token: str = Field(..., min_length=20, max_length=512)
    password: str = Field(..., min_length=10, max_length=256)


class MessageResponse(BaseModel):
    message: str
