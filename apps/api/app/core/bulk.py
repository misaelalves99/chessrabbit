"""
Chunked multi-row writes.

Everything here exists because the natural way to write a loop -
``for row in rows: db.add(Row(...))`` with a flush inside - costs one network
round trip per row. On the paths that matter (a PGN import indexes ~80
positions per game, a repertoire is a few hundred cards) that is the whole
cost of the request: the statements themselves are trivial, the latency is
not.

Chunking is not optional. Postgres caps a statement at 65535 bound
parameters, so a 10-column row overflows at ~6500 rows, and a single
statement that large also holds locks for as long as it runs. CHUNK_ROWS is
set so the widest table here stays well inside both limits.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Sequence
from typing import Any

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

# 1000 rows x at most ~12 columns = 12k parameters, comfortably under the
# 65535 wire limit, and small enough that one chunk is a short-lived lock.
CHUNK_ROWS = 1000


def chunked(rows: Sequence[Any], size: int = CHUNK_ROWS) -> Iterator[Sequence[Any]]:
    """Yield `rows` in slices of at most `size`."""
    for start in range(0, len(rows), size):
        yield rows[start : start + size]


async def bulk_insert(
    db: AsyncSession,
    model: Any,
    rows: Sequence[dict],
    *,
    ignore_conflicts: bool = False,
    chunk: int = CHUNK_ROWS,
) -> int:
    """
    INSERT `rows` into `model`'s table, one statement per chunk.

    Does not flush the session's ORM state, so callers holding a parent object
    must have flushed it themselves - these rows carry foreign keys by value.

    `ignore_conflicts` needs the table to have a unique constraint worth
    skipping on; it is ON CONFLICT DO NOTHING, so it silently drops
    duplicates rather than raising. Returns the number of rows submitted, not
    the number actually written.
    """
    if not rows:
        return 0
    for batch in chunked(rows, chunk):
        stmt = pg_insert(model)
        if ignore_conflicts:
            stmt = stmt.on_conflict_do_nothing()
        await db.execute(stmt, list(batch))
    return len(rows)


async def bulk_upsert(
    db: AsyncSession,
    model: Any,
    rows: Sequence[dict],
    *,
    conflict_on: Iterable[str],
    update: Iterable[str],
    chunk: int = CHUNK_ROWS,
) -> int:
    """
    INSERT ... ON CONFLICT (conflict_on) DO UPDATE SET (update), chunked.

    `update` names the columns a conflicting row overwrites; anything omitted
    keeps the value already stored. That distinction is load-bearing for
    annotations, where the engine owns the eval columns and the user owns the
    comment.
    """
    rows = [r for r in rows if r]
    if not rows:
        return 0
    update = list(update)
    for batch in chunked(rows, chunk):
        stmt = pg_insert(model)
        await db.execute(
            stmt.on_conflict_do_update(
                index_elements=list(conflict_on),
                set_={col: getattr(stmt.excluded, col) for col in update},
            ),
            list(batch),
        )
    return len(rows)
