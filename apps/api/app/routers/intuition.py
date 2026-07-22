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
import random

import chess
import chess.pgn
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import check_daily_session, get_current_user
from app.core.tiers import tier_for
from app.models import User
from app.schemas import IntuitionOut

router = APIRouter(prefix="/intuition", tags=["intuition"])

MIN_ELO = 2400   # strongest side must be at least this
MIN_PLY = 10     # skip the book phase - intuition starts where theory ends
MAX_PLY = 34     # stay in the middlegame


@router.post("/start")
async def start_session(user: User = Depends(get_current_user)):
    """Gate intuition sessions per day on the free tier."""
    tier = tier_for(user.plan)
    await check_daily_session(
        user, "intuition", tier.intuition_per_day, "intuition session"
    )
    return {"ok": True}


@router.get("/next", response_model=IntuitionOut)
async def next_position(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """A random master-game position and the move that was played there."""
    for _ in range(6):  # retry a few times past short or unparseable games
        row = (
            await db.execute(
                text(
                    """
                    SELECT white, black, white_elo, black_elo, event, movetext
                    FROM games
                    WHERE owner_id IS NULL
                      AND GREATEST(white_elo, black_elo) >= :elo
                      AND ply_count >= :minply
                    ORDER BY random()
                    LIMIT 1
                    """
                ),
                {"elo": MIN_ELO, "minply": MIN_PLY + 4},
            )
        ).mappings().first()
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
