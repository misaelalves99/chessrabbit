"""
Redis-backed rate limiting.

Fixed-window counters: cheap, predictable, good enough for auth brute-force
protection. Keys look like rl:{scope}:{ip}:{window}. Fails OPEN if Redis is
down - availability beats strictness for a rate limiter.

Usage:
    @router.post("/login", dependencies=[rate_limit("login", 10, 60)])
"""

from __future__ import annotations

import logging
import time

from fastapi import Depends, HTTPException, Request, status

from app.core.redis_client import get_redis

log = logging.getLogger(__name__)


def _client_ip(request: Request) -> str:
    # Behind Caddy/nginx the real IP arrives in X-Forwarded-For (first hop).
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(scope: str, limit: int, window_s: int):
    """Dependency: allow `limit` requests per `window_s` seconds per client IP."""

    async def dependency(request: Request) -> None:
        ip = _client_ip(request)
        window = int(time.time() // window_s)
        key = f"rl:{scope}:{ip}:{window}"

        try:
            redis = get_redis()
            count = await redis.incr(key)
            if count == 1:
                await redis.expire(key, window_s + 1)
        except Exception:
            log.warning("Rate limiter: Redis unavailable, failing open")
            return

        if count > limit:
            retry_in = window_s - int(time.time() % window_s)
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={
                    "code": "rate_limited",
                    "message": f"Too many attempts. Try again in {retry_in}s.",
                },
                headers={"Retry-After": str(retry_in)},
            )

    return Depends(dependency)
