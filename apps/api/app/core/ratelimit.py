"""
Redis-backed rate limiting.

Fixed-window counters: cheap, predictable, good enough for auth brute-force
protection. Keys look like rl:{scope}:{who}:{window}. Fails OPEN if Redis is
down - availability beats strictness for a rate limiter.

Two flavours, because they answer different questions:

    rate_limit      - per client IP. For endpoints reachable without an
                      account, where the IP is the only identity there is.
    user_rate_limit - per user id. For authenticated work that costs us real
                      resources. An IP limit is the wrong control there: one
                      account behind a phone NAT is throttled by its
                      neighbours, while one attacker with a proxy pool is not
                      throttled at all. The account is what we can bill and
                      what we can suspend, so it is what we should count.

Usage:
    @router.post("/login",  dependencies=[rate_limit("login", 10, 60)])
    @router.post("/import", dependencies=[user_rate_limit("import", 20, 60)])
"""

from __future__ import annotations

import logging
import time

from fastapi import Depends, HTTPException, Request, status

from app.core.config import settings
from app.core.redis_client import get_redis

log = logging.getLogger(__name__)


def _client_ip(request: Request) -> str:
    """
    The identity we count against.

    X-Forwarded-For is attacker-controlled unless a proxy we run overwrites it,
    and this function decides who gets locked out of /auth/login. Trusting the
    header unconditionally meant a fresh header value per request - i.e. an
    unlimited password-guessing budget. It is honoured only when the operator
    asserts a proxy is in front (TRUST_PROXY_HEADERS); otherwise the socket
    peer, which cannot be forged, is what counts.
    """
    if settings.TRUST_PROXY_HEADERS:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            # Left-most is the origin client; hops append to the right.
            return fwd.split(",")[0].strip()[:64]
    return request.client.host if request.client else "unknown"


async def _consume(
    scope: str, who: str, limit: int, window_s: int, noun: str,
    fail_closed: bool = False,
) -> None:
    """Count one request against {scope}:{who}; raise 429 past `limit`."""
    window = int(time.time() // window_s)
    key = f"rl:{scope}:{who}:{window}"

    try:
        redis = get_redis()
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, window_s + 1)
    except Exception:
        # Failing open is right for ordinary endpoints: a Redis blip should not
        # take the product down. It is the wrong default for the login form,
        # where "the limiter is down" means "password guessing is unmetered"
        # and an attacker who can knock Redis over gets exactly that. Which
        # tradeoff applies is the operator's call - see AUTH_RATELIMIT_FAIL_CLOSED.
        if fail_closed and settings.AUTH_RATELIMIT_FAIL_CLOSED:
            log.error("Rate limiter: Redis unavailable, refusing %s (fail-closed)", scope)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "code": "rate_limiter_unavailable",
                    "message": "Sign-in is briefly unavailable. Please try again shortly.",
                },
            )
        log.warning("Rate limiter: Redis unavailable, failing open (%s)", scope)
        return

    if count > limit:
        retry_in = window_s - int(time.time() % window_s)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "rate_limited",
                "message": f"Too many {noun}. Try again in {retry_in}s.",
            },
            headers={"Retry-After": str(retry_in)},
        )


# Scopes where an unmetered burst is a credential attack rather than a busy
# user. These honour AUTH_RATELIMIT_FAIL_CLOSED when Redis is unreachable.
_CREDENTIAL_SCOPES = frozenset(
    {"login", "admin_login", "register", "forgot", "reset", "verify", "refresh"}
)


def rate_limit(scope: str, limit: int, window_s: int):
    """Dependency: allow `limit` requests per `window_s` seconds per client IP."""

    async def dependency(request: Request) -> None:
        await _consume(
            scope, _client_ip(request), limit, window_s, "attempts",
            fail_closed=scope in _CREDENTIAL_SCOPES,
        )

    return Depends(dependency)


def user_rate_limit(scope: str, limit: int, window_s: int):
    """
    Dependency: allow `limit` requests per `window_s` seconds per account.

    Resolves the caller through the usual `get_current_user`, so the endpoint's
    own auth is unchanged and FastAPI's per-request dependency cache means the
    user is still loaded exactly once.
    """
    from app.core.deps import get_current_user

    async def dependency(user=Depends(get_current_user)) -> None:
        await _consume(scope, str(user.id), limit, window_s, "requests")

    return Depends(dependency)
