import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class CustomPaletteRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    colors: list[str] = Field(..., min_length=1, max_length=12)


class CustomPaletteResponse(BaseModel):
    id: uuid.UUID
    key: str
    name: str
    label: str
    colorblind_safe: bool = False
    hex: list[str]
    custom: bool = True
    created_at: datetime
    updated_at: datetime
