"""Local bootstrap boundaries, unrestricted features, and engine routing."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import chess
import httpx
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.core.config import DEV_JWT_SECRET, Settings
from app.core.security import create_access_token, decode_access_token
from app.schemas import AnalysePositionRequest, MeOut, OpeningOut


def test_local_mode_requires_loopback_and_cannot_run_in_production():
    for values in ({"ENVIRONMENT": "production"}, {"APP_BASE_URL": "https://example.com"}):
        with pytest.raises(ValidationError):
            Settings(_env_file=None, LOCAL_MODE=True, **values)
    local = Settings(_env_file=None, LOCAL_MODE=True, JWT_SECRET=DEV_JWT_SECRET)
    assert local.JWT_SECRET != DEV_JWT_SECRET


def test_account_and_opening_schemas_have_no_entitlements():
    assert "plan" not in MeOut.model_fields
    assert not {"tier", "locked"} & OpeningOut.model_fields.keys()
    assert "plan" not in decode_access_token(create_access_token(1))


@pytest.mark.asyncio
async def test_no_billing_routes_and_all_openings_are_available():
    from app.main import app
    from app.routers.openings import OPENINGS, list_openings

    assert not any(path.startswith(("/billing", "/tiers")) for path in app.openapi()["paths"])
    assert len(await list_openings(None)) == len(OPENINGS)


@pytest.mark.asyncio
async def test_local_session_is_disabled_or_rejects_foreign_origins(monkeypatch):
    from app.core.db import get_db
    from app.main import app
    from app.routers.auth import settings

    async def no_database():
        yield None

    app.dependency_overrides[get_db] = no_database
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
            monkeypatch.setattr(settings, "LOCAL_MODE", False)
            assert (await client.post("/auth/local-session")).status_code == 404
            monkeypatch.setattr(settings, "LOCAL_MODE", True)
            for origin in (None, "https://example.com", "http://localhost:9999"):
                headers = {"Origin": origin} if origin else {}
                assert (await client.post("/auth/local-session", headers=headers)).status_code == 403
    finally:
        app.dependency_overrides.pop(get_db)


@pytest.mark.asyncio
async def test_worker_offline_unknown_and_unavailable_engines(monkeypatch):
    from app.core import engines
    monkeypatch.setattr(engines, "engine_catalog", AsyncMock(return_value=[]))
    with pytest.raises(HTTPException) as exc:
        await engines.resolve_engine("stockfish")
    assert exc.value.status_code == 503
    monkeypatch.setattr(engines, "engine_catalog", AsyncMock(return_value=[{"id": "lc0", "name": "Leela", "available": False}]))
    for engine, status in (("lc0", 503), ("arbitrary-binary", 400)):
        with pytest.raises(HTTPException) as exc:
            await engines.resolve_engine(engine)
        assert exc.value.status_code == status


@pytest.mark.asyncio
@pytest.mark.parametrize("engine_id", ["stockfish", "lc0"])
async def test_position_queue_and_cache_query_use_selected_engine(monkeypatch, engine_id):
    from app.routers import analysis

    statements = []
    async def execute(statement):
        statements.append(statement.compile().params)
        return SimpleNamespace(scalar_one_or_none=lambda: None)
    async def refresh(job):
        job.id = 42
    db = SimpleNamespace(execute=execute, add=lambda _: None, commit=AsyncMock(), refresh=refresh)
    redis = SimpleNamespace(rpush=AsyncMock())
    monkeypatch.setattr(analysis, "resolve_engine", AsyncMock(return_value={"id": engine_id, "cache_key": engine_id + ":weights-v1"}))
    monkeypatch.setattr(analysis, "check_and_increment_usage", AsyncMock())
    monkeypatch.setattr(analysis, "get_redis", lambda: redis)
    request = AnalysePositionRequest(fen=chess.STARTING_FEN, engine=engine_id, depth=12, multipv=3)
    result = await analysis.analyse_position(request, SimpleNamespace(id=1), db)
    assert result.job_id == 42
    assert engine_id + ":weights-v1" in statements[0].values()
    assert 3 in statements[0].values()
    queue, payload = redis.rpush.call_args.args
    assert queue == f"q:{engine_id}:interactive"
    assert json.loads(payload)["engine"] == engine_id
