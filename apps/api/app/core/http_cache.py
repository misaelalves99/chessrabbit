"""
Caching for responses whose body is the same for everybody.

Two layers, and they answer different questions:

- `cached_json` keeps the *computed* payload in Redis, so the work behind it
  (a table scan, a third-party call) happens once per TTL for the whole
  deployment rather than once per request.
- `etag_response` keeps the *transferred* payload out of the network. A client
  that already has the current version sends If-None-Match and gets 304 with
  no body at all, which beats even a compressed hit.

Only for content that does not vary per user. Anything personalised must stay
`private` at most - an aggregate over every puzzle in the database is the same
object for every reader; a game list is not, and putting one behind a shared
cache is how one account's data ends up in another's browser.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse, Response

from app.core.redis_client import get_redis

log = logging.getLogger(__name__)


async def cached_json(
    key: str,
    ttl: int,
    produce: Callable[[], Awaitable[Any]],
) -> Any:
    """
    Return `produce()`'s result, memoised in Redis under `key` for `ttl`.

    Redis is treated as an optimisation, never a dependency: a read or write
    that fails is logged and the request is served from source.
    """
    try:
        hit = await get_redis().get(key)
        if hit:
            return json.loads(hit)
    except Exception:
        log.warning("cache read failed for %s", key, exc_info=True)

    value = await produce()

    try:
        await get_redis().setex(key, ttl, json.dumps(value, default=str))
    except Exception:
        log.warning("cache write failed for %s", key, exc_info=True)

    return value


def etag_response(
    request: Request,
    payload: Any,
    *,
    max_age: int,
    public: bool = False,
) -> Response:
    """
    Serve `payload` with a strong ETag, or 304 when the client already has it.

    The tag is a hash of the serialised body, so it changes exactly when the
    content does - no version numbers to remember to bump, and two API workers
    computing the same payload agree on the same tag.

    `public` is opt-in per endpoint and means "any cache may store this".
    Endpoints that need authentication but return the same bytes to every
    caller stay private: the response is identical, but making a proxy
    responsible for that distinction is not a bet worth taking.
    """
    body = json.dumps(payload, default=str, separators=(",", ":")).encode()
    etag = '"' + hashlib.blake2b(body, digest_size=16).hexdigest() + '"'
    visibility = "public" if public else "private"
    headers = {
        "ETag": etag,
        "Cache-Control": f"{visibility}, max-age={max_age}",
    }

    # If-None-Match is a list, and a proxy may have added W/ to our tag.
    if any(
        tag.strip().removeprefix("W/") == etag
        for tag in (request.headers.get("if-none-match") or "").split(",")
        if tag.strip()
    ):
        return Response(status_code=304, headers=headers)

    return JSONResponse(content=payload, headers=headers)
