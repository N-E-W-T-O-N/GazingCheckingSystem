"""Configuration constants for the engagement backend.

Kept deliberately small — no Pydantic settings layer needed for v1.
"""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# SQLite database file. Override with DB_PATH env var for tests.
DB_PATH = Path(os.environ.get("DB_PATH", BASE_DIR / "engagement.db"))
DB_URL = f"sqlite:///{DB_PATH}"

# Thresholds used by the report aggregator. These mirror the constants in
# MATH.md §7.3 so a change in one place should be reflected in the other.
ATTENTIVE_THRESHOLD = 0.6
DISENGAGED_THRESHOLD = 0.3

# CORS — wide-open in dev, lock down in prod.
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")
