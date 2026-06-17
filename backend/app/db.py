"""SQLAlchemy engine and session factory.

Using the synchronous engine because ingest is short-lived and SQLite is the
default. Swap to `create_async_engine` + asyncpg for Postgres without changing
the route signatures (FastAPI accepts both).
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import DB_URL


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


# SQLite needs check_same_thread=False because FastAPI may serve requests on
# different threads, and we hand out short-lived sessions per request.
engine = create_engine(
    DB_URL,
    connect_args={"check_same_thread": False} if DB_URL.startswith("sqlite") else {},
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db() -> None:
    """Create tables. Called once on app startup."""
    # Import models so that Base.metadata is populated.
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)


@contextmanager
def session_scope() -> Iterator[Session]:
    """Context-managed DB session for use outside of FastAPI dependencies."""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_db() -> Iterator[Session]:
    """FastAPI dependency."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
