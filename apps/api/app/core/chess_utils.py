"""Chess helpers shared by API routers. Mirrors logic in services/engine."""

from __future__ import annotations

import io
import re

import chess
import chess.pgn
import chess.polyglot

MAX_INDEXED_PLY = 40  # BLUEPRINT 7.4: cap position index size


def zobrist_of(fen: str) -> int:
    """Polyglot zobrist as a SIGNED 64-bit int (Postgres BIGINT compatible)."""
    board = chess.Board(fen)
    unsigned = chess.polyglot.zobrist_hash(board)
    return unsigned - (1 << 64) if unsigned >= (1 << 63) else unsigned


def validate_fen(fen: str) -> chess.Board:
    """Raise ValueError if the FEN is malformed or the position is illegal."""
    board = chess.Board(fen)  # raises ValueError on bad FEN
    if not board.is_valid():
        raise ValueError("Position is not legal")
    return board


def _normalize_headers(pgn_text: str) -> str:
    """Repair PGNs pasted from web pages where header tags lost their
    newlines: [White "A"] [Black "B"] -> one tag per line, per the spec.
    The pattern only matches directly-adjacent tag brackets, so movetext
    comments like {[%clk 0:03]} are untouched."""
    return re.sub(r'\]\s*\[', ']\n[', pgn_text)


def parse_pgn(pgn_text: str) -> list[dict]:
    """
    Parse one or more games from PGN text into dicts ready for insertion.
    Returns [] rather than raising on unparseable input.
    """
    games: list[dict] = []
    stream = io.StringIO(_normalize_headers(pgn_text))

    while True:
        try:
            game = chess.pgn.read_game(stream)
        except Exception:
            break
        if game is None:
            break

        headers = game.headers
        moves = list(game.mainline_moves())

        # python-chess yields an empty Game object for junk input rather than
        # None. A real game has at least one move; anything else is not a game.
        if not moves:
            continue

        exporter = chess.pgn.StringExporter(headers=False, variations=True, comments=True)
        movetext = game.accept(exporter).strip()

        games.append(
            {
                "white": headers.get("White", "")[:200],
                "black": headers.get("Black", "")[:200],
                "white_elo": _safe_int(headers.get("WhiteElo")),
                "black_elo": _safe_int(headers.get("BlackElo")),
                "result": _safe_result(headers.get("Result", "*")),
                "event": headers.get("Event", "")[:300],
                "site": headers.get("Site", "")[:300],
                "played_on": _safe_date(headers.get("Date")),
                "eco": (headers.get("ECO") or None),
                "opening": headers.get("Opening") or None,
                "ply_count": len(moves),
                "movetext": movetext,
            }
        )

    return games


def positions_of_game(movetext: str, max_ply: int = MAX_INDEXED_PLY) -> list[tuple[int, int, str]]:
    """
    Replay a game and return (ply, zobrist, move_uci) for the position index.
    The zobrist is of the position BEFORE the move is played.
    """
    out: list[tuple[int, int, str]] = []
    game = chess.pgn.read_game(io.StringIO(movetext))
    if game is None:
        return out

    board = game.board()
    for ply, move in enumerate(game.mainline_moves()):
        if ply >= max_ply:
            break
        out.append((ply, zobrist_of(board.fen()), move.uci()))
        board.push(move)
    return out


def extract_repertoire(pgn_text: str, color: str) -> list[dict]:
    """
    Walk a PGN (variations included) and produce training cards for one color.

    Semantics of a repertoire:
    - At OUR turn, the FIRST variation is the repertoire move -> one card.
      Sidelines for our own color are ignored (a repertoire is one choice).
    - At the OPPONENT's turn, EVERY variation is a reply we must be ready
      for, so all branches are expanded.
    - Transpositions dedupe on zobrist: one card per position.

    Returns [{fen, zobrist, expected_uci, expected_san}, ...]
    """
    want_white = color == "white"
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        return []

    cards: dict[int, dict] = {}

    def walk(node: chess.pgn.GameNode, board: chess.Board) -> None:
        our_turn = board.turn == (chess.WHITE if want_white else chess.BLACK)
        variations = node.variations
        if not variations:
            return

        if our_turn:
            child = variations[0]  # the repertoire's chosen move
            key = zobrist_of(board.fen())
            if key not in cards:
                cards[key] = {
                    "fen": board.fen(),
                    "zobrist": key,
                    "expected_uci": child.move.uci(),
                    "expected_san": board.san(child.move),
                }
            board.push(child.move)
            walk(child, board)
            board.pop()
        else:
            for child in variations:  # every opponent reply we cover
                board.push(child.move)
                walk(child, board)
                board.pop()

    walk(game, game.board())
    return list(cards.values())


def _safe_int(value) -> int | None:
    try:
        n = int(value)
        return n if 0 < n < 4000 else None
    except (TypeError, ValueError):
        return None


def _safe_result(value: str) -> str:
    return value if value in {"1-0", "0-1", "1/2-1/2", "*"} else "*"


def _safe_date(value):
    if not value:
        return None
    parts = value.split(".")
    if len(parts) != 3:
        return None
    try:
        y, m, d = (int(p) for p in parts)
        if y < 1475 or not (1 <= m <= 12) or not (1 <= d <= 31):
            return None
        from datetime import date
        return date(y, m, d)
    except ValueError:
        return None
