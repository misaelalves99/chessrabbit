"""
Access-token revocation list.

A JWT is valid because it verifies, not because we still like it - so signing
out, on its own, only throws the token away on the client. The refresh token is
revoked in the database and that ends the session's ability to renew itself,
but the access token already in hand keeps working until it expires. On a
shared or borrowed machine that is a window in which "sign out" did not sign
anybody out.

The window is bounded by ACCESS_TOKEN_TTL_MIN (15 minutes by default), which is
why this is a small hole rather than a large one. It is still a hole, and it is
cheap to close: every token carries a `jti`, logout writes that id to Redis
with a TTL matching the token's own remaining life, and the dependency that
resolves a token checks the list. Entries expire exactly when the token they
describe would have, so the list stays the size of "sessions signed out in the
last quarter of an hour" and needs no sweeping.

**Fails open.** If Redis cannot be reached, tokens are accepted. The
alternative - refusing every authenticated request when the cache blinks -
turns a Redis hiccup into a total outage, and the exposure it would buy is at
most the remaining minutes of tokens whose owners have pressed sign out. That
tradeoff is deliberate; if it is ever the wrong one, this is the single place
to change it.
"""

from __future__ import annotations

import logging
import time

from app.core.redis_client import get_redis

log = logging.getLogger(__name__)

_PREFIX = "jwt:revoked:"


async def revoke(jti: str, expires_at: int) -> None:
    """
    Deny `jti` until `expires_at` (a JWT `exp`, i.e. epoch seconds).

    A token already past its expiry needs no entry - it will not verify.
    """
    ttl = int(expires_at - time.time())
    if not jti or ttl <= 0:
        return
    try:
        await get_redis().setex(_PREFIX + jti, ttl, "1")
    except Exception:
        # Logged rather than raised: the caller is signing out, and failing
        # that request would leave the user staring at an error while their
        # refresh token has already been revoked in the database.
        log.warning("Could not record revocation for jti %s", jti, exc_info=True)


async def is_revoked(jti: str | None) -> bool:
    """True when this token was explicitly signed out. See the module note."""
    if not jti:
        # Tokens minted before this existed carry no jti. They cannot be
        # revoked individually and expire within the access-token TTL.
        return False
    try:
        return await get_redis().exists(_PREFIX + jti) == 1
    except Exception:
        log.warning("Revocation check unavailable; admitting token", exc_info=True)
        return False
