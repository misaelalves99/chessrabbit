"""
Tactics puzzle trainer.

Puzzles come from the Lichess open puzzle database (CC0): a FEN plus a UCI
solution line whose first move is the opponent's setup (played automatically),
after which the solver must find the rest. `/puzzles/next` serves one near the
player's tactics rating; `/puzzles/attempt` records the result and nudges that
rating Elo-style so difficulty tracks the player.

Solutions are sent to the client, which validates moves locally (standard for
puzzle trainers - the same is true on Lichess). The rating that matters is
updated server-side from the reported outcome.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import get_current_user
from app.models import Puzzle, PuzzleAttempt, User
from app.schemas import PuzzleAttemptIn, PuzzleAttemptResult, PuzzleOut, PuzzleStats

router = APIRouter(prefix="/puzzles", tags=["puzzles"])

RATING_WINDOW = 300     # how far from the player's rating we look first
K_FACTOR = 32           # Elo responsiveness
RATING_FLOOR, RATING_CEIL = 400, 3200


def _to_out(p: Puzzle) -> PuzzleOut:
    return PuzzleOut(
        id=p.id,
        lichess_id=p.lichess_id,
        fen=p.fen,
        moves=p.moves.split(),
        rating=p.rating,
        themes=(p.themes or "").split(),
        game_url=p.game_url,
    )


@router.get("/next", response_model=PuzzleOut)
async def next_puzzle(
    theme: str | None = Query(default=None, max_length=40),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """A puzzle near the player's rating they haven't seen, optionally by theme."""
    attempted = select(PuzzleAttempt.puzzle_id).where(PuzzleAttempt.user_id == user.id)

    def base():
        stmt = select(Puzzle).where(Puzzle.id.not_in(attempted))
        if theme:
            stmt = stmt.where(Puzzle.themes.like(f"%{theme}%"))
        return stmt

    lo, hi = user.puzzle_rating - RATING_WINDOW, user.puzzle_rating + RATING_WINDOW

    # 1) unseen, near rating, matching theme -> 2) unseen anywhere -> 3) anything
    for stmt in (
        base().where(Puzzle.rating.between(lo, hi)).order_by(func.random()),
        base().order_by(func.random()),
        (
            select(Puzzle)
            .where(Puzzle.themes.like(f"%{theme}%") if theme else True)
            .order_by(func.random())
        ),
    ):
        puzzle = (await db.execute(stmt.limit(1))).scalar_one_or_none()
        if puzzle is not None:
            return _to_out(puzzle)

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"code": "no_puzzles", "message": "No puzzles loaded. Run pipeline/load_puzzles.py."},
    )


@router.post("/attempt", response_model=PuzzleAttemptResult)
async def record_attempt(
    payload: PuzzleAttemptIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Record a solve/fail and update the player's tactics rating (Elo)."""
    puzzle = await db.get(Puzzle, payload.puzzle_id)
    if puzzle is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "Puzzle not found"},
        )

    before = user.puzzle_rating
    expected = 1.0 / (1.0 + 10 ** ((puzzle.rating - before) / 400.0))
    score = 1.0 if payload.solved else 0.0
    after = round(before + K_FACTOR * (score - expected))
    after = max(RATING_FLOOR, min(RATING_CEIL, after))

    user.puzzle_rating = after
    db.add(
        PuzzleAttempt(
            user_id=user.id, puzzle_id=puzzle.id, solved=payload.solved,
            rating_before=before, rating_after=after,
        )
    )
    await db.commit()

    return PuzzleAttemptResult(
        solved=payload.solved,
        rating_before=before,
        rating_after=after,
        delta=after - before,
        puzzle_rating=puzzle.rating,
    )


@router.get("/stats", response_model=PuzzleStats)
async def puzzle_stats(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Solve counts and the player's current solved streak."""
    totals = (
        await db.execute(
            select(
                func.count(PuzzleAttempt.id),
                func.count(PuzzleAttempt.id).filter(PuzzleAttempt.solved.is_(True)),
            ).where(PuzzleAttempt.user_id == user.id)
        )
    ).one()
    attempted, solved = totals[0], totals[1]

    recent = (
        await db.execute(
            select(PuzzleAttempt.solved)
            .where(PuzzleAttempt.user_id == user.id)
            .order_by(PuzzleAttempt.created_at.desc())
            .limit(200)
        )
    ).scalars().all()
    streak = 0
    for ok in recent:
        if not ok:
            break
        streak += 1

    return PuzzleStats(
        puzzle_rating=user.puzzle_rating,
        solved=solved,
        attempted=attempted,
        streak=streak,
    )
