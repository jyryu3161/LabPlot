import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ClientErrorCreate(BaseModel):
    source: str = Field(default="browser", max_length=80)
    message: str = Field(..., min_length=1, max_length=1000)
    path: str | None = Field(default=None, max_length=512)
    stack: str | None = Field(default=None, max_length=8000)


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
