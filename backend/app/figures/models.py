import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship

from app.database import Base


def _now():
    return datetime.now(timezone.utc)


class Figure(Base):
    __tablename__ = "figures"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    dataset_id = Column(UUID(as_uuid=True), ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)
    name = Column(String(255), nullable=False)
    plot_type = Column(String(40), nullable=False)
    style_preset = Column(String(40), nullable=False, default="nature")
    status = Column(String(20), nullable=False, default="ready")  # ready | failed
    current_version_id = Column(UUID(as_uuid=True), nullable=True)
    description = Column(Text, nullable=True)   # user-written interpretation
    legend = Column(Text, nullable=True)        # figure legend (AI or user)
    created_at = Column(DateTime(timezone=True), default=_now)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now)

    owner = relationship("User", back_populates="figures")
    dataset = relationship("Dataset", back_populates="figures")
    versions = relationship("FigureVersion", back_populates="figure",
                            cascade="all, delete-orphan", order_by="FigureVersion.version_number")


class FigureVersion(Base):
    __tablename__ = "figure_versions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    figure_id = Column(UUID(as_uuid=True), ForeignKey("figures.id", ondelete="CASCADE"), nullable=False, index=True)
    version_number = Column(Integer, nullable=False, default=1)
    mapping = Column(JSONB, nullable=False, default=dict)
    options = Column(JSONB, nullable=False, default=dict)
    style_preset = Column(String(40), nullable=False, default="nature")
    r_code = Column(Text, nullable=True)
    png_path = Column(String(512), nullable=True)
    svg_path = Column(String(512), nullable=True)
    tiff_path = Column(String(512), nullable=True)
    pdf_path = Column(String(512), nullable=True)
    r_path = Column(String(512), nullable=True)
    render_log = Column(Text, nullable=True)
    change_note = Column(String(512), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_now)

    figure = relationship("Figure", back_populates="versions")
    reviews = relationship("Review", back_populates="version", cascade="all, delete-orphan")
    improvements = relationship("Improvement", back_populates="version", cascade="all, delete-orphan")


class Recommendation(Base):
    __tablename__ = "recommendations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    dataset_id = Column(UUID(as_uuid=True), ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    plot_type = Column(String(40), nullable=False)
    title = Column(String(255), nullable=True)
    score = Column(String(16), nullable=True)
    rationale = Column(Text, nullable=True)
    required_vars = Column(JSONB, nullable=True)
    example_usage = Column(Text, nullable=True)
    source = Column(String(16), nullable=False, default="claude")
    created_at = Column(DateTime(timezone=True), default=_now)


class Review(Base):
    __tablename__ = "reviews"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    figure_version_id = Column(UUID(as_uuid=True), ForeignKey("figure_versions.id", ondelete="CASCADE"), nullable=False, index=True)
    publication_score = Column(Integer, nullable=True)
    payload = Column(JSONB, nullable=False, default=dict)
    model = Column(String(64), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_now)

    version = relationship("FigureVersion", back_populates="reviews")


class Improvement(Base):
    __tablename__ = "improvements"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    figure_version_id = Column(UUID(as_uuid=True), ForeignKey("figure_versions.id", ondelete="CASCADE"), nullable=False, index=True)
    suggestion_type = Column(String(128), nullable=True)
    current_state = Column(Text, nullable=True)
    recommended = Column(Text, nullable=True)
    param_patch = Column(JSONB, nullable=False, default=dict)
    priority = Column(String(16), nullable=True)
    applied = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), default=_now)

    version = relationship("FigureVersion", back_populates="improvements")
