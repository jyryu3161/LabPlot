import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.database import Base


def _now():
    return datetime.now(timezone.utc)


class Organization(Base):
    __tablename__ = "organizations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    slug = Column(String(120), nullable=False, unique=True, index=True)
    domain = Column(String(255), nullable=True, index=True)
    description = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now, nullable=False)

    memberships = relationship("OrganizationMembership", back_populates="organization", cascade="all, delete-orphan")
    ai_config = relationship("OrganizationAIConfig", back_populates="organization", uselist=False, cascade="all, delete-orphan")


class OrganizationMembership(Base):
    __tablename__ = "organization_memberships"
    __table_args__ = (UniqueConstraint("organization_id", "user_id", name="uq_org_membership_org_user"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(20), nullable=False, default="member")  # admin | member
    status = Column(String(20), nullable=False, default="pending")  # pending | active | rejected
    requested_at = Column(DateTime(timezone=True), default=_now, nullable=False)
    reviewed_at = Column(DateTime(timezone=True), nullable=True)
    reviewed_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    organization = relationship("Organization", back_populates="memberships")


class OrganizationAIConfig(Base):
    __tablename__ = "organization_ai_config"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organization_id = Column(UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, unique=True, index=True)
    provider = Column(String(20), nullable=False, default="claude")
    enabled = Column(Boolean, nullable=False, default=True)
    claude_model = Column(String(64), nullable=False, default="claude-sonnet-4-6")
    gemini_model = Column(String(64), nullable=False, default="gemini-3.1-flash-lite")
    anthropic_api_key = Column(Text, nullable=True)
    gemini_api_key = Column(Text, nullable=True)
    updated_by_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now, nullable=False)

    organization = relationship("Organization", back_populates="ai_config")
