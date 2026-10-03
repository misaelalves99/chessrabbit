"""Real migrated database coverage for personal-account bootstrap."""

import os
from types import SimpleNamespace

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import decode_access_token
from app.models import User
from app.routers import auth

pytestmark = pytest.mark.skipif(not os.getenv("CHESSRABBIT_TEST_DB"), reason="Needs an isolated migrated database")


@pytest.mark.asyncio
async def test_local_bootstrap_is_idempotent_and_creates_verified_non_admin(monkeypatch):
    engine = create_async_engine(os.environ["CHESSRABBIT_TEST_DB"])
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(auth.settings, "LOCAL_MODE", True)
    request = SimpleNamespace(headers={"origin": auth.settings.APP_BASE_URL})
    try:
        async with sessions() as db:
            first = await auth.local_session(request, db)
            second = await auth.local_session(request, db)
            assert decode_access_token(first.access_token)["sub"] == decode_access_token(second.access_token)["sub"]
            user = (await db.execute(select(User).where(User.email == "local@chessrabbit.dev"))).scalar_one()
            assert user.email_verified and not user.is_admin
            await db.execute(delete(User).where(User.id == user.id))
            await db.commit()
    finally:
        await engine.dispose()
