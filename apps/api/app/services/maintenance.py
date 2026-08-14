"""
Nightly housekeeping for the tables that only ever grow.

Runs INSIDE the api container so it shares the app's DB session and config
(the pipeline/ scripts are standalone; this one is not). Cron:

    30 4 * * *  cd /srv/chessrabbit && docker compose exec -T api python -m app.services.maintenance

Four things accumulate without bound:

- analysis_cache: one row per (position, engine version) anyone has ever
  analysed. It is a cache, but nothing ever evicted from it, and it is already
  the largest contributor to db_size_mb on /admin/stats.
- refresh_tokens / email_tokens: every login and every password-reset mail adds
  a row that stays after it expires. They are also the tables an attacker with
  read access would most like to find full of history.
- analysis_jobs: finished job rows, including their full result payload, which
  the client has long since read.
- the Redis presence set: one member per user who has ever signed in, of which
  only the last few minutes are ever read.

Everything here is safe to run repeatedly and safe to interrupt: each step is
its own transaction and deletes only rows the app can no longer serve.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import SessionLocal

log = logging.getLogger(__name__)

# Deleting a few million rows in one statement takes a long lock and a large
# WAL write. Chunking keeps each transaction short enough that the API never
# waits on it.
CHUNK = 10_000
MAX_CHUNKS = 500


async def _delete_chunked(db: AsyncSession, sql: str, params: dict, label: str) -> int:
    """Run a chunked DELETE until it stops matching rows. Returns rows removed."""
    removed = 0
    for _ in range(MAX_CHUNKS):
        result = await db.execute(text(sql), params)
        await db.commit()
        n = result.rowcount or 0
        removed += n
        if n < CHUNK:
            break
    else:
        log.warning(
            "%s hit the chunk ceiling (%d rows); more remain for the next run",
            label, removed,
        )
    return removed


async def evict_analysis_cache(db: AsyncSession) -> dict:
    """
    Age out stale cached evaluations, then enforce a hard row cap.

    Age first: an entry nobody has needed in ANALYSIS_CACHE_TTL_DAYS is a
    position that fell out of fashion, and recomputing it costs one search.
    The cap is the backstop for a burst that outruns the age policy - it keeps
    the newest rows, which are the ones an active board is actually hitting.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.ANALYSIS_CACHE_TTL_DAYS)

    by_age = await _delete_chunked(
        db,
        """
        DELETE FROM analysis_cache
        WHERE ctid IN (
            SELECT ctid FROM analysis_cache WHERE created_at < :cutoff LIMIT :chunk
        )
        """,
        {"cutoff": cutoff, "chunk": CHUNK},
        "analysis_cache age eviction",
    )

    total = (await db.execute(text("SELECT count(*) FROM analysis_cache"))).scalar_one()
    by_cap = 0
    if total > settings.ANALYSIS_CACHE_MAX_ROWS:
        # Rank newest-first and skip the ones we are keeping; whatever is left
        # is surplus, oldest included. Repeating this converges on the cap.
        by_cap = await _delete_chunked(
            db,
            """
            DELETE FROM analysis_cache
            WHERE ctid IN (
                SELECT ctid FROM analysis_cache
                ORDER BY created_at DESC
                OFFSET :keep LIMIT :chunk
            )
            """,
            {"chunk": CHUNK, "keep": settings.ANALYSIS_CACHE_MAX_ROWS},
            "analysis_cache cap eviction",
        )

    return {"evicted_by_age": by_age, "evicted_by_cap": by_cap, "remaining": total - by_cap}


async def purge_expired_tokens(db: AsyncSession) -> dict:
    """
    Drop auth tokens that can no longer authenticate anything.

    Revoked refresh tokens are kept for a grace window rather than deleted at
    once: reuse detection recognises a stolen token by finding its revoked row,
    and a row deleted the moment it rotates would make a replay look like an
    unknown token instead of a theft.
    """
    now = datetime.now(timezone.utc)
    grace = now - timedelta(days=settings.REVOKED_TOKEN_GRACE_DAYS)

    refresh = await _delete_chunked(
        db,
        """
        DELETE FROM refresh_tokens
        WHERE ctid IN (
            SELECT ctid FROM refresh_tokens
            WHERE expires_at < :now OR (revoked AND created_at < :grace)
            LIMIT :chunk
        )
        """,
        {"now": now, "grace": grace, "chunk": CHUNK},
        "refresh_tokens purge",
    )

    email = await _delete_chunked(
        db,
        """
        DELETE FROM email_tokens
        WHERE ctid IN (
            SELECT ctid FROM email_tokens
            WHERE expires_at < :now OR used LIMIT :chunk
        )
        """,
        {"now": now, "chunk": CHUNK},
        "email_tokens purge",
    )

    return {"refresh_tokens": refresh, "email_tokens": email}


async def purge_finished_jobs(db: AsyncSession) -> dict:
    """Forget completed engine jobs once nobody could still be polling them."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.JOB_RETENTION_DAYS)
    removed = await _delete_chunked(
        db,
        """
        DELETE FROM analysis_jobs
        WHERE ctid IN (
            SELECT ctid FROM analysis_jobs
            WHERE status IN ('done', 'failed', 'canceled') AND created_at < :cutoff
            LIMIT :chunk
        )
        """,
        {"cutoff": cutoff, "chunk": CHUNK},
        "analysis_jobs purge",
    )
    return {"analysis_jobs": removed}


async def run_maintenance() -> dict:
    from app.services import presence

    async with SessionLocal() as db:
        summary = {
            "analysis_cache": await evict_analysis_cache(db),
            "tokens": await purge_expired_tokens(db),
            "jobs": await purge_finished_jobs(db),
            # The presence set keeps one member per user who has ever signed
            # in. Small, but unbounded, and nothing reads past 24h of it.
            "presence_trimmed": await presence.trim(),
        }
    log.info("Maintenance complete: %s", summary)
    return summary


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)-8s [maint] %(message)s"
    )
    print(asyncio.run(run_maintenance()))
