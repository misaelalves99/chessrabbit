"""Desktop regressions: authenticated explorer and an empty master database."""

import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import chess
import httpx
import pytest
from fastapi import HTTPException

from app.core.breaker import CircuitBreaker
from app.routers import prep
from app.schemas import ExplorerRequest, PrepRepertoireIn
from app.services import lichess_explorer as live


@pytest.fixture
def live_cache(monkeypatch):
    cache = SimpleNamespace(get=AsyncMock(return_value=None), setex=AsyncMock())
    monkeypatch.setattr(live, "get_redis", lambda: cache)
    monkeypatch.setattr(live, "_breaker", CircuitBreaker("test-explorer"))
    return cache


@pytest.mark.asyncio
async def test_missing_token_is_actionable_and_does_not_call_upstream(monkeypatch, live_cache):
    fetch = AsyncMock()
    monkeypatch.setattr(live, "_fetch", fetch)
    with pytest.raises(live.ExplorerUnavailable) as exc:
        await live.masters_moves(chess.STARTING_FEN)
    assert exc.value.code == "lichess_auth_required"
    fetch.assert_not_called()


@pytest.mark.asyncio
async def test_token_is_only_sent_in_authorization_header(monkeypatch, live_cache):
    token = "test_only_not_a_real_token"
    data = {"white": 12, "draws": 2, "black": 4, "moves": []}
    def handler(request):
        assert request.headers["authorization"] == f"Bearer {token}"
        assert token not in str(request.url)
        assert request.url.host == "explorer.lichess.ovh"
        return httpx.Response(200, json=data)
    client = httpx.AsyncClient
    monkeypatch.setattr(live.httpx, "AsyncClient", lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs))
    assert await live.masters_moves(chess.STARTING_FEN, token) == data
    assert token not in str(live_cache.setex.call_args)
    assert token not in repr(ExplorerRequest(fen=chess.STARTING_FEN, lichess_token=token))


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 403, 429, 500])
async def test_upstream_errors_do_not_expose_credentials(monkeypatch, status):
    client = httpx.AsyncClient
    monkeypatch.setattr(live.httpx, "AsyncClient", lambda **kwargs: client(
        transport=httpx.MockTransport(lambda _: httpx.Response(status)), **kwargs))
    with pytest.raises(live.ExplorerUnavailable) as exc:
        await live._fetch(chess.STARTING_FEN, "test_only_not_a_real_token")
    assert "test_only" not in str(exc.value)
    assert (exc.value.code == "lichess_auth_required") == (status in (401, 403))


@pytest.mark.asyncio
async def test_stale_statistics_survive_network_failure(monkeypatch, live_cache):
    data = {"white": 1, "draws": 0, "black": 0, "moves": []}
    live_cache.get.return_value = json.dumps({"data": data, "fresh_until": time.time() - 10})
    monkeypatch.setattr(live, "_fetch", AsyncMock(side_effect=live.ExplorerUnavailable("offline")))
    assert await live.masters_moves(chess.STARTING_FEN, "test_only_token") == data


@pytest.mark.asyncio
@pytest.mark.parametrize("my_color", ["white", "black"])
async def test_prep_builds_legal_cards_without_a_master_database(monkeypatch, my_color):
    opponent = "GameSleepCode"
    games = [{"white": "someone" if my_color == "white" else opponent,
              "black": opponent if my_color == "white" else "someone",
              "movetext": "1. e4 d5 2. exd5 Nf6 3. Nc3 Bf5 *"}]
    monkeypatch.setattr(prep, "_fetch_opponent", AsyncMock(return_value=games))
    master = AsyncMock(return_value=None)
    monkeypatch.setattr(prep, "_master_reply", master)
    inserted = []
    async def insert(_db, _model, rows, **kwargs):
        inserted.extend(rows)
    monkeypatch.setattr(prep, "bulk_insert", insert)
    def add(rep):
        rep.id = 7
    db = SimpleNamespace(add=add, flush=AsyncMock(), commit=AsyncMock())
    result = await prep.build_prep_repertoire(
        PrepRepertoireIn(platform="chesscom", username=opponent, my_color=my_color),
        user=SimpleNamespace(id=1), db=db)
    assert result.card_count == 3
    assert result.prep_sources == {"opponent_games": 3}
    assert "game-based" in result.name
    for card in inserted:
        board = chess.Board(card["fen"])
        assert board.turn == (my_color == "white")
        assert chess.Move.from_uci(card["expected_uci"]) in board.legal_moves
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_prep_ignores_games_that_do_not_contain_opponent(monkeypatch):
    monkeypatch.setattr(prep, "_fetch_opponent", AsyncMock(return_value=[
        {"white": "alice", "black": "bob", "movetext": "1. e4 e5 *"}]))
    with pytest.raises(HTTPException) as exc:
        await prep.build_prep_repertoire(
            PrepRepertoireIn(platform="chesscom", username="other", my_color="white"),
            user=SimpleNamespace(id=1), db=None)
    assert exc.value.detail["code"] == "no_lines"
