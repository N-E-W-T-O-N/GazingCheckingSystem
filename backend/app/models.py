"""ORM models.

A `Session` row is created the first time we see a `(session_id)` in ingest.
Each ingested event becomes one `EngagementEvent` row. We keep the schema
deliberately flat — feature dicts are stored as JSON so adding `affect` and
`drowsiness` later does not require a migration.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, Float, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    lecture_id: Mapped[str] = mapped_column(String, index=True)
    user_id: Mapped[str] = mapped_column(String, index=True)
    mode: Mapped[str] = mapped_column(String, default="camera")  # camera | behavioral_only
    started_at: Mapped[datetime] = mapped_column(default=_utcnow)
    last_event_at: Mapped[datetime] = mapped_column(default=_utcnow)

    events: Mapped[list["EngagementEvent"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )


class EngagementEvent(Base):
    __tablename__ = "engagement_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"), index=True)
    # Frontend-supplied epoch seconds (float). We store both that and our
    # server-side received_at so we can detect clock skew later.
    t: Mapped[float] = mapped_column(Float)
    received_at: Mapped[datetime] = mapped_column(default=_utcnow)
    score: Mapped[float] = mapped_column(Float)
    features: Mapped[dict] = mapped_column(JSON)
    affect: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    drowsiness: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    session: Mapped[Session] = relationship(back_populates="events")


Index("ix_events_session_t", EngagementEvent.session_id, EngagementEvent.t)
