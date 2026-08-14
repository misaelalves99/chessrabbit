"""
Opponent preparation (Master tier).

Point it at an opponent's chess.com or Lichess account and it fetches their
recent games, breaks down the openings they actually play with each colour,
and can build a counter-repertoire: their most-played lines, with your
replies taken from the master reference database (52k+ strong games) - i.e.
how professionals answer exactly what your opponent likes to play.
"""

from __future__ import annotations

import io
from collections import Counter

import chess
import chess.pgn
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.bulk import bulk_insert
from app.core.chess_utils import zobrist_of
from app.core.db import get_db
from app.core.deps import require_master
from app.core.ratelimit import user_rate_limit
from app.models import Repertoire, TrainingCard, User
from app.schemas import (
    PrepDossier, PrepLine, PrepRepertoireIn, PrepRequest, RepertoireOut,
)
from app.services.importers import PlatformError, fetch_games

router = APIRouter(prefix="/prep", tags=["prep"])

MAX_GAMES = 200        # opponent games to analyse
LINE_PLIES = 6         # opening line granularity for grouping (3 full moves)
TOP_LINES = 5
PREP_MAX_PLIES = 12    # how deep the counter-repertoire follows each line


def _san_line(movetext: str, plies: int) -> list[str]:
    game = chess.pgn.read_game(io.StringIO(movetext))
    if game is None:
        return []
    board = game.board()
    sans: list[str] = []
    for mv in game.mainline_moves():
        if len(sans) >= plies:
            break
        sans.append(board.san(mv))
        board.push(mv)
    return sans


async def _fetch_opponent(platform: str, username: str) -> list[dict]:
    if platform not in ("lichess", "chesscom"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "bad_platform", "message": "platform must be lichess or chesscom"},
        )
    try:
        entries = await fetch_games(platform, username, since=None, max_games=MAX_GAMES)
    except PlatformError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "platform_error", "message": str(exc)},
        )
    return [parsed for parsed, _ in entries]


def _aggregate(games: list[dict], username: str) -> tuple[dict, dict]:
    """Group the opponent's games by their opening line, per colour they played."""
    uname = username.lower()
    lines: dict[str, dict[tuple, dict]] = {"white": {}, "black": {}}

    for g in games:
        white = (g.get("white") or "").lower()
        color = "white" if white == uname else "black"
        sans = _san_line(g["movetext"], LINE_PLIES)
        if len(sans) < 2:
            continue
        key = tuple(sans)
        bucket = lines[color].setdefault(key, {"count": 0, "w": 0, "d": 0, "l": 0})
        bucket["count"] += 1
        result = g.get("result", "*")
        won = (result == "1-0") if color == "white" else (result == "0-1")
        lost = (result == "0-1") if color == "white" else (result == "1-0")
        if won:
            bucket["w"] += 1
        elif lost:
            bucket["l"] += 1
        elif result == "1/2-1/2":
            bucket["d"] += 1

    def top(color: str) -> list[PrepLine]:
        ranked = sorted(lines[color].items(), key=lambda kv: -kv[1]["count"])
        return [
            PrepLine(moves=list(k), count=v["count"],
                     wins=v["w"], draws=v["d"], losses=v["l"])
            for k, v in ranked[:TOP_LINES]
        ]

    return top("white"), top("black")


# Each call pulls up to 200 games from Lichess/Chess.com. Their rate limits are
# shared across our whole deployment, so one account must not be able to spend
# everyone else's budget.
@router.post(
    "/opponent",
    response_model=PrepDossier,
    dependencies=[user_rate_limit("prep_dossier", 10, 60)],
)
async def opponent_dossier(
    payload: PrepRequest,
    user: User = Depends(require_master),
):
    """What does this opponent actually play? Their top lines with each colour."""
    games = await _fetch_opponent(payload.platform, payload.username)
    if not games:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "no_games", "message": "No recent games found for that account"},
        )
    as_white, as_black = _aggregate(games, payload.username)
    return PrepDossier(
        username=payload.username,
        platform=payload.platform,
        games_analyzed=len(games),
        as_white=as_white,
        as_black=as_black,
    )


async def _master_reply(db: AsyncSession, fen: str) -> str | None:
    """The most-played master move in this position, from the reference DB."""
    row = await db.execute(
        text("SELECT move_uci FROM opening_tree WHERE zobrist = :z "
             "ORDER BY games DESC LIMIT 1"),
        {"z": zobrist_of(fen)},
    )
    return row.scalar_one_or_none()


@router.post("/opponent/repertoire", response_model=RepertoireOut,
             status_code=status.HTTP_201_CREATED,
             dependencies=[user_rate_limit("prep_repertoire", 5, 60)])
async def build_prep_repertoire(
    payload: PrepRepertoireIn,
    user: User = Depends(require_master),
    db: AsyncSession = Depends(get_db),
):
    """
    Build a drillable counter-repertoire against this opponent.

    Follows each of their most-played lines as the colour they'd have against
    you; at every one of YOUR turns the expected move is the most popular
    master continuation from the reference database.
    """
    games = await _fetch_opponent(payload.platform, payload.username)
    if not games:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "no_games", "message": "No recent games found for that account"},
        )

    opp_color = "black" if payload.my_color == "white" else "white"
    my_white = payload.my_color == "white"
    opp_white = not my_white

    # Position-keyed map of the opponent's habits: every position they have
    # faced (as the relevant colour) -> what they played there, how often.
    # Position-keyed, not sequence-keyed, so it survives our own moves
    # diverging from whatever their past opponents happened to play.
    posmap: dict[int, Counter] = {}
    uname = payload.username.lower()
    for g in games:
        white_name = (g.get("white") or "").lower()
        their_color = "white" if white_name == uname else "black"
        if their_color != opp_color:
            continue
        parsed = chess.pgn.read_game(io.StringIO(g["movetext"]))
        if parsed is None:
            continue
        board = parsed.board()
        for i, mv in enumerate(parsed.mainline_moves()):
            if i >= 16:
                break
            if board.turn == (chess.WHITE if opp_white else chess.BLACK):
                posmap.setdefault(zobrist_of(board.fen()), Counter())[board.san(mv)] += 1
            board.push(mv)

    if not posmap:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "no_lines", "message": f"No games where they played {opp_color}"},
        )

    cards: dict[int, dict] = {}

    async def walk(board: chess.Board, depth: int) -> None:
        if depth >= PREP_MAX_PLIES or len(cards) >= 200:
            return
        my_turn = board.turn == (chess.WHITE if my_white else chess.BLACK)
        if my_turn:
            reply = await _master_reply(db, board.fen())
            if reply is None:
                return
            try:
                mv = chess.Move.from_uci(reply)
                san = board.san(mv)
            except (ValueError, AssertionError):
                return
            key = zobrist_of(board.fen())
            if key not in cards:
                cards[key] = {
                    "fen": board.fen(), "zobrist": key,
                    "expected_uci": mv.uci(), "expected_san": san,
                }
            board.push(mv)
            await walk(board, depth + 1)
            board.pop()
        else:
            counter = posmap.get(zobrist_of(board.fen()))
            if not counter:
                return
            # Cover their two most common choices in this position.
            for san, _count in counter.most_common(2):
                try:
                    mv = board.parse_san(san)
                except ValueError:
                    continue
                board.push(mv)
                await walk(board, depth + 1)
                board.pop()

    await walk(chess.Board(), 0)

    if not cards:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "no_prep", "message": "Could not build a prep line from their games"},
        )

    rep = Repertoire(
        user_id=user.id,
        name=f"🎯 Prep vs {payload.username}",
        color=payload.my_color,
    )
    db.add(rep)
    await db.flush()
    await bulk_insert(
        db,
        TrainingCard,
        [
            {
                "repertoire_id": rep.id, "user_id": user.id,
                "zobrist": c["zobrist"], "fen": c["fen"],
                "expected_uci": c["expected_uci"], "expected_san": c["expected_san"],
            }
            for c in cards.values()
        ],
        ignore_conflicts=True,
    )
    await db.commit()
    return RepertoireOut(
        id=rep.id, name=rep.name, color=rep.color,
        card_count=len(cards), due_count=len(cards),
    )
