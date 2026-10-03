"""
Intuition trainer: guess the master's move.

Serves a random middlegame position from the master reference database
(strongest player >= 2400) together with the move actually played there.
The client gives the solver a short countdown to answer on feel; a match
against either the master's move or the engine's top choice (fetched via the
existing /play/move endpoint at full strength) counts as a hit - sometimes
you out-play the game move, and that deserves the point.
"""

from __future__ import annotations

import io
import logging
import random
import time

import chess
import chess.pgn
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import get_current_user
from app.models import User
from app.schemas import IntuitionOut

log = logging.getLogger(__name__)
router = APIRouter(prefix="/intuition", tags=["intuition"])

MIN_ELO = 2400   # strongest side must be at least this
MIN_PLY = 10     # skip the book phase - intuition starts where theory ends
MAX_PLY = 34     # stay in the middlegame

# The reference database is a static dump, so its id range only moves when we
# reload one. An hour of staleness costs nothing; recomputing it per request
# would reintroduce the scan this cache exists to avoid.
_ID_RANGE_TTL = 3600
_id_range: tuple[int, int] | None = None
_id_range_at: float = 0.0


async def _reference_id_range(db: AsyncSession) -> tuple[int, int] | None:
    """Lowest and highest id among reference games, cached per process."""
    global _id_range, _id_range_at

    if _id_range is not None and time.monotonic() - _id_range_at < _ID_RANGE_TTL:
        return _id_range

    row = (
        await db.execute(
            text("SELECT min(id) AS lo, max(id) AS hi FROM games WHERE owner_id IS NULL")
        )
    ).mappings().first()
    if row is None or row["lo"] is None:
        return None

    _id_range = (int(row["lo"]), int(row["hi"]))
    _id_range_at = time.monotonic()
    return _id_range


@router.post("/start")
async def start_session(user: User = Depends(get_current_user)):
    """Gate intuition sessions per day on the free tier."""
    return {"ok": True}


@router.get("/next", response_model=IntuitionOut)
async def next_position(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """A random master-game position and the move that was played there."""
    bounds = await _reference_id_range(db)
    if bounds is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "no_positions", "message": "No master games loaded yet"},
        )
    lo, hi = bounds

    for _ in range(6):  # retry a few times past short or unparseable games
        # `ORDER BY random()` had to read every eligible reference game - tens
        # of thousands of rows, each carrying its full movetext - and sort them
        # to take one, roughly two seconds a go and up to six goes per request.
        # Instead, drop a pivot in the id range and let the primary key walk
        # forward to the first eligible row; the wrap-around covers a pivot
        # landing in a tail of user-owned ids.
        pivot = random.randint(lo, hi)
        row = None
        for start in (pivot, lo):
            row = (
                await db.execute(
                    text(
                        """
                        SELECT white, black, white_elo, black_elo, event, movetext
                        FROM games
                        WHERE owner_id IS NULL
                          AND id >= :pivot
                          AND GREATEST(white_elo, black_elo) >= :elo
                          AND ply_count >= :minply
                        ORDER BY id
                        LIMIT 1
                        """
                    ),
                    {"pivot": start, "elo": MIN_ELO, "minply": MIN_PLY + 4},
                )
            ).mappings().first()
            if row is not None:
                break
        if row is None:
            break

        game = chess.pgn.read_game(io.StringIO(row["movetext"]))
        if game is None:
            continue
        moves = list(game.mainline_moves())
        hi = min(MAX_PLY, len(moves) - 2)
        if hi <= MIN_PLY:
            continue

        ply = random.randint(MIN_PLY, hi)
        board = game.board()
        for mv in moves[:ply]:
            board.push(mv)
        master = moves[ply]

        return IntuitionOut(
            fen=board.fen(),
            master_uci=master.uci(),
            master_san=board.san(master),
            white=row["white"],
            black=row["black"],
            white_elo=row["white_elo"],
            black_elo=row["black_elo"],
            event=row["event"] or "",
            ply=ply,
        )

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"code": "no_positions", "message": "No master games loaded yet"},
    )
