#!/usr/bin/env python3
"""
Populate the reference database from real Lichess games via the public API,
without downloading a multi-GB monthly dump (see SCALABILITY note: the host
has limited disk). Strategy:

  1. Ask Lichess for the top-rated players in blitz / rapid / classical
     (GET /api/player/top/{n}/{perf}).
  2. Stream each player's rated games (GET /api/games/user/{u}, PGN).
  3. Filter to standard chess with at least one side >= --min-elo, insert as
     reference games (owner_id NULL), index positions, dedupe on game URL.
  4. Rebuild opening_tree so the explorer + position search light up.

All games are CC0-licensed Lichess data (BLUEPRINT Section 10). Example:

    pip install chess httpx "psycopg[binary]"
    python pipeline/load_lichess_api.py \
        --players-per-perf 80 --max-games-per-player 300 --min-elo 2200 \
        --dsn postgresql://chessrabbit:devpassword@localhost:5432/chessrabbit

Polite by construction: one stream at a time, a short pause between players,
and exponential backoff on HTTP 429. Resumable — games already stored (by URL)
are skipped, so re-running only adds what is new.
"""

from __future__ import annotations

import argparse
import io
import sys
import time

import chess
import chess.pgn
import chess.polyglot
import httpx
import psycopg

MAX_INDEXED_PLY = 40
BATCH = 500
PERFS = ("blitz", "rapid", "classical")
HEADERS = {"User-Agent": "ChessRabbit/0.1 reference-loader (noreply@chessrabbit.app)"}


def zobrist_signed(board: chess.Board) -> int:
    u = chess.polyglot.zobrist_hash(board)
    return u - (1 << 64) if u >= (1 << 63) else u


def top_players(client: httpx.Client, per_perf: int) -> list[str]:
    """Union of the top `per_perf` usernames across the three main time controls."""
    names: dict[str, None] = {}  # dict preserves insertion order, dedupes
    for perf in PERFS:
        try:
            res = client.get(f"https://lichess.org/api/player/top/{per_perf}/{perf}")
            res.raise_for_status()
        except httpx.HTTPError as exc:
            print(f"  ! could not fetch top {perf}: {exc}")
            continue
        for user in res.json().get("users", []):
            name = user.get("username") or user.get("id")
            if name:
                names.setdefault(name, None)
    return list(names)


def fetch_player_pgn(client: httpx.Client, username: str, max_games: int) -> str | None:
    """Return a player's rated standard games as PGN text, or None on failure."""
    params = {
        "max": max_games,
        "rated": "true",
        "perfType": ",".join(PERFS),
        "moves": "true",
        "tags": "true",
        "opening": "true",
        "clocks": "false",
        "evals": "false",
    }
    backoff = 5.0
    for attempt in range(4):
        try:
            res = client.get(
                f"https://lichess.org/api/games/user/{username}",
                params=params,
                headers={"Accept": "application/x-chess-pgn"},
            )
        except httpx.HTTPError as exc:
            print(f"  ! {username}: {exc.__class__.__name__}")
            return None
        if res.status_code == 429:
            print(f"  … rate limited, backing off {backoff:.0f}s")
            time.sleep(backoff)
            backoff *= 2
            continue
        if res.status_code == 404:
            return None
        if res.status_code != 200:
            print(f"  ! {username}: HTTP {res.status_code}")
            return None
        return res.text
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", default="postgresql://chessrabbit:devpassword@localhost:5432/chessrabbit")
    ap.add_argument("--min-elo", type=int, default=2200)
    ap.add_argument("--players-per-perf", type=int, default=80)
    ap.add_argument("--max-games-per-player", type=int, default=300)
    ap.add_argument("--pause", type=float, default=1.0, help="seconds between players")
    args = ap.parse_args()

    conn = psycopg.connect(args.dsn)

    # Resume support: never insert a reference game we already have.
    with conn.cursor() as cur:
        cur.execute("SELECT site FROM games WHERE owner_id IS NULL AND site <> ''")
        seen: set[str] = {row[0] for row in cur.fetchall()}
    print(f"{len(seen)} reference games already present")

    client = httpx.Client(headers=HEADERS, timeout=httpx.Timeout(30.0, read=120.0),
                          follow_redirects=True)

    players = top_players(client, args.players_per_perf)
    print(f"Fetched {len(players)} unique top players across {', '.join(PERFS)}")

    inserted = skipped = 0
    t0 = time.time()
    game_rows: list[tuple] = []
    pos_rows: list[list[tuple]] = []

    def flush() -> None:
        nonlocal game_rows, pos_rows
        if not game_rows:
            return
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO games
                  (owner_id, source, external_id, white, black, white_elo, black_elo,
                   result, event, site, played_on, eco, opening, ply_count, movetext)
                VALUES (NULL, 'lichess', %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
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
            flat = []
            for gid, positions in zip(ids, pos_rows):
                for ply, zob, uci in positions:
                    flat.append((gid, ply, zob, uci))
            if flat:
                cur.executemany(
                    "INSERT INTO game_positions (game_id, ply, zobrist, move_uci) "
                    "VALUES (%s,%s,%s,%s)",
                    flat,
                )
        conn.commit()
        game_rows, pos_rows = [], []

    for pi, username in enumerate(players, 1):
        pgn_text = fetch_player_pgn(client, username, args.max_games_per_player)
        if not pgn_text:
            continue
        stream = io.StringIO(pgn_text)

        while True:
            try:
                game = chess.pgn.read_game(stream)
            except Exception:
                break
            if game is None:
                break

            h = game.headers
            if h.get("Variant", "Standard") not in ("Standard", "From Position"):
                skipped += 1
                continue

            site = h.get("Site", "")
            if site and site in seen:
                skipped += 1
                continue

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
                site or None,
                h.get("White", "")[:200], h.get("Black", "")[:200],
                welo or None, belo or None,
                h.get("Result", "*"), h.get("Event", "")[:300], site[:300],
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
            if site:
                seen.add(site)

            inserted += 1
            if len(game_rows) >= BATCH:
                flush()

        rate = inserted / max(1e-9, time.time() - t0)
        print(f"\r[{pi}/{len(players)}] {username:<20} "
              f"{inserted:>7} games ({rate:.0f}/s, {skipped} skipped)", end="", flush=True)
        time.sleep(args.pause)

    flush()
    print(f"\nInserted {inserted} games, skipped {skipped}, in {time.time()-t0:.0f}s")

    print("Building opening_tree from game_positions…")
    with conn.cursor() as cur:
        cur.execute("TRUNCATE opening_tree")
        cur.execute(
            """
            INSERT INTO opening_tree
              (zobrist, move_uci, games, white_wins, draws, black_wins, avg_elo)
            SELECT p.zobrist, p.move_uci, COUNT(*),
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
    sys.exit(main())
