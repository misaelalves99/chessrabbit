#!/usr/bin/env python3
"""
Load reference games into the public database and build the opening tree.

Implements BLUEPRINT.md Section 10. Source data: the Lichess open database
(https://database.lichess.org, CC0). Download a monthly .pgn.zst, then:

    pip install chess psycopg[binary] zstandard
    python load_reference_games.py lichess_db_standard_rated_2024-01.pgn.zst \
        --min-elo 2200 --max-games 200000 \
        --dsn postgresql://chessrabbit:devpassword@localhost:5432/chessrabbit

Filtering to >=2200 Elo keeps the explorer statistics meaningful and the
database small enough for a single Postgres node.
"""

from __future__ import annotations

import argparse
import io
import sys
import time

import chess
import chess.pgn
import chess.polyglot
import psycopg

MAX_INDEXED_PLY = 40
BATCH = 500


def zobrist_signed(board: chess.Board) -> int:
    u = chess.polyglot.zobrist_hash(board)
    return u - (1 << 64) if u >= (1 << 63) else u


def open_pgn_stream(path: str):
    """Yield a text stream for .pgn or .pgn.zst files."""
    if path.endswith(".zst"):
        try:
            import zstandard
        except ImportError:
            sys.exit("pip install zstandard to read .zst files")
        fh = open(path, "rb")
        reader = zstandard.ZstdDecompressor().stream_reader(fh)
        return io.TextIOWrapper(reader, encoding="utf-8", errors="replace")
    return open(path, encoding="utf-8", errors="replace")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pgn_file")
    ap.add_argument("--dsn", default="postgresql://chessrabbit:devpassword@localhost:5432/chessrabbit")
    ap.add_argument("--min-elo", type=int, default=2200)
    ap.add_argument("--max-games", type=int, default=100_000)
    args = ap.parse_args()

    conn = psycopg.connect(args.dsn)
    stream = open_pgn_stream(args.pgn_file)

    inserted = skipped = 0
    t0 = time.time()
    game_rows: list[tuple] = []
    pos_rows: list[tuple] = []

    def flush() -> None:
        nonlocal game_rows, pos_rows
        if not game_rows:
            return
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO games
                  (owner_id, source, white, black, white_elo, black_elo,
                   result, event, site, played_on, eco, opening, ply_count, movetext)
                VALUES (NULL, 'lichess', %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
                """,
                game_rows,
                returning=True,
            )
            ids = []
            while True:
                ids.append(cur.fetchone()[0])
                if not cur.nextset():
                    break

            # Attach the buffered positions to their new game ids
            flat = []
            for gid, positions in zip(ids, pos_rows):
                for ply, zob, uci in positions:
                    flat.append((gid, ply, zob, uci))
            if flat:
                cur.executemany(
                    "INSERT INTO game_positions (game_id, ply, zobrist, move_uci) VALUES (%s,%s,%s,%s)",
                    flat,
                )
        conn.commit()
        game_rows, pos_rows = [], []

    while inserted < args.max_games:
        game = chess.pgn.read_game(stream)
        if game is None:
            break

        h = game.headers
        try:
            welo = int(h.get("WhiteElo", 0))
            belo = int(h.get("BlackElo", 0))
        except ValueError:
            welo = belo = 0

        if max(welo, belo) < args.min_elo:
            skipped += 1
            continue

        moves = list(game.mainline_moves())
        if len(moves) < 6:
            skipped += 1
            continue

        exporter = chess.pgn.StringExporter(headers=False, variations=False, comments=False)
        movetext = game.accept(exporter).strip()

        played_on = None
        date_raw = h.get("UTCDate") or h.get("Date") or ""
        parts = date_raw.split(".")
        if len(parts) == 3 and parts[0].isdigit():
            played_on = f"{parts[0]}-{parts[1]}-{parts[2]}"

        game_rows.append((
            h.get("White", "")[:200], h.get("Black", "")[:200],
            welo or None, belo or None,
            h.get("Result", "*"), h.get("Event", "")[:300], h.get("Site", "")[:300],
            played_on, (h.get("ECO") or None), h.get("Opening") or None,
            len(moves), movetext,
        ))

        board = game.board()
        positions = []
        for ply, mv in enumerate(moves):
            if ply >= MAX_INDEXED_PLY:
                break
            positions.append((ply, zobrist_signed(board), mv.uci()))
            board.push(mv)
        pos_rows.append(positions)

        inserted += 1
        if len(game_rows) >= BATCH:
            flush()
            rate = inserted / (time.time() - t0)
            print(f"\r{inserted:>8} games ({rate:.0f}/s, {skipped} skipped)", end="", flush=True)

    flush()
    print(f"\nInserted {inserted} games, skipped {skipped}, in {time.time()-t0:.0f}s")

    print("Building opening_tree from game_positions (this can take a few minutes)…")
    with conn.cursor() as cur:
        cur.execute("TRUNCATE opening_tree")
        cur.execute(
            """
            INSERT INTO opening_tree
              (zobrist, move_uci, games, white_wins, draws, black_wins, avg_elo)
            SELECT p.zobrist,
                   p.move_uci,
                   COUNT(*),
                   COUNT(*) FILTER (WHERE g.result = '1-0'),
                   COUNT(*) FILTER (WHERE g.result = '1/2-1/2'),
                   COUNT(*) FILTER (WHERE g.result = '0-1'),
                   AVG(GREATEST(g.white_elo, g.black_elo))::smallint
            FROM game_positions p
            JOIN games g ON g.id = p.game_id
            WHERE g.owner_id IS NULL
            GROUP BY p.zobrist, p.move_uci
            """
        )
        print(f"opening_tree rows: {cur.rowcount}")
    conn.commit()
    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
