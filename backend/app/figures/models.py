import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
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
    is_favorite = Column(Boolean, nullable=False, default=False)
    is_public = Column(Boolean, nullable=False, default=False, index=True)
    share_token = Column(String(64), nullable=True, unique=True, index=True)
    display_order = Column(Integer, nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), default=_now)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now)

    owner = relationship("User", back_populates="figures")
    dataset = relationship("Dataset", back_populates="figures")
    versions = relationship("FigureVersion", back_populates="figure",
                            cascade="all, delete-orphan", order_by="FigureVersion.version_number")
    template_favorites = relationship("FigureTemplateFavorite", back_populates="figure", cascade="all, delete-orphan")


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
    eps_path = Column(String(512), nullable=True)
    r_path = Column(String(512), nullable=True)
    render_log = Column(Text, nullable=True)
    change_note = Column(String(512), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_now)

    figure = relationship("Figure", back_populates="versions")
    reviews = relationship("Review", back_populates="version", cascade="all, delete-orphan")
    improvements = relationship("Improvement", back_populates="version", cascade="all, delete-orphan")


class FigureTemplateFavorite(Base):
    __tablename__ = "figure_template_favorites"
    __table_args__ = (
        UniqueConstraint("user_id", "figure_id", name="uq_figure_template_favorites_user_figure"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    figure_id = Column(UUID(as_uuid=True), ForeignKey("figures.id", ondelete="CASCADE"), nullable=False, index=True)
    source_version_id = Column(UUID(as_uuid=True), ForeignKey("figure_versions.id", ondelete="SET NULL"), nullable=True, index=True)
    source_version_number = Column(Integer, nullable=True)
    source_plot_type = Column(String(40), nullable=True)
    source_style_preset = Column(String(40), nullable=True)
    source_mapping = Column(JSONB, nullable=False, default=dict)
    source_options = Column(JSONB, nullable=False, default=dict)
    name = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=_now)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now)

    user = relationship("User", back_populates="figure_template_favorites")
    figure = relationship("Figure", back_populates="template_favorites")
    source_version = relationship("FigureVersion")


class FigureComment(Base):
    __tablename__ = "figure_comments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    figure_id = Column(UUID(as_uuid=True), ForeignKey("figures.id", ondelete="CASCADE"), nullable=False, index=True)
    author_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    body = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), default=_now)


class FigureCodeArtifact(Base):
    __tablename__ = "figure_code_artifacts"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    dataset_id = Column(UUID(as_uuid=True), ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True, index=True)
    figure_id = Column(UUID(as_uuid=True), ForeignKey("figures.id", ondelete="SET NULL"), nullable=True, index=True)
    figure_version_id = Column(UUID(as_uuid=True), ForeignKey("figure_versions.id", ondelete="SET NULL"), nullable=True, unique=True, index=True)
    plot_type = Column(String(40), nullable=False, index=True)
    style_preset = Column(String(40), nullable=False, default="nature")
    mapping = Column(JSONB, nullable=False, default=dict)
    options = Column(JSONB, nullable=False, default=dict)
    dataset_profile = Column(JSONB, nullable=False, default=dict)
    r_code = Column(Text, nullable=False)
    render_log = Column(Text, nullable=True)
    code_hash = Column(String(64), nullable=False, index=True)
    reusable = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), default=_now)


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
