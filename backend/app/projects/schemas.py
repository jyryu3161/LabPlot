import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ProjectCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    collaborator_ids: list[uuid.UUID] = Field(default_factory=list)


class ProjectUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None


class ProjectCollaboratorItem(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    email: str
    display_name: str
    role: str = "editor"
    created_at: datetime


class ProjectResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    owner_id: uuid.UUID
    name: str
    description: str | None = None
    created_at: datetime
    updated_at: datetime
    role: str = "owner"
    collaborators: list["ProjectCollaboratorItem"] = Field(default_factory=list)


class ProjectListItem(BaseModel):
    id: uuid.UUID
    owner_id: uuid.UUID
    name: str
    description: str | None = None
    created_at: datetime
    updated_at: datetime
    dataset_count: int = 0
    figure_count: int = 0
    collaborator_count: int = 0
    role: str = "owner"


class ProjectCollaboratorCreate(BaseModel):
    user_id: uuid.UUID
    role: str = Field(default="editor", pattern="^(editor|viewer)$")


class ProjectUserSearchItem(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
