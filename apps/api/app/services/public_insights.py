"""
Insights for a player who is not the caller.

Same questions as `insights.py` ("how does this player play?"), different
source and a smaller answer. Two things drive the differences:

1. The games are not ours. Online games are fetched from Lichess/Chess.com on
   demand and never persisted - a stranger's history is not worth the storage,
   and `prep.py` already established that pattern. Over-the-board games come
   from the reference database (`games.owner_id IS NULL`), matched by name.

2. There are no engine annotations, so anything derived from an eval curve -
   accuracy, move classifications, game shape - cannot be computed. Reviewing
   a career's worth of games per lookup would cost more engine time than the
   whole rest of the product. Those sections are omitted and the response says
   so via `engine_metrics: false`, rather than rendering zeroes that read as
   "this player is bad".

Everything reachable from the moves alone IS computed: results, openings,
terminations, opponent strength, calendar, plus piece usage, castling and
which phase games ended in, all from replaying the PGN.
"""

from __future__ import annotations

import io
import logging
from collections import Counter, defaultdict
from datetime import date
from typing import Any, Iterable

import chess
import chess.pgn
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.openings import normalize_eco, opening_label
from app.services.insights import (
    DAY_LABELS, MAX_OPENING_ROWS, MIN_OPENING_GAMES, PIECE_NAMES, Filters,
    _Tally, _phase_of, outcome_for,
)

log = logging.getLogger(__name__)

# Replaying is the expensive half. Bounded so one lookup cannot pin a worker.
REPLAY_LIMIT = 300

# How many OTB games we pull for a player. Reference dumps hold whole careers.
OTB_LIMIT = 1000


def colour_of(game: dict, player: str) -> str | None:
    """Which side `player` had, or None when the name does not appear."""
    needle = player.strip().lower()
    if (game.get("white") or "").strip().lower() == needle:
        return "w"
    if (game.get("black") or "").strip().lower() == needle:
        return "b"
    return None


def _passes(game: dict, colour: str, filters: Filters) -> bool:
    if filters.color and colour != filters.color:
        return False
    if filters.time_class and game.get("time_class") != filters.time_class:
        return False
    if filters.since:
        played = game.get("played_on")
        if played is None or played < filters.since:
            return False
    return True


async def otb_games(db: AsyncSession, player: str, limit: int = OTB_LIMIT) -> list[dict]:
    """
    Over-the-board games from the reference database.

    Matched on an exact lower(name) equality so the partial index on
    `lower(white)`/`lower(black)` (migration 001, WHERE owner_id IS NULL) can
    serve it. Reference PGNs use "Lastname, Firstname", which is why the UI
    offers a name picker rather than free text.
    """
    rows = await db.execute(
        text(
            """
            SELECT white, black, white_elo, black_elo, result, event,
                   played_on, eco, opening, ply_count, movetext, termination,
                   time_class, played_at
            FROM games
            WHERE owner_id IS NULL
              AND (lower(white) = :name OR lower(black) = :name)
            ORDER BY played_on DESC NULLS LAST
            LIMIT :lim
            """
        ),
        {"name": player.strip().lower(), "lim": limit},
    )
    return [dict(r) for r in rows.mappings()]


async def otb_name_matches(db: AsyncSession, query: str, limit: int = 10) -> list[dict]:
    """Reference-database players whose name contains `query`, commonest first."""
    rows = await db.execute(
        text(
            """
            SELECT name, count(*) AS games FROM (
                SELECT white AS name FROM games
                WHERE owner_id IS NULL AND lower(white) LIKE :q
                UNION ALL
                SELECT black AS name FROM games
                WHERE owner_id IS NULL AND lower(black) LIKE :q
            ) t
            WHERE name <> ''
            GROUP BY name
            ORDER BY games DESC
            LIMIT :lim
            """
        ),
        {"q": f"%{query.strip().lower()}%", "lim": limit},
    )
    return [{"name": r["name"], "games": r["games"]} for r in rows.mappings()]


def _month(game: dict) -> str | None:
    played = game.get("played_on")
    return played.strftime("%Y-%m") if isinstance(played, date) else None


def _slot(hour: int) -> str:
    if hour < 6:
        return "night"
    if hour < 12:
        return "morning"
    if hour < 18:
        return "afternoon"
    return "evening"


def _replay(game: dict, colour: str) -> dict[str, Any] | None:
    """
    Board-only facts about one game: which pieces the player moved, whether and
    when they castled, and the phase the game ended in. No evals involved.
    """
    movetext = game.get("movetext") or ""
    if not movetext:
        return None
    try:
        parsed = chess.pgn.read_game(io.StringIO(movetext))
    except Exception:
        return None
    if parsed is None:
        return None

    board = parsed.board()
    white = colour == "w"
    pieces: dict[str, int] = defaultdict(int)
    castled: tuple[str, str] | None = None
    last_phase = "opening"

    try:
        for ply, move in enumerate(parsed.mainline_moves()):
            phase = _phase_of(board, ply)
            last_phase = phase
            if (ply % 2 == 0) == white:
                piece = board.piece_at(move.from_square)
                name = PIECE_NAMES.get(piece.piece_type) if piece else None
                if board.is_castling(move):
                    castled = (
                        phase, "short" if board.is_kingside_castling(move) else "long"
                    )
                if name:
                    pieces[name] += 1
            board.push(move)
    except Exception:  # a malformed PGN must not sink the whole request
        return None

    return {"pieces": pieces, "castled": castled, "ended_in": last_phase}


def build_public_insights(
    games: Iterable[dict], player: str, source: str, filters: Filters
) -> dict:
    """Aggregate one player's games into the Insights page's response shape."""
    overall = _Tally()
    by_month: dict[str, int] = defaultdict(int)
    opponents: dict[int, _Tally] = defaultdict(_Tally)
    terminations: dict[str, dict[str, int]] = {
        "win": defaultdict(int), "draw": defaultdict(int), "loss": defaultdict(int),
    }
    openings: dict[str, dict[str, Any]] = {}
    slots: dict[str, _Tally] = defaultdict(_Tally)
    dows: dict[int, _Tally] = defaultdict(_Tally)
    ended_in: dict[str, int] = defaultdict(int)
    piece_moves: dict[str, int] = defaultdict(int)
    castle_phase: dict[str, int] = defaultdict(int)
    castle_side: dict[str, int] = defaultdict(int)

    considered = 0
    unattributed = 0
    replayed = 0

    for game in games:
        colour = colour_of(game, player)
        if colour is None:
            unattributed += 1
            continue
        # An unfinished game has no outcome to learn from, and counting it
        # would make wins + draws + losses disagree with the total.
        if game.get("result") not in ("1-0", "0-1", "1/2-1/2"):
            continue
        if not _passes(game, colour, filters):
            continue

        considered += 1
        outcome = outcome_for(game["result"], colour)
        overall.add(outcome)

        month = _month(game)
        if month:
            by_month[month] += 1

        opp_elo = game.get("black_elo") if colour == "w" else game.get("white_elo")
        if opp_elo:
            opponents[(int(opp_elo) // 200) * 200].add(outcome)

        terminations[outcome][game.get("termination") or "other"] += 1

        # Chess.com PGNs carry an ECO code but no Opening name, so the code has
        # to name the row. A bare "C50" told a reader nothing; the family does.
        name = opening_label(game.get("opening"), game.get("eco"))
        key = f"{colour}:{name}"
        row = openings.setdefault(
            key, {"colour": colour, "name": name, "codes": Counter(),
                  "games": 0, "wins": 0, "draws": 0}
        )
        code = normalize_eco(game.get("eco"))
        if code:
            row["codes"][code] += 1
        row["games"] += 1
        if outcome == "win":
            row["wins"] += 1
        elif outcome == "draw":
            row["draws"] += 1

        played_at = game.get("played_at")
        if played_at is not None:
            # Stored UTC; the slots only mean anything in the reader's clock.
            hour = (played_at.hour + filters.tz_offset // 60) % 24
            slots[_slot(hour)].add(outcome)
        played_on = game.get("played_on")
        if isinstance(played_on, date):
            dows[(played_on.weekday() + 1) % 7].add(outcome)

        if replayed < REPLAY_LIMIT:
            replayed += 1
            board_facts = _replay(game, colour)
            if board_facts:
                ended_in[board_facts["ended_in"]] += 1
                for piece, n in board_facts["pieces"].items():
                    piece_moves[piece] += n
                if board_facts["castled"]:
                    castle_phase[board_facts["castled"][0]] += 1
                    castle_side[board_facts["castled"][1]] += 1
                else:
                    castle_phase["none"] += 1

    def opening_rows(colour: str) -> list[dict]:
        rows = [
            r for r in openings.values()
            if r["colour"] == colour and r["games"] >= MIN_OPENING_GAMES
        ]
        rows.sort(key=lambda r: (-r["games"], r["name"]))
        return [
            {"name": r["name"],
             # The code most of the row is made of; a named opening can span
             # several, and the commonest is the honest one to show.
             "eco": r["codes"].most_common(1)[0][0] if r["codes"] else None,
             "games": r["games"], "wins": r["wins"], "draws": r["draws"],
             "losses": r["games"] - r["wins"] - r["draws"]}
            for r in rows[:MAX_OPENING_ROWS]
        ]

    return {
        "filters": filters.as_dict(),
        "player": player,
        "source": source,
        # Tells the page to hide the eval-derived sections rather than draw
        # them empty. See this module's docstring.
        "engine_metrics": False,
        "games": overall.games,
        "reviewed": 0,
        "unattributed": unattributed,
        "replay_limit": REPLAY_LIMIT,
        "replayed": replayed,
        "overview": {
            "played": overall.games,
            "wins": overall.wins,
            "draws": overall.draws,
            "losses": overall.losses,
            "by_month": [
                {"label": m, "games": n} for m, n in sorted(by_month.items())
            ],
            "accuracy": {},
            "accuracy_by_move": [],
            "by_opponent_rating": [
                {"bucket": b, "games": t.games, "wins": t.wins,
                 "draws": t.draws, "losses": t.losses}
                for b, t in sorted(opponents.items())
            ],
        },
        "results": {
            "won_by": [{"reason": k, "games": v}
                       for k, v in sorted(terminations["win"].items(),
                                          key=lambda kv: -kv[1])],
            "drew_by": [{"reason": k, "games": v}
                        for k, v in sorted(terminations["draw"].items(),
                                           key=lambda kv: -kv[1])],
            "lost_by": [{"reason": k, "games": v}
                        for k, v in sorted(terminations["loss"].items(),
                                           key=lambda kv: -kv[1])],
        },
        "phases": {"ended_in": dict(ended_in), "accuracy": {}, "results": {}},
        "shapes": {},
        "openings": {"white": opening_rows("w"), "black": opening_rows("b")},
        "moves": {
            "quality": [],
            "quality_by_month": {},
            "pieces": [
                {"piece": p, "moves": piece_moves[p], "accuracy": None}
                for p in ("pawn", "knight", "bishop", "rook", "queen", "king")
                if piece_moves[p]
            ],
            "castling": {
                "phase": dict(castle_phase),
                "side": dict(castle_side),
                "results": {},
            },
        },
        "calendar": {
            "time_of_day": [
                {"slot": s, "games": t.games, "wins": t.wins,
                 "draws": t.draws, "losses": t.losses}
                for s, t in slots.items()
            ],
            "day_of_week": [
                {"day": DAY_LABELS[d], "games": t.games, "wins": t.wins,
                 "draws": t.draws, "losses": t.losses}
                for d, t in sorted(dows.items())
            ],
        },
    }
