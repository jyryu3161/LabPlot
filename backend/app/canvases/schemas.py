import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

MAX_GRID_DIM = 4
MAX_PANELS = 16


class CanvasItem(BaseModel):
    figure_id: uuid.UUID
    version_id: uuid.UUID
    row: int = Field(..., ge=1, le=MAX_GRID_DIM)
    col: int = Field(..., ge=1, le=MAX_GRID_DIM)
    label: str | None = Field(default=None, max_length=8)


class CanvasState(BaseModel):
    """Layout stored in FigureCanvas.state (JSONB).

    The render endpoint additionally stores an ``output`` key
    ({"png_path": ..., "pdf_path": ...}) alongside these fields; it is
    ignored on input validation and cleared whenever the layout changes.
    """

    rows: int = Field(default=1, ge=1, le=MAX_GRID_DIM)
    cols: int = Field(default=1, ge=1, le=MAX_GRID_DIM)
    items: list[CanvasItem] = Field(default_factory=list, max_length=MAX_PANELS)
    label_style: Literal["lower", "upper", "none"] = "lower"

    @model_validator(mode="after")
    def _validate_grid(self):
        seen: set[tuple[int, int]] = set()
        for item in self.items:
            if item.row > self.rows or item.col > self.cols:
                raise ValueError(
                    f"Panel at ({item.row}, {item.col}) is outside the {self.rows}x{self.cols} grid"
                )
            cell = (item.row, item.col)
            if cell in seen:
                raise ValueError(f"Duplicate panel cell ({item.row}, {item.col})")
            seen.add(cell)
        return self


class CanvasCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=4000)
    project_id: uuid.UUID | None = None
    preset: str = Field(default="double_column", min_length=1, max_length=40)
    width_px: int = Field(default=720, ge=64, le=4000)
    height_px: int = Field(default=500, ge=64, le=4000)
    state: CanvasState | None = None


class CanvasUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=4000)
    preset: str | None = Field(default=None, min_length=1, max_length=40)
    width_px: int | None = Field(default=None, ge=64, le=4000)
    height_px: int | None = Field(default=None, ge=64, le=4000)
    state: CanvasState | None = None


class CanvasDetail(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID | None
    name: str
    description: str | None
    preset: str
    width_px: int
    height_px: int
    state: dict[str, Any]
    png_url: str | None
    pdf_url: str | None
    created_at: datetime
    updated_at: datetime | None


class CanvasListItem(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID | None
    name: str
    preset: str
    width_px: int
    height_px: int
    panel_count: int
    png_url: str | None
    created_at: datetime
    updated_at: datetime | None


class CanvasRenderResponse(BaseModel):
    png_url: str
    pdf_url: str
