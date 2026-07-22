#!/usr/bin/env python3
"""
Load tactics puzzles from the Lichess open puzzle database (CC0) into Postgres.

Streams https://database.lichess.org/lichess_db_puzzle.csv.zst, decompressing on
the fly and stopping as soon as enough puzzles pass the filters - so it never
downloads the whole ~250MB file or needs disk for it. Columns (Lichess CSV):

    PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,
    GameUrl,OpeningTags

Example:

    pip install httpx zstandard "psycopg[binary]"
    python pipeline/load_puzzles.py --max 30000 --min-rating 600 --max-rating 2400 \
        --dsn postgresql://chessrabbit:devpassword@localhost:5432/chessrabbit

Resumable: ON CONFLICT (lichess_id) DO NOTHING, so re-running only adds new rows.
"""

from __future__ import annotations

import argparse
import csv
import io
import sys
import time

import httpx
import psycopg

URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst"
BATCH = 1000
HEADERS = {"User-Agent": "ChessRabbit/0.1 puzzle-loader (noreply@chessrabbit.app)"}


class _IterStream(io.RawIOBase):
    """Read()-able view over an httpx byte iterator, so zstandard can stream it."""

    def __init__(self, chunks):
        self._chunks = chunks
        self._buf = b""

    def readable(self) -> bool:
        return True

    def readinto(self, b) -> int:
        while not self._buf:
            try:
                self._buf = next(self._chunks)
            except StopIteration:
                return 0
        n = min(len(b), len(self._buf))
        b[:n] = self._buf[:n]
        self._buf = self._buf[n:]
        return n


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", default="postgresql://chessrabbit:devpassword@localhost:5432/chessrabbit")
    ap.add_argument("--max", type=int, default=30_000, help="puzzles to insert")
    ap.add_argument("--min-rating", type=int, default=600)
    ap.add_argument("--max-rating", type=int, default=2400)
    ap.add_argument("--min-popularity", type=int, default=70)
    ap.add_argument("--min-plays", type=int, default=30)
    args = ap.parse_args()

    try:
        import zstandard
    except ImportError:
        sys.exit("pip install zstandard to read the .zst puzzle dump")

    conn = psycopg.connect(args.dsn)

    inserted = seen = 0
    batch: list[tuple] = []
    header_skipped = False
    t0 = time.time()

    def flush() -> None:
        nonlocal batch
        if not batch:
            return
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO puzzles
                  (lichess_id, fen, moves, rating, rating_dev, popularity,
                   nb_plays, themes, game_url, opening_tags)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (lichess_id) DO NOTHING
                """,
                batch,
            )
        conn.commit()
        batch = []

    def handle(line: str) -> bool:
        """Parse one CSV line; return True when we've inserted enough."""
        nonlocal inserted, seen, header_skipped
        if not header_skipped:
            header_skipped = True
            return False
        row = next(csv.reader([line]), None)
        if not row or len(row) < 8:
            return False
        seen += 1
        pid, fen, moves, rating, rdev, pop, plays, themes = row[:8]
        game_url = row[8] if len(row) > 8 else None
        opening_tags = row[9] if len(row) > 9 else None
        try:
            rating_i, pop_i, plays_i = int(rating), int(pop), int(plays)
        except ValueError:
            return False
        if not (args.min_rating <= rating_i <= args.max_rating):
            return False
        if pop_i < args.min_popularity or plays_i < args.min_plays:
            return False

        batch.append((
            pid, fen, moves, rating_i, int(rdev or 0), pop_i, plays_i,
            themes or None, game_url or None, opening_tags or None,
        ))
        inserted += 1
        if len(batch) >= BATCH:
            flush()
            rate = inserted / max(1e-9, time.time() - t0)
            print(f"\r{inserted:>7} inserted / {seen:>8} scanned ({rate:.0f}/s)",
                  end="", flush=True)
        return inserted >= args.max

    with httpx.stream("GET", URL, headers=HEADERS, timeout=httpx.Timeout(30.0, read=180.0)) as resp:
        resp.raise_for_status()
        src = _IterStream(resp.iter_bytes(chunk_size=1 << 16))
        reader = zstandard.ZstdDecompressor().stream_reader(src, read_across_frames=True)
        text = io.TextIOWrapper(reader, encoding="utf-8", errors="replace")
        for line in text:
            line = line.rstrip("\n")
            if line and handle(line):
                break

    flush()
    conn.close()
    print(f"\nInserted {inserted} puzzles (scanned {seen}) in {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
