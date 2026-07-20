"""
Nightly re-sync of every connected Lichess/Chess.com account.

Runs INSIDE the api container so it shares the app's DB session, config, and
importer code (the pipeline/ scripts are standalone; this one is not). Cron:

    0 5 * * *  cd /srv/chessrabbit && docker compose exec -T api python -m app.services.sync_all

Polite by design: accounts are synced sequentially with a pause between each,
so we never hammer the platform APIs. A failed account is recorded on its row
(last_status) and does not stop the rest of the run.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select

from app.core.db import SessionLocal
from app.models import ExternalAccount, User
from app.services.importers import PlatformError, sync_account

log = logging.getLogger(__name__)

PAUSE_BETWEEN_ACCOUNTS_S = 2.0


async def sync_all_accounts() -> dict:
    synced = failed = skipped = 0
    total_imported = 0

    async with SessionLocal() as db:
        result = await db.execute(select(ExternalAccount))
        accounts = list(result.scalars().all())

    for account in accounts:
        async with SessionLocal() as db:
            # Re-fetch inside this session; skip owners who are gone or suspended.
            acc = await db.get(ExternalAccount, account.id)
            if acc is None:
                continue
            user = await db.get(User, acc.user_id)
            if user is None or user.deleted_at is not None or user.suspended_at is not None:
                skipped += 1
                continue

            try:
                stats = await sync_account(db, user, acc)
                synced += 1
                total_imported += stats["imported"]
            except PlatformError as exc:
                failed += 1
                log.warning("Sync failed for %s/%s: %s", acc.platform, acc.username, exc)

        await asyncio.sleep(PAUSE_BETWEEN_ACCOUNTS_S)

    summary = {
        "accounts": len(accounts),
        "synced": synced,
        "failed": failed,
        "skipped": skipped,
        "games_imported": total_imported,
    }
    log.info("Nightly sync complete: %s", summary)
    return summary


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)-8s [sync] %(message)s"
    )
    print(asyncio.run(sync_all_accounts()))
