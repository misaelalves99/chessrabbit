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

The cache entry outlives its own freshness. Each entry carries the instant it
stops being current, and is kept for `_STALE_TTL` beyond that: while Lichess is
unreachable, a day-old count of how often 1.e4 was met with 1...c5 is a far
better answer than an error, and master statistics do not move quickly enough
for the staleness to mislead anyone. That stale copy is the circuit breaker's
fallback, which is what makes fast-failing safe here.
"""

from __future__ import annotations

import json
import logging
import re
import time

import httpx

from app.core.breaker import CircuitOpen, breaker
from app.core.redis_client import get_redis

log = logging.getLogger(__name__)

MASTERS_URL = "https://explorer.lichess.ovh/masters"
_TIMEOUT = httpx.Timeout(6.0, connect=3.0, read=6.0)
_HEADERS = {"User-Agent": "ChessRabbit (https://github.com/shivamjg101/chessrabbit)"}
_CACHE_TTL = 3600  # seconds; masters data barely moves within an hour
_STALE_TTL = 86400 * 7  # how long an entry stays usable as a fallback
_CACHE_PREFIX = "lex:masters:"

# The analysis board queries this on every move navigation, so it is both the
# highest-volume outbound call and the one most able to pile up. Concurrency is
# capped below Lichess's own tolerance: their explorer is a shared free service
# and our whole deployment shares one budget with it.
_breaker = breaker(
    "lichess-explorer",
    failure_threshold=5,
    reset_after=30.0,
    slow_call_seconds=4.0,
    max_concurrency=8,
)


class ExplorerUnavailable(Exception):
    """Upstream Lichess explorer errored, timed out, or rate-limited us."""

    def __init__(self, message: str, code: str = "explorer_unavailable"):
        super().__init__(message)
        self.code = code


async def _fetch(fen: str, token: str) -> dict:
    """One call to Lichess. Every failure mode raises ExplorerUnavailable."""
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, headers={**_HEADERS, "Authorization": f"Bearer {token}"}) as client:
            res = await client.get(
                MASTERS_URL,
                params={"fen": fen, "moves": 20, "topGames": 0},
            )
    except httpx.HTTPError as exc:
        raise ExplorerUnavailable("Cannot reach Lichess. Check your internet connection and retry.") from exc

    if res.status_code in (401, 403):
        raise ExplorerUnavailable("Lichess rejected this token. Create a new personal API token with no permissions selected and connect again.", "lichess_auth_required")

    if res.status_code == 429:
        raise ExplorerUnavailable("rate limited by Lichess")
    if res.status_code != 200:
        raise ExplorerUnavailable(f"HTTP {res.status_code}")

    try:
        data = res.json()
        if not isinstance(data, dict) or not isinstance(data.get("moves"), list):
            raise ValueError("Expected explorer statistics")
        return data
    except ValueError as exc:
        raise ExplorerUnavailable("malformed response") from exc


async def _cached(key: str) -> tuple[dict | None, bool]:
    """Return (data, is_fresh). (None, False) when there is nothing stored."""
    try:
        raw = await get_redis().get(key)
    except Exception:  # cache is best-effort; never fail the request on it
        return None, False
    if not raw:
        return None, False
    try:
        entry = json.loads(raw)
        return entry["data"], time.time() < entry["fresh_until"]
    except (ValueError, KeyError, TypeError):
        return None, False


async def masters_moves(fen: str, token: str | None = None) -> dict:
    """
    Return Lichess's raw masters response for a FEN:
    ``{"white": int, "draws": int, "black": int, "moves": [...]}``.

    Served from Redis while fresh. When the upstream call fails or the circuit
    is open, a stale entry is served in preference to an error. Raises
    ExplorerUnavailable only when there is nothing to fall back on, so the
    caller can still distinguish "no master games here" (a valid empty result)
    from "could not reach Lichess".
    """
    if not token or not re.fullmatch(r"[A-Za-z0-9_-]{10,512}", token):
        raise ExplorerUnavailable("Connect a Lichess personal API token below to use Live explorer. No token permissions are needed.", "lichess_auth_required")
    # Move counters do not change opening statistics; transpositions share a cache.
    key = _CACHE_PREFIX + " ".join(fen.split()[:4])
    cached, fresh = await _cached(key)
    if cached is not None and fresh:
        return cached

    try:
        data = await _breaker.call(_fetch, fen, token)
    except (ExplorerUnavailable, CircuitOpen) as exc:
        if isinstance(exc, ExplorerUnavailable) and exc.code == "lichess_auth_required":
            raise
        if cached is not None:
            log.info("Serving stale masters data for %s (%s)", fen, exc)
            return cached
        raise ExplorerUnavailable("Lichess explorer is temporarily unavailable. Please retry shortly.") from exc

    try:
        await get_redis().setex(
            key,
            _STALE_TTL,
            json.dumps({"data": data, "fresh_until": time.time() + _CACHE_TTL}),
        )
    except Exception:
        pass

    return data
