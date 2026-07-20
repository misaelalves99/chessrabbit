"""
Repertoire trainer.

Create a repertoire from a PGN with variations; the extractor builds one
flashcard per position where it's your move. Review uses SM-2-lite spaced
repetition:

    correct  -> reps+1; interval 1d on first success, then interval*ease;
                ease creeps up (+0.05, capped 2.8)
    wrong    -> lapse; card comes back in 10 minutes; ease drops (-0.2,
                floored at 1.3); interval resets

Answers are judged server-side so the client can't mark itself correct.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import chess
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.chess_utils import extract_repertoire
from app.core.db import get_db
from app.core.deps import get_current_user
from app.models import Repertoire, TrainingCard, User
from app.schemas import (
    RepertoireCreate, RepertoireOut, TrainingAnswer, TrainingCardOut, TrainingResult,
)

router = APIRouter(tags=["training"])

MAX_CARDS_PER_REPERTOIRE = 2000
RETRY_MINUTES = 10


@router.post("/repertoires", response_model=RepertoireOut, status_code=status.HTTP_201_CREATED)
async def create_repertoire(
    payload: RepertoireCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cards = extract_repertoire(payload.pgn, payload.color)
    if not cards:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "empty_repertoire",
                "message": "No positions found. Paste a PGN containing moves "
                           "(variations in parentheses become branches).",
            },
        )
    if len(cards) > MAX_CARDS_PER_REPERTOIRE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "repertoire_too_large",
                "message": f"Repertoire has {len(cards)} positions; the limit is "
                           f"{MAX_CARDS_PER_REPERTOIRE}. Split it into chapters.",
            },
        )

    rep = Repertoire(user_id=user.id, name=payload.name, color=payload.color)
    db.add(rep)
    await db.flush()

    for c in cards:
        db.add(
            TrainingCard(
                repertoire_id=rep.id,
                user_id=user.id,
                zobrist=c["zobrist"],
                fen=c["fen"],
                expected_uci=c["expected_uci"],
                expected_san=c["expected_san"],
            )
        )
    await db.commit()
    return RepertoireOut(
        id=rep.id, name=rep.name, color=rep.color,
        card_count=len(cards), due_count=len(cards),
    )


@router.get("/repertoires", response_model=list[RepertoireOut])
async def list_repertoires(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    rows = await db.execute(
        select(
            Repertoire,
            func.count(TrainingCard.id),
            func.count(TrainingCard.id).filter(TrainingCard.due_at <= now),
        )
        .outerjoin(TrainingCard, TrainingCard.repertoire_id == Repertoire.id)
        .where(Repertoire.user_id == user.id)
        .group_by(Repertoire.id)
        .order_by(Repertoire.created_at.desc())
    )
    return [
        RepertoireOut(id=r.id, name=r.name, color=r.color, card_count=total, due_count=due)
        for r, total, due in rows.all()
    ]


@router.delete("/repertoires/{rep_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_repertoire(
    rep_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    rep = await db.get(Repertoire, rep_id)
    if rep is None or rep.user_id != user.id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Repertoire not found"})
    await db.delete(rep)
    await db.commit()


BLUNDER_REP_NAMES = {"white": "♞ My Blunders (White)", "black": "♞ My Blunders (Black)"}


@router.post("/training/blunders/sync")
async def sync_blunder_puzzles(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Turn every engine-tagged mistake (? / ??) in the user's analysed games
    into a training card: the position BEFORE the mistake, with the engine's
    best move as the expected answer. Cards land in auto-repertoires
    ("My Blunders (White/Black)") and flow through the normal SM-2 review
    queue. Re-running only adds new positions (dedupe on zobrist).
    """
    import io

    import chess.pgn

    from app.core.chess_utils import zobrist_of
    from app.models import Annotation, Game

    rows = await db.execute(
        select(Annotation.game_id, Annotation.ply, Annotation.best_uci, Game.movetext)
        .join(Game, Game.id == Annotation.game_id)
        .where(
            Annotation.user_id == user.id,
            Game.owner_id == user.id,
            Annotation.nag.in_([2, 4]),
            Annotation.best_uci.is_not(None),
        )
        .order_by(Annotation.game_id, Annotation.ply)
    )
    mistakes = rows.all()

    # Lazily create the two auto-repertoires on first use
    reps: dict[str, Repertoire] = {}

    async def rep_for(color: str) -> Repertoire:
        if color in reps:
            return reps[color]
        existing = await db.execute(
            select(Repertoire).where(
                Repertoire.user_id == user.id,
                Repertoire.name == BLUNDER_REP_NAMES[color],
            )
        )
        rep = existing.scalar_one_or_none()
        if rep is None:
            rep = Repertoire(user_id=user.id, name=BLUNDER_REP_NAMES[color], color=color)
            db.add(rep)
            await db.flush()
        reps[color] = rep
        return rep

    created = skipped = invalid = 0
    board_cache: dict[int, list] = {}  # game_id -> parsed move list

    for game_id, ply, best_uci, movetext in mistakes:
        if game_id not in board_cache:
            parsed = chess.pgn.read_game(io.StringIO(movetext))
            board_cache[game_id] = list(parsed.mainline_moves()) if parsed else []
        moves = board_cache[game_id]
        if ply > len(moves):
            invalid += 1
            continue

        board = chess.Board()
        for mv in moves[:ply]:
            board.push(mv)

        try:
            best = chess.Move.from_uci(best_uci)
            expected_san = board.san(best)
        except (ValueError, AssertionError):
            invalid += 1
            continue

        color = "white" if board.turn == chess.WHITE else "black"
        rep = await rep_for(color)
        zob = zobrist_of(board.fen())

        dup = await db.execute(
            select(TrainingCard.id).where(
                TrainingCard.repertoire_id == rep.id,
                TrainingCard.zobrist == zob,
            )
        )
        if dup.scalar_one_or_none() is not None:
            skipped += 1
            continue

        db.add(
            TrainingCard(
                repertoire_id=rep.id, user_id=user.id, zobrist=zob,
                fen=board.fen(), expected_uci=best.uci(), expected_san=expected_san,
            )
        )
        created += 1

    await db.commit()
    return {
        "mistakes_found": len(mistakes),
        "cards_created": created,
        "already_present": skipped,
        "invalid": invalid,
    }


@router.get("/training/due", response_model=list[TrainingCardOut])
async def due_cards(
    limit: int = Query(default=10, ge=1, le=50),
    repertoire: int | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    stmt = (
        select(TrainingCard, Repertoire.name, Repertoire.color)
        .join(Repertoire, Repertoire.id == TrainingCard.repertoire_id)
        .where(TrainingCard.user_id == user.id, TrainingCard.due_at <= now)
        .order_by(TrainingCard.due_at)
        .limit(limit)
    )
    if repertoire is not None:
        stmt = stmt.where(TrainingCard.repertoire_id == repertoire)

    rows = await db.execute(stmt)
    return [
        TrainingCardOut(
            id=c.id, repertoire_id=c.repertoire_id, repertoire_name=name,
            color=color, fen=c.fen, reps=c.reps, interval_days=c.interval_days,
        )
        for c, name, color in rows.all()
    ]


@router.post("/training/answer", response_model=TrainingResult)
async def answer_card(
    payload: TrainingAnswer,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    card = await db.get(TrainingCard, payload.card_id)
    if card is None or card.user_id != user.id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Card not found"})

    # Judge server-side. Accept the answer if it is the expected move; also
    # normalize e.g. missing promotion suffixes via chess.Move parsing.
    try:
        answered = chess.Move.from_uci(payload.answer_uci)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_move", "message": "Answer is not a UCI move"},
        )
    correct = answered.uci() == card.expected_uci

    now = datetime.now(timezone.utc)
    if correct:
        card.reps += 1
        card.ease = min(2.8, card.ease + 0.05)
        card.interval_days = 1.0 if card.reps == 1 else round(card.interval_days * card.ease, 1)
        card.due_at = now + timedelta(days=card.interval_days)
        next_days = card.interval_days
    else:
        card.lapses += 1
        card.reps = 0
        card.ease = max(1.3, card.ease - 0.2)
        card.interval_days = 0.0
        card.due_at = now + timedelta(minutes=RETRY_MINUTES)
        next_days = RETRY_MINUTES / 1440

    await db.commit()
    return TrainingResult(
        correct=correct,
        expected_uci=card.expected_uci,
        expected_san=card.expected_san,
        next_due_days=next_days,
    )
