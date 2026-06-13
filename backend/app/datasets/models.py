import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship

from app.database import Base


class Dataset(Base):
    __tablename__ = "datasets"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    original_filename = Column(String(255), nullable=False)
    file_path = Column(String(512), nullable=False)
    format = Column(String(16), nullable=False)
    n_rows = Column(Integer, nullable=False, default=0)
    n_cols = Column(Integer, nullable=False, default=0)
    column_profile = Column(JSONB, nullable=False, default=list)
    preview = Column(JSONB, nullable=False, default=list)
    statistics = Column(JSONB, nullable=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    owner = relationship("User", back_populates="datasets")
    figures = relationship("Figure", back_populates="dataset", cascade="all, delete-orphan")
