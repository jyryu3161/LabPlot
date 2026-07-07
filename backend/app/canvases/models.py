import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship

from app.database import Base


def _now():
    return datetime.now(timezone.utc)


class Canvas(Base):
    __tablename__ = "canvases"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    width_mm = Column(Float, nullable=False)   # physical canvas size (DOUBLE PRECISION)
    height_mm = Column(Float, nullable=False)
    preset = Column(String(40), nullable=True)  # journal preset key (e.g. nature_single)
    background = Column(String(20), nullable=False, default="white")  # white | transparent
    export_snapshot = Column(JSONB, nullable=True)  # {panel_id: version_id} from last export
    # U8: text/arrow/line/rect/ellipse annotation objects, painted ABOVE every
    # panel. Server-validated shape lives in service._sanitize_annotations.
    annotations = Column(JSONB, nullable=False, server_default=text("'[]'::jsonb"), default=list)
    # Server-incremented on every annotations replace — the optimistic-
    # concurrency token for the whole-array PATCH (409 ANNOTATIONS_CONFLICT
    # when a client's base_annotations_rev no longer matches).
    annotations_rev = Column(Integer, nullable=False, server_default=text("0"), default=0)
    created_at = Column(DateTime(timezone=True), default=_now)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now)

    panels = relationship(
        "CanvasPanel",
        back_populates="canvas",
        cascade="all, delete-orphan",
        order_by="CanvasPanel.z_order",
    )


class CanvasPanel(Base):
    __tablename__ = "canvas_panels"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    canvas_id = Column(UUID(as_uuid=True), ForeignKey("canvases.id", ondelete="CASCADE"), nullable=False, index=True)
    # reverse lookup: "canvases using this figure" (invalidate derived cache on color commit).
    # NULL for imported-image panels (image_key set instead) — a DB CHECK
    # constraint enforces exactly one of figure_id/image_key per row.
    figure_id = Column(UUID(as_uuid=True), ForeignKey("figures.id", ondelete="CASCADE"), nullable=True, index=True)
    # null => follow-latest (figure.current_version_id); else pinned
    pinned_version_id = Column(UUID(as_uuid=True), nullable=True)
    # Imported external image (SVG/PNG/JPEG): relative storage key
    # "canvases/imports/<hex32>.<ext>" under the figures storage root. The blob
    # is validated + (for SVG) sanitized at upload and never deleted on panel
    # removal (undo/duplicate safety — orphan cleanup is a future batch job).
    image_key = Column(String(160), nullable=True)
    # Native physical size (mm) computed once at upload from the image's own
    # dimensions/DPI — feeds the editor's original-size placement/reset.
    image_native_width_mm = Column(Float, nullable=True)
    image_native_height_mm = Column(Float, nullable=True)
    x_mm = Column(Float, nullable=False)   # top-left position on canvas (DOUBLE PRECISION)
    y_mm = Column(Float, nullable=False)
    width_mm = Column(Float, nullable=False)   # panel physical size -> drives re-render
    height_mm = Column(Float, nullable=False)
    z_order = Column(Integer, nullable=False, default=0)  # paint order
    label = Column(String(8), nullable=True)  # A/B/C... (rendered at export in pt)
    label_visible = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), default=_now)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now)

    canvas = relationship("Canvas", back_populates="panels")
