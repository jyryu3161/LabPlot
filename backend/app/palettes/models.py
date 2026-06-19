import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship

from app.database import Base


def _now():
    return datetime.now(timezone.utc)


class UserColorPalette(Base):
    __tablename__ = "user_color_palettes"
    __table_args__ = (
        UniqueConstraint("owner_id", "name", name="uq_user_color_palettes_owner_name"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(100), nullable=False)
    colors = Column(JSONB, nullable=False, default=list)
    created_at = Column(DateTime(timezone=True), default=_now)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now)

    owner = relationship("User", back_populates="color_palettes")
