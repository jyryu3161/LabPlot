import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, String, Text
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


class AIConfig(Base):
    """Single-row runtime AI configuration, editable by admins."""
    __tablename__ = "ai_config"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    provider = Column(String(20), nullable=False, default="claude")  # claude | gemini
    enabled = Column(Boolean, nullable=False, default=True)
    claude_model = Column(String(64), nullable=False, default="claude-sonnet-4-6")
    gemini_model = Column(String(64), nullable=False, default="gemini-3.5-flash")
    anthropic_api_key = Column(Text, nullable=True)
    gemini_api_key = Column(Text, nullable=True)
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc))
