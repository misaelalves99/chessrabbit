"""Shared Redis connection for queueing and pub/sub."""

from __future__ import annotations

import redis.asyncio as aioredis

from app.core.config import settings

_redis: aioredis.Redis | None = None


def configure_redis(client: aioredis.Redis) -> None:
    """Inject the desktop's shared in-memory queue before starting the API."""
    global _redis
    if _redis is not None:
        raise RuntimeError("Redis is already initialized")
    _redis = client


def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None
