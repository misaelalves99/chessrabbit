"""Player Insights: aggregate statistics across a player's own games."""

from __future__ import annotations

import json
import logging
import re
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import get_current_user, require_master
from app.core.http_cache import cached_json, etag_response
from app.core.ratelimit import user_rate_limit
from app.core.redis_client import get_redis
from app.models import User
from app.services.importers import PlatformError, fetch_games
from app.services.insights import Filters, cached_insights
from app.services.public_insights import (
    build_public_insights, otb_games, otb_name_matches,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["insights"])

TIME_CLASSES = ("bullet", "blitz", "rapid", "classical", "correspondence")
RANGES = {"30d": 30, "90d": 90, "1y": 365}

SOURCES = ("lichess", "chesscom", "otb")

_PLATFORM_NAME = re.compile(r"[\w.-]{1,60}")

# Online games are fetched from a rate-limited third party, so the same lookup
# must not hit them twice in a row. OTB is a static dump and can sit longer.
PUBLIC_TTL = 1800
OTB_TTL = 86400
# The name picker's index only changes when a reference dump is loaded.
OTB_NAMES_TTL = 86400

# Bounded so one lookup cannot stall on a 20k-game account.
MAX_ONLINE_GAMES = 400


def _validate(time_class: str | None, range_: str) -> date | None:
    if time_class is not None and time_class not in TIME_CLASSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "bad_time_class",
                "message": f"time_class must be one of {', '.join(TIME_CLASSES)}",
            },
        )
    if range_ != "all" and range_ not in RANGES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "bad_range",
                "message": f"range must be 'all' or one of {', '.join(RANGES)}",
            },
        )
    return None if range_ == "all" else date.today() - timedelta(days=RANGES[range_])


@router.get("/insights")
async def get_insights(
    time_class: str | None = Query(default=None),
    color: str | None = Query(default=None, pattern="^[wb]$"),
    range_: str = Query(default="all", alias="range"),
    # Minutes east of UTC, from the browser. Without it "when do you play
    # worst?" would answer in UTC, which is nobody's evening.
    tz_offset: int = Query(default=0, ge=-840, le=840),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Everything the Insights page draws, in one response.

    Filters are deliberately coarse (time class, colour, a few date ranges):
    each combination is a cache key, and the value of a finer filter does not
    pay for the cache misses it would cause.
    """
    since = _validate(time_class, range_)
    filters = Filters(
        time_class=time_class, color=color, since=since, tz_offset=tz_offset
    )

    return await cached_insights(db, user, filters, get_redis())


@router.get("/insights/players")
async def search_otb_players(
    request: Request,
    q: str = Query(min_length=2, max_length=60),
    _: User = Depends(require_master),
    db: AsyncSession = Depends(get_db),
):
    """
    Name-complete against the over-the-board reference database.

    Reference PGNs spell names "Lastname, Firstname", which nobody types
    correctly first go - so the lookup itself is a picker, not free text.

    Two scans of `games` with a leading-wildcard LIKE, per keystroke past the
    client's debounce, for an answer that is the same for every user and only
    changes when a new dump is loaded. Cached on the normalised query.
    """
    needle = q.strip().lower()

    payload = await cached_json(
        f"otb:names:{needle}",
        OTB_NAMES_TTL,
        lambda: otb_name_matches(db, needle),
    )
    return etag_response(request, payload, max_age=600)


@router.get(
    "/insights/player",
    dependencies=[user_rate_limit("player_insights", 20, 60)],
)
async def get_player_insights(
    source: str = Query(description="lichess | chesscom | otb"),
    username: str = Query(min_length=1, max_length=100),
    time_class: str | None = Query(default=None),
    color: str | None = Query(default=None, pattern="^[wb]$"),
    range_: str = Query(default="all", alias="range"),
    tz_offset: int = Query(default=0, ge=-840, le=840),
    user: User = Depends(require_master),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """
    Insights for somebody else: an online account, or a player's
    over-the-board career from the reference database.

    Online games are fetched on demand and never stored. Engine-derived
    sections are absent for every source here - see services/public_insights.
    """
    if source not in SOURCES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "bad_source",
                    "message": f"source must be one of {', '.join(SOURCES)}"},
        )

    since = _validate(time_class, range_)
    filters = Filters(
        time_class=time_class, color=color, since=since, tz_offset=tz_offset
    )
    name = username.strip()

    # OTB names are free text ("Carlsen, Magnus"), but an online name goes into
    # a lichess.org/chess.com URL path, where a "/" would make it a different
    # endpoint. Constrain exactly the case that leaves the process.
    if source != "otb" and not _PLATFORM_NAME.fullmatch(name):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "bad_username",
                    "message": "Usernames may contain letters, digits, '_', '.' and '-' only"},
        )

    redis = get_redis()
    cache_key = (
        f"pins:{source}:{name.lower()}:{time_class or 'all'}:"
        f"{color or 'all'}:{since or 'all'}:{tz_offset}"
    )
    try:
        hit = await redis.get(cache_key)
        if hit:
            return json.loads(hit)
    except Exception:
        log.warning("player insights cache read failed", exc_info=True)

    if source == "otb":
        games = await otb_games(db, name)
        if not games:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"code": "player_not_found",
                        "message": f'No over-the-board games for "{name}". '
                                   "Try the name picker - reference games spell "
                                   "names 'Lastname, Firstname'."},
            )
        ttl = OTB_TTL
    else:
        try:
            # fetch_games yields (entry, external_id) pairs for the importer;
            # only the parsed game matters here, since nothing is persisted.
            games = [
                entry
                for entry, _ in await fetch_games(
                    source, name, since=None, max_games=MAX_ONLINE_GAMES
                )
            ]
        except PlatformError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={"code": "platform_error", "message": str(exc)},
            )
        ttl = PUBLIC_TTL

    payload = build_public_insights(games, name, source, filters)

    if payload["games"] == 0:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "no_games",
                "message": f'Found no finished games for "{name}" with these filters.',
            },
        )

    try:
        await redis.setex(cache_key, ttl, json.dumps(payload, default=str))
    except Exception:
        log.warning("player insights cache write failed", exc_info=True)
    return payload
