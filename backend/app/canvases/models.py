import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID

from app.database import Base


def _now():
    return datetime.now(timezone.utc)


class FigureCanvas(Base):
    __tablename__ = "figure_canvases"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    preset = Column(String(40), nullable=False, default="double_column")
    width_px = Column(Integer, nullable=False, default=720)
    height_px = Column(Integer, nullable=False, default=500)
    state = Column(JSONB, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), default=_now)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now)
