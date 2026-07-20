#!/usr/bin/env python3
"""
Nightly maintenance. Run from cron or a systemd timer:

    0 4 * * *  cd /srv/chessrabbit && python pipeline/purge.py

Does four things:
1. Hard-deletes accounts soft-deleted more than RETENTION_DAYS ago.
   ON DELETE CASCADE wipes their games, tokens, jobs, and annotations.
2. Deletes expired/used email tokens and expired/revoked refresh tokens.
3. Trims analysis_cache rows not touched in CACHE_TTL_DAYS (optional, keeps
   the cache from growing without bound; comment out to keep everything).
4. Trims analysis_jobs: finished jobs past JOB_RETENTION_DAYS, plus jobs
   stuck queued/running for over 7 days (orphaned by a dead worker).
"""

from __future__ import annotations

import os

import psycopg

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://chessrabbit:devpassword@localhost:5432/chessrabbit"
)
RETENTION_DAYS = int(os.getenv("ACCOUNT_RETENTION_DAYS", "30"))
CACHE_TTL_DAYS = int(os.getenv("ANALYSIS_CACHE_TTL_DAYS", "180"))
JOB_RETENTION_DAYS = int(os.getenv("ANALYSIS_JOB_RETENTION_DAYS", "30"))


def main() -> None:
    with psycopg.connect(DATABASE_URL) as conn, conn.cursor() as cur:
        cur.execute(
            "DELETE FROM users WHERE deleted_at IS NOT NULL "
            "AND deleted_at < now() - make_interval(days => %s)",
            (RETENTION_DAYS,),
        )
        purged_users = cur.rowcount

        cur.execute(
            "DELETE FROM email_tokens WHERE used OR expires_at < now()"
        )
        purged_email = cur.rowcount

        cur.execute(
            "DELETE FROM refresh_tokens WHERE revoked OR expires_at < now()"
        )
        purged_refresh = cur.rowcount

        cur.execute(
            "DELETE FROM analysis_cache WHERE created_at < now() - make_interval(days => %s)",
            (CACHE_TTL_DAYS,),
        )
        purged_cache = cur.rowcount

        cur.execute(
            "DELETE FROM analysis_jobs WHERE "
            "(status IN ('done','failed','canceled') "
            " AND finished_at < now() - make_interval(days => %s)) "
            "OR (status IN ('queued','running') "
            " AND created_at < now() - make_interval(days => 7))",
            (JOB_RETENTION_DAYS,),
        )
        purged_jobs = cur.rowcount

        conn.commit()

    print(
        f"purged: {purged_users} accounts, {purged_email} email tokens, "
        f"{purged_refresh} refresh tokens, {purged_cache} cache rows, "
        f"{purged_jobs} job rows"
    )


if __name__ == "__main__":
    main()
