"""
Live Masters statistics from Lichess's Opening Explorer API.

Where the local opening_tree is a snapshot we loaded once, this queries
https://explorer.lichess.ovh/masters on demand, so the numbers always reflect
the current Lichess masters database (OTB games, both sides 2200+). We call it
server-side so the browser never hits a third-party origin (no CORS, one place
to cache and rate-limit).

Responses are cached in Redis per FEN: the analysis workspace re-queries the
explorer on every move navigation, and the upstream endpoint is rate-limited,
so caching keeps us both fast and polite. A position Lichess has never seen in
master play legitimately returns zero moves - that is cached too.
"""

from __future__ import annotations

import json
import logging

import httpx

from app.core.redis_client import get_redis

log = logging.getLogger(__name__)

MASTERS_URL = "https://explorer.lichess.ovh/masters"
_TIMEOUT = httpx.Timeout(6.0, read=6.0)
_HEADERS = {"User-Agent": "ChessRabbit/0.1 (opening-explorer; noreply@chessrabbit.app)"}
_CACHE_TTL = 3600  # seconds; masters data barely moves within an hour
_CACHE_PREFIX = "lex:masters:"


class ExplorerUnavailable(Exception):
    """Upstream Lichess explorer errored, timed out, or rate-limited us."""


async def masters_moves(fen: str) -> dict:
    """
    Return Lichess's raw masters response for a FEN:
    ``{"white": int, "draws": int, "black": int, "moves": [...]}``.

    Cached in Redis for ``_CACHE_TTL`` seconds. Raises ExplorerUnavailable when
    the upstream call fails so the caller can distinguish "no master games here"
    (a valid empty result) from "could not reach Lichess".
    """
    redis = get_redis()
    key = _CACHE_PREFIX + fen

    try:
        cached = await redis.get(key)
        if cached:
            return json.loads(cached)
    except Exception:  # cache is best-effort; never fail the request on it
        pass

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_HEADERS) as client:
            res = await client.get(
                MASTERS_URL,
                params={"fen": fen, "moves": 20, "topGames": 0},
            )
    except httpx.HTTPError as exc:
        raise ExplorerUnavailable(f"request failed: {exc}") from exc

    if res.status_code == 429:
        raise ExplorerUnavailable("rate limited by Lichess")
    if res.status_code != 200:
        raise ExplorerUnavailable(f"HTTP {res.status_code}")

    try:
        data = res.json()
    except ValueError as exc:
        raise ExplorerUnavailable("malformed response") from exc

    try:
        await redis.setex(key, _CACHE_TTL, json.dumps(data))
    except Exception:
        pass

    return data
