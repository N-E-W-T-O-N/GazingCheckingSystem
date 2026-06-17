"""Pydantic request/response models.

Mirrors the JSON shape described in README.md → API Surface.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class EventFeatures(BaseModel):
    """Per-frame feature vector. See MATH.md §7."""

    face_present: float = Field(ge=0, le=1)
    head_aligned: float = Field(ge=0, le=1)
    gaze_on_screen: float = Field(ge=0, le=1)
    tab_visible: float = Field(ge=0, le=1)
    window_focused: float = Field(ge=0, le=1)
    input_activity: float = Field(ge=0, le=1)


class EngagementEventIn(BaseModel):
    t: float
    score: float = Field(ge=0, le=1)
    features: EventFeatures
    # Reserved for v1.x. The mid/good-to-have tiers will populate these.
    affect: dict | None = None
    drowsiness: dict | None = None


class IngestRequest(BaseModel):
    session_id: str
    lecture_id: str
    user_id: str
    mode: Literal["camera", "behavioral_only"] = "camera"
    events: list[EngagementEventIn]


class IngestResponse(BaseModel):
    accepted: int


class SessionReport(BaseModel):
    """Aggregate stats. See MATH.md §7.3."""

    model_config = ConfigDict(populate_by_name=True)

    session_id: str
    lecture_id: str
    user_id: str
    mode: str
    n_events: int
    mean_engagement: float
    percent_attentive: float
    percent_disengaged: float
    longest_drop_seconds: float
